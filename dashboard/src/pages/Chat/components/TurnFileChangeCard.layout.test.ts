import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(__dirname, "../chatMessages.partial.less"),
  "utf8",
);

describe("generated file list sizing", () => {
  it("bounds the list item so the button can truncate its filename", () => {
    const section = css
      .split(".fileChangeList {")[1]
      ?.split(".fileChangeRow {")[0];
    expect(section).toMatch(/> li\s*\{[^}]*max-width:\s*100%;/);
  });
});
