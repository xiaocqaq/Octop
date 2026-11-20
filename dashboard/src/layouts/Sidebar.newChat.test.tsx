import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutModeProvider } from "../context/LayoutModeContext";
import { LAYOUT_MODE_KEY } from "./layoutModeStorage";
import Sidebar from "./Sidebar";

const state = vi.hoisted(() => {
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = class DOMMatrix {} as unknown as typeof DOMMatrix;
  }
  return { activeAgentId: "active-expert" as string | null, navigate: vi.fn() };
});
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("../context/AgentContext", () => ({
  useAgent: () => ({ activeAgentId: state.activeAgentId }),
}));
vi.mock("../components/AvatarDropdown", () => ({ default: () => null }));
vi.mock("../components/CurrentVersionBadge", () => ({ default: () => null }));
vi.mock("./MinimalRecordsHost", () => ({ default: () => null }));
vi.mock("../hooks/useUpdateStatus", () => ({
  useUpdateStatus: () => ({ hasUpdate: false }),
}));
vi.mock("../hooks/useServerCapabilities", () => ({
  useServerCapabilities: () => ({ mobileEnabled: false, loading: false }),
}));

function setup(path: string, mobile = false, onToggle = vi.fn()) {
  const view = render(
    <LayoutModeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar
          selectedKey="chat"
          collapsed={false}
          onToggle={onToggle}
          isMobile={mobile}
        />
      </MemoryRouter>
    </LayoutModeProvider>,
  );
  const row = view.container.querySelector<HTMLElement>(
    '[data-nav-key="chat"]',
  )!;
  return {
    row,
    button: within(row).getByRole("button", { name: "新建对话" }),
    onToggle,
  };
}

describe("sidebar new conversation", () => {
  beforeEach(() => {
    state.activeAgentId = "active-expert";
    state.navigate.mockReset();
    localStorage.setItem(LAYOUT_MODE_KEY, "classic");
  });

  it("places the new-chat button immediately before the existing history toggle", () => {
    const { button, row } = setup("/chat/route-expert/thread-1");
    const history = within(row).getByRole("button", { name: /对话历史/ });
    expect(button.nextElementSibling).toBe(history);
  });

  it("starts a blank conversation with the route expert instead of a stale active expert", () => {
    const { button } = setup("/chat/route-expert/thread-1");
    fireEvent.click(button);
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith(
      "/chat/route-expert",
      { state: { newChat: true } },
    );
  });

  it("uses the selected expert when launched outside chat", () => {
    fireEvent.click(setup("/settings").button);
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith(
      "/chat/active-expert",
      { state: { newChat: true } },
    );
  });

  it("closes the navigation drawer after starting a conversation on mobile", () => {
    const { button, onToggle } = setup("/chat/route-expert/thread-1", true);
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith(
      "/chat/route-expert",
      { state: { newChat: true } },
    );
  });

  it("does not choose another expert when no expert is selected", () => {
    state.activeAgentId = null;
    const { button } = setup("/chat");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("keeps the existing history button available", () => {
    setup("/chat/route-expert/thread-1");
    expect(screen.getByRole("button", { name: /对话历史/ })).toBeEnabled();
  });
});
