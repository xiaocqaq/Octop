import { afterEach, describe, expect, it, vi } from "vitest";
import { requestUpload } from "./request";

vi.mock("./config", () => ({ getApiUrl: (path: string) => "/api" + path }));
vi.mock("../i18n", () => ({ default: { language: "en" } }));

class MockXhr {
  static current: MockXhr;
  upload = {};
  timeout = 0;
  onloadend?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => {
    this.onabort?.();
    this.onloadend?.();
  });
  constructor() {
    MockXhr.current = this;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestUpload", () => {
  it("rejects a timed out request so the caller can release its upload slot", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXhr);
    const upload = requestUpload("/upload", new FormData(), {
      timeoutMs: 60_000,
    });
    const xhr = MockXhr.current;
    const timeout = xhr.timeout;
    if (xhr.ontimeout) xhr.ontimeout();
    else xhr.onerror?.();
    await expect(upload).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toBe(60_000);
  });
  it("releases the abort listener when an upload ends", async () => {
    vi.stubGlobal("XMLHttpRequest", MockXhr);
    const controller = new AbortController();
    const upload = requestUpload("/upload", new FormData(), {
      signal: controller.signal,
    });
    const xhr = MockXhr.current;
    xhr.onerror?.();
    xhr.onloadend?.();
    await expect(upload).rejects.toThrow("Network error");
    controller.abort();
    expect(xhr.abort).not.toHaveBeenCalled();
  });
});
