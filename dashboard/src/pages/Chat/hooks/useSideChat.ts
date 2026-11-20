import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  octopThreadsApi,
  type OctopThread,
} from "../../../api/modules/octopThreads";
import { isNotFoundApiError, parseApiError } from "../../../utils/apiError";
import * as chatStore from "./chatStore";

interface SideChatEntry {
  ownerId: number | null;
  agentId: string;
  sourceThreadId: string;
  thread: OctopThread | null;
  visible: boolean;
  opening: boolean;
  closing: boolean;
  saving: boolean;
}

export interface RetainedSideChat {
  readonly agentId: string;
  readonly sourceThreadId: string;
  readonly thread: OctopThread;
}

// Page-local memory only: the server remains responsible for the 24-hour TTL.
const entries = new Map<string, SideChatEntry>();
const listeners = new Set<() => void>();
let revision = 0;
function notify() {
  revision += 1;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function getSnapshot() {
  return revision;
}

async function deleteSideChat(entry: SideChatEntry): Promise<void> {
  if (!entry.thread) return;
  const id = entry.thread.thread_id;
  chatStore.cancelStream(id, { agentId: entry.agentId, threadId: id });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await octopThreadsApi.delete(entry.agentId, id, false, true);
      break;
    } catch (error) {
      if (isNotFoundApiError(error)) break;
      if (
        parseApiError(error)?.code !== "THREAD_TURN_ACTIVE" ||
        attempt >= 19
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  chatStore.removeSession(id);
}

/** A temporary child stays with its parent across navigation and page remounts. */
export function useSideChat(
  agentId: string | null,
  sourceThreadId: string | null,
  ownerId: number | null = null,
) {
  const key =
    agentId && sourceThreadId
      ? JSON.stringify([ownerId, agentId, sourceThreadId])
      : null;
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const entry = key ? entries.get(key) : undefined;
  const scopeRef = useRef(key);
  const mountedRef = useRef(true);
  scopeRef.current = key;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const open = useCallback(async () => {
    if (!key || !agentId || !sourceThreadId) return false;
    const existing = entries.get(key);
    if (existing) {
      existing.visible = true;
      notify();
      return !existing.opening && !existing.closing;
    }
    const next: SideChatEntry = {
      ownerId,
      agentId,
      sourceThreadId,
      thread: null,
      visible: true,
      opening: true,
      closing: false,
      saving: false,
    };
    entries.set(key, next);
    notify();
    try {
      next.thread = await octopThreadsApi.createSideChat(
        agentId,
        sourceThreadId,
      );
      return mountedRef.current && scopeRef.current === key;
    } catch (error) {
      if (entries.get(key) === next) entries.delete(key);
      throw error;
    } finally {
      next.opening = false;
      notify();
    }
  }, [agentId, key, ownerId, sourceThreadId]);

  const close = useCallback(async () => {
    const current = key ? entries.get(key) : undefined;
    if (
      !key ||
      !current ||
      current.opening ||
      current.closing ||
      current.saving
    )
      return;
    current.closing = true;
    notify();
    try {
      await deleteSideChat(current);
      if (entries.get(key) === current) entries.delete(key);
    } finally {
      current.closing = false;
      notify();
    }
  }, [key]);

  const persist = useCallback(async () => {
    const current = key ? entries.get(key) : undefined;
    if (
      !key ||
      !current?.thread ||
      current.opening ||
      current.closing ||
      current.saving
    )
      return false;
    current.saving = true;
    notify();
    try {
      await octopThreadsApi.persistSideChat(
        current.agentId,
        current.thread.thread_id,
      );
      if (entries.get(key) === current) entries.delete(key);
      return true;
    } catch (error) {
      if (isNotFoundApiError(error) && entries.get(key) === current) {
        entries.delete(key);
        chatStore.removeSession(current.thread.thread_id);
      }
      throw error;
    } finally {
      current.saving = false;
      notify();
    }
  }, [key]);

  const hide = useCallback(() => {
    const current = key ? entries.get(key) : undefined;
    if (current) {
      current.visible = false;
      notify();
    }
  }, [key]);
  const show = useCallback(() => {
    const current = key ? entries.get(key) : undefined;
    if (current) {
      current.visible = true;
      notify();
    }
  }, [key]);

  const retainedChats: readonly RetainedSideChat[] = Array.from(
    entries.values(),
  )
    .filter((candidate) => candidate.ownerId === ownerId && candidate.thread)
    .map((candidate) => ({
      agentId: candidate.agentId,
      sourceThreadId: candidate.sourceThreadId,
      thread: candidate.thread!,
    }));

  return {
    thread: entry?.thread ?? null,
    opening: entry?.opening ?? false,
    closing: entry?.closing ?? false,
    saving: entry?.saving ?? false,
    visible: entry?.visible ?? false,
    retainedChats,
    open,
    close,
    persist,
    hide,
    show,
  };
}
