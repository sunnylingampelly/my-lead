"""Mirror the code-defined RBAC model into the roles/permissions tables.

Called from migrations whenever roles or permissions change, and safe to run repeatedly."""
import sqlalchemy as sa
from sqlalchemy.engine import Connection

from app.core.permissions import (
    ORG_WIDE_ROLES,
    PERMISSION_DESCRIPTIONS,
    ROLE_DESCRIPTIONS,
    ROLE_LABELS,
    ROLE_PERMISSIONS,
    ROLE_RANK,
    Perm,
    Role,
)

_roles = sa.table("roles", sa.column("key"), sa.column("name"), sa.column("description"), sa.column("rank"),
                  sa.column("is_org_wide"))
_perms = sa.table("permissions", sa.column("key"), sa.column("description"))
_rp = sa.table("role_permissions", sa.column("role_key"), sa.column("permission_key"))


def sync_rbac(conn: Connection) -> None:
    existing_roles = set(conn.execute(sa.select(_roles.c.key)).scalars())
    for r in Role:
        values = dict(name=ROLE_LABELS[r], description=ROLE_DESCRIPTIONS[r], rank=ROLE_RANK[r],
                      is_org_wide=r in ORG_WIDE_ROLES)
        if r.value in existing_roles:
            conn.execute(sa.update(_roles).where(_roles.c.key == r.value).values(**values))
        else:
            conn.execute(sa.insert(_roles).values(key=r.value, **values))

    existing_perms = set(conn.execute(sa.select(_perms.c.key)).scalars())
    for p in Perm:
        if p.value in existing_perms:
            conn.execute(sa.update(_perms).where(_perms.c.key == p.value)
                         .values(description=PERMISSION_DESCRIPTIONS[p]))
        else:
            conn.execute(sa.insert(_perms).values(key=p.value, description=PERMISSION_DESCRIPTIONS[p]))

    conn.execute(sa.delete(_rp))
    conn.execute(sa.insert(_rp), [
        {"role_key": r.value, "permission_key": p.value} for r, perms in ROLE_PERMISSIONS.items() for p in sorted(perms)
    ])
