"""Side-chat snapshots, private routing, persistence and retryable expiry."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from octop.api.routers.chat.turn import resolve_thread_id
from octop.infra.agents.threads.side_chat import sweep_expired_side_chats
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.gateway.threads import ThreadRegistry
from tests.support.app import octop_client
from tests.support.auth import (
    auth_header,
    bootstrap_admin,
    create_agent,
    ensure_users,
    seed_openai_provider,
)
from tests.support.fakes import FakeHarnessAgent
from tests.support.http import chat_ws_path, ws_connect


@pytest.fixture
async def env(tmp_octop_home: Path) -> AsyncIterator[Any]:
    async with octop_client(tmp_octop_home, fake_agent=FakeHarnessAgent()) as (c, srv):
        await bootstrap_admin(c, tmp_octop_home)
        admin = await auth_header(c)
        await seed_openai_provider(c, admin)
        users = await ensure_users(c, admin, "alice", "bob")
        aid = await create_agent(c, users["alice"])
        source = (await c.post(f"/api/agents/{aid}/threads", headers=users["alice"])).json()[
            "thread_id"
        ]
        agent = srv.app_runtime.agent_registry.get_agent(aid)
        yield c, srv, agent, users, aid, source


async def _create(env: Any) -> dict[str, Any]:
    c, _srv, _agent, users, aid, source = env
    response = await c.post(f"/api/agents/{aid}/threads/{source}/side-chat", headers=users["alice"])
    assert response.status_code == 200, response.text
    return response.json()


def _expire(srv: Any, tid: str) -> None:
    with srv.services.thread_repo._db.transaction() as conn:
        conn.execute(
            "UPDATE threads SET expires_at = ? WHERE thread_id = ?", (int(time.time()) - 1, tid)
        )


async def test_snapshot_inherits_effective_context_and_is_bidirectionally_isolated(
    env: Any,
) -> None:
    c, srv, agent, users, aid, source = env
    messages = [
        SystemMessage(content="compacted summary"),
        HumanMessage(content="question"),
        AIMessage(content="answer"),
    ]
    agent.seed_thread_messages(source, messages)
    registry = srv.app_runtime.gateway.thread_registry
    registry.update_composer(
        source,
        model_ref="openai:gpt-4o",
        reasoning_mode="on",
        reasoning_effort="high",
        conversation_mode="ask",
        pending_plan_path="plans/source.md",
        hitl_policy="ask",
    )
    row = registry.get_thread(source)
    main = ThreadRegistry.dashboard_key(agent_id=aid, user_id=row.user_id)
    before = registry.get_bound_thread_id(main)
    side = await _create(env)
    tid = side["thread_id"]
    assert side["source_thread_id"] == source
    assert side["copied_messages"] == 3 and side["side_chat"] is True
    assert 86390 <= side["expires_at"] - int(time.time()) <= 86400
    assert side["model_ref"] == "openai:gpt-4o"
    assert side["reasoning_effort"] == "high" and side["conversation_mode"] == "ask"
    assert registry.get_bound_thread_id(main) == before
    assert side["pending_plan_path"] is None
    copied = await agent.aget_effective_messages(tid)
    assert [m.content for m in copied] == [m.content for m in messages]
    copied[0].content = "child mutation"
    assert (await agent.aget_effective_messages(source))[0].content == "compacted summary"
    messages[1].content = "parent mutation"
    assert (await agent.aget_effective_messages(tid))[1].content == "question"
    listed = (await c.get(f"/api/agents/{aid}/threads", headers=users["alice"])).json()
    assert tid not in [r["thread_id"] for r in listed]


@pytest.mark.parametrize("messages", [[], [HumanMessage(content="no assistant yet")]])
async def test_empty_and_user_only_context_can_snapshot(env: Any, messages: list[Any]) -> None:
    _c, _srv, agent, _users, _aid, source = env
    agent.seed_thread_messages(source, messages)
    assert (await _create(env))["copied_messages"] == len(messages)


async def test_persist_is_idempotent_listed_and_keeps_main_binding(env: Any) -> None:
    c, srv, _agent, users, aid, source = env
    side = await _create(env)
    registry = srv.app_runtime.gateway.thread_registry
    uid = registry.get_thread(source).user_id
    main = ThreadRegistry.dashboard_key(agent_id=aid, user_id=uid)
    for _ in range(2):
        r = await c.post(
            f"/api/agents/{aid}/threads/{side['thread_id']}/persist", headers=users["alice"]
        )
        assert r.status_code == 200, r.text
        assert r.json()["expires_at"] is None and r.json()["side_chat"] is True
    listed = (await c.get(f"/api/agents/{aid}/threads", headers=users["alice"])).json()
    assert side["thread_id"] in [r["thread_id"] for r in listed]
    assert registry.get_bound_thread_id(main) == source
    tid, key = await resolve_thread_id(
        agent_id=aid,
        user_id=uid,
        thread_registry=registry,
        thread_id=side["thread_id"],
        session_key=main,
    )
    assert tid == side["thread_id"] and key == side["session_key"]
    assert registry.get_bound_thread_id(main) == source


async def test_owner_agent_scope_and_busy_sources(
    env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    c, srv, _agent, users, aid, source = env
    other = await create_agent(c, users["alice"], name="other")
    assert (
        await c.post(f"/api/agents/{other}/threads/{source}/side-chat", headers=users["alice"])
    ).status_code == 404
    assert (
        await c.post(f"/api/agents/{aid}/threads/{source}/side-chat", headers=users["bob"])
    ).status_code in (403, 404)
    hub = srv.app_runtime.gateway.ws_hub
    monkeypatch.setattr(hub, "is_turn_active", lambda _tid: True)
    assert (
        await c.post(f"/api/agents/{aid}/threads/{source}/side-chat", headers=users["alice"])
    ).status_code == 409
    monkeypatch.setattr(hub, "is_turn_active", lambda _tid: False)
    store = srv.app_runtime.gateway.processor.hitl_coordinator.store
    monkeypatch.setattr(store, "pending_thread_ids", lambda **_kw: {source})
    assert (
        await c.post(f"/api/agents/{aid}/threads/{source}/side-chat", headers=users["alice"])
    ).status_code == 409


async def test_expiry_blocks_send_persist_and_cleanup_retries_checkpoint_failure(
    env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    c, srv, _agent, users, aid, _source = env
    side = await _create(env)
    tid = side["thread_id"]
    _expire(srv, tid)
    registry = srv.app_runtime.gateway.thread_registry
    uid = registry.get_thread(tid).user_id
    assert (
        await c.post(f"/api/agents/{aid}/threads/{tid}/persist", headers=users["alice"])
    ).status_code == 404
    with pytest.raises(OctopError) as exc:
        await resolve_thread_id(
            agent_id=aid, user_id=uid, thread_registry=registry, thread_id=tid, session_key=None
        )
    assert exc.value.code == ErrorCode.NOT_FOUND
    processor = srv.app_runtime.gateway.processor
    with pytest.raises(OctopError):
        processor._validate_side_chat_turn(
            agent_id=aid, user_id=uid, session_key=side["session_key"], thread_id=tid
        )
    delete = AsyncMock(side_effect=OctopError(ErrorCode.CHECKPOINT_DELETE_FAILED, "retry"))
    monkeypatch.setattr(srv.app_runtime.agent_registry, "delete_thread_checkpoint", delete)
    await sweep_expired_side_chats(srv)
    assert registry.get_thread(tid) is not None
    assert registry.get_thread(tid).gc_claimed_at is None
    delete.side_effect = None
    await sweep_expired_side_chats(srv)
    assert registry.get_thread(tid) is None
    assert delete.await_count == 2
    with pytest.raises(OctopError):
        processor._validate_side_chat_turn(
            agent_id=aid, user_id=uid, session_key=side["session_key"], thread_id=tid
        )


async def test_persist_and_gc_claim_compare_and_swap(env: Any) -> None:
    _c, srv, _agent, _users, _aid, _source = env
    side = await _create(env)
    repo = srv.services.thread_repo
    tid = side["thread_id"]
    assert repo.persist_side_chat(tid, now=int(time.time()))
    assert not repo.claim_expired_side_chat(tid, now=side["expires_at"] + 1)
    second = await _create(env)
    _expire(srv, second["thread_id"])
    assert repo.claim_expired_side_chat(second["thread_id"], now=int(time.time()))
    assert not repo.persist_side_chat(second["thread_id"], now=int(time.time()))


async def test_ws_ignores_spoofed_session_keys_and_excludes_memory(env: Any) -> None:
    c, srv, agent, users, aid, source = env
    side = await _create(env)
    registry = srv.app_runtime.gateway.thread_registry
    uid = registry.get_thread(source).user_id
    main = ThreadRegistry.dashboard_key(agent_id=aid, user_id=uid)
    async with ws_connect(c._octop_app, chat_ws_path(aid, users["alice"])) as ws:
        await ws.send_json(
            {
                "type": "user_turn",
                "text": "side only",
                "thread_id": side["thread_id"],
                "session_key": main,
            }
        )
        frames = await ws.drain_turn()
    assert not [f for f in frames if f.get("type") == "error"], frames
    assert agent.last_request["thread_id"] == side["thread_id"]
    assert agent.last_request["configurable"]["octop_memory_capture_exclude"] is True
    assert registry.get_bound_thread_id(main) == source
    # Without an explicit thread, even a forged side route resolves the main thread.
    tid, key = await resolve_thread_id(
        agent_id=aid,
        user_id=uid,
        thread_registry=registry,
        thread_id=None,
        session_key=side["session_key"],
    )
    assert tid == source and key == main


async def test_close_retains_metadata_on_checkpoint_failure(
    env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    c, srv, _agent, users, aid, _source = env
    side = await _create(env)
    tid = side["thread_id"]
    delete = AsyncMock(side_effect=OctopError(ErrorCode.CHECKPOINT_DELETE_FAILED, "retry"))
    monkeypatch.setattr(srv.app_runtime.agent_registry, "delete_thread_checkpoint", delete)
    r = await c.delete(f"/api/agents/{aid}/threads/{tid}", headers=users["alice"])
    assert r.status_code >= 400
    assert srv.app_runtime.gateway.thread_registry.get_thread(tid) is not None
    delete.side_effect = None
    r = await c.delete(f"/api/agents/{aid}/threads/{tid}", headers=users["alice"])
    assert r.status_code == 204
    assert srv.app_runtime.gateway.thread_registry.get_thread(tid) is None


@pytest.mark.parametrize("expired", [False, True])
async def test_close_and_expiry_invalidate_pending_approvals(env: Any, expired: bool) -> None:
    c, srv, _agent, users, aid, _source = env
    side = await _create(env)
    tid = side["thread_id"]
    registry = srv.app_runtime.gateway.thread_registry
    uid = registry.get_thread(tid).user_id
    coordinator = srv.app_runtime.gateway.processor.hitl_coordinator
    coordinator.session_policies.set(tid, {"mode": "allow_all"})
    coordinator.session_policies.set(f"{tid}~member", {"mode": "allow_all"})
    record = coordinator.store.register(
        thread_id=tid,
        agent_id=aid,
        user_id=uid,
        session_key=side["session_key"],
        channel_type="dashboard",
        action_requests=[{"name": "shell", "args": {}}],
        review_configs=None,
    )
    # Saving a paused side chat is rejected, leaving its original TTL in place.
    response = await c.post(f"/api/agents/{aid}/threads/{tid}/persist", headers=users["alice"])
    assert response.status_code == 409
    if expired:
        _expire(srv, tid)
        await sweep_expired_side_chats(srv)
    else:
        response = await c.delete(f"/api/agents/{aid}/threads/{tid}", headers=users["alice"])
        assert response.status_code == 204, response.text
    assert registry.get_thread(tid) is None
    assert record.status == "expired"
    assert tid not in coordinator.session_policies._cache
    assert f"{tid}~member" not in coordinator.session_policies._cache
    assert coordinator.owned_tool_approval(record.pending_id, agent_id=aid, user_id=uid) is None
    with pytest.raises(OctopError):
        await resolve_thread_id(
            agent_id=aid,
            user_id=uid,
            thread_registry=registry,
            thread_id=tid,
            session_key=side["session_key"],
        )


async def test_temporary_discard_does_not_remove_saved_or_ordinary_thread(env: Any) -> None:
    c, srv, _agent, users, aid, source = env
    side = await _create(env)
    tid = side["thread_id"]
    saved = await c.post(f"/api/agents/{aid}/threads/{tid}/persist", headers=users["alice"])
    assert saved.status_code == 200, saved.text
    for thread_id in (tid, source):
        discarded = await c.delete(
            f"/api/agents/{aid}/threads/{thread_id}?temporary_only=true", headers=users["alice"]
        )
        assert discarded.status_code == 204
        row = srv.app_runtime.gateway.thread_registry.get_thread(thread_id)
        assert row is not None and row.expires_at is None


async def test_temporary_discard_claim_wins_over_late_persist(
    env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    c, srv, _agent, users, aid, _source = env
    side = await _create(env)
    tid = side["thread_id"]

    async def check_late_persist(agent_id: str, thread_id: str, *, reclaim: bool) -> None:
        assert (agent_id, thread_id, reclaim) == (aid, tid, True)
        persist = await c.post(f"/api/agents/{aid}/threads/{tid}/persist", headers=users["alice"])
        assert persist.status_code == 404
        assert srv.app_runtime.gateway.thread_registry.get_thread(tid) is not None

    delete = AsyncMock(side_effect=check_late_persist)
    monkeypatch.setattr(srv.app_runtime.agent_registry, "delete_thread_checkpoint", delete)
    discarded = await c.delete(
        f"/api/agents/{aid}/threads/{tid}?temporary_only=true", headers=users["alice"]
    )
    assert discarded.status_code == 204
    delete.assert_awaited_once()
    assert srv.app_runtime.gateway.thread_registry.get_thread(tid) is None


async def test_temporary_discard_releases_claim_after_checkpoint_failure(
    env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    c, srv, _agent, users, aid, _source = env
    side = await _create(env)
    tid = side["thread_id"]
    delete = AsyncMock(side_effect=OctopError(ErrorCode.CHECKPOINT_DELETE_FAILED, "retry"))
    monkeypatch.setattr(srv.app_runtime.agent_registry, "delete_thread_checkpoint", delete)
    response = await c.delete(
        f"/api/agents/{aid}/threads/{tid}?temporary_only=true", headers=users["alice"]
    )
    assert response.status_code >= 400
    row = srv.app_runtime.gateway.thread_registry.get_thread(tid)
    assert row is not None and row.gc_claimed_at is None
    delete.side_effect = None
    persisted = await c.post(f"/api/agents/{aid}/threads/{tid}/persist", headers=users["alice"])
    assert persisted.status_code == 200, persisted.text
