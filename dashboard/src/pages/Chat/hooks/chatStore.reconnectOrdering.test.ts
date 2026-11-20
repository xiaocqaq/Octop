import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "i18next";
import zh from "../../../locales/zh.json";
import * as store from "./chatStore";
import { clearInflightTail } from "../utils/inflightTranscriptCache";

const session = "reconnect-ordering";
class Socket {
  static instances: Socket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor() {
    Socket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  frame(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

beforeEach(async () => {
  await i18n.init({ lng: "zh", resources: { zh: { translation: zh } } });
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  store.removeSession(session);
  clearInflightTail(session);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("ignores late frames and close events from a replaced socket", async () => {
  const first = store.sendTurn(
    session,
    "first",
    "agent",
    "",
    undefined,
    undefined,
    null,
    session,
  );
  await Promise.resolve();
  const old = Socket.instances[0];
  old.frame({ type: "turn.started", turn_id: "old" });
  old.frame({ type: "token", content: "first reply" });
  old.frame({ type: "turn.ended", turn_id: "old" });
  await first;
  store.appendUserMessage(session, {
    id: "new-user",
    role: "user",
    content: "next",
    timestamp: 1,
  });
  const second = store.sendTurn(
    session,
    "second",
    "agent",
    "",
    undefined,
    undefined,
    null,
    session,
  );
  await Promise.resolve();
  const current = Socket.instances[1];
  current.frame({
    type: "turn.started",
    turn_id: "new",
  });
  old.frame({ type: "token", content: "ghost old reply" });
  old.frame({ type: "turn.ended", turn_id: "old" });
  old.close();
  current.frame({ type: "turn.ended", turn_id: "old" });
  expect(store.getSnapshot(session).activeTurnId).toBe("new");
  expect(store.getSnapshot(session).isStreaming).toBe(true);
  expect(
    store.getSnapshot(session).messages.find((m) => m.id === "new-user")
      ?.localPending,
  ).toBe(true);
  current.frame({ type: "token", content: "second reply" });
  current.frame({ type: "turn.ended", turn_id: "new" });
  await second;
  expect(store.getSnapshot(session).messages.map((m) => m.content)).toEqual([
    "first reply",
    "next",
    "second reply",
  ]);
});

it("shows a failed turn fallback without discarding partial output", async () => {
  const sent = store.sendTurn(
    session,
    "question",
    "agent",
    "",
    undefined,
    undefined,
    null,
    session,
  );
  await Promise.resolve();
  const socket = Socket.instances[0];
  socket.frame({ type: "turn.started", turn_id: "failed-turn" });
  socket.frame({
    type: "token",
    content: "partial reply",
    turn_id: "failed-turn",
  });
  socket.frame({ type: "done" });
  socket.frame({ type: "turn.ended", turn_id: "failed-turn", failed: true });
  await sent;

  const state = store.getSnapshot(session);
  expect(
    state.messages.find((m) => m.content === "partial reply")?.status,
  ).toBe("done");
  const errors = state.messages.filter((m) => m.status === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]?.content).toBe(zh.chat.errorOccurred);
  expect(errors[0]?.errorInfo?.code).toBe("stream_error");
  expect(state.isStreaming).toBe(false);
  expect(state.activeTurnId).toBeNull();
});

it("does not duplicate a detailed error already received for the failed turn", async () => {
  const sent = store.sendTurn(
    session,
    "question",
    "agent",
    "",
    undefined,
    undefined,
    null,
    session,
  );
  await Promise.resolve();
  const socket = Socket.instances[0];
  socket.frame({ type: "turn.started", turn_id: "failed-turn" });
  // Receive the detailed chunk before the terminal protocol frame.
  store.ingestHarnessChunk(session, {
    type: "error",
    message: "provider failure",
  });
  socket.frame({ type: "turn.ended", turn_id: "failed-turn", failed: true });
  await sent;

  expect(
    store
      .getSnapshot(session)
      .messages.filter((m) => m.status === "error")
      .map((m) => m.content),
  ).toEqual(["provider failure"]);
});

it.each([true, false, undefined])(
  "keeps previous errors separate when the next turn ends with failed=%s",
  async (failed) => {
    store.setMessages(session, [
      {
        id: "old-error",
        role: "assistant",
        content: "old failure",
        status: "error",
        turnId: "old-turn",
        timestamp: 1,
      },
    ]);
    await store.attachThread(session, "agent", session);
    const socket = Socket.instances[0];
    socket.frame({ type: "turn.resumed", turn_id: "new-turn" });
    socket.frame({ type: "token", content: "new reply", turn_id: "new-turn" });
    socket.frame({ type: "turn.ended", turn_id: "new-turn", failed });

    const state = store.getSnapshot(session);
    const errors = state.messages.filter((m) => m.status === "error");
    expect(errors).toHaveLength(failed === true ? 2 : 1);
    expect(state.messages.find((m) => m.content === "new reply")?.status).toBe(
      "done",
    );
    if (failed === true) {
      expect(errors[1]?.turnId).toBe("new-turn");
      expect(errors[1]?.content).toBe(zh.chat.errorOccurred);
    }
    expect(state.isStreaming).toBe(false);
  },
);

it("does not duplicate a restored error after reconnecting to the same turn", async () => {
  store.setMessages(session, [
    {
      id: "error",
      role: "assistant",
      content: "provider failure",
      status: "error",
      turnId: "failed-turn",
      timestamp: 1,
    },
  ]);
  await store.attachThread(session, "agent", session);
  const socket = Socket.instances[0];
  socket.frame({ type: "turn.resumed", turn_id: "failed-turn" });
  socket.frame({ type: "turn.ended", turn_id: "failed-turn", failed: true });
  expect(store.getSnapshot(session).messages).toHaveLength(1);
});

it("seals a restored streaming bubble when the turn is already idle", async () => {
  store.setMessages(session, [
    {
      id: "u",
      role: "user",
      content: "问题",
      timestamp: 1,
      turnId: "turn-a",
    },
    {
      id: "a",
      role: "assistant",
      content: "半截",
      status: "streaming",
      timestamp: 2,
      turnId: "turn-a",
    },
  ]);
  const pending = store.attachThread(session, "agent", session);
  await pending;
  Socket.instances[0].frame({
    type: "turn_status",
    active: false,
    thread_id: session,
  });
  expect(store.getSnapshot(session).messages[1]?.status).toBe("done");
  expect(store.getSnapshot(session).isStreaming).toBe(false);
});

it("reconnects by subscribing without resending the user message", async () => {
  vi.useFakeTimers();
  const sent = store.sendTurn(
    session,
    "question",
    "agent",
    "",
    undefined,
    undefined,
    null,
    session,
  );
  await Promise.resolve();
  const old = Socket.instances[0];
  old.frame({ type: "token", content: "first" });
  old.close();
  await sent;
  await vi.advanceTimersByTimeAsync(400);
  const resumed = Socket.instances[1];
  expect(resumed).toBeDefined();
  expect(resumed.sent.map((row) => JSON.parse(row).type)).toEqual([
    "subscribe",
  ]);
  resumed.frame({
    type: "turn_status",
    active: true,
    thread_id: session,
  });
  old.frame({ type: "token", content: "ghost" });
  resumed.frame({ type: "token", content: " second" });
  resumed.frame({ type: "done" });
  expect(store.getSnapshot(session).messages.at(-1)?.content).toBe(
    "first second",
  );
  expect(store.getSnapshot(session).isStreaming).toBe(false);
});
