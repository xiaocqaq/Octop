"""Per-call human approval for knowledge mutations, independent of security bypasses."""

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


def require_knowledge_write_approval(name: str, args: dict[str, Any]) -> bool:
    """Pause within the tool, including bootstrap, before any knowledge write.

    Keep this gate inside the mutation coroutine: the harness only mounts its
    configurable tool gate after bootstrap. Each tool call needs its own decision.
    """
    config = KNOWLEDGE_WRITE_INTERRUPT_CONFIG[name]
    response = interrupt(
        {
            "action_requests": [{"name": name, "args": args}],
            "review_configs": [
                {"action_name": name, "allowed_decisions": list(config["allowed_decisions"])}
            ],
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
    )
