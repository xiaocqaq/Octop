"""Knowledge writes stay interactive even when callers supply permissive policies."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from octop.infra.gateway.hitl.coordinator import (
    HitlChannelCoordinator,
    iter_with_session_auto_approve,
)
from octop.infra.knowledge.approval import KNOWLEDGE_WRITE_TOOL_NAMES


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_name", sorted(KNOWLEDGE_WRITE_TOOL_NAMES))
@pytest.mark.parametrize("mixed", [False, True])
async def test_knowledge_write_never_auto_resumes(tool_name: str, mixed: bool) -> None:
    actions = [{"name": tool_name, "args": {}}]
    if mixed:
        actions.insert(0, {"name": "execute", "args": {}})
    paused: dict[str, Any] = {"type": "hitl_required", "request": {"action_requests": actions}}
    resumed: list[Any] = []

    async def source():
        yield paused

    async def resume(decisions):
        resumed.append(decisions)
        yield {"type": "token", "content": "unexpected write"}

    chunks = [
        chunk
        async for chunk in iter_with_session_auto_approve(
            source(),
            thread_id="thread",
            policies=SimpleNamespace(allows=lambda *_args: True),
            resume=resume,
        )
    ]
    assert chunks == [paused]
    assert resumed == []


@pytest.mark.parametrize("tool_name", sorted(KNOWLEDGE_WRITE_TOOL_NAMES))
@pytest.mark.parametrize("sticky", ["tool", "all"])
def test_knowledge_write_sticky_approval_is_once(tool_name: str, sticky: Any) -> None:
    coordinator = HitlChannelCoordinator()
    record = coordinator.store.register(
        thread_id="thread",
        agent_id="agent",
        user_id=1,
        session_key="session",
        channel_type="dashboard",
        action_requests=[{"name": tool_name, "args": {}}],
        review_configs=None,
    )
    effective, stamps = coordinator._apply_sticky(record, sticky)
    assert effective == "once"
    assert stamps == []
    assert coordinator.session_policies.get("thread").mode == "ask"
