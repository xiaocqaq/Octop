import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "layout.css"), "utf8");
const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");

function mobileInputRules(): CSSStyleRule[] {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const rules = Array.from(style.sheet!.cssRules)
    .filter(
      (rule): rule is CSSMediaRule =>
        rule instanceof CSSMediaRule &&
        rule.conditionText.includes("any-pointer: coarse"),
    )
    .flatMap((rule) => Array.from(rule.cssRules))
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
  style.remove();
  return rules;
}

describe("mobile input focus zoom protection", () => {
  it("keeps text entry at 16px on touch devices including landscape and portals", () => {
    const rules = mobileInputRules();
    for (const markup of [
      '<input class="octop-input" />',
      '<input type="password" />',
      '<input type="search" />',
      '<input type="email" />',
      '<input type="number" />',
      '<input type="tel" />',
      '<input type="url" />',
      '<input type="date" />',
      '<textarea class="chat-textarea"></textarea>',
      "<select><option>Model</option></select>",
      '<div contenteditable="true"></div>',
      '<div contenteditable="plaintext-only"></div>',
    ]) {
      const container = document.createElement("div");
      container.innerHTML = markup;
      document.body.appendChild(container);
      const element = container.firstElementChild!;
      const rule = rules.find(
        (candidate) =>
          element.matches(candidate.selectorText) &&
          candidate.style.getPropertyValue("font-size") === "16px" &&
          candidate.style.getPropertyPriority("font-size") === "important",
      );
      container.remove();
      expect(rule, markup).toBeDefined();
    }
  });

  it("does not restrict user viewport zoom", () => {
    const viewport = html.match(
      /name="viewport"[\s\S]*?content="([^"]+)"/,
    )?.[1];
    expect(viewport).toBeDefined();
    expect(viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*(?:no|0)/);
  });
});
