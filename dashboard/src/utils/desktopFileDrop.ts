/** CustomEvent the desktop shell dispatches after it has expanded dropped paths. */
export const DESKTOP_FILE_DROP_EVENT = "octop:desktop-file-drop";

export interface DesktopDropFileRef {
  name: string;
  url: string;
  type?: string;
  size?: number;
}

export interface DesktopFileDropDetail {
  files?: DesktopDropFileRef[];
  truncated?: boolean;
  max?: number;
}

type DesktopDropTargetEvent = Event & {
  __octopDesktopDropTarget?: HTMLElement | null;
  __octopDesktopDropClaimed?: boolean;
};

// undefined: no pending drop; null: its marked target became unavailable.
let lastMarkedTarget: HTMLElement | null | undefined;

function isVisibleTarget(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true")
      return false;
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
  }
  return true;
}

function targetFromEvent(event: Event): HTMLElement | null {
  const source = event.target;
  if (!(source instanceof Element)) return null;
  return source.closest<HTMLElement>("[data-file-drop-target]");
}

/** Records the last composer marked by the desktop shell. */
export function rememberDesktopDropTarget(element: HTMLElement) {
  if (isVisibleTarget(element)) lastMarkedTarget = element;
}

export function forgetDesktopDropTarget(element: HTMLElement) {
  if (lastMarkedTarget === element) lastMarkedTarget = null;
}

/** Resolve one composer for a native event. The result is cached per event. */
export function desktopDropTargetForEvent(event: Event): HTMLElement | null {
  const routed = event as DesktopDropTargetEvent;
  if ("__octopDesktopDropTarget" in routed)
    return routed.__octopDesktopDropTarget ?? null;
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("[data-file-drop-target]"),
  ).filter(isVisibleTarget);
  const direct = targetFromEvent(event);
  const focused = document.activeElement?.closest<HTMLElement>(
    "[data-file-drop-target]",
  );
  const marked = candidates.find((element) =>
    element.classList.contains("file-drop-target-active"),
  );
  const explicitTarget = direct || marked;
  const target = explicitTarget
    ? candidates.includes(explicitTarget)
      ? explicitTarget
      : null
    : lastMarkedTarget !== undefined
    ? lastMarkedTarget && candidates.includes(lastMarkedTarget)
      ? lastMarkedTarget
      : null
    : (focused && candidates.includes(focused) && focused) ||
      (candidates.length === 1 ? candidates[0] : null);
  // A delayed drop must never migrate from an unavailable target to another chat.
  lastMarkedTarget = undefined;
  routed.__octopDesktopDropTarget = target;
  return target;
}

export function claimDesktopDropEvent(event: Event): boolean {
  const routed = event as DesktopDropTargetEvent;
  if (routed.__octopDesktopDropClaimed) return false;
  routed.__octopDesktopDropClaimed = true;
  return true;
}

/** Fetch loopback URLs the desktop shell minted for a drop and turn them into File objects. */
export async function filesFromDesktopDrop(
  detail: DesktopFileDropDetail | null | undefined,
): Promise<File[]> {
  const refs = detail?.files ?? [];
  const files: File[] = [];
  for (const item of refs) {
    if (!item?.url || !item.name) continue;
    const response = await fetch(item.url);
    if (!response.ok) {
      throw new Error(`desktop drop fetch failed: ${response.status}`);
    }
    const blob = await response.blob();
    files.push(
      new File([blob], item.name, { type: item.type || blob.type || "" }),
    );
  }
  return files;
}
