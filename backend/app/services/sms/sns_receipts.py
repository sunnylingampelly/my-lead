"""Read SMS delivery receipts from Amazon SNS delivery status logs.

SNS does not call back with SMS delivery results. With delivery status logging enabled
(SNS > Text messaging > Delivery status logs), it writes one log event per message to CloudWatch:

    sns/<region>/<account>/DirectPublishToPhoneNumber           successes
    sns/<region>/<account>/DirectPublishToPhoneNumber/Failure   failures

This poller reads both groups from a little before the last receipt it stored (log events can
arrive a few minutes late) and stores each one once as a webhook event, so receipts go through
the same idempotent processing as every other provider callback.
"""
import json
from datetime import timedelta

import boto3
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import get_logger
from app.models.email import WebhookEvent
from app.services.sms.webhooks import store_event
from app.utils.time import utcnow

log = get_logger(__name__)
PROVIDER = "sms_sns"
OVERLAP = timedelta(minutes=15)
MAX_LOOKBACK = timedelta(hours=24)
FIRST_LOOKBACK = timedelta(hours=1)

# SNS providerResponse text -> our error code and final status.
FAILURES = (
    ("opted out", "OPTED_OUT", "failed"),
    ("invalid phone number", "INVALID_NUMBER", "failed"),
    ("not a valid", "INVALID_NUMBER", "failed"),
    ("blocked", "BLOCKED", "undelivered"),
    ("spam", "BLOCKED", "undelivered"),
    ("unreachable", "UNREACHABLE", "undelivered"),
    ("unavailable", "UNREACHABLE", "undelivered"),
    ("expired", "EXPIRED", "undelivered"),
)


def parse_log_event(raw: str) -> dict | None:
    """One SNS delivery status log line -> {message_id, status, error_code, error_message}."""
    try:
        e = json.loads(raw)
    except ValueError:
        return None
    mid = (e.get("notification") or {}).get("messageId")
    delivery = e.get("delivery") or {}
    if not mid or e.get("status") not in ("SUCCESS", "FAILURE"):
        return None
    if e["status"] == "SUCCESS":
        return {"message_id": mid, "status": "delivered", "error_code": None, "error_message": None,
                "parts": delivery.get("numberOfMessageParts"), "price_usd": delivery.get("priceInUSD")}
    text = str(delivery.get("providerResponse") or "")
    code, status = "FAILED", "undelivered"
    for needle, c, s in FAILURES:
        if needle in text.lower():
            code, status = c, s
            break
    return {"message_id": mid, "status": status, "error_code": code, "error_message": text[:500] or None}


def _since(db: Session):
    last = db.scalar(select(func.max(WebhookEvent.received_at)).where(
        WebhookEvent.provider == PROVIDER, WebhookEvent.event_type == "status"))
    now = utcnow()
    if last is None:
        return now - FIRST_LOOKBACK
    if last.tzinfo is None:
        last = last.replace(tzinfo=now.tzinfo)
    return max(last - OVERLAP, now - MAX_LOOKBACK)


def _account_id() -> str:
    if settings.AWS_ACCOUNT_ID:
        return settings.AWS_ACCOUNT_ID
    sts = boto3.client("sts", region_name=settings.AWS_REGION, aws_access_key_id=settings.AWS_ACCESS_KEY_ID or None,
                       aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY or None)
    return sts.get_caller_identity()["Account"]


def log_groups() -> list[str]:
    base = f"sns/{settings.AWS_REGION}/{_account_id()}/DirectPublishToPhoneNumber"
    return [base, f"{base}/Failure"]


def poll(db: Session, logs_client=None) -> int:
    """Store new receipts. Returns how many were stored (duplicates are skipped)."""
    logs = logs_client or boto3.client(
        "logs", region_name=settings.AWS_REGION, aws_access_key_id=settings.AWS_ACCESS_KEY_ID or None,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY or None)
    start_ms = int(_since(db).timestamp() * 1000)
    stored = 0
    for group in log_groups():
        kwargs = {"logGroupName": group, "startTime": start_ms}
        while True:
            try:
                page = logs.filter_log_events(**kwargs)
            except logs.exceptions.ResourceNotFoundException:
                break  # nothing logged yet, or delivery status logging is off
            for ev in page.get("events", []):
                item = parse_log_event(ev.get("message", ""))
                if item and store_event(db, PROVIDER, f"{item['message_id']}:{item['status']}", "status", item):
                    stored += 1
            token = page.get("nextToken")
            if not token or token == kwargs.get("nextToken"):
                break
            kwargs["nextToken"] = token
    return stored
