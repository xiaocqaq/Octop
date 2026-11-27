"""Repack the pinned PyPI 1.0.13 wheel using a patched 1.0.13 source tree.

Standard library only; no build backend, dependency install, or tests are run.
Usage: python3 vendor/repack_harness.py UPSTREAM_WHEEL PATCHED_SOURCE OUTPUT_WHEEL
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import sys
import tomllib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

UPSTREAM_SHA256 = "96d55c25e77e6ff25755d611021ff600c2a53f50a8e5ebe9c9eb3453c36501f9"
VERSION = "1.0.13+mxiao.1"
OLD_INFO = "octop_harness-1.0.13.dist-info/"
NEW_INFO = f"octop_harness-{VERSION}.dist-info/"


def repack(upstream: Path, source: Path, output: Path) -> None:
    """Preserve upstream payload/metadata, overlay patched source, renew RECORD."""
    if hashlib.sha256(upstream.read_bytes()).hexdigest() != UPSTREAM_SHA256:
        raise ValueError("Expected the unmodified PyPI octop-harness 1.0.13 wheel")
    if tomllib.loads((source / "pyproject.toml").read_text())["project"]["version"] != VERSION:
        raise ValueError(f"Patched source must declare version {VERSION}")
    if output.resolve() == upstream.resolve():
        raise ValueError("Output must not overwrite the upstream wheel")
    if output.name != f"octop_harness-{VERSION}-py3-none-any.whl":
        raise ValueError("Output filename must match the custom wheel version and tag")

    with ZipFile(upstream) as archive:
        payload = {
            name.replace(OLD_INFO, NEW_INFO, 1): archive.read(name)
            for name in archive.namelist()
            if not name.endswith("/RECORD")
        }
    for path in sorted((source / "src" / "octop_harness").rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            payload[path.relative_to(source / "src").as_posix()] = path.read_bytes()
    metadata_name = NEW_INFO + "METADATA"
    headers, _ = payload[metadata_name].split(b"\n\n", 1)
    old_version = b"\nVersion: 1.0.13\n"
    if old_version not in headers:
        raise ValueError("Unexpected upstream METADATA Version header")
    headers = headers.replace(old_version, f"\nVersion: {VERSION}\n".encode(), 1)
    payload[metadata_name] = headers + b"\n\n" + (source / "README.md").read_bytes()

    record = io.StringIO(newline="")
    writer = csv.writer(record, lineterminator="\n")
    for name, data in sorted(payload.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        writer.writerow([name, "sha256=" + digest, len(data)])
    record_name = NEW_INFO + "RECORD"
    writer.writerow([record_name, "", ""])
    payload[record_name] = record.getvalue().encode()

    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(payload.items()):
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compresslevel=9)
    print(f"{hashlib.sha256(output.read_bytes()).hexdigest()}  {output}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    repack(*(Path(value) for value in sys.argv[1:]))
