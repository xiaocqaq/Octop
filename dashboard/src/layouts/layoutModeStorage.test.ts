import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAYOUT_MODE_KEY,
  MINIMAL_NAV_PANE_KEY,
  loadLayoutMode,
  loadMinimalNavPane,
  saveLayoutMode,
  saveMinimalNavPane,
} from "../../src/layouts/layoutModeStorage";

describe("layoutModeStorage", () => {
  beforeEach(() => {
    localStorage.removeItem(LAYOUT_MODE_KEY);
    localStorage.removeItem(MINIMAL_NAV_PANE_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(LAYOUT_MODE_KEY);
    localStorage.removeItem(MINIMAL_NAV_PANE_KEY);
  });

  it("defaults to minimal layout and records pane without persisting", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    expect(loadLayoutMode()).toBe("minimal");
    expect(loadMinimalNavPane()).toBe("records");
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(LAYOUT_MODE_KEY)).toBeNull();
  });

  it.each(["classic", "minimal"] as const)(
    "preserves an explicitly saved %s layout",
    (mode) => {
      saveLayoutMode(mode);
      expect(loadLayoutMode()).toBe(mode);
      expect(localStorage.getItem(LAYOUT_MODE_KEY)).toBe(mode);
    },
  );

  it("uses minimal without persisting when storage reads throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    expect(loadLayoutMode()).toBe("minimal");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("persists layout mode and minimal pane", () => {
    saveLayoutMode("minimal");
    saveMinimalNavPane("settings");
    expect(loadLayoutMode()).toBe("minimal");
    expect(loadMinimalNavPane()).toBe("settings");
  });

  it("migrates briefly-shipped chat/nav aliases", () => {
    localStorage.setItem(MINIMAL_NAV_PANE_KEY, "chat");
    expect(loadMinimalNavPane()).toBe("records");
    localStorage.setItem(MINIMAL_NAV_PANE_KEY, "nav");
    expect(loadMinimalNavPane()).toBe("settings");
  });

  it("ignores invalid stored values", () => {
    localStorage.setItem(LAYOUT_MODE_KEY, "weird");
    localStorage.setItem(MINIMAL_NAV_PANE_KEY, "other");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    expect(loadLayoutMode()).toBe("minimal");
    expect(loadMinimalNavPane()).toBe("records");
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(LAYOUT_MODE_KEY)).toBe("weird");
  });
});
