import { useState, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OctopThread } from "../../../api/modules/octopThreads";
import type { ChatMessage } from "../hooks/useChat";
import type ChatInput from "./ChatInput";
import type MessageList from "./MessageList";
import type { AskQuestionCardProps } from "./AskQuestionCard";
import SideChatPanel from "./SideChatPanel";

type InputProps = ComponentProps<typeof ChatInput>;
type ListProps = ComponentProps<typeof MessageList>;
const mocks = vi.hoisted(() => ({ useChat: vi.fn(), snapshot: vi.fn() }));
let inputProps: InputProps;
let listProps: ListProps;
let questionProps: AskQuestionCardProps;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../hooks/useChat", () => ({ useChat: mocks.useChat }));
vi.mock("../hooks/chatStore", () => ({ getSnapshot: mocks.snapshot }));
vi.mock("./ChatInput", () => ({
  default: function MockChatInput(props: InputProps) {
    inputProps = props;
    const [draft, setDraft] = useState("");
    return (
      <div>
        <input
          aria-label="draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={props.disabled}
        />
        <button disabled={props.disabled} onClick={() => props.onSend(draft)}>
          send
        </button>
        <button onClick={props.onCancel}>cancel</button>
        <button onClick={props.onNewChat}>new chat</button>
      </div>
    );
  },
}));
vi.mock("./MessageList", () => ({
  default: (props: ListProps) => {
    listProps = props;
    return (
      <div data-testid="history" data-session={props.sessionKey}>
        {props.messages.map((message) => (
          <p key={message.id}>{message.content}</p>
        ))}
        <button onClick={() => props.onLoadMoreHistory?.()}>older</button>
        <button onClick={props.onRefreshHistory}>refresh</button>
      </div>
    );
  },
}));
vi.mock("./AskQuestionCard", () => ({
  default: (props: AskQuestionCardProps) => {
    questionProps = props;
    return (
      <div>
        <p>{props.questions[0]?.question}</p>
        <button onClick={() => props.onSubmit?.("card answer")}>answer</button>
        <button onClick={props.onDismiss}>dismiss</button>
      </div>
    );
  },
}));

function chat(messages: ChatMessage[] = []) {
  return {
    messages,
    isStreaming: false,
    thinkingStartedAt: null,
    liveSpeakers: [],
    historyLoading: false,
    historyError: false,
    historyHasMore: true,
    historyLoadingMore: false,
    historyRefreshing: false,
    loadHistory: vi.fn().mockResolvedValue(undefined),
    loadMoreHistory: vi.fn().mockResolvedValue(true),
    refreshHistory: vi.fn().mockResolvedValue(undefined),
    retryHistory: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    cancelStream: vi.fn(),
    resumeHitl: vi.fn(),
  };
}

function hitl(name: string, id = "side-pause"): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp: 1,
    status: "done",
    hitlData: {
      pending_id: id,
      status: "pending",
      action_requests: [
        {
          name,
          args:
            name === "ask_user_question"
              ? { questions: [{ question: "Side question?" }] }
              : {},
        },
      ],
    },
  };
}

const thread: OctopThread = {
  thread_id: "side-a",
  title: null,
  channel_type: "web",
  session_key: "side-session-a",
  last_active: 1,
  created_at: 1,
  model_ref: "provider/model-a",
  reasoning_mode: "enabled",
  reasoning_effort: "high",
  conversation_mode: "plan",
  session_mode: "code",
  hitl_policy: { mode: "allow_tools", tools: ["read_file"] },
};
let side: ReturnType<typeof chat>;
let parent: ReturnType<typeof chat>;
const props = () => ({
  agentId: "agent-a",
  thread,
  onClose: vi.fn(),
  onPersist: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  vi.clearAllMocks();
  side = chat([
    {
      id: "side-message",
      role: "assistant",
      content: "side history",
      timestamp: 1,
      status: "done",
    },
  ]);
  parent = chat([hitl("execute", "parent-pause")]);
  mocks.useChat.mockImplementation(() => side);
  mocks.snapshot.mockImplementation((id: string) =>
    id === "parent" ? parent : side,
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SideChatPanel", () => {
  it("loads only the side thread and keeps history controls scoped to it", () => {
    render(<SideChatPanel {...props()} />);
    expect(mocks.useChat).toHaveBeenCalledWith(
      "side-a",
      "agent-a",
      false,
      true,
    );
    expect(side.loadHistory).toHaveBeenCalledWith("side-a");
    expect(screen.getByText("side history")).toBeTruthy();
    expect(screen.getByTestId("history").getAttribute("data-session")).toBe(
      "side-a",
    );
    expect(listProps.agentId).toBe("agent-a");
    expect(listProps.historyHasMore).toBe(true);
    fireEvent.click(screen.getByText("older"));
    fireEvent.click(screen.getByText("refresh"));
    expect(side.loadMoreHistory).toHaveBeenCalledOnce();
    expect(side.refreshHistory).toHaveBeenCalledWith("side-a");
    expect(parent.loadHistory).not.toHaveBeenCalled();
  });

  it("sends with inherited settings despite a parent HITL pause and cancels independently", () => {
    render(<SideChatPanel {...props()} />);
    expect(inputProps.threadId).toBe("side-a");
    expect(inputProps.agentId).toBe("agent-a");
    expect(inputProps.selectedModel).toBe(thread.model_ref);
    expect(inputProps.sessionMode).toBe("code");
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "side question" },
    });
    fireEvent.click(screen.getByText("send"));
    expect(side.sendMessage).toHaveBeenCalledWith(
      "side question",
      "side-session-a",
      "agent-a",
      undefined,
      "side-a",
      "provider/model-a",
      undefined,
      undefined,
      undefined,
      {
        model: "provider/model-a",
        reasoningMode: "enabled",
        reasoningEffort: "high",
      },
      "enabled",
      "high",
      "plan",
      { mode: "allow_tools", tools: ["read_file"] },
      "code",
    );
    fireEvent.click(screen.getByText("cancel"));
    expect(side.cancelStream).toHaveBeenCalledOnce();
    expect(parent.sendMessage).not.toHaveBeenCalled();
    expect(parent.resumeHitl).not.toHaveBeenCalled();
    expect(parent.cancelStream).not.toHaveBeenCalled();
  });

  it("routes typed and card answers into the side ask pause and dismisses it", () => {
    side.messages = [hitl("ask_user_question")];
    render(<SideChatPanel {...props()} />);
    expect(screen.getByText("Side question?")).toBeTruthy();
    expect(inputProps.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: " typed answer " },
    });
    fireEvent.click(screen.getByText("send"));
    expect(side.resumeHitl).toHaveBeenLastCalledWith(
      [{ type: "respond", message: "typed answer" }],
      "side-a",
    );
    fireEvent.click(screen.getByText("answer"));
    expect(side.resumeHitl).toHaveBeenLastCalledWith(
      [{ type: "respond", message: "card answer" }],
      "side-a",
      undefined,
      undefined,
      undefined,
    );
    fireEvent.click(screen.getByText("dismiss"));
    expect(side.resumeHitl).toHaveBeenLastCalledWith(
      [{ type: "respond", message: "chat.sideChat.dismissMessage" }],
      "side-a",
      true,
    );
    expect(side.sendMessage).not.toHaveBeenCalled();
    expect(parent.resumeHitl).not.toHaveBeenCalled();
  });

  it("rejects attachments during ask and ordinary sends during approval", () => {
    side.messages = [hitl("ask_user_question")];
    const { rerender } = render(<SideChatPanel {...props()} />);
    act(() =>
      inputProps.onSend("answer", [
        { name: "image.png", type: "image", url: "/image.png" },
      ]),
    );
    expect(screen.getByText("chat.sideChat.askAttachments")).toBeTruthy();
    expect(side.resumeHitl).not.toHaveBeenCalled();
    side.messages = [hitl("execute")];
    rerender(<SideChatPanel {...props()} />);
    expect(inputProps.disabled).toBe(true);
    act(() => inputProps.onSend("another turn"));
    expect(screen.getByText("chat.sideChat.finishPendingFirst")).toBeTruthy();
    expect(side.sendMessage).not.toHaveBeenCalled();
  });

  it("merges allowed tools locally and preserves the approval pending id", () => {
    side.messages = [hitl("execute")];
    render(<SideChatPanel {...props()} />);
    act(
      () =>
        listProps.onHitlDecision?.(
          [{ type: "approve" }],
          { mode: "allow_tools", tools: ["execute"] },
          "side-pause",
        ),
    );
    expect(side.resumeHitl).toHaveBeenCalledWith(
      [{ type: "approve" }],
      "side-a",
      undefined,
      { mode: "allow_tools", tools: ["read_file", "execute"] },
      "side-pause",
    );
    expect(inputProps.hitlPolicy).toEqual({
      mode: "allow_tools",
      tools: ["read_file", "execute"],
    });
    expect(thread.hitl_policy).toEqual({
      mode: "allow_tools",
      tools: ["read_file"],
    });
    expect(parent.resumeHitl).not.toHaveBeenCalled();
  });

  it("automatically resumes allowed tools once and leaves knowledge writes pending", () => {
    vi.useFakeTimers();
    side.messages = [hitl("read_file")];
    const panelProps = props();
    const { rerender } = render(<SideChatPanel {...panelProps} />);
    act(() => vi.advanceTimersByTime(50));
    expect(side.resumeHitl).toHaveBeenCalledOnce();
    expect(side.resumeHitl).toHaveBeenCalledWith(
      [{ type: "approve" }],
      "side-a",
      undefined,
      thread.hitl_policy,
      "side-pause",
    );
    side.messages = [...side.messages];
    rerender(<SideChatPanel {...panelProps} />);
    act(() => vi.advanceTimersByTime(100));
    expect(side.resumeHitl).toHaveBeenCalledOnce();
    side.messages = [hitl("create_knowledge_document", "knowledge-pause")];
    rerender(<SideChatPanel {...panelProps} />);
    act(() => inputProps.onHitlPolicyChange?.({ mode: "allow_all" }));
    act(() => vi.advanceTimersByTime(100));
    expect(side.resumeHitl).toHaveBeenCalledOnce();
  });

  it("resumes a currently pending approval when the side policy changes", () => {
    side.messages = [hitl("execute")];
    render(<SideChatPanel {...props()} />);
    act(() => inputProps.onHitlPolicyChange?.({ mode: "allow_all" }));
    expect(side.resumeHitl).toHaveBeenCalledWith(
      [{ type: "approve" }],
      "side-a",
      undefined,
      { mode: "allow_all" },
      "side-pause",
    );
    expect(parent.resumeHitl).not.toHaveBeenCalled();
  });

  it("delegates save and close without opening a main session, and shows saving state", async () => {
    const panelProps = props();
    const { rerender } = render(<SideChatPanel {...panelProps} />);
    fireEvent.click(screen.getByText("chat.sideChat.save"));
    await waitFor(() => expect(panelProps.onPersist).toHaveBeenCalledOnce());
    expect(panelProps.onClose).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "chat.sideChat.close" }),
    );
    fireEvent.click(screen.getByText("new chat"));
    expect(panelProps.onClose).toHaveBeenCalledTimes(2);
    rerender(<SideChatPanel {...panelProps} saving />);
    const savingButton = screen.getByRole("button", {
      name: /chat.sideChat.saving/,
    });
    expect(savingButton.hasAttribute("disabled")).toBe(true);
    expect(savingButton.className).toContain("loading");
    fireEvent.click(screen.getByText("new chat"));
    expect(panelProps.onClose).toHaveBeenCalledTimes(2);
    expect(inputProps.disabled).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "chat.sideChat.close" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("locks sends, HITL and saving while disabled or streaming", () => {
    side.messages = [hitl("ask_user_question")];
    const panelProps = props();
    const { rerender } = render(<SideChatPanel {...panelProps} disabled />);
    expect(inputProps.disabled).toBe(true);
    expect(listProps.onHitlDecision).toBeUndefined();
    expect(questionProps.onSubmit).toBeUndefined();
    expect(questionProps.onDismiss).toBeUndefined();
    act(() => inputProps.onSend("ignored"));
    fireEvent.click(screen.getByText("cancel"));
    expect(side.resumeHitl).not.toHaveBeenCalled();
    expect(side.cancelStream).not.toHaveBeenCalled();
    side.messages = [];
    side.isStreaming = true;
    rerender(<SideChatPanel {...panelProps} />);
    act(() => inputProps.onSend("ignored"));
    expect(side.sendMessage).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: /chat.sideChat.save/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps history visible on failure and retries the failed history operation", () => {
    side.historyError = true;
    render(<SideChatPanel {...props()} />);
    expect(screen.getByText("side history")).toBeTruthy();
    expect(screen.getByText("chat.sideChat.loadFailed")).toBeTruthy();
    fireEvent.click(screen.getByText("chat.sideChat.retry"));
    expect(side.retryHistory).toHaveBeenCalledOnce();
    expect(
      screen
        .getByRole("button", { name: /chat.sideChat.save/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("remounts composer and settings on thread or agent changes, including late history", async () => {
    let finishHistory: () => void = () => {};
    side.loadHistory.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishHistory = resolve;
        }),
    );
    const panelProps = props();
    const { rerender } = render(<SideChatPanel {...panelProps} />);
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "old draft" },
    });
    act(() => {
      inputProps.onModelChange?.("provider/local-override");
      inputProps.onReasoningChange?.("disabled", null);
      inputProps.onConversationModeChange?.("ask");
      inputProps.onHitlPolicyChange?.({ mode: "allow_all" });
    });
    const first = side;
    side = chat([
      {
        id: "b",
        role: "assistant",
        content: "new history",
        timestamp: 1,
        status: "done",
      },
    ]);
    const nextThread = {
      ...thread,
      thread_id: "side-b",
      model_ref: "provider/model-b",
    };
    rerender(<SideChatPanel {...panelProps} thread={nextThread} />);
    await act(async () => finishHistory());
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("side history")).toBeNull();
    expect(screen.getByText("new history")).toBeTruthy();
    expect(inputProps.selectedModel).toBe("provider/model-b");
    expect(inputProps.reasoningMode).toBe("enabled");
    expect(inputProps.conversationMode).toBe("plan");
    expect(inputProps.hitlPolicy).toEqual(thread.hitl_policy);
    expect(side.loadHistory).toHaveBeenCalledWith("side-b");
    act(() => inputProps.onSend("new side"));
    expect(side.sendMessage.mock.calls[0][4]).toBe("side-b");
    expect(first.sendMessage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "agent-a draft" },
    });
    rerender(
      <SideChatPanel {...panelProps} thread={nextThread} agentId="agent-b" />,
    );
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("");
    expect(mocks.useChat).toHaveBeenLastCalledWith(
      "side-b",
      "agent-b",
      false,
      true,
    );
  });
});
