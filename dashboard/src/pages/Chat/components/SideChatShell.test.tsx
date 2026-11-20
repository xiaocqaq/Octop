import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SideChatShell from "./SideChatShell";

beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window);
  // Ant Design measures a scrollbar pseudo-element that jsdom cannot render.
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) =>
    getComputedStyle(
      element,
      pseudo === "::-webkit-scrollbar" ? undefined : pseudo,
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

function pointer(
  target: HTMLElement,
  type: string,
  clientX: number,
  pointerId = 1,
) {
  const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(target, event);
}

it("drags the divider within the pane limits and ends on pointer cancel", () => {
  const { separator } = desktop();
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.assign(separator, { setPointerCapture, releasePointerCapture });
  pointer(separator, "pointerdown", 560);
  expect(setPointerCapture).toHaveBeenCalledWith(1);
  pointer(separator, "pointermove", 60, 2);
  expect(separator).toHaveAttribute("aria-valuenow", "440");
  pointer(separator, "pointermove", 60);
  expect(separator).toHaveAttribute("aria-valuenow", "680");
  pointer(separator, "pointermove", 960);
  expect(separator).toHaveAttribute("aria-valuenow", "280");
  pointer(separator, "pointercancel", 960);
  expect(releasePointerCapture).toHaveBeenCalledWith(1);
  pointer(separator, "pointermove", 530);
  expect(separator).toHaveAttribute("aria-valuenow", "280");
});

function desktop() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  Object.defineProperty(container, "clientWidth", { value: 1000 });
  const result = render(
    <SideChatShell open mobile={false} onHide={vi.fn()}>
      <input aria-label="side draft" />
    </SideChatShell>,
    { container },
  );
  return {
    ...result,
    separator: screen.getByRole("separator", { name: "chat.sideChat.resize" }),
  };
}

it("resizes the side pane by keyboard within the available space", () => {
  const { separator } = desktop();
  expect(separator).toHaveAttribute("aria-orientation", "vertical");
  expect(separator).toHaveAttribute("aria-valuenow", "440");
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator).toHaveAttribute("aria-valuenow", "456");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator).toHaveAttribute("aria-valuenow", "440");
  fireEvent.keyDown(separator, { key: "Home" });
  expect(separator).toHaveAttribute("aria-valuenow", "280");
  fireEvent.keyDown(separator, { key: "End" });
  expect(separator).toHaveAttribute("aria-valuenow", "680");
});

it("hides the mobile drawer through its mask or Escape while retaining the draft", () => {
  const onHide = vi.fn();
  const shell = (open: boolean) => (
    <SideChatShell open={open} mobile onHide={onHide}>
      <input aria-label="side draft" />
    </SideChatShell>
  );
  const { rerender } = render(shell(true));
  expect(screen.queryByRole("separator")).toBeNull();
  const dialog = screen.getByRole("dialog");
  const draft = screen.getByRole("textbox");
  fireEvent.change(draft, { target: { value: "unfinished" } });
  fireEvent.keyDown(draft, { key: "Escape", keyCode: 27 });
  expect(onHide).toHaveBeenCalledOnce();
  rerender(shell(false));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  rerender(shell(true));
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft).toHaveValue("unfinished");
  const mask = dialog.closest(".ant-drawer")?.querySelector(".ant-drawer-mask");
  expect(mask).toBeTruthy();
  fireEvent.click(mask!);
  expect(onHide).toHaveBeenCalledTimes(2);
});

it("keeps the same draft when switching between desktop and mobile", () => {
  const onHide = vi.fn();
  const shell = (open: boolean, mobile: boolean) => (
    <SideChatShell open={open} mobile={mobile} onHide={onHide}>
      <input aria-label="side draft" />
    </SideChatShell>
  );
  const { rerender } = render(shell(true, false));
  const draft = screen.getByRole("textbox");
  fireEvent.change(draft, { target: { value: "unsaved" } });
  rerender(shell(false, false));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("separator")).toBeNull();
  rerender(shell(true, true));
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft).toHaveValue("unsaved");
  rerender(shell(true, false));
  expect(screen.getByRole("textbox")).toBe(draft);
});
