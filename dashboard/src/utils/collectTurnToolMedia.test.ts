import { describe, expect, it } from "vitest";
import type { AssistantTurnSplit } from "../pages/Chat/utils/messageContent";
import { collectTurnToolMedia } from "./collectTurnToolMedia";

describe("collectTurnToolMedia", () => {
  it("shows one image and its file card when generation is followed by sending", () => {
    const split: AssistantTurnSplit = {
      tools: [
        {
          id: "generate",
          role: "assistant",
          content: "",
          timestamp: 1,
          toolData: {
            name: "generate_image",
            output: JSON.stringify({
              type: "image_gen_tool_result",
              images: [
                { path: "generated/images/chart.png", mediaType: "image/png" },
              ],
            }),
          },
        },
        {
          id: "send",
          role: "assistant",
          content: "",
          timestamp: 2,
          toolData: {
            name: "send_file_to_user",
            arguments: JSON.stringify({ path: "generated/images/chart.png" }),
            output: JSON.stringify({
              type: "file",
              path: "generated/images/chart.png",
              filename: "chart.png",
            }),
          },
        },
      ],
      thinkings: [],
      processSteps: [],
      answerMessage: null,
    };

    const media = collectTurnToolMedia(split, "agent-1");
    expect(media.images).toHaveLength(1);
    expect(media.files).toHaveLength(1);
    expect(media.files[0].filename).toBe("chart.png");
  });
});
