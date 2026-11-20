import { act, renderHook, waitFor } from "@testing-library/react";
import { requestBlob } from "../../../api/request";
import { useAuthImageSrc } from "../../../hooks/useAuthImageSrc";
import type { DragEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { message } from "@/utils/antdMessage";
import { uploadFile } from "../../../api/modules/upload";
import { DESKTOP_FILE_DROP_EVENT } from "../../../utils/desktopFileDrop";
import { useChatAttachments } from "./useChatAttachments";

vi.mock("../../../hooks/useServerUploadLimit", () => ({
  useServerUploadLimit: () => ({ maxUploadBytes: 1024, maxUploadMb: 1 }),
}));

vi.mock("../../../api/request", () => ({
  requestBlob: vi.fn(
    async () => new Blob(["server copy"], { type: "image/png" }),
  ),
}));

vi.mock("../../../api/modules/upload", () => ({
  uploadFile: vi.fn(),
}));

vi.mock("@/utils/antdMessage", () => ({
  message: { error: vi.fn(), warning: vi.fn() },
}));

function dragEvent(
  init: Partial<DragEvent<HTMLElement>> & { currentTarget?: HTMLElement },
): DragEvent<HTMLElement> {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { types: ["Files"], items: [], files: [] },
    relatedTarget: null,
    ...init,
  } as unknown as DragEvent<HTMLElement>;
}

describe("useChatAttachments drop", () => {
  beforeEach(() => {
    vi.mocked(uploadFile).mockReset();
    vi.mocked(message.error).mockReset();
    vi.mocked(message.warning).mockReset();
    vi.mocked(uploadFile).mockImplementation(async (_agentId, file) => ({
      path: `inbound/${file.name}`,
      workspace_path: `inbound/${file.name}`,
      filename: file.name,
      media_type: file.type || "application/octet-stream",
      url: "",
      access_url: `/files/${file.name}`,
    }));
  });

  it("uploads every file from one drop", async () => {
    const { result } = renderHook(() => useChatAttachments("agent-1"));
    const first = new File(["a"], "a.txt", { type: "text/plain" });
    const second = new File(["b"], "b.txt", { type: "text/plain" });
    const dropped = dragEvent({
      dataTransfer: {
        types: ["Files"],
        items: [
          { kind: "file", getAsFile: () => first },
          { kind: "file", getAsFile: () => second },
        ],
        files: [first, second],
      } as unknown as DataTransfer,
    });

    await act(async () => {
      await result.current.handleDrop(dropped);
    });

    await waitFor(() => {
      expect(result.current.attachments.map((item) => item.filename)).toEqual([
        "a.txt",
        "b.txt",
      ]);
    });
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(result.current.dragOver).toBe(false);
  });

  it("limits concurrent uploads across selections and reports byte progress", async () => {
    const { result } = renderHook(() => useChatAttachments("agent-1"));
    const files = Array.from(
      { length: 6 },
      (_, i) => new File(["x"], "file-" + i + ".txt"),
    );
    const finish: (() => void)[] = [];
    const makeResponse = vi.mocked(uploadFile).getMockImplementation()!;
    vi.mocked(uploadFile).mockImplementation(
      async (agentId, file, progress?: (percent: number) => void) => {
        progress?.(50);
        await new Promise<void>((resolve) => finish.push(resolve));
        return makeResponse(agentId, file);
      },
    );

    let batches: Promise<void>[] = [];
    act(() => {
      batches = [
        result.current.processFiles(files.slice(0, 5)),
        result.current.processFiles(files.slice(5)),
      ];
    });
    const initialUploads = finish.length;
    const initialProgress = result.current.uploadProgress;
    await act(async () => {
      finish.splice(0).forEach((done) => done());
    });
    const stillUploading = result.current.uploading;
    await act(async () => {
      finish.splice(0).forEach((done) => done());
      await Promise.all(batches);
    });

    expect(initialUploads).toBe(4);
    expect(initialProgress).toBe(33);
    expect(stillUploading).toBe(true);
    expect(result.current.uploading).toBe(false);
    expect(result.current.attachments.map((item) => item.filename)).toEqual(
      files.map((file) => file.name),
    );
  });

  it("keeps successful attachments when another file fails", async () => {
    const { result } = renderHook(() => useChatAttachments("agent-1"));
    vi.mocked(uploadFile).mockRejectedValueOnce(new Error("broken"));
    await act(async () => {
      await result.current.processFiles([
        new File(["bad"], "bad.txt"),
        new File(["ok"], "ok.txt"),
      ]);
    });

    expect(result.current.attachments.map((item) => item.filename)).toEqual([
      "ok.txt",
    ]);
    expect(message.error).toHaveBeenCalledOnce();
  });

  it("ignores a late response after the draft is cleared", async () => {
    const { result } = renderHook(() => useChatAttachments("agent-1"));
    let finish!: () => void;
    const makeResponse = vi.mocked(uploadFile).getMockImplementation()!;
    vi.mocked(uploadFile).mockImplementationOnce(async (agentId, file) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return makeResponse(agentId, file);
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.processFiles([new File(["old"], "old.txt")]);
      result.current.clearAttachments();
    });
    await act(async () => {
      finish();
      await pending;
    });

    expect(result.current.attachments).toEqual([]);
    expect(result.current.uploading).toBe(false);
  });

  it("cancels old requests so a cleared draft cannot block the next upload", async () => {
    const { result } = renderHook(() => useChatAttachments("agent-1"));
    const makeResponse = vi.mocked(uploadFile).getMockImplementation()!;
    const signals: (AbortSignal | undefined)[] = [];
    vi.mocked(uploadFile).mockImplementation(
      async (agentId, file, _progress, signal) => {
        if (file.name.startsWith("old")) {
          signals.push(signal);
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        return makeResponse(agentId, file);
      },
    );
    let oldBatch!: Promise<void>;
    act(() => {
      oldBatch = result.current.processFiles(
        Array.from(
          { length: 4 },
          (_, index) => new File(["old"], "old-" + index + ".txt"),
        ),
      );
    });
    act(() => {
      result.current.clearAttachments();
    });
    let nextBatch!: Promise<void>;
    act(() => {
      nextBatch = result.current.processFiles([new File(["new"], "new.txt")]);
    });
    await waitFor(() =>
      expect(result.current.attachments.map((item) => item.filename)).toEqual([
        "new.txt",
      ]),
    );
    await act(async () => {
      await Promise.all([oldBatch, nextBatch]);
    });
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    expect(message.error).not.toHaveBeenCalled();
  });

  it("marks a dropped directory busy while the browser reads its entries", async () => {
    const { result } = renderHook(() => useChatAttachments("agent-1"));
    let finish!: (entries: FileSystemEntry[]) => void;
    const directory = {
      isDirectory: true,
      isFile: false,
      name: "folder",
      fullPath: "/folder",
      createReader: () => ({
        readEntries: (success: typeof finish) => {
          finish = success;
        },
      }),
    };
    let pending: unknown;
    act(() => {
      pending = result.current.handleDrop(
        dragEvent({
          dataTransfer: {
            types: ["Files"],
            items: [
              {
                kind: "file",
                webkitGetAsEntry: () => directory,
                getAsFile: () => null,
              },
            ],
            files: [],
          } as unknown as DataTransfer,
        }),
      );
    });
    const busyWhileReading = result.current.uploading;
    await act(async () => {
      finish([]);
      await pending;
    });
    expect(busyWhileReading).toBe(true);
    expect(result.current.uploading).toBe(false);
  });

  it("marks desktop files busy before their bytes have been read", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    try {
      const { result } = renderHook(() => useChatAttachments("agent-1"));
      act(() => {
        window.dispatchEvent(
          new CustomEvent(DESKTOP_FILE_DROP_EVENT, {
            detail: {
              files: [
                {
                  name: "note.txt",
                  url: "http://127.0.0.1:9/drop/token/0",
                  type: "text/plain",
                },
              ],
            },
          }),
        );
      });
      const busyWhileReading = result.current.uploading;
      await act(async () => {
        finish(
          new Response("note", { headers: { "Content-Type": "text/plain" } }),
        );
      });
      await waitFor(() => expect(result.current.attachments).toHaveLength(1));
      expect(busyWhileReading).toBe(true);
      expect(result.current.uploading).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("previews an uploaded image without downloading its server copy", async () => {
    const accessUrl =
      "/api/agents/agent-1/media/preview?source=inbound%2Fpreview.png";
    const file = new File(["local copy"], "preview.png", { type: "image/png" });
    vi.mocked(uploadFile).mockResolvedValueOnce({
      path: "inbound/preview.png",
      workspace_path: "inbound/preview.png",
      filename: file.name,
      media_type: file.type,
      url: accessUrl,
      access_url: accessUrl,
    });
    class ObjectUrl extends URL {
      static createObjectURL = vi.fn(() => "blob:preview");
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", ObjectUrl);
    try {
      const { result } = renderHook(() => {
        const composer = useChatAttachments("agent-1");
        const image = composer.attachments[0];
        const preview = useAuthImageSrc(image?.url ?? "", image?.filename);
        return { composer, preview };
      });
      await act(async () => {
        await result.current.composer.processFiles([file]);
      });
      expect(result.current.composer.attachments[0]?.url).toBe(accessUrl);
      expect(result.current.preview.src).toBe("blob:preview");
      expect(requestBlob).not.toHaveBeenCalled();
      expect(ObjectUrl.createObjectURL).toHaveBeenCalledWith(file);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the drop highlight while the pointer is still inside the composer", () => {
    const { result } = renderHook(() => useChatAttachments("agent-1"));
    const shell = document.createElement("div");
    const field = document.createElement("textarea");
    shell.appendChild(field);

    act(() => {
      result.current.handleDragEnter(
        dragEvent({
          currentTarget: shell,
          dataTransfer: { types: ["Files"] } as DataTransfer,
        }),
      );
    });
    expect(result.current.dragOver).toBe(true);

    act(() => {
      result.current.handleDragLeave(
        dragEvent({ currentTarget: shell, relatedTarget: field }),
      );
    });
    expect(result.current.dragOver).toBe(true);

    act(() => {
      result.current.handleDragLeave(
        dragEvent({ currentTarget: shell, relatedTarget: document.body }),
      );
    });
    expect(result.current.dragOver).toBe(false);
  });

  it("does not highlight a text drag", () => {
    const { result } = renderHook(() => useChatAttachments("agent-1"));
    const event = dragEvent({
      dataTransfer: {
        types: ["text/plain"],
        items: [],
        files: [],
      } as unknown as DataTransfer,
    });

    act(() => {
      result.current.handleDragEnter(event);
    });

    expect(result.current.dragOver).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("warns when a dropped folder has no files", async () => {
    const { result } = renderHook(() => useChatAttachments("agent-1"));
    const emptyDir = {
      isFile: false,
      isDirectory: true,
      name: "empty",
      fullPath: "/empty",
      createReader: () => ({
        readEntries(success: (entries: FileSystemEntry[]) => void) {
          success([]);
        },
      }),
    };
    const dropped = dragEvent({
      dataTransfer: {
        types: ["Files"],
        items: [
          {
            kind: "file",
            webkitGetAsEntry: () => emptyDir,
            getAsFile: () => null,
          },
        ],
        files: [],
      } as unknown as DataTransfer,
    });

    await act(async () => {
      await result.current.handleDrop(dropped);
    });

    expect(uploadFile).not.toHaveBeenCalled();
    expect(message.warning).toHaveBeenCalledWith("No files to upload");
  });

  it("uploads files delivered by the desktop shell", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("note", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );
    const { result } = renderHook(() => useChatAttachments("agent-1"));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(DESKTOP_FILE_DROP_EVENT, {
          detail: {
            files: [
              {
                name: "note.txt",
                url: "http://127.0.0.1:9/drop/token/0",
                type: "text/plain",
              },
            ],
            truncated: true,
            max: 500,
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.attachments.map((item) => item.filename)).toEqual([
        "note.txt",
      ]);
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(message.warning).toHaveBeenCalledWith(
      "Only the first 500 files can be uploaded at once",
    );
    expect(result.current.dragOver).toBe(false);
    vi.unstubAllGlobals();
  });
});
