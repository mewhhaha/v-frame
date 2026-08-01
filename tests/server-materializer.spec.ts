import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { StylesheetFetch } from "../src/server/index";
import {
  INERT_SCRIPT_TYPE,
  materializeStylesheet,
  rewriteScriptElement,
  rewriteShellElement,
  SCRIPT_MARKER_ATTRIBUTE,
  SCRIPT_TYPE_ATTRIBUTE,
  SHELL_DISPLAY_STYLE,
} from "../src/server/index";

interface DocumentNode {
  tagName: string;
  attributes: Record<string, string>;
  text: string | null;
}

interface MaterializedNode {
  tagName: string;
  attributes: Record<string, string>;
  prepend: string | null;
  text: string | null;
}

function attributeReader(attributes: Map<string, string>) {
  return {
    getAttribute(name: string): string | null {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name: string): boolean {
      return attributes.has(name);
    },
  };
}

function applyScriptRewrite(attributes: Map<string, string>): void {
  const rewrite = rewriteScriptElement(attributeReader(attributes));
  if (rewrite === null) {
    return;
  }

  for (const name of rewrite.removeAttributes) {
    attributes.delete(name);
  }
  for (const assignment of rewrite.setAttributes) {
    attributes.set(assignment.name, assignment.value);
  }
}

/**
 * Stands in for the streaming parser a real adapter drives: it replays the
 * callbacks a parser would make for the document below and applies the core's
 * decisions to each one, so the assertion covers the composed output rather
 * than any single runtime's rewriter.
 */
async function materializeNodes(
  nodes: readonly DocumentNode[],
  documentURL: string,
  fetchText: StylesheetFetch,
): Promise<MaterializedNode[]> {
  const materialized: MaterializedNode[] = [];
  for (const node of nodes) {
    const attributes = new Map(Object.entries(node.attributes));
    if (node.tagName === "script") {
      applyScriptRewrite(attributes);
    }

    const shell = rewriteShellElement(node.tagName);
    const text =
      node.tagName === "style" && node.text !== null
        ? await materializeStylesheet(node.text, documentURL, { fetchText })
        : node.text;
    materialized.push({
      tagName: shell === null ? node.tagName : shell.tagName,
      attributes: Object.fromEntries(attributes),
      prepend: shell === null ? null : shell.prependHTML,
      text,
    });
  }
  return materialized;
}

async function unusedStylesheetFetch(url: string): Promise<string> {
  throw new Error(`unexpected stylesheet fetch for ${url}`);
}

test("materializes a small guest document into the adopted shape", async () => {
  // <html lang="en"><head><style>…</style></head>
  // <body><div id="root">…</div><script type="module" src="client.js"></script></body></html>
  const guestDocument: readonly DocumentNode[] = [
    { tagName: "html", attributes: { lang: "en" }, text: null },
    { tagName: "head", attributes: {}, text: null },
    {
      tagName: "style",
      attributes: {},
      text: 'html{color:red}#logo{background:url("logo.png")}',
    },
    { tagName: "body", attributes: {}, text: null },
    { tagName: "div", attributes: { id: "root" }, text: null },
    {
      tagName: "script",
      attributes: { type: "module", src: "client.js" },
      text: null,
    },
  ];

  const materialized = await materializeNodes(
    guestDocument,
    "https://guest.example/orders/",
    unusedStylesheetFetch,
  );

  expect(materialized).toEqual([
    { tagName: "v-html", attributes: { lang: "en" }, prepend: null, text: null },
    { tagName: "v-head", attributes: {}, prepend: SHELL_DISPLAY_STYLE, text: null },
    {
      tagName: "style",
      attributes: {},
      prepend: null,
      text: "v-html{color:red}#logo{background:url(https://guest.example/orders/logo.png)}",
    },
    { tagName: "v-body", attributes: {}, prepend: null, text: null },
    { tagName: "div", attributes: { id: "root" }, prepend: null, text: null },
    {
      tagName: "script",
      attributes: {
        type: INERT_SCRIPT_TYPE,
        src: "client.js",
        [SCRIPT_MARKER_ATTRIBUTE]: "",
        [SCRIPT_TYPE_ATTRIBUTE]: "module",
      },
      prepend: null,
      text: null,
    },
  ]);
});

test("neutralizes a typeless script without inventing an authored type", () => {
  const attributes = new Map([["src", "client.js"]]);
  applyScriptRewrite(attributes);

  expect(Object.fromEntries(attributes)).toEqual({
    src: "client.js",
    type: INERT_SCRIPT_TYPE,
    [SCRIPT_MARKER_ATTRIBUTE]: "",
  });
});

test("leaves an already materialized script untouched", () => {
  const attributes = new Map([
    ["type", INERT_SCRIPT_TYPE],
    [SCRIPT_MARKER_ATTRIBUTE, ""],
    [SCRIPT_TYPE_ATTRIBUTE, "module"],
  ]);
  applyScriptRewrite(attributes);

  expect(Object.fromEntries(attributes)).toEqual({
    type: INERT_SCRIPT_TYPE,
    [SCRIPT_MARKER_ATTRIBUTE]: "",
    [SCRIPT_TYPE_ATTRIBUTE]: "module",
  });
});

test("drops a marker a guest authored itself", () => {
  const attributes = new Map([
    ["type", "module"],
    [SCRIPT_MARKER_ATTRIBUTE, ""],
    [SCRIPT_TYPE_ATTRIBUTE, "text/plain"],
  ]);
  applyScriptRewrite(attributes);

  expect(Object.fromEntries(attributes)).toEqual({
    type: INERT_SCRIPT_TYPE,
    [SCRIPT_MARKER_ATTRIBUTE]: "",
    [SCRIPT_TYPE_ATTRIBUTE]: "module",
  });
});

test("inlines imports and escapes text that would close the style element", async () => {
  const requested: string[] = [];
  async function fetchImportedStylesheet(url: string): Promise<string> {
    requested.push(url);
    return ":root{--brand:teal}";
  }

  const materialized = await materializeStylesheet(
    '@import "theme.css";body::after{content:"</style>"}',
    "https://guest.example/orders/",
    { fetchText: fetchImportedStylesheet },
  );

  expect(requested).toEqual(["https://guest.example/orders/theme.css"]);
  expect(materialized).toBe(
    ':where(v-html):nth-child(n){--brand:teal}v-body::after{content:"\\3c /style>"}',
  );
});

test("ships a server entry that depends on no DOM global", async () => {
  const bundle = await readFile(new URL("../dist/server/index.js", import.meta.url), {
    encoding: "utf8",
  });

  expect(bundle).not.toMatch(/\bwindow\b/);
  expect(bundle).not.toMatch(/\bdocument\b/);
});
