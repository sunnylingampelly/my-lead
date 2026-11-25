"""Workflow graphs in React Flow shape: {"nodes": [{id, type, data, position}], "edges": [{id, source, target,
sourceHandle}]}. Graphs are data only: node types come from a fixed list and nothing in a graph is
ever evaluated as code."""
from dataclasses import dataclass, field

CRM_TRIGGERS = ("deal_created", "deal_stage_changed", "deal_won", "deal_lost", "deal_rotting", "score_reached",
                "sla_breached", "owner_assigned", "ai_call_completed", "chat_lead_captured",
                "chat_conversation_closed", "form_submitted")
# Engagement triggers read the channel records: replies, clicks, answered calls and opt-outs.
ENGAGEMENT_TRIGGERS = ("sms_replied", "email_clicked", "call_answered", "unsubscribed")
TRIGGERS = ("contact_created", "added_to_list", "tag_added", "segment_entered", *ENGAGEMENT_TRIGGERS, *CRM_TRIGGERS)
TRIGGER_NAMES = {
    "contact_created": "Contact is created", "added_to_list": "Added to a list", "tag_added": "Tag is added",
    "segment_entered": "Enters a segment", "sms_replied": "SMS reply received", "email_clicked": "Email link clicked",
    "call_answered": "Call answered", "unsubscribed": "Unsubscribed or opted out", "deal_created": "Deal is created",
    "deal_stage_changed": "Deal changes stage", "deal_won": "Deal is won", "deal_lost": "Deal is lost",
    "deal_rotting": "Deal is going cold", "score_reached": "Lead becomes hot",
    "sla_breached": "First-response SLA is missed", "owner_assigned": "Owner is assigned",
    "ai_call_completed": "AI call completed",
    "chat_lead_captured": "Chatbot captures a lead", "chat_conversation_closed": "Chat conversation ends",
    "form_submitted": "Form is submitted",
}
# Display names for step types (run history, issues and dry runs).
STEP_NAMES = {"trigger": "Trigger", "send_email": "Send email", "send_sms": "Send SMS", "voice_call": "Voice call",
              "wait": "Wait", "condition": "Condition", "split": "A/B split", "update_contact": "Update contact",
              "crm_action": "CRM action", "ai_step": "AI step", "slack_message": "Send to Slack", "end": "End"}
NODE_TYPES = ("trigger", "send_email", "send_sms", "voice_call", "wait", "condition", "split", "update_contact",
              "crm_action", "ai_step", "slack_message", "end")
SEND_TYPES = ("send_email", "send_sms", "voice_call")
# Which outgoing handles each node type has. None = a single unnamed output.
HANDLES = {"condition": ("yes", "no"), "split": ("a", "b"), "end": ()}
WAIT_UNITS = {"minutes": 60, "hours": 3600, "days": 86400}
MAX_NODES = 100


@dataclass
class Issue:
    node_id: str | None
    message: str


@dataclass
class Graph:
    nodes: dict[str, dict]
    edges: list[dict]
    out: dict[str, dict[str | None, str]] = field(default_factory=dict)

    @classmethod
    def load(cls, raw: dict | None) -> "Graph":
        raw = raw or {}
        nodes = {n["id"]: n for n in raw.get("nodes", []) if isinstance(n, dict) and n.get("id")}
        edges = [e for e in raw.get("edges", []) if isinstance(e, dict) and e.get("source") and e.get("target")]
        g = cls(nodes, edges)
        for e in edges:
            g.out.setdefault(e["source"], {})[e.get("sourceHandle") or None] = e["target"]
        return g

    def trigger(self) -> dict | None:
        found = [n for n in self.nodes.values() if n.get("type") == "trigger"]
        return found[0] if len(found) == 1 else None

    def next(self, node_id: str, handle: str | None = None) -> str | None:
        outs = self.out.get(node_id, {})
        target = outs.get(handle) if handle is not None else (outs.get(None) or next(iter(outs.values()), None))
        return target if target in self.nodes else None


def data(node: dict) -> dict:
    return node.get("data") or {}


def label(node: dict) -> str:
    t = node.get("type", "step")
    return (data(node).get("label") or STEP_NAMES.get(t) or t.replace("_", " ").capitalize())[:80]


def structural_issues(g: Graph) -> list[Issue]:
    """Shape problems independent of the application's data."""
    issues: list[Issue] = []
    if len(g.nodes) > MAX_NODES:
        issues.append(Issue(None, f"Workflows can have up to {MAX_NODES} steps"))
    triggers = [n for n in g.nodes.values() if n.get("type") == "trigger"]
    if len(triggers) != 1:
        issues.append(Issue(None, "A workflow needs exactly one trigger"))
        return issues
    trig = triggers[0]
    for n in g.nodes.values():
        if n.get("type") not in NODE_TYPES:
            issues.append(Issue(n["id"], f"Unknown step type {n.get('type')!r}"))
    for e in g.edges:
        if e["source"] not in g.nodes or e["target"] not in g.nodes:
            issues.append(Issue(e.get("source"), "A connection points to a step that no longer exists"))
        elif e["target"] == trig["id"]:
            issues.append(Issue(e["source"], "Nothing can connect into the trigger"))
    for nid, outs in g.out.items():
        node = g.nodes.get(nid)
        if node is None:
            continue
        allowed = HANDLES.get(node.get("type"))
        if allowed is not None:
            bad = [h for h in outs if h not in allowed]
            if bad:
                issues.append(Issue(nid, "This step has an output it does not support"))
        elif len([e for e in g.edges if e["source"] == nid]) > 1:
            issues.append(Issue(nid, "This step can only lead to one next step. Use a condition or split to branch."))
    # Reachability and cycles.
    seen, on_path = set(), set()

    def visit(nid: str) -> bool:
        if nid in on_path:
            return True
        if nid in seen:
            return False
        seen.add(nid)
        on_path.add(nid)
        for target in g.out.get(nid, {}).values():
            if target in g.nodes and visit(target):
                return True
        on_path.discard(nid)
        return False

    if visit(trig["id"]):
        issues.append(Issue(None, "The workflow loops back on itself. Remove the connection that creates the loop."))
    for nid, n in g.nodes.items():
        if nid not in seen:
            issues.append(Issue(nid, f"“{label(n)}” is not connected to the trigger"))
    if not g.next(trig["id"]):
        issues.append(Issue(trig["id"], "Connect the trigger to a first step"))
    return issues


def wait_seconds(node: dict) -> int:
    d = data(node)
    try:
        amount = int(d.get("amount") or 0)
    except (TypeError, ValueError):
        amount = 0
    return amount * WAIT_UNITS.get(d.get("unit") or "hours", 3600)
