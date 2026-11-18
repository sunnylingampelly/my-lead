"""Tags, static lists, custom attribute definitions and the suppression list."""
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import (
    Contact,
    ContactAttributeDefinition,
    ContactList,
    ContactListMember,
    ContactTag,
    SuppressionEntry,
    Tag,
)
from app.schemas.audience import (
    AttributeCreate,
    AttributeUpdate,
    ListCreate,
    ListOut,
    ListUpdate,
    SuppressionCreate,
    SuppressionOut,
    TagCreate,
    TagUpdate,
    TagWithCount,
)
from app.schemas.common import Page, PageParams
from app.services import audit_service
from app.services.audience.consent import suppress
from app.services.audience.contacts import add_to_lists
from app.services.audience.segments import segments_referencing
from app.services.tenancy import AppContext
from app.utils.contact_normalize import (
    InvalidValue,
    identifier_hash,
    mask_email,
    mask_phone,
    normalize_email,
    parse_phone,
)

RESERVED_KEYS = {"id", "first_name", "last_name", "full_name", "email", "phone", "company", "country", "state",
                 "city", "postal_code", "source", "status", "timezone", "tags", "created_at", "updated_at"}


def _audit(db, ctx, action, target_type, target_id, summary):
    audit_service.record(db, action, actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type=target_type, target_id=target_id,
                         summary=summary)


# ------------------------------------------------------------------ tags

def list_tags(db: Session, ctx: AppContext) -> list[TagWithCount]:
    ctx.require(Perm.AUDIENCE_READ)
    counts = dict(db.execute(select(ContactTag.tag_id, func.count()).where(
        ContactTag.application_id == ctx.application_id).group_by(ContactTag.tag_id)).all())
    tags = db.scalars(select(Tag).where(Tag.application_id == ctx.application_id).order_by(Tag.name))
    return [TagWithCount(id=t.id, name=t.name, color=t.color, created_at=t.created_at,
                         contact_count=counts.get(t.id, 0)) for t in tags]


def _tag(db, ctx, tag_id) -> Tag:
    t = db.scalar(select(Tag).where(Tag.id == tag_id, Tag.application_id == ctx.application_id))
    if t is None:
        raise NotFound("Tag not found")
    return t


def _tag_name_free(db, ctx, name, exclude=None):
    q = select(Tag.id).where(Tag.application_id == ctx.application_id, func.lower(Tag.name) == name.lower())
    if exclude:
        q = q.where(Tag.id != exclude)
    if db.scalar(q):
        raise Conflict("A tag with this name already exists", code="DUPLICATE_NAME")


def create_tag(db: Session, ctx: AppContext, data: TagCreate) -> Tag:
    ctx.require(Perm.AUDIENCE_WRITE)
    _tag_name_free(db, ctx, data.name)
    t = Tag(organization_id=ctx.organization_id, application_id=ctx.application_id, name=data.name, color=data.color)
    db.add(t)
    db.flush()
    _audit(db, ctx, "tag.created", "tag", t.id, t.name)
    return t


def get_or_create_tags(db: Session, ctx: AppContext, names: list[str]) -> list[str]:
    ids = []
    for name in dict.fromkeys(n.strip() for n in names if n.strip()):
        t = db.scalar(select(Tag).where(Tag.application_id == ctx.application_id,
                                        func.lower(Tag.name) == name.lower()))
        if t is None:
            t = Tag(organization_id=ctx.organization_id, application_id=ctx.application_id, name=name[:60])
            db.add(t)
            db.flush()
        ids.append(t.id)
    return ids


def update_tag(db: Session, ctx: AppContext, tag_id: str, data: TagUpdate) -> Tag:
    ctx.require(Perm.AUDIENCE_WRITE)
    t = _tag(db, ctx, tag_id)
    if data.name is not None:
        name = data.name.strip()
        if not name:
            raise ValidationFailed("Name is required")
        _tag_name_free(db, ctx, name, exclude=t.id)
        t.name = name
    if data.color is not None:
        t.color = data.color
    return t


def delete_tag(db: Session, ctx: AppContext, tag_id: str) -> None:
    ctx.require(Perm.AUDIENCE_WRITE)
    t = _tag(db, ctx, tag_id)
    used = segments_referencing(db, ctx, tag_id=t.id)
    if used:
        raise Conflict(f"This tag is used by segments: {', '.join(used)}", code="IN_USE", details={"segments": used})
    db.delete(t)
    _audit(db, ctx, "tag.deleted", "tag", tag_id, t.name)


# ------------------------------------------------------------------ lists

def _list_out(li: ContactList, n: int) -> ListOut:
    return ListOut(id=li.id, name=li.name, description=li.description, contact_count=n, created_at=li.created_at,
                   updated_at=li.updated_at)


def _counts(db, ctx) -> dict[str, int]:
    return dict(db.execute(select(ContactListMember.list_id, func.count()).where(
        ContactListMember.application_id == ctx.application_id).group_by(ContactListMember.list_id)).all())


def list_lists(db: Session, ctx: AppContext) -> list[ListOut]:
    ctx.require(Perm.AUDIENCE_READ)
    counts = _counts(db, ctx)
    return [_list_out(li, counts.get(li.id, 0)) for li in db.scalars(
        select(ContactList).where(ContactList.application_id == ctx.application_id).order_by(ContactList.name))]


def _list(db, ctx, list_id) -> ContactList:
    li = db.scalar(select(ContactList).where(ContactList.id == list_id,
                                             ContactList.application_id == ctx.application_id))
    if li is None:
        raise NotFound("List not found")
    return li


def get_list(db: Session, ctx: AppContext, list_id: str) -> ListOut:
    ctx.require(Perm.AUDIENCE_READ)
    li = _list(db, ctx, list_id)
    n = db.scalar(select(func.count()).select_from(ContactListMember).where(ContactListMember.list_id == li.id)) or 0
    return _list_out(li, n)


def _list_name_free(db, ctx, name, exclude=None):
    q = select(ContactList.id).where(ContactList.application_id == ctx.application_id,
                                     func.lower(ContactList.name) == name.lower())
    if exclude:
        q = q.where(ContactList.id != exclude)
    if db.scalar(q):
        raise Conflict("A list with this name already exists", code="DUPLICATE_NAME")


def create_list(db: Session, ctx: AppContext, data: ListCreate) -> ListOut:
    ctx.require(Perm.AUDIENCE_WRITE)
    name = data.name.strip()
    if not name:
        raise ValidationFailed("Name is required")
    _list_name_free(db, ctx, name)
    li = ContactList(organization_id=ctx.organization_id, application_id=ctx.application_id, name=name,
                     description=data.description, created_by_id=ctx.user.id)
    db.add(li)
    db.flush()
    _audit(db, ctx, "list.created", "list", li.id, name)
    return _list_out(li, 0)


def update_list(db: Session, ctx: AppContext, list_id: str, data: ListUpdate) -> ListOut:
    ctx.require(Perm.AUDIENCE_WRITE)
    li = _list(db, ctx, list_id)
    if data.name is not None:
        _list_name_free(db, ctx, data.name.strip(), exclude=li.id)
        li.name = data.name.strip()
    if "description" in data.model_fields_set:
        li.description = data.description
    db.flush()
    return get_list(db, ctx, list_id)


def delete_list(db: Session, ctx: AppContext, list_id: str) -> None:
    ctx.require(Perm.AUDIENCE_WRITE)
    li = _list(db, ctx, list_id)
    used = segments_referencing(db, ctx, list_id=li.id)
    if used:
        raise Conflict(f"This list is used by segments: {', '.join(used)}", code="IN_USE", details={"segments": used})
    db.delete(li)
    _audit(db, ctx, "list.deleted", "list", list_id, li.name)


def add_list_members(db: Session, ctx: AppContext, list_id: str, contact_ids: list[str]) -> int:
    ctx.require(Perm.AUDIENCE_WRITE)
    li = _list(db, ctx, list_id)
    valid = list(db.scalars(select(Contact.id).where(Contact.application_id == ctx.application_id,
                                                     Contact.id.in_(contact_ids))))
    return add_to_lists(db, ctx, valid, [li.id])


def remove_list_members(db: Session, ctx: AppContext, list_id: str, contact_ids: list[str]) -> int:
    ctx.require(Perm.AUDIENCE_WRITE)
    li = _list(db, ctx, list_id)
    return db.execute(delete(ContactListMember).where(ContactListMember.list_id == li.id,
                                                      ContactListMember.contact_id.in_(contact_ids))).rowcount


# ------------------------------------------------------------------ custom attributes

def list_attributes(db: Session, ctx: AppContext) -> list[ContactAttributeDefinition]:
    ctx.require(Perm.AUDIENCE_READ)
    return list(db.scalars(select(ContactAttributeDefinition).where(
        ContactAttributeDefinition.application_id == ctx.application_id).order_by(ContactAttributeDefinition.label)))


def _attr(db, ctx, attr_id) -> ContactAttributeDefinition:
    d = db.scalar(select(ContactAttributeDefinition).where(ContactAttributeDefinition.id == attr_id,
                                                           ContactAttributeDefinition.application_id ==
                                                           ctx.application_id))
    if d is None:
        raise NotFound("Custom field not found")
    return d


def create_attribute(db: Session, ctx: AppContext, data: AttributeCreate) -> ContactAttributeDefinition:
    ctx.require(Perm.AUDIENCE_WRITE)
    if data.key in RESERVED_KEYS:
        raise ValidationFailed(f"'{data.key}' is a built-in field", code="RESERVED_KEY")
    if data.data_type == "select" and not data.options:
        raise ValidationFailed("Add at least one option for a select field")
    if db.scalar(select(ContactAttributeDefinition.id).where(
            ContactAttributeDefinition.application_id == ctx.application_id,
            ContactAttributeDefinition.key == data.key)):
        raise Conflict("A custom field with this key already exists", code="DUPLICATE_KEY")
    count = db.scalar(select(func.count()).select_from(ContactAttributeDefinition).where(
        ContactAttributeDefinition.application_id == ctx.application_id)) or 0
    if count >= 100:
        raise ValidationFailed("An application can have at most 100 custom fields")
    d = ContactAttributeDefinition(organization_id=ctx.organization_id, application_id=ctx.application_id,
                                   key=data.key, label=data.label.strip(), data_type=data.data_type,
                                   options=data.options, description=data.description)
    db.add(d)
    db.flush()
    _audit(db, ctx, "custom_field.created", "custom_field", d.id, d.key)
    return d


def update_attribute(db: Session, ctx: AppContext, attr_id: str, data: AttributeUpdate) -> ContactAttributeDefinition:
    ctx.require(Perm.AUDIENCE_WRITE)
    d = _attr(db, ctx, attr_id)
    if data.label is not None:
        d.label = data.label.strip()
    if data.options is not None:
        if d.data_type != "select":
            raise ValidationFailed("Only select fields have options")
        d.options = list(dict.fromkeys(o.strip() for o in data.options if o.strip()))
    if "description" in data.model_fields_set:
        d.description = data.description
    return d


def delete_attribute(db: Session, ctx: AppContext, attr_id: str) -> None:
    ctx.require(Perm.AUDIENCE_WRITE)
    d = _attr(db, ctx, attr_id)
    used = segments_referencing(db, ctx, field=f"attr.{d.key}")
    if used:
        raise Conflict(f"This field is used by segments: {', '.join(used)}", code="IN_USE",
                       details={"segments": used})
    db.delete(d)
    _audit(db, ctx, "custom_field.deleted", "custom_field", attr_id, d.key)


# ------------------------------------------------------------------ suppression

def list_suppressions(db: Session, ctx: AppContext, params: PageParams, channel: str | None,
                      search: str | None) -> Page[SuppressionOut]:
    ctx.require(Perm.AUDIENCE_READ)
    q = select(SuppressionEntry).where(SuppressionEntry.application_id == ctx.application_id)
    if channel:
        q = q.where(SuppressionEntry.channel == channel)
    if search:
        hashes = [identifier_hash(search.strip().lower())]
        try:
            p = parse_phone(search, ctx.application.default_country)
            if p:
                hashes.append(identifier_hash(p.e164))
        except InvalidValue:
            pass
        q = q.where(or_(SuppressionEntry.value_hash.in_(hashes)))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    items = db.scalars(q.order_by(SuppressionEntry.created_at.desc()).offset(params.offset).limit(params.page_size))
    return Page(items=[SuppressionOut.model_validate(i) for i in items], total=total, page=params.page,
                page_size=params.page_size)


def add_suppression(db: Session, ctx: AppContext, data: SuppressionCreate) -> SuppressionEntry:
    ctx.require(Perm.AUDIENCE_WRITE)
    try:
        if data.channel == "email":
            value = normalize_email(data.value)
            masked = mask_email(value)
        else:
            parsed = parse_phone(data.value, ctx.application.default_country)
            value = parsed.e164
            masked = mask_phone(value)
    except InvalidValue as exc:
        raise ValidationFailed(str(exc), code="INVALID_VALUE") from exc
    h = identifier_hash(value)
    if not suppress(db, ctx, data.channel, h, masked, data.reason, "manual", data.note, ctx.user.id):
        raise Conflict("This address is already suppressed on that channel", code="ALREADY_SUPPRESSED")
    db.flush()
    _audit(db, ctx, "suppression.added", "suppression", None, f"{data.channel}: {masked}")
    return db.scalar(select(SuppressionEntry).where(SuppressionEntry.application_id == ctx.application_id,
                                                    SuppressionEntry.channel == data.channel,
                                                    SuppressionEntry.value_hash == h))


def remove_suppression(db: Session, ctx: AppContext, entry_id: str) -> None:
    ctx.require(Perm.AUDIENCE_WRITE)
    e = db.scalar(select(SuppressionEntry).where(SuppressionEntry.id == entry_id,
                                                 SuppressionEntry.application_id == ctx.application_id))
    if e is None:
        raise NotFound("Suppression entry not found")
    if e.reason in ("complaint", "unsubscribed"):
        raise Conflict("Unsubscribes and spam complaints cannot be removed here. An unsubscribed person can only be "
                       "re-subscribed by recording their new consent on their contact profile.", code="PROTECTED")
    db.delete(e)
    _audit(db, ctx, "suppression.removed", "suppression", entry_id, f"{e.channel}: {e.value_masked}")
