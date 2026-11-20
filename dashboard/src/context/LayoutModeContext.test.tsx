import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAYOUT_MODE_KEY,
  MINIMAL_NAV_PANE_KEY,
} from "../layouts/layoutModeStorage";
import { LayoutModeProvider, useLayoutMode } from "./LayoutModeContext";

describe("LayoutModeContext", () => {
  beforeEach(() => {
    localStorage.removeItem(LAYOUT_MODE_KEY);
    localStorage.removeItem(MINIMAL_NAV_PANE_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(LAYOUT_MODE_KEY);
    localStorage.removeItem(MINIMAL_NAV_PANE_KEY);
  });

  it("falls back to minimal outside the provider", () => {
    const { result } = renderHook(() => useLayoutMode());

    expect(result.current.layoutMode).toBe("minimal");
  });

  it("starts in minimal with records without persisting a default", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useLayoutMode(), {
      wrapper: LayoutModeProvider,
    });

    expect(result.current.layoutMode).toBe("minimal");
    expect(result.current.minimalPane).toBe("records");
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(LAYOUT_MODE_KEY)).toBeNull();
  });

  it.each(["classic", "minimal"] as const)(
    "keeps an existing %s choice when the provider mounts",
    (mode) => {
      localStorage.setItem(LAYOUT_MODE_KEY, mode);
      const { result } = renderHook(() => useLayoutMode(), {
        wrapper: LayoutModeProvider,
      });

      expect(result.current.layoutMode).toBe(mode);
      expect(localStorage.getItem(LAYOUT_MODE_KEY)).toBe(mode);
    },
  );

  it("persists switching to classic for the next mount", () => {
    const first = renderHook(() => useLayoutMode(), {
      wrapper: LayoutModeProvider,
    });

    act(() => first.result.current.setLayoutMode("classic"));

    expect(first.result.current.layoutMode).toBe("classic");
    expect(localStorage.getItem(LAYOUT_MODE_KEY)).toBe("classic");
    first.unmount();

    const second = renderHook(() => useLayoutMode(), {
      wrapper: LayoutModeProvider,
    });
    expect(second.result.current.layoutMode).toBe("classic");
  });
});
