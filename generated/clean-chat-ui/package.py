"""Build a single-root, dependency-free plugin ZIP from an explicit allowlist."""
import hashlib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
plugin = root / "clean-chat-ui"
archive = root / "clean-chat-ui-0.1.1.zip"
files = ["plugin.yaml", "main.py", "README.md", "ui/dist/index.js", "ui/dist/manifest.json"]
with ZipFile(archive, "w", compression=ZIP_DEFLATED) as package:
    for file in files:
        package.write(plugin / file, "clean-chat-ui/" + file)
with ZipFile(archive) as package:
    assert package.testzip() is None
    assert set(package.namelist()) == {"clean-chat-ui/" + file for file in files}
    for file in files:
        assert package.read("clean-chat-ui/" + file) == (plugin / file).read_bytes()
print("ZIP verified:", archive.name, archive.stat().st_size, "bytes;", len(files), "files; one root")
print("SHA256:", hashlib.sha256(archive.read_bytes()).hexdigest())
