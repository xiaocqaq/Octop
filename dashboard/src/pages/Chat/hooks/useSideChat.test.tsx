import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
let useSideChat: typeof import("./useSideChat").useSideChat;

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
  beforeEach(async () => {
    vi.resetModules();
    useSideChat = (await import("./useSideChat")).useSideChat;
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

  it("restores the same unsaved child after navigating away and back", async () => {
    const { result, rerender } = renderHook(
      ({ parent }) => useSideChat("agent", parent),
      { initialProps: { parent: "parent" } },
    );
    await act(async () => {
      await result.current.open();
    });
    rerender({ parent: "other" });
    expect(result.current.thread).toBeNull();
    rerender({ parent: "parent" });
    expect(result.current.thread?.thread_id).toBe("side-1");
    await act(async () => {
      expect(await result.current.open()).toBe(true);
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("keeps the child across hook unmount and remount", async () => {
    const first = renderHook(() => useSideChat("agent", "parent"));
    await act(async () => {
      await first.result.current.open();
    });
    first.unmount();
    const second = renderHook(() => useSideChat("agent", "parent"));
    expect(second.result.current.thread?.thread_id).toBe("side-1");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("hides and shows without deleting the child", async () => {
    const { result } = renderHook(() => useSideChat("agent", "parent"));
    await act(async () => {
      await result.current.open();
    });
    expect(result.current.visible).toBe(true);
    act(() => result.current.hide());
    expect(result.current.visible).toBe(false);
    expect(result.current.thread?.thread_id).toBe("side-1");
    act(() => result.current.show());
    expect(result.current.visible).toBe(true);
    expect(mocks.remove).not.toHaveBeenCalled();
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

  it("restores a late creation response when returning to its parent", async () => {
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
    expect(mocks.remove).not.toHaveBeenCalled();
    rerender({ parent: "parent" });
    expect(result.current.thread?.thread_id).toBe("side-1");
    expect(mocks.create).toHaveBeenCalledTimes(1);
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

  it("does not duplicate an entry while an old save is still in flight", async () => {
    const oldSave = deferred<object>();
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
    expect(result.current.thread?.thread_id).toBe("side-1");
    expect(result.current.opening).toBe(false);
    await act(async () => {
      expect(await result.current.open()).toBe(true);
      oldSave.resolve({});
      await saved;
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
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

  it("retains an unsaved child when switching experts", async () => {
    const { result, rerender } = renderHook(
      ({ agent }) => useSideChat(agent, "parent"),
      { initialProps: { agent: "agent" } },
    );
    await act(async () => {
      await result.current.open();
    });
    rerender({ agent: "other-agent" });
    await waitFor(() => expect(result.current.thread).toBeNull());
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("keeps identical agent and parent scopes separate for different owners", async () => {
    const { result, rerender } = renderHook(
      ({ owner }) => useSideChat("agent", "parent", owner),
      { initialProps: { owner: 1 } },
    );
    await act(async () => {
      await result.current.open();
    });
    rerender({ owner: 2 });
    expect(result.current.thread).toBeNull();
    mocks.create.mockResolvedValueOnce({ ...child, thread_id: "owner-2-side" });
    await act(async () => {
      await result.current.open();
    });
    expect(result.current.thread?.thread_id).toBe("owner-2-side");
    rerender({ owner: 1 });
    expect(result.current.thread?.thread_id).toBe("side-1");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("restores a hidden entry without carrying it into another parent", async () => {
    const { result, rerender } = renderHook(
      ({ parent }) => useSideChat("agent", parent),
      { initialProps: { parent: "parent" } },
    );
    await act(async () => {
      await result.current.open();
    });
    act(() => result.current.hide());
    rerender({ parent: "other" });
    expect(result.current.thread).toBeNull();
    expect(result.current.visible).toBe(false);
    rerender({ parent: "parent" });
    expect(result.current.thread?.thread_id).toBe("side-1");
    expect(result.current.visible).toBe(false);
    await act(async () => {
      await result.current.open();
    });
    expect(result.current.visible).toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("keeps pending creation through unmount and prevents duplicate creation on remount", async () => {
    const pending = deferred<typeof child>();
    mocks.create.mockReturnValueOnce(pending.promise);
    const first = renderHook(() => useSideChat("agent", "parent"));
    let opened!: Promise<boolean>;
    act(() => {
      opened = first.result.current.open();
    });
    first.unmount();
    const second = renderHook(() => useSideChat("agent", "parent"));
    expect(second.result.current.opening).toBe(true);
    await act(async () => {
      expect(await second.result.current.open()).toBe(false);
    });
    await act(async () => {
      pending.resolve(child);
      expect(await opened).toBe(false);
    });
    expect(second.result.current.thread?.thread_id).toBe("side-1");
    expect(second.result.current.opening).toBe(false);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("tracks pending creates independently for parallel parents", async () => {
    const pendingA = deferred<typeof child>();
    const pendingB = deferred<typeof child>();
    mocks.create
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);
    const { result, rerender } = renderHook(
      ({ parent }) => useSideChat("agent", parent),
      { initialProps: { parent: "parent" } },
    );
    let openedA!: Promise<boolean>;
    let openedB!: Promise<boolean>;
    act(() => {
      openedA = result.current.open();
    });
    rerender({ parent: "other" });
    expect(result.current.opening).toBe(false);
    act(() => {
      openedB = result.current.open();
    });
    await act(async () => {
      pendingA.resolve(child);
      expect(await openedA).toBe(false);
    });
    expect(result.current.thread).toBeNull();
    expect(result.current.opening).toBe(true);
    await act(async () => {
      pendingB.resolve({
        ...child,
        thread_id: "side-B",
        source_thread_id: "other",
      });
      expect(await openedB).toBe(true);
    });
    rerender({ parent: "parent" });
    expect(result.current.thread?.thread_id).toBe("side-1");
    expect(result.current.opening).toBe(false);
    rerender({ parent: "other" });
    expect(result.current.thread?.thread_id).toBe("side-B");
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it.each(["close", "persist"] as const)(
    "does not clear another parent's child when an old %s finishes",
    async (operation) => {
      const pending = deferred<object>();
      const { result, rerender } = renderHook(
        ({ parent }) => useSideChat("agent", parent),
        { initialProps: { parent: "parent" } },
      );
      await act(async () => {
        await result.current.open();
      });
      (operation === "close"
        ? mocks.remove
        : mocks.persist
      ).mockReturnValueOnce(pending.promise);
      let finished!: Promise<unknown>;
      act(() => {
        finished = result.current[operation]();
      });
      rerender({ parent: "other" });
      mocks.create.mockResolvedValueOnce({
        ...child,
        thread_id: "side-B",
        source_thread_id: "other",
      });
      await act(async () => {
        await result.current.open();
      });
      expect(result.current.closing).toBe(false);
      expect(result.current.saving).toBe(false);
      await act(async () => {
        pending.resolve({});
        await finished;
      });
      expect(result.current.thread?.thread_id).toBe("side-B");
      rerender({ parent: "parent" });
      expect(result.current.thread).toBeNull();
      expect(mocks.create).toHaveBeenCalledTimes(2);
    },
  );

  it("allows recreating an expired child after saving returns 404", async () => {
    const { result } = renderHook(() => useSideChat("agent", "parent"));
    await act(async () => {
      await result.current.open();
    });
    mocks.persist.mockRejectedValueOnce(
      new Error('404 - {"error":{"code":"THREAD_NOT_FOUND"}}'),
    );
    await act(async () => {
      await expect(result.current.persist()).rejects.toThrow("404");
    });
    expect(result.current.thread).toBeNull();
    mocks.create.mockResolvedValueOnce({ ...child, thread_id: "replacement" });
    await act(async () => {
      await result.current.open();
    });
    expect(result.current.thread?.thread_id).toBe("replacement");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("allows recreating after explicit close finds the expired child missing", async () => {
    const { result } = renderHook(() => useSideChat("agent", "parent"));
    await act(async () => {
      await result.current.open();
    });
    mocks.remove.mockRejectedValueOnce(
      new Error('404 - {"error":{"code":"THREAD_NOT_FOUND"}}'),
    );
    await act(async () => {
      await result.current.close();
    });
    expect(result.current.thread).toBeNull();
    await act(async () => {
      await result.current.open();
    });
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("allows retrying a failed create, close and save", async () => {
    const { result } = renderHook(() => useSideChat("agent", "parent"));
    mocks.create.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(result.current.open()).rejects.toThrow("offline");
    });
    expect(result.current.opening).toBe(false);
    await act(async () => {
      await result.current.open();
    });
    mocks.remove.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(result.current.close()).rejects.toThrow("offline");
    });
    mocks.persist.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(result.current.persist()).rejects.toThrow("offline");
    });
    await act(async () => {
      expect(await result.current.persist()).toBe(true);
    });
    expect(result.current.thread).toBeNull();
  });
  it("projects unsaved retained entries for the current owner", async () => {
    const { result, rerender } = renderHook(
      ({ parent, owner }) => useSideChat("agent", parent, owner),
      { initialProps: { parent: "parent-a", owner: 1 } },
    );
    await act(async () => {
      await result.current.open();
    });
    rerender({ parent: "parent-b", owner: 1 });
    await act(async () => {
      await result.current.open();
    });
    rerender({ parent: "parent-a", owner: 1 });
    expect(result.current.retainedChats).toEqual([
      expect.objectContaining({
        agentId: "agent",
        sourceThreadId: "parent-a",
        thread: expect.objectContaining({ thread_id: "side-1" }),
      }),
      expect.objectContaining({
        agentId: "agent",
        sourceThreadId: "parent-b",
        thread: expect.objectContaining({ thread_id: "side-1" }),
      }),
    ]);
    rerender({ parent: "parent-a", owner: 2 });
    expect(result.current.retainedChats).toEqual([]);
  });
});
