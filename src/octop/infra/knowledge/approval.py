"""In-tool approval for knowledge mutations selected by the global security policy."""

from __future__ import annotations

from typing import Any

from langgraph.types import interrupt

KNOWLEDGE_WRITE_TOOL_NAMES = frozenset(
    {
        "create_knowledge_base",
        "update_knowledge_base",
        "create_knowledge_document",
        "upload_knowledge_document",
        "update_knowledge_document",
    }
)
KNOWLEDGE_WRITE_INTERRUPT_CONFIG = {
    name: {"allowed_decisions": ["approve", "reject"]} for name in KNOWLEDGE_WRITE_TOOL_NAMES
}


def require_knowledge_write_approval(
    name: str, args: dict[str, Any], *, interrupt_config: dict[str, Any] | None = None
) -> bool:
    """Pause a policy-selected write within the tool, including during bootstrap.

    The caller resolves the global policy before entering this gate. Keeping it
    inside the mutation coroutine also covers the bootstrap graph.
    """
    config = (
        interrupt_config if interrupt_config is not None else KNOWLEDGE_WRITE_INTERRUPT_CONFIG[name]
    )
    # This in-tool gate authorizes the original args; edit/respond are unsupported.
    allowed_decisions = [
        decision for decision in config["allowed_decisions"] if decision in {"approve", "reject"}
    ]
    if not allowed_decisions:
        return False
    response = interrupt(
        {
            "action_requests": [{"name": name, "args": args}],
            "review_configs": [{"action_name": name, "allowed_decisions": allowed_decisions}],
        }
    )
    if not isinstance(response, dict):
        return False
    decisions = response.get("decisions")
    return (
        isinstance(decisions, list)
        and len(decisions) == 1
        and isinstance(decisions[0], dict)
        and decisions[0].get("type") == "approve"
        and "approve" in allowed_decisions
    )
