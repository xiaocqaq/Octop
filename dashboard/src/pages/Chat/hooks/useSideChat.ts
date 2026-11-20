import { useCallback, useEffect, useRef, useState } from "react";
import {
  octopThreadsApi,
  type OctopThread,
} from "../../../api/modules/octopThreads";
import { isNotFoundApiError, parseApiError } from "../../../utils/apiError";
import * as chatStore from "./chatStore";

interface SideChatEntry {
  agentId: string;
  thread: OctopThread;
  saved: boolean;
  persisting?: Promise<void>;
  discarding?: Promise<void>;
}

function discardSideChat(entry: SideChatEntry): Promise<void> {
  entry.discarding ??= deleteSideChat(entry).catch((error) => {
    entry.discarding = undefined;
    throw error;
  });
  return entry.discarding;
}

async function deleteSideChat(entry: SideChatEntry): Promise<void> {
  // A navigation racing Save must never delete the newly saved conversation.
  await entry.persisting?.catch(() => undefined);
  if (entry.saved) return;
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

/** A temporary child belongs to the currently open parent, never its sidebar binding. */
export function useSideChat(
  agentId: string | null,
  sourceThreadId: string | null,
) {
  const [thread, setThread] = useState<OctopThread | null>(null);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const entryRef = useRef<SideChatEntry | null>(null);
  const operationRef = useRef(false);
  const generationRef = useRef(0);
  const scopeRef = useRef({ agentId, sourceThreadId });
  scopeRef.current = { agentId, sourceThreadId };

  useEffect(() => {
    setThread(null);
    setOpening(false);
    setClosing(false);
    setSaving(false);
    operationRef.current = false;
    return () => {
      generationRef.current += 1;
      const entry = entryRef.current;
      entryRef.current = null;
      if (entry) {
        // TTL is the fallback if navigation or a network failure interrupts cleanup.
        void discardSideChat(entry).catch(() => {
          chatStore.removeSession(entry.thread.thread_id);
        });
      }
    };
  }, [agentId, sourceThreadId]);

  const open = useCallback(async () => {
    if (!agentId || !sourceThreadId || operationRef.current || entryRef.current)
      return false;
    const generation = generationRef.current;
    operationRef.current = true;
    setOpening(true);
    try {
      const created = await octopThreadsApi.createSideChat(
        agentId,
        sourceThreadId,
      );
      const entry: SideChatEntry = { agentId, thread: created, saved: false };
      if (
        generation !== generationRef.current ||
        scopeRef.current.agentId !== agentId ||
        scopeRef.current.sourceThreadId !== sourceThreadId
      ) {
        await discardSideChat(entry).catch(() =>
          chatStore.removeSession(created.thread_id),
        );
        return false;
      }
      entryRef.current = entry;
      setThread(created);
      return true;
    } finally {
      if (generation === generationRef.current) {
        operationRef.current = false;
        setOpening(false);
      }
    }
  }, [agentId, sourceThreadId]);

  const close = useCallback(async () => {
    const entry = entryRef.current;
    if (!entry || operationRef.current) return;
    const generation = generationRef.current;
    operationRef.current = true;
    setClosing(true);
    try {
      await discardSideChat(entry);
      if (entryRef.current === entry) {
        entryRef.current = null;
        setThread(null);
      }
    } finally {
      if (generation === generationRef.current) {
        operationRef.current = false;
        setClosing(false);
      }
    }
  }, []);

  const persist = useCallback(async () => {
    const entry = entryRef.current;
    if (!entry || operationRef.current) return false;
    const generation = generationRef.current;
    operationRef.current = true;
    setSaving(true);
    entry.persisting = (async () => {
      await octopThreadsApi.persistSideChat(
        entry.agentId,
        entry.thread.thread_id,
      );
      entry.saved = true;
    })();
    try {
      await entry.persisting;
      if (entryRef.current === entry) {
        entryRef.current = null;
        setThread(null);
      }
      return true;
    } finally {
      if (generation === generationRef.current) {
        operationRef.current = false;
        setSaving(false);
      }
    }
  }, []);

  return { thread, opening, closing, saving, open, close, persist };
}
