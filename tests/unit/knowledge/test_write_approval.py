"""Knowledge writes require a fresh standard HITL decision inside the tool graph."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from langgraph.types import Command

WRITE_TOOLS = (
    "create_knowledge_base",
    "update_knowledge_base",
    "create_knowledge_document",
    "upload_knowledge_document",
    "update_knowledge_document",
)


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_name", WRITE_TOOLS)
@pytest.mark.parametrize("decision", ["approve", "reject"])
async def test_knowledge_write_waits_for_each_explicit_decision(
    tool_name: str, decision: str
) -> None:
    from octop.infra.knowledge.approval import require_knowledge_write_approval

    writes: list[str] = []

    async def write(value: str) -> str:
        if not require_knowledge_write_approval(tool_name, {"value": value}):
            return "rejected"
        writes.append(value)
        return "written"

    tool = StructuredTool.from_function(
        name=tool_name, description="Write knowledge.", coroutine=write
    )
    builder = StateGraph(MessagesState)
    builder.add_node("tools", ToolNode([tool]))
    builder.set_entry_point("tools")
    builder.add_edge("tools", END)
    graph = builder.compile(checkpointer=InMemorySaver())
    config: Any = {"configurable": {"thread_id": "knowledge-write"}}

    def message(call_id: str) -> AIMessage:
        return AIMessage(
            content="",
            tool_calls=[{"id": call_id, "name": tool_name, "args": {"value": call_id}}],
        )

    paused = await graph.ainvoke({"messages": [message("first")]}, config)
    assert writes == []
    request = paused["__interrupt__"][0].value
    assert request["action_requests"] == [{"name": tool_name, "args": {"value": "first"}}]
    assert request["review_configs"] == [
        {"action_name": tool_name, "allowed_decisions": ["approve", "reject"]}
    ]

    result = await graph.ainvoke(Command(resume={"decisions": [{"type": decision}]}), config)
    assert "__interrupt__" not in result
    assert writes == (["first"] if decision == "approve" else [])
    assert result["messages"][-1].content == ("written" if decision == "approve" else "rejected")

    paused_again = await graph.ainvoke({"messages": [message("second")]}, config)
    assert len(paused_again["__interrupt__"]) == 1
    assert writes == (["first"] if decision == "approve" else [])


@pytest.mark.parametrize(
    "response",
    [
        None,
        True,
        "approve",
        {"type": "approve"},
        {"decisions": []},
        {"decisions": "approve"},
        {"decisions": [True]},
        {"decisions": [{"type": "edit", "edited_action": {"name": "create_knowledge_base"}}]},
        {"decisions": [{"type": "approve"}, {"type": "approve"}]},
    ],
)
def test_only_standard_single_approval_is_accepted(
    monkeypatch: pytest.MonkeyPatch, response: Any
) -> None:
    from octop.infra.knowledge.approval import require_knowledge_write_approval

    monkeypatch.setattr("octop.infra.knowledge.approval.interrupt", lambda _request: response)
    assert require_knowledge_write_approval("create_knowledge_base", {"name": "Draft"}) is False
