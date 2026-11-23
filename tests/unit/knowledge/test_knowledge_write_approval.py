"""Knowledge-write approval only advertises and accepts supported decisions."""

from typing import Any

import pytest

from octop.infra.knowledge import approval


@pytest.mark.parametrize(
    ("configured", "decision", "advertised", "accepted"),
    [
        (["approve", "reject"], "approve", ["approve", "reject"], True),
        (["approve", "reject"], "reject", ["approve", "reject"], False),
        (["reject"], "approve", ["reject"], False),
        (["edit", "approve", "respond"], "approve", ["approve"], True),
        (["edit", "approve", "respond"], "edit", ["approve"], False),
        (["edit", "respond"], "approve", [], False),
    ],
)
def test_decisions_respect_supported_policy_subset(
    monkeypatch: pytest.MonkeyPatch,
    configured: list[str],
    decision: str,
    advertised: list[str],
    accepted: bool,
) -> None:
    requests: list[dict[str, Any]] = []

    def resume(request: dict[str, Any]) -> dict[str, Any]:
        requests.append(request)
        return {"decisions": [{"type": decision}]}

    monkeypatch.setattr(approval, "interrupt", resume)
    result = approval.require_knowledge_write_approval(
        "create_knowledge_base",
        {"name": "Example"},
        interrupt_config={"allowed_decisions": configured},
    )
    assert result is accepted
    if advertised:
        assert len(requests) == 1
        assert requests[0]["review_configs"] == [
            {"action_name": "create_knowledge_base", "allowed_decisions": advertised}
        ]
    else:
        assert requests == []
