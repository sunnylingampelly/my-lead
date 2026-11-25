"""Role-based access control.

Roles are organization-scoped. Owners and admins implicitly access every application in their
organization. Every other role needs an explicit application membership. The mapping below is
the source of truth for enforcement and is mirrored into the roles, permissions and
role_permissions tables by migrations so the admin panel and UI can display it.
"""
from enum import StrEnum


class Role(StrEnum):
    OWNER = "owner"
    ADMIN = "admin"
    APPLICATION_MANAGER = "application_manager"
    CAMPAIGN_MANAGER = "campaign_manager"
    ANALYST = "analyst"
    VIEWER = "viewer"
    # Internal: platform staff with a time-limited, read-only support session. Never assignable to members.
    PLATFORM_SUPPORT = "platform_support"


ROLE_LABELS = {
    Role.OWNER: "Organization Owner",
    Role.ADMIN: "Organization Admin",
    Role.APPLICATION_MANAGER: "Application Manager",
    Role.CAMPAIGN_MANAGER: "Campaign Manager",
    Role.ANALYST: "Analyst",
    Role.VIEWER: "Viewer",
    Role.PLATFORM_SUPPORT: "Platform support (read-only)",
}

ROLE_DESCRIPTIONS = {
    Role.OWNER: "Full control including billing and deleting the organization.",
    Role.ADMIN: "Manages members, applications and settings across the organization.",
    Role.APPLICATION_MANAGER: "Creates applications and manages the applications they belong to.",
    Role.CAMPAIGN_MANAGER: "Manages audiences and runs campaigns in assigned applications.",
    Role.ANALYST: "Read-only access to audiences, campaigns and analytics.",
    Role.VIEWER: "Read-only access to assigned applications.",
    Role.PLATFORM_SUPPORT: "Temporary read-only access for platform support staff.",
}

# Higher number means more privilege. Used to stop people granting roles above their own.
ROLE_RANK = {
    Role.PLATFORM_SUPPORT: 0,
    Role.VIEWER: 10,
    Role.ANALYST: 20,
    Role.CAMPAIGN_MANAGER: 30,
    Role.APPLICATION_MANAGER: 40,
    Role.ADMIN: 50,
    Role.OWNER: 60,
}

ORG_WIDE_ROLES = frozenset({Role.OWNER, Role.ADMIN, Role.PLATFORM_SUPPORT})
ASSIGNABLE_ROLES = tuple(r for r in Role if r != Role.PLATFORM_SUPPORT)
# Platform-level roles, separate from organization roles.
PLATFORM_ROLES = ("super_admin", "support")


class Perm(StrEnum):
    ORG_READ = "org.read"
    ORG_UPDATE = "org.update"
    ORG_DELETE = "org.delete"
    MEMBERS_READ = "members.read"
    MEMBERS_INVITE = "members.invite"
    MEMBERS_UPDATE = "members.update"
    MEMBERS_REMOVE = "members.remove"
    APPS_CREATE = "apps.create"
    APP_READ = "app.read"
    APP_UPDATE = "app.update"
    APP_DELETE = "app.delete"
    APP_MEMBERS_MANAGE = "app.members.manage"
    AUDIENCE_READ = "audience.read"
    AUDIENCE_WRITE = "audience.write"
    AUDIENCE_EXPORT = "audience.export"
    CAMPAIGNS_READ = "campaigns.read"
    CAMPAIGNS_WRITE = "campaigns.write"
    CAMPAIGNS_LAUNCH = "campaigns.launch"
    AUTOMATION_READ = "automation.read"
    AUTOMATION_WRITE = "automation.write"
    ANALYTICS_READ = "analytics.read"
    SETTINGS_READ = "settings.read"
    SETTINGS_WRITE = "settings.write"
    BILLING_READ = "billing.read"
    BILLING_MANAGE = "billing.manage"
    AUDIT_READ = "audit.read"
    CRM_READ = "crm.read"
    CRM_WRITE = "crm.write"
    CRM_MANAGE = "crm.manage"
    CHAT_READ = "chat.read"
    CHAT_WRITE = "chat.write"
    CHAT_REPLY = "chat.reply"
    FORMS_READ = "forms.read"
    FORMS_WRITE = "forms.write"
    PRIVACY_MANAGE = "privacy.manage"
    AI_USE = "ai.use"
    AI_MANAGE = "ai.manage"


PERMISSION_DESCRIPTIONS = {
    Perm.ORG_READ: "View organization",
    Perm.ORG_UPDATE: "Edit organization details",
    Perm.ORG_DELETE: "Delete organization",
    Perm.MEMBERS_READ: "View team members",
    Perm.MEMBERS_INVITE: "Invite team members",
    Perm.MEMBERS_UPDATE: "Change member roles and application access",
    Perm.MEMBERS_REMOVE: "Remove team members",
    Perm.APPS_CREATE: "Create applications",
    Perm.APP_READ: "View application",
    Perm.APP_UPDATE: "Edit application",
    Perm.APP_DELETE: "Delete application",
    Perm.APP_MEMBERS_MANAGE: "Manage application access",
    Perm.AUDIENCE_READ: "View contacts, lists and segments",
    Perm.AUDIENCE_WRITE: "Create and edit contacts, lists and segments",
    Perm.AUDIENCE_EXPORT: "Export contact data",
    Perm.CAMPAIGNS_READ: "View campaigns",
    Perm.CAMPAIGNS_WRITE: "Create and edit campaigns",
    Perm.CAMPAIGNS_LAUNCH: "Launch, schedule, pause and cancel campaigns",
    Perm.AUTOMATION_READ: "View workflows",
    Perm.AUTOMATION_WRITE: "Create, edit and activate workflows",
    Perm.ANALYTICS_READ: "View analytics",
    Perm.SETTINGS_READ: "View application settings",
    Perm.SETTINGS_WRITE: "Edit application settings",
    Perm.BILLING_READ: "View wallet and usage",
    Perm.BILLING_MANAGE: "Purchase credits and manage billing",
    Perm.AUDIT_READ: "View audit logs",
    Perm.CRM_READ: "View companies, deals, tasks and notes",
    Perm.CRM_WRITE: "Create and edit companies, deals, tasks and notes",
    Perm.CRM_MANAGE: "Manage pipelines, assignment rules, lead scoring and CRM settings",
    Perm.CHAT_READ: "View chatbots, chat conversations and chat analytics",
    Perm.CHAT_WRITE: "Create, train and publish website chatbots",
    Perm.CHAT_REPLY: "Answer visitors in the live-chat inbox",
    Perm.FORMS_READ: "View lead forms, their submissions and analytics",
    Perm.FORMS_WRITE: "Create, edit and publish lead forms and manage submissions",
    Perm.PRIVACY_MANAGE: "Handle data-subject requests: download all of a contact's data and erase contacts",
    Perm.AI_USE: "Use the AI Assistant (it can only do what the person's own role allows, after confirmation)",
    Perm.AI_MANAGE: "Create and manage AI agents, approve their actions and connect Slack",
}

# Organization-administration permissions that are withheld from owners and admins who have not set up
# two-factor authentication while their organization requires it.
MFA_GATED_PERMS = frozenset({
    Perm.ORG_UPDATE, Perm.ORG_DELETE, Perm.MEMBERS_INVITE, Perm.MEMBERS_UPDATE, Perm.MEMBERS_REMOVE,
    Perm.APP_DELETE, Perm.BILLING_MANAGE, Perm.PRIVACY_MANAGE,
})

_ALL = set(Perm)
_APP_WORK = {
    Perm.APP_READ, Perm.AUDIENCE_READ, Perm.AUDIENCE_WRITE, Perm.CAMPAIGNS_READ, Perm.CAMPAIGNS_WRITE,
    Perm.CAMPAIGNS_LAUNCH, Perm.AUTOMATION_READ, Perm.AUTOMATION_WRITE, Perm.ANALYTICS_READ, Perm.SETTINGS_READ,
    Perm.CRM_READ, Perm.CRM_WRITE,
    Perm.CHAT_READ, Perm.CHAT_WRITE, Perm.CHAT_REPLY,
    Perm.FORMS_READ, Perm.FORMS_WRITE,
    Perm.AI_USE, Perm.AI_MANAGE,
}

ROLE_PERMISSIONS: dict[Role, frozenset[Perm]] = {
    Role.OWNER: frozenset(_ALL),
    Role.ADMIN: frozenset(_ALL - {Perm.ORG_DELETE}),
    Role.APPLICATION_MANAGER: frozenset(
        _APP_WORK
        | {Perm.ORG_READ, Perm.MEMBERS_READ, Perm.APPS_CREATE, Perm.APP_UPDATE, Perm.APP_MEMBERS_MANAGE,
           Perm.SETTINGS_WRITE, Perm.BILLING_READ, Perm.AUDIT_READ, Perm.AUDIENCE_EXPORT, Perm.CRM_MANAGE}
    ),
    Role.CAMPAIGN_MANAGER: frozenset(_APP_WORK | {Perm.ORG_READ, Perm.MEMBERS_READ, Perm.AUDIENCE_EXPORT}),
    Role.ANALYST: frozenset(
        {Perm.ORG_READ, Perm.MEMBERS_READ, Perm.APP_READ, Perm.AUDIENCE_READ, Perm.CAMPAIGNS_READ,
         Perm.AUTOMATION_READ, Perm.ANALYTICS_READ, Perm.SETTINGS_READ, Perm.BILLING_READ, Perm.CRM_READ,
         Perm.CHAT_READ, Perm.FORMS_READ, Perm.AI_USE}
    ),
    # Viewers can ask the assistant questions too: its tools run with the viewer's own (read-only) permissions,
    # so every write tool is unavailable to them.
    Role.VIEWER: frozenset(
        {Perm.ORG_READ, Perm.APP_READ, Perm.AUDIENCE_READ, Perm.CAMPAIGNS_READ, Perm.AUTOMATION_READ,
         Perm.ANALYTICS_READ, Perm.CRM_READ, Perm.CHAT_READ, Perm.FORMS_READ, Perm.AI_USE}
    ),
    Role.PLATFORM_SUPPORT: frozenset(
        {Perm.ORG_READ, Perm.MEMBERS_READ, Perm.APP_READ, Perm.AUDIENCE_READ, Perm.CAMPAIGNS_READ,
         Perm.AUTOMATION_READ, Perm.ANALYTICS_READ, Perm.SETTINGS_READ, Perm.BILLING_READ, Perm.AUDIT_READ,
         Perm.CRM_READ, Perm.CHAT_READ, Perm.FORMS_READ}),
}


def permissions_for(role: str | Role) -> frozenset[Perm]:
    try:
        return ROLE_PERMISSIONS[Role(role)]
    except ValueError:
        return frozenset()


def can_assign(actor_role: str | Role, target_role: str | Role) -> bool:
    """Owners may grant any role. Everyone else may only grant roles strictly below their own."""
    actor, target = Role(actor_role), Role(target_role)
    if actor == Role.OWNER:
        return True
    return ROLE_RANK[target] < ROLE_RANK[actor]
