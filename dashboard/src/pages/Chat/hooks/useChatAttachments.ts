import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { uploadFile } from "../../../api/modules/upload";
import { primeAuthImageSrc } from "../../../hooks/useAuthImageSrc";
import {
  agentAttachmentAccessUrl,
  needsAuthBlobFetch,
} from "../../../utils/toolMediaBlocks";
import type { ChatAttachment } from "./useChat";
import { message as antMessage } from "@/utils/antdMessage";
import { apiErrorMessage } from "../../../utils/apiError";

import { inferAttachmentKind } from "../utils/chatAttachments";
import {
  DESKTOP_FILE_DROP_EVENT,
  claimDesktopDropEvent,
  desktopDropTargetForEvent,
  filesFromDesktopDrop,
  type DesktopFileDropDetail,
} from "../../../utils/desktopFileDrop";
import {
  dragHasFiles,
  filesFromSnapshot,
  MAX_CHAT_UPLOAD_FILES,
  snapshotDroppedEntries,
  type CollectedDrop,
} from "../utils/droppedFiles";
import { useServerUploadLimit } from "../../../hooks/useServerUploadLimit";

const CHAT_UPLOAD_CONCURRENCY = 4;

function newUploadDraft() {
  return {
    batches: 0,
    totalBytes: 0,
    processedBytes: 0,
    controller: new AbortController(),
  };
}

export interface UseChatAttachmentsOptions {
  canHandleDesktopDrop?: (target: HTMLElement | null) => boolean;
}

export function useChatAttachments(
  agentId: string | null | undefined,
  options: UseChatAttachmentsOptions = {},
) {
  const { t } = useTranslation();
  const { maxUploadBytes, maxUploadMb } = useServerUploadLimit();
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const uploadDraftRef = useRef(newUploadDraft());
  const uploadQueueRef = useRef<(() => Promise<void>)[]>([]);
  const activeUploadsRef = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const canHandleDesktopDrop = options.canHandleDesktopDrop;

  const runUploadQueue = useCallback(() => {
    while (activeUploadsRef.current < CHAT_UPLOAD_CONCURRENCY) {
      const job = uploadQueueRef.current.shift();
      if (!job) break;
      activeUploadsRef.current += 1;
      void job().finally(() => {
        activeUploadsRef.current -= 1;
        runUploadQueue();
      });
    }
  }, []);

  const resetUploads = useCallback(() => {
    const previous = uploadDraftRef.current;
    uploadDraftRef.current = newUploadDraft();
    previous.controller.abort();
    setUploadProgress(null);
  }, []);

  useEffect(() => {
    return () => {
      const previous = uploadDraftRef.current;
      uploadDraftRef.current = newUploadDraft();
      previous.controller.abort();
    };
  }, []);

  const finishUploadBatch = useCallback(
    (draft: ReturnType<typeof newUploadDraft>) => {
      draft.batches -= 1;
      if (uploadDraftRef.current === draft && draft.batches === 0) {
        draft.totalBytes = 0;
        draft.processedBytes = 0;
        setUploadProgress(null);
      }
    },
    [],
  );

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      const incoming = Array.from(files);
      const capped =
        incoming.length > MAX_CHAT_UPLOAD_FILES
          ? incoming.slice(0, MAX_CHAT_UPLOAD_FILES)
          : incoming;
      if (incoming.length > MAX_CHAT_UPLOAD_FILES) {
        antMessage.warning(
          t(
            "upload.tooMany",
            "Only the first {{max}} files can be uploaded at once",
            { max: MAX_CHAT_UPLOAD_FILES },
          ),
        );
      }
      const fileArr = capped.filter((f) => {
        if (f.size > maxUploadBytes) {
          antMessage.error(
            t("upload.tooLarge", "File too large (max {{maxMb}}MB): {{name}}", {
              name: f.name,
              maxMb: maxUploadMb,
            }),
          );
          return false;
        }
        return true;
      });

      if (fileArr.length === 0) return;

      if (!agentId) {
        antMessage.error(t("upload.failed", "Upload failed"));
        return;
      }

      const draft = uploadDraftRef.current;
      draft.batches += 1;
      const fileWeights = fileArr.map((file) => Math.max(1, file.size));
      draft.totalBytes += fileWeights.reduce((sum, size) => sum + size, 0);
      const updateProgress = () => {
        if (uploadDraftRef.current === draft) {
          setUploadProgress(
            Math.floor((draft.processedBytes / draft.totalBytes) * 100),
          );
        }
      };
      updateProgress();

      const uploads = fileArr.map((file, index) => {
        const weight = fileWeights[index];
        return new Promise<ChatAttachment | undefined>((resolve, reject) => {
          uploadQueueRef.current.push(async () => {
            if (uploadDraftRef.current !== draft) {
              resolve(undefined);
              return;
            }
            let accountedBytes = 0;
            const report = (percent: number) => {
              const bytes = (weight * percent) / 100;
              draft.processedBytes += bytes - accountedBytes;
              accountedBytes = bytes;
              updateProgress();
            };
            try {
              const res = await uploadFile(
                agentId,
                file,
                report,
                draft.controller.signal,
              );
              if (uploadDraftRef.current !== draft) {
                resolve(undefined);
                return;
              }
              const workspacePath = res.path || res.workspace_path;
              const previewUrl =
                res.access_url ||
                res.url ||
                (workspacePath
                  ? agentAttachmentAccessUrl(
                      agentId,
                      workspacePath,
                      res.media_type,
                    )
                  : "");
              const kind = inferAttachmentKind(file, res.media_type);
              if (
                kind === "image" &&
                file.type.startsWith("image/") &&
                file.type === res.media_type &&
                needsAuthBlobFetch(previewUrl)
              ) {
                primeAuthImageSrc(previewUrl, res.filename, file);
              }
              resolve({
                url: previewUrl,
                filename: res.filename,
                mediaType: res.media_type,
                workspacePath,
                kind,
              });
            } catch (err: unknown) {
              reject(err);
            } finally {
              report(100);
            }
          });
        });
      });
      runUploadQueue();
      const results = await Promise.allSettled(uploads);
      if (uploadDraftRef.current !== draft) return;

      const completed = results.flatMap((item) =>
        item.status === "fulfilled" && item.value ? [item.value] : [],
      );
      if (completed.length > 0) {
        setAttachments((prev) => [...prev, ...completed]);
      }
      const failed = results.find((item) => item.status === "rejected");
      if (failed) {
        antMessage.error(
          apiErrorMessage(
            failed.reason,
            t("upload.failed", "Upload failed"),
            t,
          ),
        );
      }
      finishUploadBatch(draft);
    },
    [
      agentId,
      maxUploadBytes,
      maxUploadMb,
      runUploadQueue,
      finishUploadBatch,
      t,
    ],
  );

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFolderSelect = useCallback(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.click();
  }, []);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        void processFiles(e.target.files);
      }
      e.target.value = "";
    },
    [processFiles],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAttachments = useCallback(() => {
    resetUploads();
    setAttachments([]);
  }, [resetUploads]);

  const restoreAttachments = useCallback(
    (next: ChatAttachment[]) => {
      resetUploads();
      setAttachments(next.map((a) => ({ ...a })));
    },
    [resetUploads],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const pastedFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        void processFiles(pastedFiles);
      }
    },
    [processFiles],
  );

  const handleDragEnter = useCallback((e: DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      const snapshot = snapshotDroppedEntries(e.dataTransfer);
      if (!snapshot.hadFileItems) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const draft = uploadDraftRef.current;
      draft.batches += 1;
      setUploadProgress((progress) => progress ?? 0);
      return (async () => {
        try {
          const collected: CollectedDrop = await filesFromSnapshot(snapshot);
          if (uploadDraftRef.current !== draft) return;
          if (collected.truncated) {
            antMessage.warning(
              t(
                "upload.tooMany",
                "Only the first {{max}} files can be uploaded at once",
                { max: MAX_CHAT_UPLOAD_FILES },
              ),
            );
          }
          if (collected.files.length === 0) {
            antMessage.warning(t("upload.emptyDrop", "No files to upload"));
            return;
          }
          await processFiles(collected.files);
        } catch {
          if (uploadDraftRef.current === draft)
            antMessage.error(t("upload.failed", "Upload failed"));
        } finally {
          finishUploadBatch(draft);
        }
      })();
    },
    [processFiles, finishUploadBatch, t],
  );

  useEffect(() => {
    const onDesktopDrop = (event: Event) => {
      const target = desktopDropTargetForEvent(event);
      if (canHandleDesktopDrop && !canHandleDesktopDrop(target)) return;
      if (!claimDesktopDropEvent(event)) return;
      const detail = (event as CustomEvent<DesktopFileDropDetail>).detail;
      const draft = uploadDraftRef.current;
      draft.batches += 1;
      setUploadProgress((progress) => progress ?? 0);
      setDragOver(false);
      void (async () => {
        if (detail?.truncated) {
          antMessage.warning(
            t(
              "upload.tooMany",
              "Only the first {{max}} files can be uploaded at once",
              { max: detail.max ?? 500 },
            ),
          );
        }
        try {
          const files = await filesFromDesktopDrop(detail);
          if (uploadDraftRef.current !== draft) return;
          if (files.length === 0) {
            antMessage.warning(t("upload.emptyDrop", "No files to upload"));
            return;
          }
          await processFiles(files);
        } catch {
          if (uploadDraftRef.current === draft)
            antMessage.error(t("upload.failed", "Upload failed"));
        } finally {
          finishUploadBatch(draft);
        }
      })();
    };
    window.addEventListener(DESKTOP_FILE_DROP_EVENT, onDesktopDrop);
    return () =>
      window.removeEventListener(DESKTOP_FILE_DROP_EVENT, onDesktopDrop);
  }, [processFiles, finishUploadBatch, t, canHandleDesktopDrop]);

  return {
    attachments,
    uploading: uploadProgress !== null,
    uploadProgress,
    dragOver,
    fileInputRef,
    folderInputRef,
    processFiles,
    handleFileSelect,
    handleFolderSelect,
    handleFileChange,
    removeAttachment,
    clearAttachments,
    restoreAttachments,
    handlePaste,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  };
}
