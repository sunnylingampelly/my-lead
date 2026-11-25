"""Reading uploaded CSV and XLSX files safely."""
import csv
import io
import re
import zipfile
from collections.abc import Iterator
from datetime import date, datetime

from app.core.errors import ValidationFailed

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 200


def detect_type(filename: str, head: bytes) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "xlsx":
        if not head.startswith(b"PK"):
            raise ValidationFailed("This file is not a valid .xlsx workbook", code="INVALID_FILE")
        return "xlsx"
    if ext in ("csv", "txt"):
        if b"\x00" in head[:4096]:
            raise ValidationFailed("This file does not look like a text CSV", code="INVALID_FILE")
        return "csv"
    raise ValidationFailed("Upload a .csv or .xlsx file", code="UNSUPPORTED_FILE_TYPE")


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16"):
        try:
            text = data.decode(enc)
            if enc == "utf-16" and not data.startswith((b"\xff\xfe", b"\xfe\xff")):
                continue
            return text
        except UnicodeDecodeError:
            continue
    return data.decode("cp1252", errors="replace")  # Excel "CSV" on Windows


def _headers(raw: list) -> list[str]:
    out, seen = [], {}
    for i, h in enumerate(raw):
        name = re.sub(r"\s+", " ", str(h or "").strip())[:100] or f"Column {i + 1}"
        if name.lower() in seen:
            seen[name.lower()] += 1
            name = f"{name} ({seen[name.lower()]})"
        else:
            seen[name.lower()] = 1
        out.append(name)
    return out


def _cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.date().isoformat() if (v.hour, v.minute, v.second) == (0, 0, 0) else v.isoformat(sep=" ")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))  # phone numbers stored as numbers in Excel
    return str(v).strip()


def iter_rows(data: bytes, file_type: str) -> tuple[list[str], Iterator[tuple[int, dict[str, str]]]]:
    """Return (headers, iterator of (line_number, {header: value})). Line 1 is the header."""
    if file_type == "csv":
        text = _decode(data)
        sample = text[:20000]
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        reader = csv.reader(io.StringIO(text), dialect)
        try:
            headers = _headers(next(reader))
        except StopIteration as exc:
            raise ValidationFailed("The file is empty", code="EMPTY_FILE") from exc

        def gen():
            for i, row in enumerate(reader, start=2):
                yield i, {h: (row[j].strip() if j < len(row) else "") for j, h in enumerate(headers)}

        return headers, gen()

    try:
        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except (zipfile.BadZipFile, KeyError, ValueError, OSError) as exc:
        raise ValidationFailed("This workbook could not be read", code="INVALID_FILE") from exc
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    try:
        headers = _headers(list(next(rows)))
    except StopIteration as exc:
        raise ValidationFailed("The first sheet is empty", code="EMPTY_FILE") from exc

    def gen_x():
        for i, row in enumerate(rows, start=2):
            yield i, {h: (_cell(row[j]) if j < len(row) else "") for j, h in enumerate(headers)}
        wb.close()

    return headers, gen_x()


def inspect(data: bytes, file_type: str) -> tuple[list[str], list[dict], int]:
    headers, rows = iter_rows(data, file_type)
    if len(headers) > MAX_COLUMNS:
        raise ValidationFailed(f"Files can have at most {MAX_COLUMNS} columns", code="TOO_MANY_COLUMNS")
    preview, total = [], 0
    for _, r in rows:
        if not any(r.values()):
            continue
        total += 1
        if len(preview) < 5:
            preview.append(r)
        if total > MAX_ROWS:
            raise ValidationFailed(f"Files can have at most {MAX_ROWS:,} rows. Split the file and import each part.",
                                   code="TOO_MANY_ROWS")
    if total == 0:
        raise ValidationFailed("The file has a header row but no data", code="EMPTY_FILE")
    return headers, preview, total


_SYNONYMS = {
    "first_name": ["first name", "firstname", "first", "given name", "fname"],
    "last_name": ["last name", "lastname", "surname", "family name", "lname"],
    "full_name": ["name", "full name", "fullname", "contact name", "customer name"],
    "email": ["email", "e-mail", "email address", "e-mail address", "mail", "email id"],
    "phone": ["phone", "mobile", "mobile number", "phone number", "cell", "cell phone", "contact number",
              "whatsapp", "mobile no", "phone no", "telephone", "tel"],
    "company": ["company", "organization", "organisation", "business", "company name", "employer"],
    "country": ["country", "country code", "nation"],
    "state": ["state", "province", "region", "state/province"],
    "city": ["city", "town", "district", "city/town"],
    "postal_code": ["postal code", "zip", "zip code", "zipcode", "pincode", "pin code", "pin", "postcode"],
    "source": ["source", "lead source"],
    "tags": ["tags", "tag", "labels"],
    "timezone": ["timezone", "time zone", "tz"],
    "owner_email": ["owner", "owner email", "contact owner", "sales rep", "assigned to", "account owner"],
    "lifecycle_stage": ["lifecycle stage", "lifecycle", "lead status", "lead stage"],
}


def suggest_mapping(headers: list[str], attr_keys: dict[str, str]) -> dict[str, str]:
    """Best-guess header -> target. attr_keys: {normalised label or key: key}."""
    out, used = {}, set()
    for h in headers:
        norm = re.sub(r"[_\-]+", " ", h.strip().lower())
        target = ""
        for t, names in _SYNONYMS.items():
            if norm in names or norm == t.replace("_", " "):
                target = t
                break
        if not target and norm.replace(" ", "_") in attr_keys:
            target = f"attr:{attr_keys[norm.replace(' ', '_')]}"
        if not target and norm in attr_keys:
            target = f"attr:{attr_keys[norm]}"
        if target and target in used:
            target = ""
        if target:
            used.add(target)
        out[h] = target
    return out
