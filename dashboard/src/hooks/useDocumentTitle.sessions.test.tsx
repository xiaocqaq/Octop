import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emitSessionEvent } from "../pages/Chat/hooks/chatStore";
import {
  resetSessionStoreForTests,
  useSessions,
} from "../pages/Chat/hooks/useSessions";
import { useChatDocumentTitle, useSiteDocumentTitle } from "./useDocumentTitle";

const createMock = vi.fn();

vi.mock("../api/modules/octopThreads", () => ({
  octopThreadsApi: {
    list: vi.fn().mockResolvedValue([]),
    create: (...args: unknown[]) => createMock(...args),
  },
  normalizeThreadArtifacts: () => [],
}));

afterEach(() => {
  resetSessionStoreForTests();
});

it("keeps a real delayed side rename off the pending main tab, then follows the created main thread", async () => {
  resetSessionStoreForTests();
  let finishCreate!: (created: { thread_id: string }) => void;
  createMock.mockReturnValue(
    new Promise<{ thread_id: string }>((resolve) => {
      finishCreate = resolve;
    }),
  );
  const { result, rerender } = renderHook(
    ({ threadId }) => {
      const sessions = useSessions("same-expert");
      const currentSession = sessions.sessions.find((s) => s.id === threadId);
      useSiteDocumentTitle("Mxiao");
      useChatDocumentTitle(currentSession?.name, "Mxiao", threadId);
      return sessions;
    },
    { initialProps: { threadId: "__pending__" } },
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  let creating!: ReturnType<typeof result.current.createSession>;
  act(() => {
    creating = result.current.createSession();
  });
  expect(document.title).toBe("Mxiao");
  act(() => {
    emitSessionEvent({
      kind: "sessionRenamed",
      sessionId: "unlisted-side-thread",
      agentId: "same-expert",
      title: "Delayed side title",
    });
  });
  expect(result.current.sessions[0]?.name).toBe("Delayed side title");
  expect(document.title).toBe("Mxiao");

  await act(async () => {
    finishCreate({ thread_id: "created-main-thread" });
    await creating.resolvedId;
  });
  rerender({ threadId: "created-main-thread" });
  expect(document.title).toBe("Mxiao");
  act(() => {
    emitSessionEvent({
      kind: "sessionRenamed",
      sessionId: "created-main-thread",
      agentId: "same-expert",
      title: "Main conversation",
    });
  });
  expect(document.title).toBe("Main conversation");
});
