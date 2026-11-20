"""Invalid successful HTTP responses must consume the configured retry budget."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage

from octop.infra.agents.middleware.model_failover import SafeModelFailoverMiddleware
from octop.infra.agents.providers.health import ModelHealthRegistry


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("budget", [0, 2])
@pytest.mark.parametrize(
    "message",
    [
        AIMessage(content=""),
        AIMessage(content=[{"type": "reasoning", "reasoning": "thinking"}]),
        AIMessage(content="partial", response_metadata={"finish_reason": "error"}),
    ],
)
async def test_invalid_response_exhausts_exact_retry_budget(asynchronous, budget, message):
    middleware = SafeModelFailoverMiddleware(
        health=ModelHealthRegistry(),
        candidates=lambda *_: [],
        model_for_ref=lambda _: None,
        max_retries=budget,
        initial_delay=0,
        max_delay=0,
        on_failure="error",
    )
    response = ModelResponse(result=[message])
    handler = AsyncMock(return_value=response) if asynchronous else MagicMock(return_value=response)
    request = ModelRequest(model=MagicMock(), messages=[HumanMessage(content="hello")])
    with pytest.raises(ValueError):
        if asynchronous:
            await middleware.awrap_model_call(request, handler)
        else:
            middleware.wrap_model_call(request, handler)
    assert handler.call_count == budget + 1


@pytest.mark.asyncio
async def test_invalid_response_retries_then_recovers():
    middleware = SafeModelFailoverMiddleware(
        health=ModelHealthRegistry(),
        candidates=lambda *_: [],
        model_for_ref=lambda _: None,
        max_retries=2,
        initial_delay=0,
        max_delay=0,
        on_failure="error",
    )
    handler = AsyncMock(
        side_effect=[
            ModelResponse(result=[AIMessage(content="")]),
            ModelResponse(result=[AIMessage(content="recovered")]),
        ]
    )
    response = await middleware.awrap_model_call(
        ModelRequest(model=MagicMock(), messages=[HumanMessage(content="hello")]),
        handler,
    )
    assert response.result[0].content == "recovered"
    assert handler.call_count == 2
