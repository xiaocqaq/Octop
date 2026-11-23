"""Frontend-only appearance prototype; no agent tools or hooks are registered."""

from octop_harness.plugins import PluginContext


def setup(ctx: PluginContext) -> None:
    """Keep enabled MCP / knowledge state and all agent behavior untouched."""
