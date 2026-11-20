"""Built-in knowledge tools backed by the real service and SQLite."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.config import var_child_runnable_config
from langgraph.graph import END, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from langgraph.types import Command
from octop_harness.backends.workspace import BackendWorkspace
from octop_harness.protocols.langgraph import LangGraphProtocol

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.knowledge import KnowledgeRepo
from octop.infra.db.repos.resource_group_grants import ResourceGroupGrantRepo
from octop.infra.db.repos.settings import SettingsRepo
from octop.infra.db.repos.user_group_members import UserGroupMemberRepo
from octop.infra.db.repos.user_groups import UserGroupRepo
from octop.infra.db.repos.users import UserRepo
from octop.infra.knowledge.service import KnowledgeService
from octop.infra.users.groups import RESOURCE_KNOWLEDGE_BASE
from octop.infra.utils.paths import PathLayout


@pytest.fixture
def services(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[SimpleNamespace]:
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path / ".octop"))
    paths = PathLayout.from_env()
    paths.ensure_root()
    db = SqlitePool(paths.db)
    run_migrations(db)
    users = UserRepo(db)
    settings = SettingsRepo(db)
    settings.set("knowledge_bases_enabled", "true")
    settings.set("knowledge_embedding_backend", "onnx")
    settings.set("knowledge_embedding_model", "test-model")
    monkeypatch.setattr(
        "octop.infra.knowledge.gate.embedding_prerequisites_ok_for_model", lambda _: True
    )
    try:
        yield SimpleNamespace(
            knowledge_repo=KnowledgeRepo(db),
            settings_repo=settings,
            provider_repo=None,
            repos=SimpleNamespace(
                user_group_repo=UserGroupRepo(db),
                user_group_member_repo=UserGroupMemberRepo(db),
                resource_group_grant_repo=ResourceGroupGrantRepo(db),
            ),
            owner=users.create(username="owner", password_hash="h", role="user"),
            reader=users.create(username="reader", password_hash="h", role="user"),
            admin=users.create(username="admin", password_hash="h", role="admin"),
        )
    finally:
        db.close()


@contextmanager
def _trusted(**configurable: object) -> Iterator[None]:
    token = var_child_runnable_config.set({"configurable": configurable})
    try:
        yield
    finally:
        var_child_runnable_config.reset(token)


def _tools(services: SimpleNamespace) -> dict[str, StructuredTool]:
    from octop.infra.knowledge.write_tools import build_knowledge_write_tools

    return {tool.name: tool for tool in build_knowledge_write_tools(services)}


async def _call(tool: StructuredTool, **args: object) -> dict[str, Any]:
    return json.loads(await tool.ainvoke(args))


@pytest.mark.asyncio
async def test_list_bases_discovers_only_visible_ids(services: SimpleNamespace) -> None:
    svc = KnowledgeService(services)
    private = svc.create_base(owner_user_id=services.owner, name="Private")
    shared = svc.create_base(owner_user_id=services.owner, name="Shared", shared=True)
    own = svc.create_base(owner_user_id=services.reader, name="Own")
    tool = _tools(services)["list_knowledge_bases"]
    with _trusted(user=services.reader, knowledge_base_ids=[private.id]):
        result = await _call(tool)
    assert {row["id"]: row["writable"] for row in result["bases"]} == {
        own.id: True,
        shared.id: False,
    }


@pytest.mark.asyncio
async def test_create_base_uses_trusted_user(
    services: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "octop.infra.knowledge.approval.require_knowledge_write_approval", lambda *_: True
    )
    tool = _tools(services)["create_knowledge_base"]
    with _trusted(user=services.owner, knowledge_base_ids=[]):
        created = await _call(tool, name="Notes", description="Private drafts")
    assert created["id"] == created["kb_id"]
    assert created["status"] == "created"
    base = services.knowledge_repo.get_base(created["id"])
    assert base.owner_user_id == services.owner
    assert base.description == "Private drafts"
    assert not base.shared


@pytest.mark.asyncio
async def test_shared_base_update_requires_owner_or_admin(
    services: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "octop.infra.knowledge.approval.require_knowledge_write_approval", lambda *_: True
    )
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Team", shared=True)
    tool = _tools(services)["update_knowledge_base"]
    with _trusted(user=services.reader, knowledge_base_ids=[base.id]):
        denied = await _call(tool, kb_id=base.id, name="Denied")
    assert denied["error"]["code"] == "KNOWLEDGE_FORBIDDEN"
    assert services.knowledge_repo.get_base(base.id).name == "Team"
    with _trusted(user=services.admin, user_is_admin=True):
        updated = await _call(tool, kb_id=base.id, name="Reviewed")
    assert updated["status"] == "updated"
    assert updated["id"] == updated["kb_id"] == base.id
    assert services.knowledge_repo.get_base(base.id).name == "Reviewed"


@pytest.mark.asyncio
async def test_no_trusted_user_cannot_request_approval(
    services: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unexpected_approval(*_args: object) -> bool:
        pytest.fail("approval requires a trusted actor")

    monkeypatch.setattr(
        "octop.infra.knowledge.approval.require_knowledge_write_approval", unexpected_approval
    )
    tool = _tools(services)["create_knowledge_base"]
    with _trusted(user_is_admin=True):
        result = await _call(tool, name="Unauthorized")
    assert result["error"]["code"] == "KNOWLEDGE_FORBIDDEN"
    assert services.knowledge_repo.list_all() == []


@pytest.mark.asyncio
async def test_rejecting_base_creation_leaves_database_untouched(
    services: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    def reject(name: str, args: dict[str, Any]) -> bool:
        assert name == "create_knowledge_base"
        assert args == {"name": "Rejected", "description": "Draft"}
        return False

    monkeypatch.setattr("octop.infra.knowledge.approval.require_knowledge_write_approval", reject)
    tool = _tools(services)["create_knowledge_base"]
    with _trusted(user=services.owner, locale="zh"):
        result = await _call(tool, name="Rejected", description="Draft")
    assert result["status"] == "rejected"
    assert services.knowledge_repo.list_all() == []


@pytest.mark.asyncio
async def test_base_update_checks_feature_before_writing(
    services: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "octop.infra.knowledge.approval.require_knowledge_write_approval", lambda *_: True
    )
    base = KnowledgeService(services).create_base(owner_user_id=services.owner, name="Original")
    services.settings_repo.set("knowledge_bases_enabled", "false")
    with _trusted(user=services.owner):
        result = await _call(_tools(services)["update_knowledge_base"], kb_id=base.id, name="New")
    assert result["error"]["code"] == "KNOWLEDGE_FEATURE_DISABLED"
    assert services.knowledge_repo.get_base(base.id).name == "Original"


@pytest.fixture
def approved(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "octop.infra.knowledge.approval.require_knowledge_write_approval", lambda *_: True
    )


@pytest.fixture
def index_queue(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    calls: list[tuple[str, str]] = []

    def enqueue(_services: object, kb_id: str, doc_id: str) -> None:
        calls.append((kb_id, doc_id))

    monkeypatch.setattr("octop.infra.knowledge.jobs.enqueue_index_document", enqueue)
    return calls


@pytest.mark.asyncio
async def test_create_and_update_document_each_queue_indexing(
    services: SimpleNamespace, approved: None, index_queue: list[tuple[str, str]]
) -> None:
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Notes")
    tools = _tools(services)
    with _trusted(user=services.owner):
        created = await _call(
            tools["create_knowledge_document"],
            kb_id=base.id,
            name="journal",
            path="daily",
            content="# 初稿",
        )
        assert created["kb_id"] == base.id
        assert created["path"] == "daily/journal.md"
        assert created["status"] == "pending"
        assert index_queue == [(base.id, created["id"])]
        updated = await _call(
            tools["update_knowledge_document"],
            kb_id=base.id,
            doc_id=created["id"],
            content="# 已修改",
        )
    assert updated["id"] == created["id"]
    assert updated["status"] == "pending"
    assert index_queue == [(base.id, created["id"])] * 2
    assert (
        svc.read_text_document(base.id, created["id"], actor_user_id=services.owner)["text"]
        == "# 已修改"
    )


@pytest.mark.asyncio
async def test_shared_document_discovery_does_not_give_write_access(
    services: SimpleNamespace, approved: None, index_queue: list[tuple[str, str]]
) -> None:
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Shared", shared=True)
    doc = svc.create_text_document(
        base.id, actor_user_id=services.owner, name="public", format="md", content="Original"
    )
    tools = _tools(services)
    with _trusted(user=services.reader):
        listed = await _call(tools["list_knowledge_documents"], kb_id=base.id)
        denied_create = await _call(
            tools["create_knowledge_document"], kb_id=base.id, name="Denied"
        )
        denied_update = await _call(
            tools["update_knowledge_document"], kb_id=base.id, doc_id=doc.id, content="Denied"
        )
    assert [row["id"] for row in listed["documents"]] == [doc.id]
    assert denied_create["error"]["code"] == "KNOWLEDGE_FORBIDDEN"
    assert denied_update["error"]["code"] == "KNOWLEDGE_FORBIDDEN"
    assert index_queue == []
    assert (
        svc.read_text_document(base.id, doc.id, actor_user_id=services.owner)["text"] == "Original"
    )


@pytest.mark.asyncio
async def test_document_update_rejects_mismatched_base(
    services: SimpleNamespace, approved: None, index_queue: list[tuple[str, str]]
) -> None:
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Source")
    wrong_base = svc.create_base(owner_user_id=services.owner, name="Other")
    doc = svc.create_text_document(
        base.id, actor_user_id=services.owner, name="notes", format="txt"
    )
    with _trusted(user=services.owner):
        result = await _call(
            _tools(services)["update_knowledge_document"],
            kb_id=wrong_base.id,
            doc_id=doc.id,
            content="Denied",
        )
    assert result["error"]["code"] == "KNOWLEDGE_NOT_FOUND"
    assert index_queue == []


class _VirtualBackend:
    sandbox_fs = True

    def __init__(self) -> None:
        self.content = b"source,value\r\nvirtual,57\r\n"
        self.size: int | None = None
        self.downloads: list[str] = []

    def ls(self, path: str) -> SimpleNamespace:
        assert path == "/incoming"
        return SimpleNamespace(entries=[{"path": "/incoming/data.csv", "size": self.size}])

    def download_files(self, paths: list[str]) -> list[SimpleNamespace]:
        self.downloads.extend(paths)
        return [SimpleNamespace(content=self.content) for _ in paths]


@pytest.fixture
def virtual_backend(services: SimpleNamespace, tmp_path: Path) -> _VirtualBackend:
    backend = _VirtualBackend()
    workspace = BackendWorkspace(
        cast(Any, backend), tmp_path / "virtual", system_files_path=".octop"
    )

    async def resolve_workspace() -> BackendWorkspace:
        return workspace

    services.resolve_workspace = resolve_workspace
    return backend


@pytest.mark.asyncio
async def test_upload_virtual_workspace_preserves_bytes(
    services: SimpleNamespace,
    approved: None,
    index_queue: list[tuple[str, str]],
    virtual_backend: _VirtualBackend,
) -> None:
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Imports")
    with _trusted(user=services.owner):
        result = await _call(
            _tools(services)["upload_knowledge_document"],
            kb_id=base.id,
            workspace_path="incoming/data.csv",
            path="records/import.csv",
        )
    assert result["path"] == "records/import.csv"
    assert result["content_type"] == "text/csv"
    assert result["status"] == "pending"
    assert virtual_backend.downloads == ["/incoming/data.csv"]
    assert index_queue == [(base.id, result["id"])]
    from octop.infra.knowledge.files import document_path

    assert (
        document_path(base.id, result["id"], "import.csv").read_bytes() == virtual_backend.content
    )


@pytest.mark.parametrize(
    "path",
    [
        "../outside.csv",
        "/absolute.csv",
        "~/.secret.csv",
        r"C:\outside.csv",
        ".octop/auth/token.txt",
        ".octop-auth/token.txt",
        "agents/internal.md",
    ],
)
@pytest.mark.asyncio
async def test_upload_rejects_nonpublic_workspace_paths_before_download(
    services: SimpleNamespace,
    approved: None,
    index_queue: list[tuple[str, str]],
    virtual_backend: _VirtualBackend,
    path: str,
) -> None:
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Imports")
    with _trusted(user=services.owner):
        result = await _call(
            _tools(services)["upload_knowledge_document"], kb_id=base.id, workspace_path=path
        )
    assert result["error"]["code"] == "KNOWLEDGE_FORBIDDEN"
    assert virtual_backend.downloads == []
    assert index_queue == []
    assert services.knowledge_repo.list_documents(base.id) == []


@pytest.mark.parametrize("reported_size,downloaded", [(100, False), (1, True), (None, True)])
@pytest.mark.asyncio
async def test_upload_checks_available_metadata_then_actual_size(
    services: SimpleNamespace,
    approved: None,
    index_queue: list[tuple[str, str]],
    virtual_backend: _VirtualBackend,
    reported_size: int | None,
    downloaded: bool,
) -> None:
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Imports")
    services.config = SimpleNamespace(max_upload_bytes=8)
    virtual_backend.size = reported_size
    with _trusted(user=services.owner):
        result = await _call(
            _tools(services)["upload_knowledge_document"],
            kb_id=base.id,
            workspace_path="incoming/data.csv",
        )
    assert result["error"]["code"] == "KNOWLEDGE_DOC_TOO_LARGE"
    assert bool(virtual_backend.downloads) == downloaded
    assert index_queue == []
    assert services.knowledge_repo.list_documents(base.id) == []


@pytest.mark.asyncio
async def test_group_restricted_knowledge_is_hidden_from_discovery(
    services: SimpleNamespace,
) -> None:
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Restricted", shared=True)
    group = services.repos.user_group_repo.create(name="Research", description=None)
    services.repos.resource_group_grant_repo.replace(
        RESOURCE_KNOWLEDGE_BASE, base.id, [group.user_group_id]
    )
    tools = _tools(services)
    with _trusted(user=services.reader, knowledge_base_ids=[base.id]):
        assert (await _call(tools["list_knowledge_bases"]))["bases"] == []
        assert (await _call(tools["list_knowledge_documents"], kb_id=base.id))["error"][
            "code"
        ] == "KNOWLEDGE_FORBIDDEN"
    services.repos.user_group_member_repo.add(group.user_group_id, services.reader)
    with _trusted(user=services.reader):
        assert [row["id"] for row in (await _call(tools["list_knowledge_bases"]))["bases"]] == [
            base.id
        ]


def test_tool_schemas_expose_no_authentication_or_approval_parameters(
    services: SimpleNamespace,
) -> None:
    tools = _tools(services)
    assert set(tools) == {
        "list_knowledge_bases",
        "list_knowledge_documents",
        "create_knowledge_base",
        "update_knowledge_base",
        "create_knowledge_document",
        "upload_knowledge_document",
        "update_knowledge_document",
    }
    for tool in tools.values():
        assert tool.args.keys().isdisjoint(
            {
                "user",
                "user_id",
                "owner_user_id",
                "actor_user_id",
                "is_admin",
                "user_is_admin",
                "approved",
                "agent_id",
            }
        )


@pytest.mark.asyncio
async def test_graph_interrupt_gates_document_persistence(
    services: SimpleNamespace,
    index_queue: list[tuple[str, str]],
) -> None:
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Approval")
    tool = _tools(services)["create_knowledge_document"]
    builder = StateGraph(MessagesState)
    builder.add_node("tools", ToolNode([tool]))
    builder.set_entry_point("tools")
    builder.add_edge("tools", END)
    graph = builder.compile(checkpointer=InMemorySaver())
    config: Any = {"configurable": {"thread_id": "knowledge", "user": services.owner}}

    for decision in ("reject", "approve"):
        args = {"kb_id": base.id, "name": decision, "content": "Approved text"}
        request = AIMessage(
            content="", tool_calls=[{"id": decision, "name": tool.name, "args": args}]
        )
        paused = await graph.ainvoke({"messages": [request]}, config)
        assert paused["__interrupt__"][0].value["action_requests"][0]["name"] == tool.name
        assert services.knowledge_repo.list_documents(base.id) == []
        assert index_queue == []
        output = await graph.ainvoke(Command(resume={"decisions": [{"type": decision}]}), config)
        assert "__interrupt__" not in output
        result = json.loads(output["messages"][-1].content)
        if decision == "reject":
            assert result["status"] == "rejected"
            assert services.knowledge_repo.list_documents(base.id) == []
            assert index_queue == []
        else:
            assert result["status"] == "pending"
            assert [doc.id for doc in services.knowledge_repo.list_documents(base.id)] == [
                result["id"]
            ]
            assert index_queue == [(base.id, result["id"])]


@pytest.mark.asyncio
async def test_upload_checks_write_access_before_resolving_workspace(
    services: SimpleNamespace,
    approved: None,
    index_queue: list[tuple[str, str]],
) -> None:
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Shared", shared=True)

    async def forbidden_resolution() -> None:
        pytest.fail("a read-only user must not resolve the workspace for upload")

    services.resolve_workspace = forbidden_resolution
    with _trusted(user=services.reader):
        result = await _call(
            _tools(services)["upload_knowledge_document"],
            kb_id=base.id,
            workspace_path="incoming/data.csv",
        )
    assert result["error"]["code"] == "KNOWLEDGE_FORBIDDEN"
    assert index_queue == []


class _ToolCallingModel(FakeMessagesListChatModel):
    def bind_tools(self, *args: Any, **kwargs: Any) -> _ToolCallingModel:
        return self


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "decisions",
    [("approve", "reject"), ("reject", "approve"), ("approve", "approve"), ("reject", "reject")],
)
@pytest.mark.parametrize("second_forbidden", [False, True])
async def test_create_agent_parallel_knowledge_approvals(
    services: SimpleNamespace,
    index_queue: list[tuple[str, str]],
    monkeypatch: pytest.MonkeyPatch,
    decisions: tuple[str, str],
    second_forbidden: bool,
) -> None:
    from octop.infra.gateway.hitl import stream_compat

    # Exercise the projection compatibility wrapper installed by the gateway too.
    monkeypatch.setattr(LangGraphProtocol, "_project_chunk", LangGraphProtocol._project_chunk)
    monkeypatch.setattr(stream_compat, "_INSTALLED", stream_compat._INSTALLED)
    stream_compat.install_harness_hitl_compat()
    svc = KnowledgeService(services)
    base = svc.create_base(owner_user_id=services.owner, name="Parallel")
    other = svc.create_base(owner_user_id=services.reader, name="Other", shared=True)
    tool = _tools(services)["create_knowledge_document"]
    targets = (base.id, other.id if second_forbidden else base.id)
    request = AIMessage(
        content="",
        tool_calls=[
            {"id": name, "name": tool.name, "args": {"kb_id": kb_id, "name": name, "content": name}}
            for name, kb_id in zip(("one", "two"), targets, strict=True)
        ],
    )
    graph = create_agent(
        _ToolCallingModel(responses=[request, AIMessage(content="done")]),
        tools=[tool],
        checkpointer=InMemorySaver(),
    )
    config: Any = {"configurable": {"thread_id": "parallel-knowledge", "user": services.owner}}
    events = [
        event
        async for event in LangGraphProtocol(graph=graph).stream(
            [HumanMessage(content="write")], config
        )
    ]
    state = await graph.aget_state(config)
    assert len(state.interrupts) == 2
    assert len({item.id for item in state.interrupts}) == 2
    assert len(state.tasks) == 2
    assert all(task.name == "tools" and task.path[0] == "__pregel_push" for task in state.tasks)
    assert services.knowledge_repo.list_documents(base.id) == []
    assert services.knowledge_repo.list_documents(other.id) == []
    assert index_queue == []
    reviews = [event["request"] for event in events if event["type"] == "hitl_required"]
    assert len(reviews) == 1
    assert [action["args"]["name"] for action in reviews[0]["action_requests"]] == ["one", "two"]
    assert len(reviews[0]["review_configs"]) == 2

    # Resume through a fresh protocol, just as a later HTTP/IM request does.
    _ = [
        event
        async for event in LangGraphProtocol(graph=graph).resume_stream(
            "parallel-knowledge", [{"type": decision} for decision in decisions], config
        )
    ]
    state = await graph.aget_state(config)
    assert not state.interrupts
    results = {
        message.tool_call_id: json.loads(message.content)
        for message in state.values["messages"]
        if isinstance(message, ToolMessage)
    }
    expected_ids = []
    for index, name in enumerate(("one", "two")):
        if decisions[index] == "reject":
            assert results[name]["status"] == "rejected"
        elif index == 1 and second_forbidden:
            assert results[name]["error"]["code"] == "KNOWLEDGE_FORBIDDEN"
        else:
            assert results[name]["status"] == "pending"
            expected_ids.append(results[name]["id"])
    assert {document.id for document in services.knowledge_repo.list_documents(base.id)} == set(
        expected_ids
    )
    assert services.knowledge_repo.list_documents(other.id) == []
    assert set(index_queue) == {(base.id, document_id) for document_id in expected_ids}
