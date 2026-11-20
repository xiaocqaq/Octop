import { act, render, within } from "@testing-library/react";
import { createPortal } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { LayoutModeProvider } from "../../../context/LayoutModeContext";
import { CHAT_HISTORY_RAIL_ID } from "../../../layouts/chatHistoryRail";
import { useChatHistoryRail } from "./useChatHistoryRail";

function ConversationRecords() {
  const rail = useChatHistoryRail();
  return rail ? createPortal(<span>Saved side conversation</span>, rail) : null;
}

function ResponsiveLayout({ mobile }: { mobile: boolean }) {
  return (
    <MemoryRouter initialEntries={["/chat/agent/main-thread"]}>
      <LayoutModeProvider>
        <section key={mobile ? "mobile-navigation" : "desktop-navigation"}>
          <div id={CHAT_HISTORY_RAIL_ID} />
        </section>
        <ConversationRecords />
      </LayoutModeProvider>
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

it.each([false, true])(
  "keeps conversation records visible when the responsive rail remounts (mobile=%s)",
  async (mobile) => {
    vi.useFakeTimers();
    const { rerender } = render(<ResponsiveLayout mobile={mobile} />);
    // Complete the initial deferred sync before changing only the breakpoint.
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    const originalRail = document.getElementById(CHAT_HISTORY_RAIL_ID)!;
    expect(
      within(originalRail).getByText("Saved side conversation"),
    ).toBeTruthy();

    rerender(<ResponsiveLayout mobile={!mobile} />);
    await act(async () => {});
    const replacementRail = document.getElementById(CHAT_HISTORY_RAIL_ID)!;
    expect(replacementRail).not.toBe(originalRail);
    expect(originalRail.isConnected).toBe(false);
    expect(
      within(replacementRail).getByText("Saved side conversation"),
    ).toBeTruthy();
  },
);
