"""Unit tests for inbound attachment storage."""

from __future__ import annotations

import asyncio
import re
import tempfile
from pathlib import Path

import pytest
from deepagents.backends.local_shell import LocalShellBackend
from octop_harness.backends.workspace import BackendWorkspace

from octop.infra.gateway.media.inbound_store import (
    build_timestamped_inbound_name,
    display_name_from_stored,
    inbound_extension,
    read_inbound_bytes,
    sanitize_inbound_filename,
    write_inbound,
)


def _workspace(root: str) -> BackendWorkspace:
    backend = LocalShellBackend(root_dir=root, virtual_mode=False)
    return BackendWorkspace(backend, root)


def test_inbound_extension_from_filename() -> None:
    assert inbound_extension("report.pdf", "application/pdf") == ".pdf"


def test_sanitize_inbound_filename_keeps_cjk() -> None:
    assert sanitize_inbound_filename("我的报告.pdf") == "我的报告.pdf"
    assert sanitize_inbound_filename(r"C:\Users\me\地球介绍.pptx") == "地球介绍.pptx"
    assert sanitize_inbound_filename('say "hi".txt') == "say _hi_.txt"
    assert sanitize_inbound_filename("../evil.pdf") == "evil.pdf"


def test_timestamped_name_and_display_roundtrip() -> None:
    stored = build_timestamped_inbound_name("地球介绍.pptx", now=1783510288)
    assert stored == "1783510288_地球介绍.pptx"
    assert display_name_from_stored(stored) == "地球介绍.pptx"
    assert (
        display_name_from_stored("1783510288_uuid-0123456789abcdef0123456789abcdef_地球介绍.pptx")
        == "地球介绍.pptx"
    )
    assert display_name_from_stored("1783510288_地球介绍-2.pptx") == "地球介绍-2.pptx"


@pytest.mark.asyncio
async def test_write_inbound_uses_timestamp_prefix_keeps_chinese() -> None:
    with tempfile.TemporaryDirectory() as ws_dir:
        workspace = _workspace(ws_dir)
        stored = await write_inbound(
            workspace,
            b"%PDF-1.4",
            filename="地球介绍.pdf",
            media_type="application/pdf",
        )
        assert stored.filename == "地球介绍.pdf"
        assert re.fullmatch(r"inbound/\d{10,}_uuid-[0-9a-f]{32}_地球介绍\.pdf", stored.path)
        on_disk = await read_inbound_bytes(workspace, stored.path)
        assert on_disk == b"%PDF-1.4"


@pytest.mark.asyncio
async def test_write_inbound_preserves_long_cjk_filename(tmp_path: Path) -> None:
    workspace = _workspace(str(tmp_path))
    filename = "报" * 75 + ".pdf"
    stored = await write_inbound(
        workspace, b"%PDF-1.4", filename=filename, media_type="application/pdf"
    )

    assert stored.filename == filename
    assert display_name_from_stored(Path(stored.path).name) == filename
    assert await read_inbound_bytes(workspace, stored.path) == b"%PDF-1.4"


@pytest.mark.asyncio
async def test_write_inbound_same_name_uses_distinct_paths() -> None:
    with tempfile.TemporaryDirectory() as ws_dir:
        workspace = _workspace(ws_dir)
        first = await write_inbound(
            workspace,
            b"first",
            filename="note.txt",
            media_type="text/plain",
        )
        second = await write_inbound(
            workspace,
            b"second",
            filename="note.txt",
            media_type="text/plain",
        )

        assert first.path.startswith("inbound/")
        assert second.path.startswith("inbound/")
        assert first.path != second.path
        assert await read_inbound_bytes(workspace, first.path) == b"first"
        assert await read_inbound_bytes(workspace, second.path) == b"second"


@pytest.mark.asyncio
async def test_concurrent_same_second_uploads_preserve_every_payload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("octop.infra.gateway.media.inbound_store.time.time", lambda: 1783510288)
    workspace = _workspace(str(tmp_path))
    payloads = [f"attachment-{index}".encode() for index in range(8)]
    ready = asyncio.Barrier(len(payloads))
    upload_bytes = workspace.aupload_bytes

    async def upload_together(path: str, data: bytes) -> None:
        # Hold writes until every caller has selected its destination.
        await asyncio.wait_for(ready.wait(), timeout=10)
        await upload_bytes(path, data)

    monkeypatch.setattr(workspace, "aupload_bytes", upload_together)
    stored = await asyncio.gather(
        *(
            write_inbound(workspace, payload, filename="同名报告.pdf", media_type="application/pdf")
            for payload in payloads
        )
    )

    assert len({item.path for item in stored}) == len(payloads)
    for item, payload in zip(stored, payloads, strict=True):
        assert await read_inbound_bytes(workspace, item.path) == payload
        assert item.filename == "同名报告.pdf"
        assert Path(item.path).suffix == ".pdf"
        assert display_name_from_stored(Path(item.path).name) == item.filename


@pytest.mark.asyncio
async def test_write_inbound_no_meta_sidecar() -> None:
    with tempfile.TemporaryDirectory() as ws_dir:
        workspace = _workspace(ws_dir)
        stored = await write_inbound(
            workspace,
            b"%PDF-1.4",
            filename="report.pdf",
            media_type="application/pdf",
        )
        assert stored.path.endswith(".pdf")
        assert stored.path.startswith("inbound/")
        on_disk = await read_inbound_bytes(workspace, stored.path)
        assert on_disk == b"%PDF-1.4"


@pytest.mark.asyncio
async def test_write_inbound_flat_docx_path() -> None:
    with tempfile.TemporaryDirectory() as ws_dir:
        workspace = _workspace(ws_dir)
        stored = await write_inbound(
            workspace,
            b"PK-docx",
            filename="report.docx",
            media_type=("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        )
        assert stored.path.endswith(".docx")
        assert stored.filename == "report.docx"
