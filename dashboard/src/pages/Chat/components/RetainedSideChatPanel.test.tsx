import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../hooks/useChat";
let RetainedSideChatPanel: typeof import("./RetainedSideChatPanel").default;
let useSideChat: typeof import("../hooks/useSideChat").useSideChat;

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  persist: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  send: vi.fn(),
  closeError: vi.fn(),
  persistError: vi.fn(),
  saved: vi.fn(),
  load: vi.fn(),
  snapshot: vi.fn(),
  cancel: vi.fn(),
  removeSession: vi.fn(),
}));
vi.mock("../../../api/modules/octopThreads", () => ({
  octopThreadsApi: {
    createSideChat: mocks.create,
    persistSideChat: mocks.persist,
    delete: mocks.remove,
  },
}));
vi.mock("../../../api/modules/upload", () => ({ uploadFile: mocks.upload }));
vi.mock("../../../hooks/useServerUploadLimit", () => ({
  useServerUploadLimit: () => ({ maxUploadBytes: 1000000, maxUploadMb: 1 }),
}));
vi.mock("../../../hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("../../../hooks/useSlashCommands", () => ({
  useSlashCommands: () => ({
    commands: [],
    labelFor: (command: string) => command,
  }),
}));
vi.mock("../../../hooks/useKeepInVisualViewport", () => ({
  useKeepInVisualViewport: () => undefined,
}));
vi.mock("../../../hooks/viewport", () => ({
  isPwaDisplay: () => false,
  needsComposerVisualViewportFix: () => false,
}));
vi.mock("../../../hooks/useVoiceInput", () => ({
  useVoiceInput: () => ({
    recording: false,
    transcribing: false,
    realtime: false,
    toggle: vi.fn(),
  }),
}));
vi.mock("../hooks/chatStore", () => ({
  getSnapshot: mocks.snapshot,
  cancelStream: mocks.cancel,
  removeSession: mocks.removeSession,
  consumePendingPrefillAttachments: () => [],
  onSteerRestore: () => () => undefined,
  readInputDraft: () => "",
  writeInputDraft: vi.fn(),
}));
const empty: never[] = [];
vi.mock("../hooks/useChat", () => ({
  useChat: () => ({
    messages: empty,
    isStreaming: false,
    thinkingStartedAt: null,
    liveSpeakers: empty,
    historyLoading: false,
    historyError: false,
    historyHasMore: false,
    historyLoadingMore: false,
    historyRefreshing: false,
    sendMessage: mocks.send,
    cancelStream: mocks.cancel,
    loadHistory: mocks.load,
    loadMoreHistory: mocks.load,
    refreshHistory: mocks.load,
    retryHistory: mocks.load,
    resumeHitl: vi.fn(),
  }),
}));
vi.mock("./MessageList", () => ({ default: () => null }));
vi.mock("./AskQuestionCard", () => ({ default: () => null }));
vi.mock("./SlashCommandMenu", () => ({ default: () => null }));
vi.mock("./MentionPickerMenu", () => ({
  default: () => null,
  buildMentionItems: () => [],
}));
vi.mock("./ChatQueuedMessages", () => ({ default: () => null }));
vi.mock("./ChatInputPreviewBar", () => ({
  default: ({ attachments }: { attachments: ChatAttachment[] }) => (
    <ul>
      {attachments.map((file) => (
        <li key={file.filename}>{file.filename}</li>
      ))}
    </ul>
  ),
}));
vi.mock("./ChatInputActionsRow", () => ({
  default: ({
    onSubmit,
    canSend,
  }: {
    onSubmit: () => void;
    canSend: boolean;
  }) => (
    <button disabled={!canSend} onClick={onSubmit}>
      send
    </button>
  ),
}));
vi.mock("../hooks/useSlashMentionInput", () => ({
  useSlashMentionInput: ({ setText }: { setText: (text: string) => void }) => ({
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
    handleKeyDown: vi.fn(),
  }),
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  useSideChat = (await import("../hooks/useSideChat")).useSideChat;
  RetainedSideChatPanel = (await import("./RetainedSideChatPanel")).default;
  mocks.create.mockImplementation(async (agent: string, source: string) => ({
    thread_id: "side-" + source,
    title: null,
    channel_type: "dashboard",
    session_key: "session-" + source,
    created_at: 1,
    last_active: 1,
    source_thread_id: source,
    side_chat: true,
  }));
  mocks.persist.mockResolvedValue({});
  mocks.remove.mockResolvedValue({});
  mocks.load.mockResolvedValue(undefined);
  mocks.snapshot.mockReturnValue({ messages: [] });
  mocks.upload.mockResolvedValue({
    filename: "unfinished.txt",
    media_type: "text/plain",
    path: "inbound/unfinished.txt",
    url: "/upload/unfinished.txt",
  });
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) =>
    computed(element, pseudo === "::-webkit-scrollbar" ? undefined : pseudo),
  );
}, 30000);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness() {
  const [parent, setParent] = useState("a");
  const [mobile, setMobile] = useState(false);
  const current = useSideChat("agent", parent, 1);
  return (
    <>
      <button
        onClick={() => {
          void current.open();
        }}
      >
        open
      </button>
      <button onClick={() => setParent(parent === "a" ? "b" : "a")}>
        switch parent
      </button>
      <button onClick={() => setMobile(!mobile)}>switch mobile</button>
      {current.retainedChats.map((descriptor) => (
        <RetainedSideChatPanel
          key={
            descriptor.agentId +
            ":" +
            descriptor.sourceThreadId +
            ":" +
            descriptor.thread.thread_id
          }
          descriptor={descriptor}
          ownerId={1}
          active={descriptor.sourceThreadId === parent}
          mobile={mobile}
          onPersisted={mocks.saved}
          onCloseError={mocks.closeError}
          onPersistError={mocks.persistError}
        />
      ))}
    </>
  );
}

it("keeps the real composer DOM, last text and uploaded attachment through immediate A-B-A navigation", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  const textbox = await screen.findByRole("textbox");
  const input = textbox.closest("aside")!.querySelector('input[type="file"]')!;
  fireEvent.change(input, {
    target: {
      files: [new File(["draft"], "unfinished.txt", { type: "text/plain" })],
    },
  });
  await screen.findByText("unfinished.txt");
  fireEvent.change(textbox, {
    target: { value: "last characters before 250ms" },
  });
  fireEvent.click(screen.getByRole("button", { name: "switch parent" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  const b = await screen.findByRole("textbox");
  expect(b).not.toBe(textbox);
  expect(b).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "switch parent" }));
  expect(screen.getByRole("textbox")).toBe(textbox);
  expect(textbox).toHaveValue("last characters before 250ms");
  expect(screen.getByText("unfinished.txt")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "switch mobile" }));
  expect(screen.getByRole("textbox")).toBe(textbox);
  fireEvent.keyDown(textbox, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  expect(await screen.findByRole("textbox")).toBe(textbox);
  expect(textbox).toHaveValue("last characters before 250ms");
  expect(screen.getByText("unfinished.txt")).toBeVisible();
  expect(mocks.cancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "send" }));
  expect(mocks.send.mock.calls[0]?.slice(0, 5)).toEqual([
    "last characters before 250ms",
    "session-a",
    "agent",
    [expect.objectContaining({ filename: "unfinished.txt" })],
    "side-a",
  ]);
  expect(mocks.remove).not.toHaveBeenCalled();
});

it.each(["close", "save"])(
  "%s affects only A when it finishes during B",
  async (action) => {
    const closing = action === "close";
    let finish!: () => void;
    const request = new Promise<void>((resolve) => {
      finish = resolve;
    });
    (closing ? mocks.remove : mocks.persist).mockReturnValueOnce(request);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    const a = await screen.findByRole("textbox");
    fireEvent.click(
      screen.getByRole("button", { name: "chat.sideChat." + action }),
    );
    fireEvent.click(screen.getByRole("button", { name: "switch parent" }));
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    const b = await screen.findByRole("textbox");
    fireEvent.change(b, { target: { value: "B draft" } });

    await act(async () => {
      finish();
    });
    expect(a).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBe(b);
    expect(b).toHaveValue("B draft");
    if (closing) {
      expect(mocks.remove.mock.calls).toEqual([
        ["agent", "side-a", false, true],
      ]);
      expect(mocks.cancel.mock.calls).toEqual([
        ["side-a", { agentId: "agent", threadId: "side-a" }],
      ]);
      expect(mocks.removeSession.mock.calls).toEqual([["side-a"]]);
      expect(mocks.persist).not.toHaveBeenCalled();
      expect(mocks.saved).not.toHaveBeenCalled();
    } else {
      expect(mocks.persist.mock.calls).toEqual([["agent", "side-a"]]);
      expect(mocks.saved.mock.calls).toEqual([
        [expect.objectContaining({ sourceThreadId: "a" })],
      ]);
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.cancel).not.toHaveBeenCalled();
      expect(mocks.removeSession).not.toHaveBeenCalled();
    }
    expect(mocks.closeError).not.toHaveBeenCalled();
    expect(mocks.persistError).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "switch parent" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "switch parent" }));
    expect(screen.getByRole("textbox")).toBe(b);
  },
);
