import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";

vi.mock("../../../hooks/useIsMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("../../../hooks/useSlashCommands", () => ({
  useSlashCommands: () => ({
    commands: [],
    labelFor: (cmd: string) => cmd,
  }),
}));

vi.mock("../../../hooks/useVoiceInput", () => ({
  useVoiceInput: () => ({
    recording: false,
    transcribing: false,
    realtime: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useKeepInVisualViewport", () => ({
  useKeepInVisualViewport: () => undefined,
}));

vi.mock("../../../hooks/viewport", () => ({
  isPwaDisplay: () => false,
  needsComposerVisualViewportFix: () => false,
}));

vi.mock("../hooks/chatStore", () => ({
  consumePendingPrefillAttachments: () => [],
  onSteerRestore: () => () => undefined,
  readInputDraft: (agentId: string) =>
    agentId === "agent-2" ? "target expert draft" : "",
  writeInputDraft: vi.fn(),
}));

vi.mock("./ChatInputPreviewBar", () => ({
  default: () => null,
}));

vi.mock("./ChatInputActionsRow", () => ({
  default: ({
    onSubmit,
    canSend,
  }: {
    onSubmit: () => void;
    canSend: boolean;
  }) => (
    <button type="button" disabled={!canSend} onClick={onSubmit}>
      send
    </button>
  ),
}));

vi.mock("./ChatQueuedMessages", () => ({
  default: () => null,
}));

vi.mock("./SlashCommandMenu", () => ({
  default: () => null,
}));

vi.mock("./MentionPickerMenu", () => ({
  default: () => null,
  buildMentionItems: () => [],
}));

vi.mock("../hooks/useSlashMentionInput", () => ({
  useSlashMentionInput: ({
    text,
    setText,
    onSubmitRef,
  }: {
    text: string;
    setText: (v: string) => void;
    onSubmitRef: { current: () => void };
  }) => ({
    slashMenuOpen: false,
    slashMenuIndex: 0,
    setSlashMenuIndex: vi.fn(),
    mentionMenuOpen: false,
    mentionMenuIndex: 0,
    setMentionMenuIndex: vi.fn(),
    mentionQuery: "",
    mentionAgents: [],
    slashMenuFlat: [],
    slashMenuGroups: [],
    slashPickerGroups: [],
    slashMenuItems: [],
    mentionItems: [],
    filesLoading: false,
    filesError: null,
    runSlashCommand: vi.fn(),
    matchSlashCommand: () => null,
    handleMentionSelect: vi.fn(),
    handleSlashSelect: vi.fn(),
    handleTextChange: setText,
    handleKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === "Enter" && !e.preventDefault) return;
      void text;
      void onSubmitRef;
    },
  }),
}));

vi.mock("../../../hooks/useServerUploadLimit", () => ({
  useServerUploadLimit: () => ({ maxUploadBytes: 1024, maxUploadMb: 1 }),
}));
vi.mock("../../../api/modules/upload", () => ({ uploadFile: vi.fn() }));
vi.mock("@/utils/antdMessage", () => ({
  message: { error: vi.fn(), warning: vi.fn() },
}));

import { uploadFile } from "../../../api/modules/upload";
import { DESKTOP_FILE_DROP_EVENT } from "../../../utils/desktopFileDrop";
import ChatInput from "./ChatInput";

const props = {
  onSend: vi.fn(),
  onCancel: vi.fn(),
  onNewChat: vi.fn(),
  isStreaming: false,
};
function composers(sideActive = true, hidden = false) {
  return (
    <>
      <div hidden={hidden} data-testid="side">
        <ChatInput {...props} agentId="side-agent" active={sideActive} />
      </div>
      <div data-testid="main">
        <ChatInput {...props} agentId="main-agent" />
      </div>
    </>
  );
}
function shell(id: string) {
  return screen
    .getByTestId(id)
    .querySelector<HTMLElement>("[data-octop-chat-drop]")!;
}
async function drop(target: EventTarget = window) {
  await act(async () => {
    target.dispatchEvent(
      new CustomEvent(DESKTOP_FILE_DROP_EVENT, {
        bubbles: true,
        detail: {
          files: [{ name: "note.txt", url: "http://localhost/drop/note" }],
        },
      }),
    );
  });
}

beforeEach(() => {
  vi.mocked(uploadFile).mockReset();
  vi.mocked(uploadFile).mockImplementation(async (_agent, file) => ({
    path: "inbound/" + file.name,
    workspace_path: "inbound/" + file.name,
    filename: file.name,
    media_type: "text/plain",
    url: "",
    access_url: "/files/" + file.name,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("note")),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("ChatInput desktop drop ownership", () => {
  it("uses the last native marker after it clears instead of the focused composer", async () => {
    render(composers());
    screen.getByTestId("main").querySelector("textarea")!.focus();
    await act(async () => {
      shell("side").classList.add("file-drop-target-active");
    });
    await act(async () => {
      shell("side").classList.remove("file-drop-target-active");
    });
    await drop();
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uploadFile).mock.calls[0][0]).toBe("side-agent");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["inactive", "hidden", "unmounted"])(
    "rejects a delayed A-side drop after switching to B (%s)",
    async (mode) => {
      const route = (switched: boolean) => (
        <>
          {!(switched && mode === "unmounted") && (
            <div
              key="side"
              hidden={switched && mode === "hidden"}
              data-testid="side"
            >
              <ChatInput
                {...props}
                agentId="a-side-agent"
                active={!(switched && mode === "inactive")}
              />
            </div>
          )}
          <div key="main" data-testid="main">
            <ChatInput {...props} agentId={switched ? "b-agent" : "a-agent"} />
          </div>
        </>
      );
      const { rerender } = render(route(false));
      await act(async () => {
        shell("side").classList.add("file-drop-target-active");
      });
      await act(async () => {
        shell("side").classList.remove("file-drop-target-active");
      });
      rerender(route(true));
      await drop();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();

      // Consume that stale intent once; a later drop into the sole B composer works.
      await drop();
      await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
      expect(vi.mocked(uploadFile).mock.calls[0][0]).toBe("b-agent");
    },
  );

  it("ignores a marked composer inside a hidden ancestor", async () => {
    render(composers(true, true));
    await act(async () => {
      shell("side").classList.add("file-drop-target-active");
    });
    await drop();
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uploadFile).mock.calls[0][0]).toBe("main-agent");
  });

  it("excludes inactive composers and honors an explicit visible event target", async () => {
    const { rerender } = render(composers(false));
    expect(shell("side")).not.toHaveAttribute("data-file-drop-target");
    await drop();
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uploadFile).mock.calls[0][0]).toBe("main-agent");
    rerender(composers());
    await drop(screen.getByTestId("side").querySelector("textarea")!);
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(uploadFile).mock.calls[1][0]).toBe("side-agent");
  });

  it("keeps normal HTML file drops local to their composer", async () => {
    render(composers());
    const file = new File(["html"], "html.txt", { type: "text/plain" });
    fireEvent.drop(shell("main"), {
      dataTransfer: {
        types: ["Files"],
        items: [{ kind: "file", getAsFile: () => file }],
        files: [file],
      },
    });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uploadFile).mock.calls[0][0]).toBe("main-agent");
    expect(fetch).not.toHaveBeenCalled();
  });
});
