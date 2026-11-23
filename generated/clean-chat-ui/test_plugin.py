import shutil
from pathlib import Path

from octop_harness.plugins import PluginRegistry, load_plugin_dir


def test_frontend_only_plugin_loads_without_agent_registrations(tmp_path):
    source = Path(__file__).parent / "clean-chat-ui"
    copied = tmp_path / "plugins" / "clean-chat-ui"
    shutil.copytree(source, copied)
    registry = PluginRegistry()
    registry.clear()
    try:
        loaded = load_plugin_dir(copied, install_deps=False)
        assert loaded.manifest.id == "clean-chat-ui"
        assert loaded.manifest.kind == "tool"
        assert loaded.tools == []
        assert loaded.middleware == []
        assert loaded.channels == []
        assert loaded.skills_dir is None
        assert (copied / "ui/dist/index.js").is_file()
        assert (copied / "ui/dist/manifest.json").is_file()
    finally:
        registry.clear()
