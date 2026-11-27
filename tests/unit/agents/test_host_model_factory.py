"""Host-level harness factory used by one-shot text calls."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage, BaseMessage
from langchain_openai import ChatOpenAI
from octop_harness.config import ModelConfig, ProviderConfig
from octop_harness.llm.factory import ChatModelFactory

from octop.config import OctopConfig
from octop.infra.agents.manager import AgentManager
from octop.infra.agents.providers.host_factory import HostModelFactory
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import build_shared_services
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.text_assist import run_text_assist
from octop.infra.utils.paths import PathLayout


def _provider(provider_id: str, *model_ids: str, disabled: str = "") -> ProviderConfig:
    return ProviderConfig(
        id=provider_id,
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        name=provider_id,
        models=[ModelConfig(id=model_id, enabled=model_id != disabled) for model_id in model_ids],
    )


def test_auto_uses_first_enabled_model(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    def fake_get_chat_model(
        self: ChatModelFactory, model_ref: str, *, max_retries: int | None = None
    ) -> MagicMock:
        del self, max_retries
        captured["ref"] = model_ref
        return MagicMock()

    monkeypatch.setattr(ChatModelFactory, "get_chat_model", fake_get_chat_model)
    host = HostModelFactory()
    host.sync(
        [
            _provider("first", "off", "on", disabled="off"),
            _provider("second", "other"),
        ]
    )

    access = host.get(None)

    assert captured["ref"] == "first/on"
    assert access.model_ref == "first/on"
    host.close()


def test_explicit_ref_is_forwarded(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    def fake_get_chat_model(
        self: ChatModelFactory, model_ref: str, *, max_retries: int | None = None
    ) -> MagicMock:
        del self, max_retries
        captured["ref"] = model_ref
        return MagicMock()

    monkeypatch.setattr(ChatModelFactory, "get_chat_model", fake_get_chat_model)
    host = HostModelFactory()
    host.sync([_provider("openai", "gpt-4o-mini", "gpt-4o")])

    access = host.get("openai/gpt-4o")

    assert captured["ref"] == "openai/gpt-4o"
    assert access.model_ref == "openai/gpt-4o"
    host.close()


def test_auto_alias_and_missing_factory() -> None:
    host = HostModelFactory()
    with pytest.raises(OctopError) as exc:
        host.get("auto")
    assert exc.value.code == ErrorCode.INTERNAL_ERROR
    assert exc.value.message == "model factory unavailable"


def test_unknown_ref_is_rejected() -> None:
    host = HostModelFactory()
    host.sync([_provider("openai", "gpt-4o")])
    with pytest.raises(OctopError) as exc:
        host.get("other/model")
    assert exc.value.message == "model unavailable for text assist"
    host.close()


@pytest.mark.asyncio
async def test_text_assist_uses_reasoning_of_the_routed_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = PathLayout(tmp_path / ".octop")
    paths.ensure_root()
    db = SqlitePool(paths.db)
    run_migrations(db)
    services = build_shared_services(db=db, paths=paths, config=OctopConfig())
    manager = AgentManager(repos=services.repos, paths=services.paths)
    services.repos.provider_repo.create(
        name="host-provider",
        kind="openai",
        base_url="https://api.example.com/v1",
        api_key="sk-test",
        models_json=json.dumps(
            [
                {
                    "id": "requires-reasoning",
                    "reasoning_config": {
                        "adapter": "openai_reasoning_effort",
                        "toggle": False,
                        "efforts": ["low", "medium"],
                        "default_effort": "medium",
                    },
                },
                {"id": "plain-chat"},
            ]
        ),
    )
    host = manager.host_models
    host.sync(manager.providers.build_harness_configs())
    requests: list[dict[str, Any]] = []

    async def capture_request(
        self: ChatOpenAI, messages: list[BaseMessage], config: Any = None, **kwargs: Any
    ) -> AIMessage:
        del config
        requests.append(self._get_request_payload(messages, **kwargs))
        return AIMessage(content="Short title")

    monkeypatch.setattr(ChatOpenAI, "ainvoke", capture_request)
    try:
        title = await run_text_assist(models=host, kind="chat.thread_title", text="A conversation")
        assert title == "Short title"
        assert (
            await run_text_assist(
                models=host,
                kind="chat.prompt",
                text="A prompt",
                default_model="host-provider/plain-chat",
            )
            == "Short title"
        )
    finally:
        host.close()
        db.close()

    assert [request["model"] for request in requests] == ["requires-reasoning", "plain-chat"]
    assert requests[0].get("reasoning_effort") == "medium"
    assert "reasoning_effort" not in requests[1]


def test_sync_drop_closes_factory(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ChatModelFactory, "get_chat_model", lambda *args, **kwargs: MagicMock())
    host = HostModelFactory()
    host.sync([_provider("openai", "gpt-4o")])
    host.sync([])
    with pytest.raises(OctopError) as exc:
        host.get("auto")
    assert exc.value.code == ErrorCode.INTERNAL_ERROR
