import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("inlines the production Workbox runtime into one compression chunk", () => {
  const source = ts.createSourceFile(
    "vite.config.ts",
    readFileSync(resolve(__dirname, "../vite.config.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let workbox: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "workbox" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      workbox = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const properties = new Map(
    workbox?.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => [
        property.name.getText(source),
        property.initializer.getText(source),
      ]),
  );
  expect(properties.get("inlineWorkboxRuntime")).toBe("true");
  expect(properties.get("skipWaiting")).toBe("false");
  expect(properties.get("navigateFallback")).toBe("null");
  expect(properties.get("importScripts")).toContain('"notify-sw.js"');
});
