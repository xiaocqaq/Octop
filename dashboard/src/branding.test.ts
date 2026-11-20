import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboard = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(dashboard, path), "utf8");

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(stringValues);
  return [];
}

describe("mxiao branding", () => {
  it("precaches every displayed brand image so content changes receive a revision", () => {
    const config = ts.createSourceFile(
      "vite.config.ts",
      read("vite.config.ts"),
      ts.ScriptTarget.Latest,
      true,
    );
    let assets: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(config) === "includeAssets" &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        assets = node.initializer.elements
          .filter(ts.isStringLiteral)
          .map((item) => item.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(config);
    expect(assets).toEqual(
      expect.arrayContaining([
        "favico.svg",
        "logo_mark.svg",
        "logo_horizontal_dark.png",
        "logo_horizontal_white.png",
        "pwa-192.png",
        "pwa-512.png",
        "apple-touch-icon.png",
        "octop-mascot-empty.png",
        "octop-mascot-peek.webp",
        "octop-mascot-type.webp",
      ]),
    );
  });
  it.each([
    "favico.svg",
    "logo_mark.svg",
    "logo_vertical_dark.svg",
    "logo_vertical_white.svg",
  ])("ships the custom mxiao M monogram in %s", (name) => {
    const svg = new DOMParser().parseFromString(
      read("public/" + name),
      "image/svg+xml",
    );
    expect(svg.querySelector("title")?.textContent).toContain("mxiao");
    expect(svg.querySelector('[data-brand-mark="mxiao-m"]')).not.toBeNull();
    expect(
      svg
        .querySelector('[data-brand-mark="mxiao-m"]')
        ?.getAttribute("data-brand-style"),
    ).toBe("folded-M");
  });
  it.each([
    ["logo_horizontal_dark.svg", "#1a1c28"],
    ["logo_horizontal_white.svg", "#ffffff"],
    ["logo_vertical_dark.svg", "#1a1c28"],
    ["logo_vertical_white.svg", "#ffffff"],
  ])("renders one colored m followed by neutral xiao in %s", (name, fill) => {
    const svg = new DOMParser().parseFromString(
      read("public/" + name),
      "image/svg+xml",
    );
    expect(svg.querySelectorAll('[data-brand-mark="mxiao-m"]')).toHaveLength(1);
    expect(
      svg.querySelector('[data-brand-mark="mxiao-m"]')?.getAttribute("fill"),
    ).toBe("url(#brand-red)");
    const wordmark = svg.querySelector('[data-brand-wordmark="xiao"]');
    expect(svg.querySelectorAll("[data-brand-wordmark]")).toHaveLength(1);
    expect(wordmark?.getAttribute("fill")).toBe(fill);
    expect(
      Array.from(wordmark?.querySelectorAll("[data-letter]") ?? []).map(
        (glyph) => glyph.getAttribute("data-letter"),
      ),
    ).toEqual(["x", "i", "a", "o"]);
  });
  it.each([
    ["pwa-192.png", 192],
    ["pwa-512.png", 512],
    ["apple-touch-icon.png", 180],
  ])("ships the m icon at the declared size in %s", (name, size) => {
    const png = readFileSync(resolve(dashboard, "public", name));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png.toString("latin1")).toContain("mxiao");
  });
  it("uses mxiao for JSX labels and fallback copy", () => {
    const legacy: string[] = [];
    const root = resolve(dashboard, "src");
    for (const entry of readdirSync(root, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".tsx") ||
        entry.name.includes(".test.")
      )
        continue;
      const file = resolve(entry.parentPath, entry.name);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) {
          const text = node.text.replace(/https?:\/\/[^\s]+/g, "");
          if (
            /\bOctop(?=$|[^A-Za-z_-])|CoPaw|Copaw/.test(text) &&
            !text.startsWith("cd Octop\n")
          ) {
            legacy.push(file.replace(root, "src") + ": " + text.trim());
          }
          if (
            ts.isJsxAttribute(node.parent) &&
            node.parent.name.getText(source) === "alt" &&
            text === "octop"
          )
            legacy.push(file + ": " + text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(legacy).toEqual([]);
  });
  it.each(["en", "zh"])(
    "uses the Mxiao site title in %s while preserving technical names",
    (locale) => {
      const frontend = JSON.parse(read(`src/locales/${locale}.json`));
      const backend = JSON.parse(read(`../src/octop/i18n/${locale}.json`));
      for (const bundle of [frontend, backend]) {
        expect(
          stringValues(bundle).filter((value) =>
            /Octop(?!Bot)|CoPaw|Copaw/.test(value),
          ),
        ).toEqual([]);
      }
      expect(frontend.app.pageTitle).toBe("Mxiao");
      expect(frontend.common.askOctopHint).toContain("mxiao");
      expect(frontend.skills["octop-assistant"]).toBe(
        backend.skills["octop-assistant"],
      );
      expect(frontend.remoteDesktop.macPermStep3Detail).toContain("octop run");
      expect(frontend.wizard.password.whereDefault).toContain(
        "~/.octop/octop-login.txt",
      );
      for (const [key, value] of Object.entries(backend.errors)) {
        // Existing frontend OAuth wording remains independent of backend copy.
        if (
          key !== "CONNECTOR_OAUTH_HTTPS_REQUIRED" &&
          typeof value === "string" &&
          value.includes("mxiao")
        ) {
          expect(frontend.apiErrors[key]).toBe(
            value.replaceAll("{", "{{").replaceAll("}", "}}"),
          );
        }
      }
    },
  );
  it("identifies the browser shell, installed app and offline page as Mxiao", () => {
    const html = new DOMParser().parseFromString(
      read("index.html"),
      "text/html",
    );
    expect(html.title).toBe("Mxiao");
    expect(
      html
        .querySelector('[name="apple-mobile-web-app-title"]')
        ?.getAttribute("content"),
    ).toBe("Mxiao");
    for (const logo of html.querySelectorAll("#octop-boot img")) {
      expect(logo.getAttribute("alt")).toBe("Mxiao");
    }
    const manifest = JSON.parse(read("public/manifest.json"));
    expect(manifest.name).toBe("Mxiao");
    expect(manifest.short_name).toBe("Mxiao");
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    const offline = read("public/offline.html");
    const offlinePage = new DOMParser().parseFromString(offline, "text/html");
    expect(offlinePage.title).toBe("Mxiao — 离线中");
    expect(offline).not.toMatch(/Octop|CoPaw|Copaw/i);
  });
});
