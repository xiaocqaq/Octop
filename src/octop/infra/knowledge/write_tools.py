"""Agent tools for listing and mutating knowledge bases through KnowledgeService."""

from __future__ import annotations

import asyncio
import json
import mimetypes
from collections.abc import Awaitable, Callable
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Annotated, Any, Literal

from langchain_core.tools import StructuredTool
from langgraph.config import get_config
from langgraph.errors import GraphBubbleUp
from octop_harness.backends.workspace import is_system_logical_entry
from pydantic import Field

from octop.i18n import tr
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.knowledge import approval, jobs
from octop.infra.knowledge.gate import assert_knowledge_usable
from octop.infra.knowledge.service import KnowledgeService
from octop.infra.knowledge.tools import _tool_ctx

if TYPE_CHECKING:
    from octop_harness.backends.workspace import BackendWorkspace

    from octop.infra.db.repos.knowledge import KnowledgeBaseRow, KnowledgeDocumentRow


def _json(result: dict[str, Any]) -> str:
    return json.dumps(result, ensure_ascii=False)


def _error(code: ErrorCode, locale: str) -> str:
    return _json(OctopError.localized(code, locale).to_envelope(locale=locale))


def _base_summary(base: KnowledgeBaseRow, actor_user_id: int, is_admin: bool) -> dict[str, Any]:
    return {
        "id": base.id,
        "kb_id": base.id,
        "name": base.name,
        "description": base.description,
        "shared": base.shared,
        "writable": is_admin or base.owner_user_id == actor_user_id,
    }


def _document_summary(document: KnowledgeDocumentRow) -> dict[str, Any]:
    return {
        "id": document.id,
        "kb_id": document.kb_id,
        "path": document.path,
        "filename": document.filename,
        "status": document.status,
        "content_type": document.content_type,
        "is_dir": document.is_dir,
    }


def _workspace_relative_path(value: str) -> PurePosixPath:
    raw = value.strip().replace("\\", "/")
    path = PurePosixPath(raw)
    if (
        not path.parts
        or path.is_absolute()
        or raw.endswith("/")
        or raw.startswith("~")
        or any(part == ".." or ":" in part or "\x00" in part for part in path.parts)
    ):
        raise PermissionError("expected a workspace-relative file path")
    return path


def _check_public_path(path: PurePosixPath, system_files_path: str = "") -> None:
    # Windows canonicalizes case and strips trailing spaces/dots in path segments.
    parts = tuple(part.rstrip(" .").casefold() for part in path.parts)
    prefix = tuple(part.casefold() for part in PurePosixPath(system_files_path).parts)
    if (
        any(part in {"", ".octop", ".octop-auth"} for part in parts)
        or is_system_logical_entry(parts[0])
        or (prefix and parts[: len(prefix)] == prefix)
    ):
        raise PermissionError("workspace system files cannot be uploaded")


def _download_workspace_document(
    workspace: BackendWorkspace, path: PurePosixPath, limit: int
) -> bytes:
    _check_public_path(path, workspace.system_files_path)
    source = path.as_posix()
    # Resolve local symlinks and backend system aliases before opening a file.
    resolved = workspace.present_path(workspace.resolve_path(source))
    _check_public_path(_workspace_relative_path(resolved), workspace.system_files_path)
    for entry in workspace.list_dir(path.parent.as_posix()) or ():
        entry_path = entry.get("path") if isinstance(entry, dict) else getattr(entry, "path", None)
        if entry_path != source:
            continue
        size = entry.get("size") if isinstance(entry, dict) else getattr(entry, "size", None)
        if isinstance(size, int) and size > limit:
            raise OctopError.localized(ErrorCode.KNOWLEDGE_DOC_TOO_LARGE)
        break
    content = workspace.download_bytes(source)
    if content is None:
        raise FileNotFoundError("workspace document not found")
    if len(content) > limit:
        raise OctopError.localized(ErrorCode.KNOWLEDGE_DOC_TOO_LARGE)
    return content


def build_knowledge_write_tools(services: Any) -> list[StructuredTool]:
    """Build tools using the authenticated turn identity and shared knowledge service."""
    svc = KnowledgeService(services)

    def offload(
        operation: Callable[[int, bool], dict[str, Any]],
    ) -> Callable[[int, bool], Awaitable[dict[str, Any]]]:
        async def run(actor_user_id: int, is_admin: bool) -> dict[str, Any]:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, operation, actor_user_id, is_admin)

        return run

    async def execute(
        operation: Callable[[int, bool], Awaitable[dict[str, Any]]],
        *,
        write: tuple[str, dict[str, Any]] | None = None,
        index_document: bool = False,
    ) -> str:
        locale = "en"
        try:
            locale = str((get_config().get("configurable") or {}).get("locale") or "en")
            actor_user_id, is_admin, _, locale = _tool_ctx()
        except (TypeError, ValueError, RuntimeError):
            return _error(ErrorCode.KNOWLEDGE_FORBIDDEN, locale)

        try:
            if write and not approval.require_knowledge_write_approval(*write):
                return _json(
                    {"status": "rejected", "message": tr("knowledge_tools.write_rejected", locale)}
                )
            result = await operation(actor_user_id, is_admin)
            if index_document:
                jobs.enqueue_index_document(services, result["kb_id"], result["id"])
            return _json(result)
        except GraphBubbleUp:
            raise
        except OctopError as exc:
            return _json(exc.to_envelope(locale=locale))
        except PermissionError:
            return _error(ErrorCode.KNOWLEDGE_FORBIDDEN, locale)
        except (LookupError, FileNotFoundError):
            return _error(ErrorCode.KNOWLEDGE_NOT_FOUND, locale)
        except Exception as exc:
            if isinstance(exc, RuntimeError):
                if str(exc) == "knowledge feature is disabled":
                    return _error(ErrorCode.KNOWLEDGE_FEATURE_DISABLED, locale)
                if str(exc) == "knowledge embedding prerequisites are not satisfied":
                    return _error(ErrorCode.KNOWLEDGE_PREREQUISITES_FAILED, locale)
            return _json({"error": {"message": tr("knowledge_tools.operation_failed", locale)}})

    async def list_knowledge_bases() -> str:
        """List knowledge bases you can read, including their IDs and whether you can write to them."""

        def list_bases(actor_user_id: int, is_admin: bool) -> dict[str, Any]:
            return {
                "bases": [
                    _base_summary(base, actor_user_id, is_admin)
                    for base in svc.list_visible_bases(
                        actor_user_id=actor_user_id, is_admin=is_admin
                    )
                ]
            }

        return await execute(offload(list_bases))

    async def create_knowledge_base(
        name: Annotated[str, Field(min_length=1, max_length=80)],
        description: Annotated[str, Field(max_length=2000)] = "",
    ) -> str:
        """Create a private knowledge base for the current user after confirmation."""

        def create(actor_user_id: int, is_admin: bool) -> dict[str, Any]:
            if not name.strip():
                raise ValueError("empty knowledge base name")
            base = svc.create_base(
                owner_user_id=actor_user_id, name=name.strip(), description=description
            )
            return {**_base_summary(base, actor_user_id, is_admin), "status": "created"}

        return await execute(
            offload(create),
            write=("create_knowledge_base", {"name": name, "description": description}),
        )

    async def update_knowledge_base(
        kb_id: str,
        name: Annotated[str | None, Field(min_length=1, max_length=80)] = None,
        description: Annotated[str | None, Field(max_length=2000)] = None,
    ) -> str:
        """Update a knowledge base name or description after confirmation. Omit fields to keep them."""

        def update(actor_user_id: int, is_admin: bool) -> dict[str, Any]:
            if name is not None and not name.strip():
                raise ValueError("empty knowledge base name")
            assert_knowledge_usable(services.settings_repo.get, services.provider_repo)
            base = svc.update_base(
                kb_id,
                actor_user_id=actor_user_id,
                is_admin=is_admin,
                name=name.strip() if name is not None else None,
                description=description,
            )
            return {**_base_summary(base, actor_user_id, is_admin), "status": "updated"}

        return await execute(
            offload(update),
            write=(
                "update_knowledge_base",
                {"kb_id": kb_id, "name": name, "description": description},
            ),
        )

    async def list_knowledge_documents(kb_id: str) -> str:
        """List document IDs, paths, and indexing status in a readable knowledge base."""

        def list_documents(actor_user_id: int, is_admin: bool) -> dict[str, Any]:
            documents = svc.list_documents(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
            return {"kb_id": kb_id, "documents": [_document_summary(doc) for doc in documents]}

        return await execute(offload(list_documents))

    async def create_knowledge_document(
        kb_id: str,
        name: Annotated[str, Field(min_length=1)],
        format: Literal["md", "txt"] = "md",
        content: str = "",
        path: Annotated[
            str | None, Field(description="Optional destination directory in the knowledge base.")
        ] = None,
    ) -> str:
        """Create a Markdown or plain-text knowledge document after confirmation and queue indexing."""

        def create(actor_user_id: int, is_admin: bool) -> dict[str, Any]:
            document = svc.create_text_document(
                kb_id,
                actor_user_id=actor_user_id,
                is_admin=is_admin,
                name=name,
                format=format,
                content=content,
                path=path,
            )
            return _document_summary(document)

        return await execute(
            offload(create),
            write=(
                "create_knowledge_document",
                {"kb_id": kb_id, "name": name, "format": format, "content": content, "path": path},
            ),
            index_document=True,
        )

    async def upload_knowledge_document(
        kb_id: str,
        workspace_path: Annotated[str, Field(description="Workspace-relative source file path.")],
        path: Annotated[
            str | None, Field(description="Optional destination file path in the knowledge base.")
        ] = None,
    ) -> str:
        """Upload an Agent workspace file after confirmation and queue it for indexing."""

        async def upload(actor_user_id: int, is_admin: bool) -> dict[str, Any]:
            source = _workspace_relative_path(workspace_path)
            _check_public_path(source)

            def check_access() -> None:
                svc.get_writable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
                assert_knowledge_usable(services.settings_repo.get, services.provider_repo)

            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, check_access)
            workspace = await services.resolve_workspace()
            if workspace is None:
                raise FileNotFoundError("agent workspace not available")

            def ingest() -> dict[str, Any]:
                content = _download_workspace_document(workspace, source, svc._max_document_bytes())
                document = svc.upload_document(
                    kb_id,
                    actor_user_id=actor_user_id,
                    is_admin=is_admin,
                    filename=source.name,
                    content_type=mimetypes.guess_type(source.name)[0] or "application/octet-stream",
                    content=content,
                    path=path,
                )
                return _document_summary(document)

            return await loop.run_in_executor(None, ingest)

        return await execute(
            upload,
            write=(
                "upload_knowledge_document",
                {"kb_id": kb_id, "workspace_path": workspace_path, "path": path},
            ),
            index_document=True,
        )

    async def update_knowledge_document(kb_id: str, doc_id: str, content: str) -> str:
        """Replace the content of a Markdown or plain-text knowledge document and queue reindexing after confirmation."""

        def update(actor_user_id: int, is_admin: bool) -> dict[str, Any]:
            document = svc.update_text_document(
                kb_id,
                doc_id,
                actor_user_id=actor_user_id,
                is_admin=is_admin,
                content=content,
            )
            return _document_summary(document)

        return await execute(
            offload(update),
            write=(
                "update_knowledge_document",
                {"kb_id": kb_id, "doc_id": doc_id, "content": content},
            ),
            index_document=True,
        )

    return [
        StructuredTool.from_function(coroutine=tool)
        for tool in (
            list_knowledge_bases,
            list_knowledge_documents,
            create_knowledge_base,
            update_knowledge_base,
            create_knowledge_document,
            upload_knowledge_document,
            update_knowledge_document,
        )
    ]
