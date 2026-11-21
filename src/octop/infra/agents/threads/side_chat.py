"""Isolated dashboard side chats and their fixed, retryable lifecycle."""

from __future__ import annotations

import asyncio
import copy
import logging
import time
from typing import Any, cast

from octop.i18n import tr
from octop.infra.db.repos.threads import ThreadRow, clip_thread_title
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.gateway.threads import ThreadRegistry
from octop.infra.history.projection import message_inputs
from octop.infra.utils.ulid import new_ulid

logger = logging.getLogger(__name__)
SIDE_CHAT_TTL = 24 * 60 * 60


def side_chat_key(*, agent_id: str, user_id: int, thread_id: str) -> str:
    return f"{agent_id}:dashboard:{user_id}:sidechat:{thread_id}"


def require_live_thread(row: Any, *, now: int | None = None) -> None:
    if row is None:
        raise OctopError(ErrorCode.NOT_FOUND, "thread not found")
    expiry = getattr(row, "expires_at", None)
    if getattr(row, "gc_claimed_at", None) is not None or (
        expiry is not None and expiry <= (int(time.time()) if now is None else now)
    ):
        raise OctopError(ErrorCode.NOT_FOUND, "thread expired")


def require_side_chat_owner(row: Any, *, agent_id: str, user_id: int) -> None:
    if row is None or row.agent_id != agent_id:
        raise OctopError(ErrorCode.NOT_FOUND, "thread not found")
    if row.user_id != user_id:
        raise OctopError(ErrorCode.FORBIDDEN, "thread not owned by user")
    require_live_thread(row)


def _assert_idle(server: Any, row: ThreadRow) -> None:
    gateway = server.app_runtime.gateway
    store = gateway.processor.hitl_coordinator.store
    if gateway.ws_hub.is_turn_active(row.thread_id) or row.thread_id in store.pending_thread_ids(
        agent_id=row.agent_id, user_id=row.user_id, any_user=True
    ):
        raise OctopError(ErrorCode.THREAD_TURN_ACTIVE, "thread has an active or paused turn")


async def create_side_chat(
    server: Any, *, agent_id: str, source_thread_id: str, user_id: int
) -> ThreadRow:
    registry = server.app_runtime.gateway.thread_registry
    source = registry.get_thread(source_thread_id)
    require_side_chat_owner(source, agent_id=agent_id, user_id=user_id)
    _assert_idle(server, source)
    harness = server.app_runtime.agent_registry.get_agent(agent_id)
    # The runtime owns compaction and effective context; never copy private graph state.
    reader = getattr(harness, "aget_effective_messages", None)
    if not callable(reader):
        raise OctopError(ErrorCode.AGENT_NOT_RUNNING, "effective context snapshots unavailable")
    registry.snapshotting_threads.add(source_thread_id)
    try:
        messages = copy.deepcopy(await reader(source_thread_id))
        _assert_idle(server, source)
        require_live_thread(registry.get_thread(source_thread_id))
        thread_id = f"thr_{new_ulid()}"
        key = side_chat_key(agent_id=agent_id, user_id=user_id, thread_id=thread_id)
        now = int(time.time())
        server.services.thread_repo.insert(
            thread_id=thread_id,
            agent_id=agent_id,
            user_id=user_id,
            channel_type=ThreadRegistry.CHANNEL_DASHBOARD,
            session_key=key,
            title=source.title,
            last_active=now if messages else 0,
            side_chat=True,
            source_thread_id=source_thread_id,
            copied_messages=len(messages),
            expires_at=now + SIDE_CHAT_TTL,
        )
        try:
            if messages:
                await harness.aappend_messages(thread_id, messages)
                server.services.thread_message_repo.append_if_ready(
                    thread_id, message_inputs(messages)
                )
            registry.update_composer(
                thread_id,
                model_ref=source.model_ref,
                reasoning_mode=source.reasoning_mode,
                reasoning_effort=source.reasoning_effort,
                conversation_mode=source.conversation_mode,
                hitl_policy=source.hitl_policy,
            )
            await registry.rebind(
                session_key=key, thread_id=thread_id, agent_id=agent_id, acting_user_id=user_id
            )
        except Exception:
            # Preserve metadata if checkpoint cleanup itself fails, for the TTL retry.
            await server.app_runtime.agent_registry.delete_thread_checkpoint(
                agent_id, thread_id, reclaim=False
            )
            registry.delete_thread(thread_id)
            raise
        row = registry.get_thread(thread_id)
        assert row is not None
        return cast(ThreadRow, row)
    finally:
        registry.snapshotting_threads.discard(source_thread_id)


def persist_side_chat(
    server: Any, *, agent_id: str, thread_id: str, user_id: int, locale: str = "en"
) -> ThreadRow:
    registry = server.app_runtime.gateway.thread_registry
    row = registry.get_thread(thread_id)
    require_side_chat_owner(row, agent_id=agent_id, user_id=user_id)
    _assert_idle(server, row)
    title = (row.title or "").strip()
    suffix = tr("threads.side_chat_title_suffix", locale)
    if not title:
        title = tr("threads.side_chat_default_title", locale)
    elif not title.endswith(suffix):
        title = clip_thread_title(title, max_len=40 - len(suffix)) + suffix
    if not row.side_chat or not server.services.thread_repo.persist_side_chat(
        thread_id, now=int(time.time()), title=title
    ):
        raise OctopError(ErrorCode.NOT_FOUND, "side chat unavailable")
    saved = registry.get_thread(thread_id)
    assert saved is not None
    return cast(ThreadRow, saved)


def clear_side_chat_pauses(server: Any, row: ThreadRow) -> None:
    """Invalidate late approval replies only after checkpoint deletion succeeds."""
    coordinator = server.app_runtime.gateway.processor.hitl_coordinator
    coordinator.expire_pending_for_thread(row.thread_id, agent_id=row.agent_id)
    coordinator.session_policies.forget(row.thread_id)


async def discard_temporary_side_chat(server: Any, row: ThreadRow, *, reclaim: bool) -> bool:
    """Delete the checkpoint only after winning the claim against persist."""
    if not row.side_chat or row.expires_at is None:
        return False
    runtime = server.app_runtime
    if runtime.gateway.ws_hub.is_turn_active(row.thread_id):
        raise OctopError(ErrorCode.THREAD_TURN_ACTIVE, "thread has an active turn")
    repo = server.services.thread_repo
    claimed_at = int(time.time())
    if not repo.claim_temporary_side_chat(row.thread_id, now=claimed_at):
        return False
    try:
        await runtime.agent_registry.delete_thread_checkpoint(
            row.agent_id, row.thread_id, reclaim=reclaim
        )
    except Exception:
        repo.release_side_chat_claim(row.thread_id, claimed_at=claimed_at)
        raise
    return True


async def sweep_expired_side_chats(server: Any) -> None:
    now = int(time.time())
    repo = server.services.thread_repo
    runtime = server.app_runtime
    for row in repo.expired_side_chats(now=now):
        if runtime.gateway.ws_hub.is_turn_active(row.thread_id):
            runtime.agent_registry.cancel_stream(row.agent_id, row.thread_id)
            continue
        if not repo.claim_expired_side_chat(row.thread_id, now=now):
            continue
        try:
            await runtime.agent_registry.delete_thread_checkpoint(
                row.agent_id, row.thread_id, reclaim=False
            )
            clear_side_chat_pauses(server, row)
            runtime.gateway.thread_registry.delete_thread(row.thread_id)
            trajectory = getattr(runtime, "trajectory_service", None)
            if trajectory is not None:
                trajectory.delete_for_thread(row.thread_id)
        except Exception:
            repo.release_side_chat_claim(row.thread_id, claimed_at=now)
            logger.exception("side chat cleanup failed thread=%s", row.thread_id)


async def side_chat_maintenance(server: Any) -> None:
    while True:
        try:
            await sweep_expired_side_chats(server)
        except Exception:
            logger.exception("side chat maintenance failed")
        await asyncio.sleep(60)
