"""Dynamic segments.

Rules are validated JSON trees of groups (all/any) and conditions. They are compiled into
parameterised SQLAlchemy expressions against a fixed whitelist of fields and operators. No user
input is ever interpolated into SQL.
"""
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, exists, func, not_, or_, select, true
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import (
    Company,
    Contact,
    ContactAttributeDefinition,
    ContactList,
    ContactListMember,
    ContactTag,
    Deal,
    PipelineStage,
    Segment,
    Tag,
)
from app.schemas.audience import SegmentCreate, SegmentGroup, SegmentPreview, SegmentUpdate
from app.services import audit_service
from app.services.audience.normalize import parse_date
from app.services.audience.query import base_query, count, eligibility_condition, escape_like
from app.services.tenancy import AppContext
from app.utils.contact_normalize import InvalidValue
from app.utils.time import utcnow

MAX_DEPTH = 4
MAX_CONDITIONS = 60

TEXT_OPS = ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty"]
NUMBER_OPS = ["is", "is_not", "gt", "lt", "is_empty", "is_not_empty"]
DATE_OPS = ["before", "after", "in_last_days", "is_empty", "is_not_empty"]
BOOL_OPS = ["is"]
SELECT_OPS = ["is", "is_not", "is_empty", "is_not_empty"]

# field -> (label, type, column)
CORE_FIELDS: dict[str, tuple[str, str, Any]] = {
    "first_name": ("First name", "text", Contact.first_name),
    "last_name": ("Last name", "text", Contact.last_name),
    "email": ("Email", "text", Contact.email),
    "phone": ("Phone", "text", Contact.phone),
    "company": ("Company", "text", Contact.company),
    "city": ("City", "text", Contact.city),
    "state": ("State", "text", Contact.state),
    "country": ("Country", "text", Contact.country),
    "postal_code": ("Postal code", "text", Contact.postal_code),
    "phone_country": ("Phone country", "text", Contact.phone_country),
    "timezone": ("Timezone", "text", Contact.timezone),
    "source": ("Source", "text", Contact.source),
    "status": ("Status", "select", Contact.status),
    "email_consent": ("Email consent", "boolean", Contact.email_consent),
    "sms_consent": ("SMS consent", "boolean", Contact.sms_consent),
    "voice_consent": ("Voice consent", "boolean", Contact.voice_consent),
    "email_unsubscribed": ("Email unsubscribed", "boolean", Contact.email_unsubscribed_at),
    "sms_unsubscribed": ("SMS unsubscribed", "boolean", Contact.sms_unsubscribed_at),
    "voice_unsubscribed": ("Voice unsubscribed", "boolean", Contact.voice_unsubscribed_at),
    "created_at": ("Created date", "date", Contact.created_at),
    "updated_at": ("Updated date", "date", Contact.updated_at),
    "last_activity_at": ("Last activity", "date", Contact.last_activity_at),
}
# CRM fields on the contact.
CRM_FIELDS: dict[str, tuple[str, str, Any]] = {
    "lifecycle_stage": ("Lifecycle stage", "select", Contact.lifecycle_stage),
    "lead_score": ("Lead score", "number", Contact.lead_score),
    "fit_score": ("Fit score", "number", Contact.fit_score),
    "engagement_score": ("Engagement score", "number", Contact.engagement_score),
}
# Fields of the contact's linked CRM company: key -> (label, type, column).
COMPANY_FIELDS: dict[str, tuple[str, str, Any]] = {
    "company.name": ("Company name", "text", Company.name),
    "company.industry": ("Company industry", "text", Company.industry),
    "company.size": ("Company size", "select", Company.size),
    "company.country": ("Company country", "text", Company.country),
}
LIFECYCLE_OPTIONS = ["subscriber", "lead", "mql", "sql", "opportunity", "customer", "other"]
COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-1000", "1000+"]
STATUS_OPTIONS = ["active", "unsubscribed", "bounced", "blocked"]
OPS_BY_TYPE = {"text": TEXT_OPS, "number": NUMBER_OPS, "date": DATE_OPS, "boolean": BOOL_OPS, "select": SELECT_OPS}


def field_catalog(db: Session, ctx: AppContext) -> dict:
    """Everything the visual builder needs: fields, their types, operators and choices."""
    ctx.require(Perm.AUDIENCE_READ)
    fields = [
        {"key": k, "label": label, "type": t, "group": "Contact", "operators": OPS_BY_TYPE[t],
         **({"options": STATUS_OPTIONS} if k == "status" else {})}
        for k, (label, t, _) in CORE_FIELDS.items()
    ]
    defs = select(ContactAttributeDefinition).where(ContactAttributeDefinition.application_id == ctx.application_id)
    for d in db.scalars(defs.order_by(ContactAttributeDefinition.label)):
        fields.append({"key": f"attr.{d.key}", "label": d.label, "type": d.data_type, "group": "Custom fields",
                       "operators": OPS_BY_TYPE[d.data_type], "options": d.options or []})
    fields += _crm_catalog(db, ctx)
    fields.append({"key": "tag", "label": "Tag", "type": "tag", "group": "Membership",
                   "operators": ["has_tag", "not_has_tag"]})
    fields.append({"key": "list", "label": "List", "type": "list", "group": "Membership",
                   "operators": ["in_list", "not_in_list"]})
    fields.append({"key": "eligible", "label": "Reachable on channel", "type": "channel", "group": "Membership",
                   "operators": ["is", "is_not"], "options": ["email", "sms", "voice"]})
    tags = [{"id": t.id, "name": t.name} for t in db.scalars(
        select(Tag).where(Tag.application_id == ctx.application_id).order_by(Tag.name))]
    lists = [{"id": li.id, "name": li.name} for li in db.scalars(
        select(ContactList).where(ContactList.application_id == ctx.application_id).order_by(ContactList.name))]
    return {"fields": fields, "tags": tags, "lists": lists}


def _crm_catalog(db: Session, ctx: AppContext) -> list[dict]:
    """CRM and company fields. Select fields carry option_labels so ids can be shown as names."""
    from app.services.crm.common import team

    owners = [{"value": "unassigned", "label": "Unassigned"}]
    owners += sorted(({"value": u.id, "label": u.full_name or u.email} for u in team(
        db, ctx.organization_id, ctx.application_id).values()), key=lambda o: o["label"].lower())
    stages = [{"value": st.id, "label": st.name} for st in db.scalars(
        select(PipelineStage).where(PipelineStage.application_id == ctx.application_id, PipelineStage.kind == "open")
        .order_by(PipelineStage.pipeline_id, PipelineStage.position))]
    out = [{"key": "owner", "label": "Owner", "type": "select", "group": "CRM", "operators": ["is", "is_not"],
            "options": [o["value"] for o in owners], "option_labels": {o["value"]: o["label"] for o in owners}}]
    for k, (label, t, _) in CRM_FIELDS.items():
        out.append({"key": k, "label": label, "type": t, "group": "CRM",
                    "operators": ["is", "is_not"] if t == "select" else OPS_BY_TYPE[t],
                    **({"options": LIFECYCLE_OPTIONS} if k == "lifecycle_stage" else {})})
    out += [
        {"key": "has_open_deal", "label": "Has an open deal", "type": "boolean", "group": "CRM", "operators": ["is"]},
        {"key": "deal_stage", "label": "Has a deal in stage", "type": "select", "group": "CRM",
         "operators": ["is", "is_not"], "options": [st["value"] for st in stages],
         "option_labels": {st["value"]: st["label"] for st in stages}},
        {"key": "sla_breached", "label": "First-response time missed", "type": "boolean", "group": "CRM",
         "operators": ["is"]},
    ]
    for k, (label, t, _) in COMPANY_FIELDS.items():
        out.append({"key": k, "label": label, "type": t, "group": "Company",
                    "operators": SELECT_OPS if t == "select" else TEXT_OPS,
                    **({"options": COMPANY_SIZES} if k == "company.size" else {})})
    return out


class _Compiler:
    def __init__(self, db: Session, ctx: AppContext):
        self.db, self.ctx = db, ctx
        self.attrs = {d.key: d for d in db.scalars(select(ContactAttributeDefinition).where(
            ContactAttributeDefinition.application_id == ctx.application_id))}
        self.tag_ids = set(db.scalars(select(Tag.id).where(Tag.application_id == ctx.application_id)))
        self.list_ids = set(db.scalars(select(ContactList.id).where(ContactList.application_id == ctx.application_id)))
        self.conditions = 0
        self.default_country = ctx.application.default_country

    def fail(self, path: str, msg: str):
        raise ValidationFailed(msg, code="INVALID_SEGMENT_RULES", details={"path": path})

    def group(self, node: dict, path: str = "rules", depth: int = 1):
        if depth > MAX_DEPTH:
            self.fail(path, f"Groups can be nested at most {MAX_DEPTH} levels deep")
        conds = node.get("conditions") or []
        parts = []
        for i, child in enumerate(conds):
            p = f"{path}.conditions[{i}]"
            if child.get("type") == "group":
                if child.get("conditions"):
                    parts.append(self.group(child, p, depth + 1))
            else:
                parts.append(self.condition(child, p))
        if not parts:
            return true()
        return and_(*parts) if node.get("match", "all") == "all" else or_(*parts)

    def condition(self, c: dict, path: str):
        self.conditions += 1
        if self.conditions > MAX_CONDITIONS:
            self.fail(path, f"A segment can have at most {MAX_CONDITIONS} conditions")
        field, op, value = c.get("field", ""), c.get("operator", ""), c.get("value")

        if field == "tag":
            if op not in ("has_tag", "not_has_tag") or value not in self.tag_ids:
                self.fail(path, "Choose a tag")
            e = exists().where(ContactTag.contact_id == Contact.id, ContactTag.tag_id == value)
            return e if op == "has_tag" else not_(e)
        if field == "list":
            if op not in ("in_list", "not_in_list") or value not in self.list_ids:
                self.fail(path, "Choose a list")
            e = exists().where(ContactListMember.contact_id == Contact.id, ContactListMember.list_id == value)
            return e if op == "in_list" else not_(e)
        if field == "eligible":
            if op not in ("is", "is_not") or value not in ("email", "sms", "voice"):
                self.fail(path, "Choose a channel")
            e = eligibility_condition(value)
            return e if op == "is" else not_(e)

        if field in ("owner", "has_open_deal", "deal_stage", "sla_breached") or field in COMPANY_FIELDS:
            return self._crm(field, op, value, path)

        if field.startswith("attr."):
            defn = self.attrs.get(field[5:])
            if defn is None:
                self.fail(path, f"Unknown custom field '{field[5:]}'")
            ftype = defn.data_type
            base = Contact.attributes[defn.key]
            col = {"number": base.as_float(), "boolean": base.as_boolean()}.get(ftype, base.as_string())
            options = defn.options or []
        elif field in CORE_FIELDS:
            _, ftype, col = CORE_FIELDS[field]
            options = STATUS_OPTIONS if field == "status" else []
        elif field in CRM_FIELDS:
            _, ftype, col = CRM_FIELDS[field]
            options = LIFECYCLE_OPTIONS if field == "lifecycle_stage" else []
        else:
            self.fail(path, f"Unknown field '{field}'")
        if op not in OPS_BY_TYPE[ftype]:
            self.fail(path, f"Operator '{op}' is not valid for {ftype} fields")

        if field.endswith("_unsubscribed"):  # boolean view over a timestamp column
            v = self._bool(value, path)
            return col.is_not(None) if v else col.is_(None)

        if op == "is_empty":
            return or_(col.is_(None), col == "") if ftype in ("text", "select") else col.is_(None)
        if op == "is_not_empty":
            return and_(col.is_not(None), col != "") if ftype in ("text", "select") else col.is_not(None)

        if ftype == "boolean":
            v = self._bool(value, path)
            return col.is_(True) if v else or_(col.is_(False), col.is_(None))
        if ftype == "number":
            n = self._number(value, path)
            return {"is": col == n, "is_not": or_(col.is_(None), col != n), "gt": col > n, "lt": col < n}[op]
        if ftype == "date":
            return self._date(col, op, value, path, json_attr=field.startswith("attr."))
        if ftype == "select" and options and op in ("is", "is_not"):
            if str(value).lower() not in {o.lower() for o in options}:
                self.fail(path, "Choose one of the allowed values")
        text = self._text(value, path)
        lc = func.lower(col)
        if op == "is":
            return lc == text
        if op == "is_not":
            return or_(col.is_(None), lc != text)
        pattern = {"contains": f"%{escape_like(text)}%", "not_contains": f"%{escape_like(text)}%",
                   "starts_with": f"{escape_like(text)}%", "ends_with": f"%{escape_like(text)}"}[op]
        like = lc.like(pattern, escape="\\")
        return or_(col.is_(None), not_(like)) if op == "not_contains" else like

    def _crm(self, field: str, op: str, value, path: str):
        if field == "owner":
            if op not in ("is", "is_not") or not value:
                self.fail(path, "Choose an owner")
            if value == "unassigned":
                cond = Contact.owner_id.is_(None)
                return cond if op == "is" else not_(cond)
            user = getattr(self.ctx, "user", None)
            uid = user.id if value == "me" and user else str(value)
            return Contact.owner_id == uid if op == "is" else or_(Contact.owner_id.is_(None),
                                                                    Contact.owner_id != uid)
        if field in ("has_open_deal", "sla_breached"):
            if op != "is":
                self.fail(path, f"Operator '{op}' is not valid for yes/no fields")
            v = self._bool(value, path)
            if field == "has_open_deal":
                cond = exists().where(Deal.contact_id == Contact.id, Deal.status == "open")
            else:
                cond = and_(Contact.sla_breached_at.is_not(None), Contact.first_response_at.is_(None))
            return cond if v else not_(cond)
        if field == "deal_stage":
            if op not in ("is", "is_not") or not value:
                self.fail(path, "Choose a pipeline stage")
            if not self.db.scalar(select(PipelineStage.id).where(
                    PipelineStage.id == str(value), PipelineStage.application_id == self.ctx.application_id)):
                self.fail(path, "Choose a pipeline stage")
            cond = exists().where(Deal.contact_id == Contact.id, Deal.stage_id == str(value))
            return cond if op == "is" else not_(cond)
        # company.*: a condition on the linked CRM company
        _, ftype, col = COMPANY_FIELDS[field]
        if op not in (SELECT_OPS if ftype == "select" else TEXT_OPS):
            self.fail(path, f"Operator '{op}' is not valid for {ftype} fields")
        linked = Company.id == Contact.company_id
        if op == "is_empty":
            return not_(exists().where(linked, col.is_not(None), col != ""))
        if op == "is_not_empty":
            return exists().where(linked, col.is_not(None), col != "")
        if ftype == "select" and str(value) not in COMPANY_SIZES:
            self.fail(path, "Choose one of the allowed values")
        text = self._text(value, path)
        lc = func.lower(col)
        if op in ("is", "is_not"):
            cond = exists().where(linked, lc == text)
            return cond if op == "is" else not_(cond)
        pattern = {"contains": f"%{escape_like(text)}%", "not_contains": f"%{escape_like(text)}%",
                   "starts_with": f"{escape_like(text)}%", "ends_with": f"%{escape_like(text)}"}[op]
        cond = exists().where(linked, lc.like(pattern, escape="\\"))
        return not_(cond) if op == "not_contains" else cond

    def _text(self, value, path) -> str:
        if value is None or not str(value).strip():
            self.fail(path, "Enter a value")
        return str(value).strip().lower()[:200]

    def _number(self, value, path) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            self.fail(path, "Enter a number")

    def _bool(self, value, path) -> bool:
        if isinstance(value, bool):
            return value
        if str(value).lower() in ("true", "yes", "1"):
            return True
        if str(value).lower() in ("false", "no", "0"):
            return False
        self.fail(path, "Choose yes or no")

    def _date(self, col, op, value, path, json_attr: bool):
        if op == "in_last_days":
            try:
                days = int(value)
            except (TypeError, ValueError):
                self.fail(path, "Enter a number of days")
            if not 1 <= days <= 3650:
                self.fail(path, "Days must be between 1 and 3650")
            since = utcnow() - timedelta(days=days)
            return col >= (since.date().isoformat() if json_attr else since)
        try:
            d = parse_date(str(value or ""), self.default_country)
        except InvalidValue:
            self.fail(path, "Enter a valid date")
        if json_attr:
            return col < d.isoformat() if op == "before" else col > d.isoformat()
        start = datetime(d.year, d.month, d.day, tzinfo=UTC)
        return col < start if op == "before" else col >= start + timedelta(days=1)


def compile_rules(db: Session, ctx: AppContext, rules: dict):
    if not isinstance(rules, dict):
        raise ValidationFailed("Invalid segment rules", code="INVALID_SEGMENT_RULES")
    return _Compiler(db, ctx).group(rules)


def _rules_dict(rules: SegmentGroup) -> dict:
    return rules.model_dump(mode="json")


def _get(db: Session, ctx: AppContext, segment_id: str) -> Segment:
    seg = db.scalar(select(Segment).where(Segment.id == segment_id, Segment.application_id == ctx.application_id))
    if seg is None:
        raise NotFound("Segment not found")
    return seg


def _unique_name(db: Session, ctx: AppContext, name: str, exclude: str | None = None) -> None:
    q = select(Segment.id).where(Segment.application_id == ctx.application_id, func.lower(Segment.name) == name.lower())
    if exclude:
        q = q.where(Segment.id != exclude)
    if db.scalar(q):
        raise Conflict("A segment with this name already exists", code="DUPLICATE_NAME")


def preview(db: Session, ctx: AppContext, rules: SegmentGroup, sample: int = 10) -> SegmentPreview:
    from app.services.audience.contacts import to_list_item

    ctx.require(Perm.AUDIENCE_READ)
    cond = compile_rules(db, ctx, _rules_dict(rules))
    stmt = base_query(ctx).where(cond)
    total = count(db, stmt)
    eligible = {ch: count(db, stmt.where(eligibility_condition(ch))) for ch in ("email", "sms", "voice")}
    rows = db.scalars(stmt.order_by(Contact.created_at.desc()).limit(sample)).all()
    return SegmentPreview(count=total, eligible=eligible, sample=[to_list_item(c, ctx) for c in rows])


def refresh_count(db: Session, ctx: AppContext, seg: Segment) -> int:
    n = count(db, base_query(ctx).where(compile_rules(db, ctx, seg.rules)))
    seg.last_count, seg.last_counted_at = n, utcnow()
    return n


def list_segments(db: Session, ctx: AppContext) -> list[Segment]:
    ctx.require(Perm.AUDIENCE_READ)
    segs = list(db.scalars(select(Segment).where(Segment.application_id == ctx.application_id).order_by(Segment.name)))
    for s in segs:  # counts are live; segments are dynamic
        try:
            refresh_count(db, ctx, s)
        except ValidationFailed:
            s.last_count = None  # rules reference something that was removed
    return segs


def get_segment(db: Session, ctx: AppContext, segment_id: str) -> Segment:
    ctx.require(Perm.AUDIENCE_READ)
    seg = _get(db, ctx, segment_id)
    refresh_count(db, ctx, seg)
    return seg


def create_segment(db: Session, ctx: AppContext, data: SegmentCreate) -> Segment:
    ctx.require(Perm.AUDIENCE_WRITE)
    name = data.name.strip()
    _unique_name(db, ctx, name)
    rules = _rules_dict(data.rules)
    compile_rules(db, ctx, rules)  # validate before saving
    seg = Segment(organization_id=ctx.organization_id, application_id=ctx.application_id, name=name,
                  description=data.description, rules=rules, created_by_id=ctx.user.id)
    db.add(seg)
    db.flush()
    refresh_count(db, ctx, seg)
    audit_service.record(db, "segment.created", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="segment", target_id=seg.id, summary=name)
    return seg


def update_segment(db: Session, ctx: AppContext, segment_id: str, data: SegmentUpdate) -> Segment:
    ctx.require(Perm.AUDIENCE_WRITE)
    seg = _get(db, ctx, segment_id)
    if data.name is not None:
        _unique_name(db, ctx, data.name.strip(), exclude=seg.id)
        seg.name = data.name.strip()
    if "description" in data.model_fields_set:
        seg.description = data.description
    if data.rules is not None:
        rules = _rules_dict(data.rules)
        compile_rules(db, ctx, rules)
        seg.rules = rules
    refresh_count(db, ctx, seg)
    audit_service.record(db, "segment.updated", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="segment", target_id=seg.id, summary=seg.name)
    return seg


def delete_segment(db: Session, ctx: AppContext, segment_id: str) -> None:
    ctx.require(Perm.AUDIENCE_WRITE)
    seg = _get(db, ctx, segment_id)
    db.delete(seg)
    audit_service.record(db, "segment.deleted", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="segment", target_id=segment_id,
                         summary=seg.name)


def segments_referencing(db: Session, ctx: AppContext, field: str | None = None, tag_id: str | None = None,
                         list_id: str | None = None) -> list[str]:
    """Names of segments whose rules mention a field, tag or list (to block unsafe deletes)."""
    names = []

    def walk(node) -> bool:
        for c in node.get("conditions", []):
            if c.get("type") == "group":
                if walk(c):
                    return True
            elif (field and c.get("field") == field) \
                    or (tag_id and c.get("field") == "tag" and c.get("value") == tag_id) \
                    or (list_id and c.get("field") == "list" and c.get("value") == list_id):
                return True
        return False

    for s in db.scalars(select(Segment).where(Segment.application_id == ctx.application_id)):
        if walk(s.rules or {}):
            names.append(s.name)
    return names

