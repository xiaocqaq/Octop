import { describe, expect, it } from "vitest";
import {
  agentAttachmentAccessUrl,
  agentMediaPreviewUrl,
  canonicalizeMediaApiUrl,
  collectToolMediaFromToolData,
  isHostAbsoluteMediaPath,
  needsAuthBlobFetch,
  parseStructuredToolOutput,
  parseToolExecutionFeedback,
  toMediaPreviewSource,
  workspaceDownloadUrl,
} from "./toolMediaBlocks";

describe("workspaceDownloadUrl", () => {
  it("keeps host-absolute paths as-is", () => {
    const url = workspaceDownloadUrl("main", "/Users/me/Desktop/a.pptx");
    expect(url).toContain("path=%2FUsers%2Fme%2FDesktop%2Fa.pptx");
  });

  it("rewrites legacy /outbound/… to relative workspace keys", () => {
    const url = workspaceDownloadUrl("main", "/outbound/chart.png");
    expect(url).toContain("path=outbound%2Fchart.png");
    expect(url).not.toContain("path=%2Foutbound");
  });

  it("passes relative outbound without adding a slash", () => {
    const url = workspaceDownloadUrl("main", "outbound/chart.png");
    expect(url).toContain("path=outbound%2Fchart.png");
  });
});

describe("canonicalizeMediaApiUrl", () => {
  it("rewrites stored download links with /outbound/ path", () => {
    const raw =
      "/api/agents/main/workspace/download?path=%2Foutbound%2Fchart.png";
    const next = canonicalizeMediaApiUrl(raw);
    expect(next).toContain("path=outbound%2Fchart.png");
    expect(next).not.toContain("path=%2Foutbound");
  });
});

describe("isHostAbsoluteMediaPath", () => {
  it("treats /outbound as workspace key, not host abs", () => {
    expect(isHostAbsoluteMediaPath("/outbound/a.png")).toBe(false);
    expect(isHostAbsoluteMediaPath("/Users/me/a.png")).toBe(true);
  });
});

describe("toMediaPreviewSource", () => {
  it("does not wrap workspace tree keys as host file:// paths", () => {
    expect(
      toMediaPreviewSource("/octop-logo.png", {
        agentId: "ED7N8B",
        fromWorkspace: true,
      }),
    ).toBe("octop-logo.png");
    expect(
      toMediaPreviewSource("/generated/slide.png", { fromWorkspace: true }),
    ).toBe("generated/slide.png");
  });

  it("keeps agent-home host abs as file:// for chat/tools (virtual failback)", () => {
    expect(
      toMediaPreviewSource("/Users/me/.octop/agents/ED7N8B/octop-logo.png", {
        agentId: "ED7N8B",
      }),
    ).toBe("file:///Users/me/.octop/agents/ED7N8B/octop-logo.png");
    expect(
      toMediaPreviewSource("file:///tmp/x/outbound/chart.png", {
        agentId: "main",
      }),
    ).toBe("outbound/chart.png");
  });

  it("keeps real host temps as file:// when not inside agent home", () => {
    expect(toMediaPreviewSource("/Users/me/Desktop/a.png")).toBe(
      "file:///Users/me/Desktop/a.png",
    );
  });

  it("feeds agentMediaPreviewUrl file:// for agent-home pngs from chat", () => {
    const url = agentMediaPreviewUrl(
      "ED7N8B",
      "/Users/me/.octop/agents/ED7N8B/octop-logo.png",
      "image/png",
    );
    expect(url).toContain("source=file");
    expect(url).toContain("octop-logo.png");
  });
});

describe("needsAuthBlobFetch", () => {
  it("requires auth for uploaded expert avatars", () => {
    expect(needsAuthBlobFetch("/api/agents/agt_1/avatar")).toBe(true);
    expect(needsAuthBlobFetch("/api/agents/agt_1/avatar?v=9")).toBe(true);
    expect(needsAuthBlobFetch("/api/experts/published/pexp_1/avatar")).toBe(
      true,
    );
    expect(needsAuthBlobFetch("/api/experts/published/pexp_1/avatar?v=9")).toBe(
      true,
    );
    expect(needsAuthBlobFetch("https://cdn.example.com/icon.png")).toBe(false);
    expect(needsAuthBlobFetch("/api/plugins/weather/ui/icon.svg")).toBe(true);
    expect(needsAuthBlobFetch("/api/plugins/market/weather/ui/icon.svg")).toBe(
      true,
    );
    expect(needsAuthBlobFetch("/api/plugins/weather/ui/dist/index.js")).toBe(
      false,
    );
  });
});

describe("parseStructuredToolOutput", () => {
  it("renders WorkBuddy image generation envelopes from workspace paths", () => {
    const parsed = parseStructuredToolOutput(
      JSON.stringify({
        type: "image_gen_tool_result",
        images: [
          {
            path: "generated/images/a.png",
            localPath: "/private/a.png",
            mediaType: "image/png",
          },
        ],
      }),
      "agent-1",
    );

    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].url).toContain("/api/agents/agent-1/media/preview");
    expect(parsed.images[0].url).toContain("generated%2Fimages%2Fa.png");
  });

  it("keeps actionable feedback when a generation envelope has no media", () => {
    const output = JSON.stringify({
      schema_version: 1,
      type: "image_gen_tool_result",
      status: "failed",
      is_error: true,
      message: "The configured image model is not enabled.",
      error: {
        code: "model_access_required",
        retryable: false,
        safe_to_resubmit: false,
      },
      remediation: { action: "configure_model" },
      execution: { provider: "volcengine_ark", model: "seedream" },
      images: [],
    });

    const parsed = parseStructuredToolOutput(output, "agent-1");
    expect(parsed.images).toEqual([]);
    expect(parsed.textOutput).toBe(
      "The configured image model is not enabled.",
    );
    expect(parsed.feedback).toMatchObject({
      isError: true,
      code: "model_access_required",
      action: "configure_model",
      retryable: false,
      safeToResubmit: false,
      provider: "volcengine_ark",
      model: "seedream",
    });
  });

  it("parses deferred tool activation feedback for the model and UI", () => {
    const feedback = parseToolExecutionFeedback(
      JSON.stringify({
        schema_version: 1,
        type: "tool_activation_error",
        status: "failed",
        is_error: true,
        message: "Tool schema was not loaded.",
        error: { code: "tool_schema_not_loaded", retryable: true },
        remediation: { action: "retry_with_loaded_schema" },
      }),
    );

    expect(feedback).toMatchObject({
      isError: true,
      code: "tool_schema_not_loaded",
      action: "retry_with_loaded_schema",
      retryable: true,
    });
  });
});

describe("collectToolMediaFromToolData", () => {
  it.each([
    agentMediaPreviewUrl("main", "generated/chart.png"),
    workspaceDownloadUrl("main", "generated/chart.png"),
  ])("deduplicates generated image alias %s", (alias) => {
    const first = agentMediaPreviewUrl(
      "main",
      "generated/chart.png",
      "image/png",
    );
    const media = collectToolMediaFromToolData(
      {
        output: JSON.stringify({
          type: "image_gen_tool_result",
          images: [{ path: "generated/chart.png", mediaType: "image/png" }],
        }),
      },
      "main",
      [{ kind: "image", url: alias }],
    );

    expect(media.images.map((item) => item.url)).toEqual([first]);
  });

  it("merges preview aliases with and without a MIME query", () => {
    const media = collectToolMediaFromToolData(
      {
        output: JSON.stringify([
          {
            type: "image",
            source: {
              type: "url",
              url: agentMediaPreviewUrl(
                "main",
                "generated/chart.png",
                "image/png",
              ),
            },
          },
          {
            type: "image",
            source: {
              type: "url",
              url: agentMediaPreviewUrl("main", "generated/chart.png"),
            },
          },
        ]),
      },
      "main",
    );
    expect(media.images).toHaveLength(1);
  });

  it.each(["image", "video"] as const)(
    "retains a later %s MIME hint on the first no-extension preview",
    (kind) => {
      const noHint = agentMediaPreviewUrl("main", "generated/art");
      const hinted = agentMediaPreviewUrl(
        "main",
        "generated/art",
        kind === "image" ? "image/png" : "video/mp4",
      );
      const media = collectToolMediaFromToolData(
        {
          output: JSON.stringify(
            [noHint, hinted].map((url) => ({
              type: kind,
              source: { type: "url", url },
            })),
          ),
        },
        "main",
      );

      const items = kind === "image" ? media.images : media.videos;
      expect(items.map(({ url }) => url)).toEqual([hinted]);
    },
  );

  it("normalizes a later uppercase MIME hint with surrounding whitespace", () => {
    const noHint = agentMediaPreviewUrl("main", "generated/art");
    const media = collectToolMediaFromToolData(
      {
        output: JSON.stringify({
          type: "image",
          source: { type: "url", url: noHint },
        }),
      },
      "main",
      [{ kind: "image", url: noHint, mediaType: " IMAGE/PNG " }],
    );
    expect(media.images.map(({ url }) => url)).toEqual([
      agentMediaPreviewUrl("main", "generated/art", "image/png"),
    ]);
    expect(media.images[0].mimeType).toBe("image/png");
  });

  it("merges later attachment MIME without changing order or other URLs", () => {
    const other = agentMediaPreviewUrl("main", "generated/other");
    const first = agentMediaPreviewUrl(
      "main",
      "generated/art",
      "application/octet-stream",
    );
    const otherAgent = agentMediaPreviewUrl("peer", "generated/art");
    const media = collectToolMediaFromToolData(
      {
        output: JSON.stringify(
          [other, first, otherAgent].map((url) => ({
            type: "image",
            source: { type: "url", url },
          })),
        ),
      },
      "main",
      [
        {
          kind: "image",
          url: agentMediaPreviewUrl("main", "generated/art"),
          mediaType: "image/png",
        },
      ],
    );
    expect(media.images.map(({ url }) => url)).toEqual([
      other,
      agentMediaPreviewUrl("main", "generated/art", "image/png"),
      otherAgent,
    ]);
    expect(media.images[1].mimeType).toBe("image/png");
  });

  it("keeps an image from tool arguments in a distinct directory", () => {
    const media = collectToolMediaFromToolData(
      {
        output: JSON.stringify({
          type: "image_gen_tool_result",
          images: [{ path: "generated/a/chart.png", mediaType: "image/png" }],
        }),
        arguments: JSON.stringify({ path: "generated/b/chart.png" }),
      },
      "main",
    );
    expect(media.images.map((item) => item.url)).toEqual([
      agentMediaPreviewUrl("main", "generated/a/chart.png", "image/png"),
      agentMediaPreviewUrl("main", "generated/b/chart.png", "image/png"),
    ]);
  });

  it("keeps local images from different agents or directories distinct", () => {
    const media = collectToolMediaFromToolData(
      {
        output: JSON.stringify([
          {
            type: "image",
            source: {
              type: "url",
              url: agentMediaPreviewUrl("agent-a", "outbound/chart.png"),
            },
          },
          {
            type: "image",
            source: {
              type: "url",
              url: agentMediaPreviewUrl("agent-b", "outbound/chart.png"),
            },
          },
          {
            type: "image",
            source: {
              type: "url",
              url: agentMediaPreviewUrl("agent-a", "other/chart.png"),
            },
          },
        ]),
      },
      "agent-a",
    );
    expect(media.images).toHaveLength(3);
  });

  it("keeps attachment download links owned by distinct agents", () => {
    const urls = ["agent-a", "agent-b"].map((id) =>
      workspaceDownloadUrl(id, "outbound/chart.png"),
    );
    const media = collectToolMediaFromToolData(
      undefined,
      "agent-a",
      urls.map((url) => ({ kind: "image", url })),
    );
    expect(media.images.map((item) => item.url)).toEqual(urls);
  });

  it("keeps the agent embedded in a legacy absolute preview source", () => {
    const media = collectToolMediaFromToolData(undefined, "chat-agent", [
      {
        kind: "image",
        url: agentMediaPreviewUrl(
          "chat-agent",
          "/tmp/.octop/agents/ABC123/generated/chart.png",
        ),
      },
    ]);
    expect(media.images.map((item) => item.url)).toEqual([
      agentMediaPreviewUrl(
        "ABC123",
        "/tmp/.octop/agents/ABC123/generated/chart.png",
      ),
    ]);
  });

  it("deduplicates a video preview and download for the same file", () => {
    const preview = agentMediaPreviewUrl(
      "main",
      "generated/clip.mp4",
      "video/mp4",
    );
    const download = workspaceDownloadUrl("main", "generated/clip.mp4");
    const media = collectToolMediaFromToolData(
      {
        output: JSON.stringify(
          [preview, download].map((url) => ({
            type: "video",
            source: { type: "url", url },
          })),
        ),
      },
      "main",
    );
    expect(media.videos.map((item) => item.url)).toEqual([preview]);
  });

  it("does not merge matching paths on different external hosts", () => {
    const media = collectToolMediaFromToolData(
      {
        output: JSON.stringify([
          {
            type: "image",
            source: {
              type: "url",
              url: "https://one.example/api/agents/a/media/preview?source=outbound%2Fchart.png",
            },
          },
          {
            type: "image",
            source: {
              type: "url",
              url: "https://two.example/api/agents/a/media/preview?source=outbound%2Fchart.png",
            },
          },
        ]),
      },
      "a",
    );
    expect(media.images).toHaveLength(2);
  });

  it("deduplicates image URLs after canonicalization", () => {
    const media = collectToolMediaFromToolData(
      {
        output: JSON.stringify([
          {
            type: "image",
            source: {
              type: "url",
              url: "/api/agents/main/media/preview?source=%2Foutbound%2Fchart.png",
            },
          },
          {
            type: "image",
            source: {
              type: "url",
              url: workspaceDownloadUrl("main", "outbound/chart.png"),
            },
          },
        ]),
      },
      "main",
    );
    expect(media.images).toHaveLength(1);
    expect(media.images[0].url).toBe(
      workspaceDownloadUrl("main", "outbound/chart.png"),
    );
  });
});

describe("agentAttachmentAccessUrl", () => {
  it("uses media preview for images, video, and audio", () => {
    expect(
      agentAttachmentAccessUrl("a1", "inbound/x.png", "image/png"),
    ).toContain("/media/preview?");
    expect(
      agentAttachmentAccessUrl("a1", "inbound/x.mp4", "video/mp4"),
    ).toContain("/media/preview?");
    expect(
      agentAttachmentAccessUrl("a1", "inbound/x.mp3", "audio/mpeg"),
    ).toContain("/media/preview?");
    expect(
      agentAttachmentAccessUrl("a1", "inbound/x.pdf", "application/pdf"),
    ).toContain("/workspace/download?");
  });
});
