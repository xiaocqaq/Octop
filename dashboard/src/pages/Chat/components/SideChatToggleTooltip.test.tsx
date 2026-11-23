import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SideChatToggleTooltip } from "./SideChatToggleTooltip";
vi.mock("antd", () => ({
  Tooltip: ({
    title,
    open,
    trigger,
    children,
  }: {
    title?: string;
    open?: boolean;
    trigger?: string[];
    children: React.ReactNode;
  }) => (
    <div
      data-testid="tooltip"
      data-open={String(open)}
      data-trigger={JSON.stringify(trigger)}
      data-title={title}
    >
      {children}
    </div>
  ),
}));

function pointer(type: string, pointerType: string, buttons = 0) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerType, buttons, relatedTarget: document.body });
  fireEvent(screen.getByRole("button"), event);
}

describe("side chat pointer-only tooltip", () => {
  it("opts out of automatic mouse/focus/touch triggers and starts closed", () => {
    render(
      <SideChatToggleTooltip title="展开侧聊">
        <button>icon</button>
      </SideChatToggleTooltip>,
    );
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-open", "false");
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-trigger", "[]");
  });

  it("touch entering clears a preceding mouse hint", () => {
    render(
      <SideChatToggleTooltip title="展开侧聊">
        <button>icon</button>
      </SideChatToggleTooltip>,
    );
    pointer("pointerover", "mouse");
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-open", "true");
    pointer("pointerover", "touch");
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-open", "false");
  });

  it.each(["touch", "pen"])("never opens for %s pointer entry", (type) => {
    render(
      <SideChatToggleTooltip title="展开侧聊">
        <button>icon</button>
      </SideChatToggleTooltip>,
    );
    pointer("pointerover", type);
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-open", "false");
  });

  it.each(["pointerout", "pointerdown"])(
    "dismisses on %s and does not reopen after title cycles",
    (event) => {
      const { rerender } = render(
        <SideChatToggleTooltip title="展开侧聊">
          <button>icon</button>
        </SideChatToggleTooltip>,
      );
      pointer("pointerover", "mouse");
      expect(screen.getByTestId("tooltip")).toHaveAttribute(
        "data-open",
        "true",
      );
      pointer(event, "mouse");
      expect(screen.getByTestId("tooltip")).toHaveAttribute(
        "data-open",
        "false",
      );
      rerender(
        <SideChatToggleTooltip>
          <button>icon</button>
        </SideChatToggleTooltip>,
      );
      rerender(
        <SideChatToggleTooltip title="展开侧聊">
          <button>icon</button>
        </SideChatToggleTooltip>,
      );
      expect(screen.getByTestId("tooltip")).toHaveAttribute(
        "data-open",
        "false",
      );
    },
  );

  it("resets an open hint when title is removed, without pointerleave", () => {
    const { rerender } = render(
      <SideChatToggleTooltip title="展开侧聊">
        <button>icon</button>
      </SideChatToggleTooltip>,
    );
    pointer("pointerover", "mouse");
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-open", "true");
    rerender(
      <SideChatToggleTooltip>
        <button>icon</button>
      </SideChatToggleTooltip>,
    );
    rerender(
      <SideChatToggleTooltip title="展开侧聊">
        <button>icon</button>
      </SideChatToggleTooltip>,
    );
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-open", "false");
  });

  it("focus and synthetic mouse events never open the hint; click dismisses without swallowing the action", () => {
    const click = vi.fn();
    render(
      <SideChatToggleTooltip title="展开侧聊">
        <button onClick={click}>icon</button>
      </SideChatToggleTooltip>,
    );
    const button = screen.getByRole("button");
    fireEvent.focus(button);
    fireEvent.mouseOver(button);
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-open", "false");
    pointer("pointerover", "mouse");
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-open", "false");
  });
});
