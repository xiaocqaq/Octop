import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSideChat } from "./useSideChat";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  persist: vi.fn(),
  remove: vi.fn(),
  cancel: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("../../../api/modules/octopThreads", () => ({
  octopThreadsApi: {
    createSideChat: mocks.create,
    persistSideChat: mocks.persist,
    delete: mocks.remove,
  },
}));
vi.mock("./chatStore", () => ({
  cancelStream: mocks.cancel,
  removeSession: mocks.clear,
}));

const child = {
  thread_id: "side-1",
  title: null,
  channel_type: "dashboard",
  session_key: "agent:dashboard:user:sidechat:side-1",
  last_active: 1,
  created_at: 1,
  side_chat: true,
  expires_at: 86401,
  source_thread_id: "parent",
  copied_messages: 2,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("useSideChat lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockReset().mockResolvedValue(child);
    mocks.persist.mockReset().mockResolvedValue({ ...child, expires_at: null });
    mocks.remove.mockReset().mockResolvedValue({});
  });

  it("creates only one child from the current parent and closes only that child", async () => {
    const { result } = renderHook(() => useSideChat("agent", "parent"));
    await act(async () => {
      await Promise.all([result.current.open(), result.current.open()]);
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith("agent", "parent");
    expect(result.current.thread?.thread_id).toBe("side-1");
    await act(async () => {
      await result.current.close();
    });
    expect(mocks.cancel).toHaveBeenCalledWith("side-1", {
      agentId: "agent",
      threadId: "side-1",
    });
    expect(mocks.remove).toHaveBeenCalledWith("agent", "side-1", false, true);
    expect(result.current.thread).toBeNull();
  });

  it("preserves a saved child after the parent unmounts", async () => {
    const { result, unmount } = renderHook(() =>
      useSideChat("agent", "parent"),
    );
    await act(async () => {
      await result.current.open();
    });
    await act(async () => {
      expect(await result.current.persist()).toBe(true);
    });
    expect(mocks.persist).toHaveBeenCalledWith("agent", "side-1");
    expect(result.current.thread).toBeNull();
    unmount();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("retains the pane for retry when saving fails", async () => {
    const { result } = renderHook(() => useSideChat("agent", "parent"));
    await act(async () => {
      await result.current.open();
    });
    mocks.persist.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(result.current.persist()).rejects.toThrow("offline");
    });
    expect(result.current.thread?.thread_id).toBe("side-1");
    expect(result.current.saving).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("uses protected cleanup after a save response is lost", async () => {
    const { result } = renderHook(() => useSideChat("agent", "parent"));
    await act(async () => {
      await result.current.open();
    });
    mocks.persist.mockRejectedValueOnce(new Error("response lost"));
    await act(async () => {
      await expect(result.current.persist()).rejects.toThrow("response lost");
    });
    await act(async () => {
      await result.current.close();
    });
    expect(mocks.remove).toHaveBeenCalledWith("agent", "side-1", false, true);
    expect(result.current.thread).toBeNull();
  });

  it("retains the pane if deletion fails instead of reporting a successful close", async () => {
    const { result } = renderHook(() => useSideChat("agent", "parent"));
    await act(async () => {
      await result.current.open();
    });
    mocks.remove.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(result.current.close()).rejects.toThrow("offline");
    });
    expect(result.current.thread?.thread_id).toBe("side-1");
    expect(result.current.closing).toBe(false);
  });

  it("discards a creation response that arrives after changing parent", async () => {
    const pending = deferred<typeof child>();
    mocks.create.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ parent }) => useSideChat("agent", parent),
      { initialProps: { parent: "parent" } },
    );
    let opened!: Promise<boolean>;
    act(() => {
      opened = result.current.open();
    });
    rerender({ parent: "other" });
    await act(async () => {
      pending.resolve(child);
      expect(await opened).toBe(false);
    });
    expect(result.current.thread).toBeNull();
    expect(mocks.remove).toHaveBeenCalledWith("agent", "side-1", false, true);
  });

  it("waits for an in-flight save before navigation cleanup decides whether to delete", async () => {
    const pending = deferred<object>();
    const { result, rerender } = renderHook(
      ({ parent }) => useSideChat("agent", parent),
      { initialProps: { parent: "parent" } },
    );
    await act(async () => {
      await result.current.open();
    });
    mocks.persist.mockReturnValueOnce(pending.promise);
    let saved!: Promise<boolean>;
    act(() => {
      saved = result.current.persist();
    });
    rerender({ parent: "other" });
    await act(async () => {
      pending.resolve({});
      await saved;
    });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(result.current.thread).toBeNull();
  });

  it("does not let an old save unlock a new creation after returning to the same parent", async () => {
    const oldSave = deferred<object>();
    const newCreation = deferred<typeof child>();
    const { result, rerender } = renderHook(
      ({ parent }) => useSideChat("agent", parent),
      { initialProps: { parent: "parent" } },
    );
    await act(async () => {
      await result.current.open();
    });
    mocks.persist.mockReturnValueOnce(oldSave.promise);
    let saved!: Promise<boolean>;
    act(() => {
      saved = result.current.persist();
    });
    rerender({ parent: "other" });
    rerender({ parent: "parent" });
    mocks.create.mockReturnValueOnce(newCreation.promise);
    let opened!: Promise<boolean>;
    act(() => {
      opened = result.current.open();
    });
    await act(async () => {
      oldSave.resolve({});
      await saved;
    });
    expect(result.current.opening).toBe(true);
    await act(async () => {
      expect(await result.current.open()).toBe(false);
    });
    expect(mocks.create).toHaveBeenCalledTimes(2);
    await act(async () => {
      newCreation.resolve({ ...child, thread_id: "side-2" });
      await opened;
    });
    expect(result.current.thread?.thread_id).toBe("side-2");
  });

  it("retries deletion while the side turn is finishing cancellation", async () => {
    const { result } = renderHook(() => useSideChat("agent", "parent"));
    await act(async () => {
      await result.current.open();
    });
    mocks.remove.mockRejectedValueOnce(
      new Error('409 - {"error":{"code":"THREAD_TURN_ACTIVE"}}'),
    );
    await act(async () => {
      await result.current.close();
    });
    expect(mocks.remove).toHaveBeenCalledTimes(2);
    expect(mocks.remove.mock.calls.every((args) => args[1] === "side-1")).toBe(
      true,
    );
    expect(result.current.thread).toBeNull();
  });

  it("shares cleanup when closing and navigating at the same time", async () => {
    const removed = deferred<object>();
    const { result, rerender } = renderHook(
      ({ parent }) => useSideChat("agent", parent),
      { initialProps: { parent: "parent" } },
    );
    await act(async () => {
      await result.current.open();
    });
    mocks.remove.mockReturnValueOnce(removed.promise);
    let closed!: Promise<void>;
    act(() => {
      closed = result.current.close();
    });
    rerender({ parent: "other" });
    await act(async () => {
      removed.resolve({});
      await closed;
    });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(result.current.thread).toBeNull();
  });

  it("cleans up an unsaved child when switching experts", async () => {
    const { result, rerender } = renderHook(
      ({ agent }) => useSideChat(agent, "parent"),
      { initialProps: { agent: "agent" } },
    );
    await act(async () => {
      await result.current.open();
    });
    rerender({ agent: "other-agent" });
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith("agent", "side-1", false, true),
    );
    expect(result.current.thread).toBeNull();
  });
});
