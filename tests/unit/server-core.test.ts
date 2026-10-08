import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapeStylesheetText,
  materializeStylesheet,
  rewriteScriptElement,
  rewriteShellElement,
  SHELL_DISPLAY_STYLE,
} from "../../src/server/core.js";
import {
  INERT_SCRIPT_TYPE,
  SCRIPT_MARKER_ATTRIBUTE,
  SCRIPT_TYPE_ATTRIBUTE,
} from "../../src/wire-format.js";

const DOCUMENT = "https://guest.test/orders/";

function script(attributes: Record<string, string>) {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
  };
}

test("shell tags map to their v-frame counterparts, case-insensitively", () => {
  assert.deepEqual(rewriteShellElement("html"), { tagName: "v-html", prependHTML: null });
  assert.deepEqual(rewriteShellElement("BODY"), { tagName: "v-body", prependHTML: null });
  assert.deepEqual(rewriteShellElement("Head"), {
    tagName: "v-head",
    prependHTML: SHELL_DISPLAY_STYLE,
  });
  assert.equal(rewriteShellElement("div"), null);
  assert.equal(rewriteShellElement("v-body"), null);
});

test("a script becomes inert and records its authored type", () => {
  const rewrite = rewriteScriptElement(script({ type: "module", src: "a.js" }));
  assert.deepEqual(rewrite?.setAttributes, [
    { name: "type", value: INERT_SCRIPT_TYPE },
    { name: SCRIPT_MARKER_ATTRIBUTE, value: "" },
    { name: SCRIPT_TYPE_ATTRIBUTE, value: "module" },
  ]);
  assert.deepEqual(rewrite?.removeAttributes, [
    SCRIPT_MARKER_ATTRIBUTE,
    SCRIPT_TYPE_ATTRIBUTE,
  ]);
});

test("a typeless script records no authored type", () => {
  const rewrite = rewriteScriptElement(script({ src: "a.js" }));
  assert.deepEqual(
    rewrite?.setAttributes.map(({ name }) => name),
    ["type", SCRIPT_MARKER_ATTRIBUTE],
  );
});

test("an already materialized script is left alone, a forged marker is not", () => {
  assert.equal(
    rewriteScriptElement(
      script({ type: INERT_SCRIPT_TYPE, [SCRIPT_MARKER_ATTRIBUTE]: "" }),
    ),
    null,
  );
  // The inert type without the marker is guest-authored, so it is recorded.
  const forged = rewriteScriptElement(script({ type: INERT_SCRIPT_TYPE }));
  assert.ok(
    forged?.setAttributes.some(
      ({ name, value }) => name === SCRIPT_TYPE_ATTRIBUTE && value === INERT_SCRIPT_TYPE,
    ),
  );
});

test("escapeStylesheetText neutralizes only a sequence that closes the style element", () => {
  assert.equal(
    escapeStylesheetText("a>b{content:'</STYLE>'}"),
    "a>b{content:'\\3c /style>'}",
  );
  assert.equal(escapeStylesheetText("a > b { color: red }"), "a > b { color: red }");
});

test("materializeStylesheet rebases urls, inlines imports and escapes the result", async () => {
  const requested: string[] = [];
  const css = await materializeStylesheet(
    '@import "theme.css";body::after{content:"</style>";background:url(a.png)}',
    DOCUMENT,
    {
      fetchText: async (url) => {
        requested.push(url);
        return ":root{--brand:teal}";
      },
    },
  );
  assert.deepEqual(requested, ["https://guest.test/orders/theme.css"]);
  assert.ok(css.includes(":root") === false);
  assert.ok(css.includes("--brand:teal"));
  assert.ok(css.includes("url(https://guest.test/orders/a.png)"));
  assert.ok(!/<\/style/i.test(css));
});

test("materializeStylesheet reports a dropped import and hands over font rules", async () => {
  const failures: string[] = [];
  const fonts: string[] = [];
  const css = await materializeStylesheet(
    '@import "gone.css";@font-face{font-family:F;src:url(f.woff2)}',
    DOCUMENT,
    {
      fetchText: async () => {
        throw new Error("gone");
      },
      onImportFailure: (failure) => failures.push(failure.url),
      onFontFace: (rules) => fonts.push(rules),
    },
  );
  assert.deepEqual(failures, ["https://guest.test/orders/gone.css"]);
  assert.equal(fonts.length, 1);
  assert.ok(fonts[0]!.includes("url(https://guest.test/orders/f.woff2)"));
  assert.ok(!css.includes("gone.css"));
});
