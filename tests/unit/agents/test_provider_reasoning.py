from langchain_openai import ChatOpenAI

from octop.infra.agents.providers.reasoning import (
    apply_reasoning_overrides,
    reasoning_capability,
    reasoning_request_parameters,
)


def test_reasoning_capability_accepts_token_plan_thinking_option() -> None:
    capability = reasoning_capability({"id": "glm-5", "options": {"thinking": {"type": "enabled"}}})
    assert capability is not None
    assert capability["toggle"] is True
    assert capability["default_mode"] == "enabled"


def test_known_token_plan_model_is_detected_without_saved_metadata() -> None:
    capability = reasoning_capability({"id": "kimi-k2.5"})
    assert capability is not None
    assert capability["toggle"] is True
    assert capability["default_mode"] == "enabled"


def test_minimax_token_plan_reasoning_is_always_on() -> None:
    capability = reasoning_capability(
        {"id": "minimax-m2.7", "options": {"thinking": {"type": "enabled"}}}
    )
    assert capability is not None
    assert capability["toggle"] is False
    assert capability["default_mode"] == "enabled"


def test_deepseek_v4_uses_nested_effort_parameter() -> None:
    for base_url in (
        "https://api.lkeap.cloud.tencent.com/plan/v3",
        "https://tokenhub.tencentmaas.com/plan/v3",
    ):
        capability = reasoning_capability(
            {
                "id": "deepseek-v4-pro-202606",
                "options": {"thinking": {"type": "enabled"}},
            },
            base_url=base_url,
        )
        assert capability is not None
        assert capability["efforts"] == ["high", "max"]
        assert reasoning_request_parameters(capability, mode="enabled", effort="max") == {
            "extra_body": {"thinking": {"type": "enabled", "reasoning_effort": "max"}}
        }


def test_explicit_capability_filters_unsupported_effort() -> None:
    capability = reasoning_capability(
        {
            "id": "reasoner",
            "reasoning_config": {
                "supported": True,
                "toggle": True,
                "efforts": ["low", "high"],
            },
        }
    )
    assert reasoning_request_parameters(capability, mode="disabled", effort="max") == {
        "extra_body": {"thinking": {"type": "disabled"}}
    }


def test_openai_adapter_maps_disable_to_none_effort_without_thinking() -> None:
    capability = reasoning_capability(
        {
            "id": "gpt-5.4",
            "reasoning_config": {
                "adapter": "openai_reasoning_effort",
                "efforts": ["low", "medium", "high", "xhigh"],
            },
        }
    )
    assert reasoning_request_parameters(capability, mode="disabled", effort=None) == {
        "model_fields": {"reasoning_effort": "none"}
    }


def test_auto_sends_default_effort_for_model_that_cannot_disable_reasoning() -> None:
    capability = reasoning_capability(
        {
            "id": "required-reasoner",
            "reasoning_config": {
                "adapter": "openai_reasoning_effort",
                "toggle": False,
                "efforts": ["low", "medium", "high"],
            },
        }
    )
    assert reasoning_request_parameters(capability, mode="auto", effort=None) == {
        "model_fields": {"reasoning_effort": "medium"}
    }


def test_auto_leaves_reasoning_to_provider_for_optional_models() -> None:
    capability = reasoning_capability(
        {"id": "optional-reasoner", "reasoning_config": {"adapter": "openai_reasoning_effort"}}
    )
    assert reasoning_request_parameters(capability, mode="auto", effort=None) == {}


def test_anthropic_adaptive_uses_native_model_fields() -> None:
    capability = reasoning_capability(
        {
            "id": "claude-opus-4-6",
            "reasoning_config": {
                "adapter": "anthropic_adaptive",
                "efforts": ["low", "medium", "high", "max"],
            },
        }
    )
    assert reasoning_request_parameters(capability, mode="enabled", effort="high") == {
        "model_fields": {"thinking": {"type": "adaptive"}, "reasoning_effort": "high"}
    }


def test_dashscope_token_budget_uses_compatible_body_fields() -> None:
    capability = reasoning_capability(
        {
            "id": "qwen3.5-plus",
            "reasoning_config": {
                "adapter": "dashscope",
                "effort_type": "token_budget",
                "efforts": ["4096", "8192"],
            },
        }
    )
    assert reasoning_request_parameters(capability, mode="enabled", effort="8192") == {
        "extra_body": {"enable_thinking": True, "thinking_budget": 8192}
    }


def test_openrouter_uses_normalized_reasoning_object() -> None:
    capability = reasoning_capability(
        {
            "id": "anthropic/claude-sonnet-4",
            "reasoning_config": {
                "adapter": "openrouter",
                "efforts": ["low", "medium", "high"],
            },
        }
    )
    assert reasoning_request_parameters(capability, mode="enabled", effort="high") == {
        "extra_body": {"reasoning": {"enabled": True, "effort": "high"}}
    }


def test_status_only_model_does_not_emit_fake_controls() -> None:
    capability = reasoning_capability(
        {
            "id": "minimax-m2.7",
            "reasoning_config": {
                "adapter": "status_only",
                "toggle": False,
                "efforts": ["low", "high"],
            },
        }
    )
    assert capability is not None
    assert capability["efforts"] == []
    assert reasoning_request_parameters(capability, mode="disabled", effort="high") == {}


def test_supported_reasoning_defaults_to_enabled_for_every_adapter() -> None:
    for adapter in (
        "thinking",
        "thinking_nested_effort",
        "dashscope",
        "openrouter",
        "anthropic_adaptive",
        "anthropic_budget",
        "openai_reasoning_effort",
    ):
        capability = reasoning_capability(
            {
                "id": "reasoner",
                "reasoning_config": {
                    "adapter": adapter,
                    "default_mode": "auto",
                    "efforts": ["low", "medium", "high"],
                },
            }
        )
        assert capability is not None
        assert capability["default_mode"] == "enabled"
        assert reasoning_request_parameters(capability, mode=None, effort=None)


def test_non_reasoning_model_does_not_receive_reasoning_parameters() -> None:
    assert reasoning_capability({"id": "ordinary-chat"}) is None
    assert reasoning_request_parameters(None, mode="enabled", effort=None) == {}


def test_reasoning_overrides_copy_api_fallback_without_changing_shared_models() -> None:
    model = ChatOpenAI(
        model="reasoner",
        api_key="sk-test",
        use_responses_api=True,
        reasoning_effort="low",
        extra_body={"primary_setting": True},
    )
    fallback = ChatOpenAI(
        model="reasoner",
        api_key="sk-test",
        use_responses_api=False,
        reasoning_effort="low",
        extra_body={"fallback_setting": True},
    )
    object.__setattr__(model, "_harness_api_fallback_model", fallback)

    configured = apply_reasoning_overrides(
        model,
        {
            "model_fields": {"reasoning_effort": "high"},
            "extra_body": {"thinking": {"type": "enabled"}},
        },
    )
    configured_fallback = getattr(configured, "_harness_api_fallback_model", None)
    assert configured_fallback is not None

    for updated, original, original_extra in (
        (configured, model, {"primary_setting": True}),
        (configured_fallback, fallback, {"fallback_setting": True}),
    ):
        assert updated is not original
        assert updated.reasoning_effort == "high"
        assert updated.extra_body == {**original_extra, "thinking": {"type": "enabled"}}
        assert original.reasoning_effort == "low"
        assert original.extra_body == original_extra
    assert configured.use_responses_api is True
    assert configured_fallback.use_responses_api is False
    assert getattr(model, "_harness_api_fallback_model", None) is fallback
