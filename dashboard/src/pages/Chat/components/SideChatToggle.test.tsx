import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import zh from "../../../locales/zh.json";
import en from "../../../locales/en.json";

// Exercise the actual inline titlebar JSX without mounting the entire chat page.
const source = readFileSync(resolve(__dirname, "../index.tsx"), "utf8");
const start = source.indexOf("  const sideChatToggle =");
const end = source.indexOf("  const sidePanelToggle =", start);
if (start < 0 || end < 0) throw new Error("Side chat titlebar JSX not found");
const compiled = ts.transpileModule(
  source.slice(start, end) + "\nreturn sideChatToggle;",
  {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  },
).outputText;

function toggle(
  visible: boolean,
  thread: { thread_id: string } | null,
  locale: typeof zh,
) {
  const sideChat = {
    visible,
    thread,
    opening: false,
    closing: false,
    saving: false,
    hide: vi.fn(),
    show: vi.fn(),
    open: vi.fn().mockResolvedValue(true),
  };
  const create = new Function(
    "React",
    "SideChatToggleTooltip",
    "Button",
    "MessagesSquare",
    "t",
    "sideChat",
    "sharedExpertViewer",
    "isTeamChat",
    "activeAgent",
    "agentChatReady",
    "activeThreadId",
    "isStreaming",
    "hasPendingHitlPause",
    "handleDockClose",
    "antMessage",
    "apiErrorMessage",
    compiled,
  );
  const element = create(
    React,
    ({ title, children }: { title?: string; children: React.ReactNode }) => (
      <div data-testid="tooltip" data-title={title}>
        {children}
      </div>
    ),
    ({
      icon,
      loading,
      type,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      icon: React.ReactNode;
      loading: boolean;
    }) => {
      void loading;
      void type;
      return <button {...props}>{icon}</button>;
    },
    () => <span />,
    (key: string) => {
      if (!key.startsWith("chat.sideChat."))
        throw new Error(`Unexpected key: ${key}`);
      return locale.chat.sideChat[
        key.slice("chat.sideChat.".length) as keyof typeof locale.chat.sideChat
      ];
    },
    sideChat,
    false,
    false,
    {},
    true,
    "main-thread",
    false,
    false,
    vi.fn(),
    { error: vi.fn() },
    vi.fn(),
  );
  return { ...render(element), sideChat };
}

describe.each([
  ["zh", zh],
  ["en", en],
] as const)("side chat toggle (%s)", (_language, locale) => {
  it("offers opening only when no retained side chat exists", () => {
    toggle(false, null, locale);
    expect(
      screen.getByRole("button", { name: locale.chat.sideChat.open }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("tooltip")).toHaveAttribute(
      "data-title",
      locale.chat.sideChat.open,
    );
  });

  it("offers showing the retained chat after hiding, without creating another", () => {
    const { sideChat } = toggle(false, { thread_id: "side-1" }, locale);
    const showLabel = _language === "zh" ? "展开侧聊" : "Show side chat";
    const button = screen.getByRole("button", { name: showLabel });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("tooltip")).toHaveAttribute(
      "data-title",
      showLabel,
    );
    button.click();
    expect(sideChat.show).toHaveBeenCalledOnce();
    expect(sideChat.open).not.toHaveBeenCalled();
  });

  it("labels hiding while visible and keeps the hover tooltip suppressed", () => {
    const { sideChat } = toggle(true, { thread_id: "side-1" }, locale);
    const button = screen.getByRole("button", {
      name: locale.chat.sideChat.hide,
    });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tooltip")).not.toHaveAttribute("data-title");
    button.click();
    expect(sideChat.hide).toHaveBeenCalledOnce();
    expect(sideChat.open).not.toHaveBeenCalled();
  });
});
