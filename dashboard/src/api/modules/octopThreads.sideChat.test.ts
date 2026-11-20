import { beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../request", () => ({ request }));
import { octopThreadsApi } from "./octopThreads";

beforeEach(() => request.mockClear());

describe("side chat API contracts", () => {
  it("creates and saves a branch using encoded thread-scoped endpoints", () => {
    octopThreadsApi.createSideChat("agent/a", "parent/b");
    octopThreadsApi.persistSideChat("agent/a", "side/c");
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/agents/agent%2Fa/threads/parent%2Fb/side-chat",
      { method: "POST" },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/agents/agent%2Fa/threads/side%2Fc/persist",
      { method: "POST" },
    );
  });

  it("protects automatic discard without changing ordinary deletion", () => {
    octopThreadsApi.delete("agent", "side", false, true);
    octopThreadsApi.delete("agent", "saved", false);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/agents/agent/threads/side?compact=false&temporary_only=true",
      { method: "DELETE" },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/agents/agent/threads/saved?compact=false",
      { method: "DELETE" },
    );
  });
});
