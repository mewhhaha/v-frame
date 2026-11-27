import assert from "node:assert/strict";
import { test } from "node:test";
import {
  balanceTemplateTags,
  createDefaultStylesheetFetch,
  escapeStylesheetText,
  materializeStylesheet,
  raceWithAbort,
  readBoundedBytes,
  rewriteAssetAttributes,
  rewritePreviewAttributes,
  rewriteScriptElement,
  rewriteShellElement,
  SHELL_DISPLAY_STYLE,
} from "../../src/server/core.js";
import {
  INERT_SCRIPT_TYPE,
  isReservedSSRAttribute,
  SCRIPT_MARKER_ATTRIBUTE,
  SCRIPT_TYPE_ATTRIBUTE,
  SSR_PREVIEW_ATTRIBUTES,
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

test("balanceTemplateTags neutralizes DSD breakout, unclosed templates, abrupt comments, and plaintext", () => {
  assert.equal(
    balanceTemplateTags("<div></template><script>1</script></div>"),
    "<div><script>1</script></div>",
  );
  assert.equal(
    balanceTemplateTags("<template><p>ok</p></template></template>"),
    "<template><p>ok</p></template>",
  );
  assert.equal(
    balanceTemplateTags("<template><p>unclosed"),
    "<template><p>unclosed</template>",
  );
  assert.equal(balanceTemplateTags("<!--></template>ok"), "<!-->ok");
  assert.equal(balanceTemplateTags("<!---></template>ok"), "<!--->ok");
  assert.equal(
    balanceTemplateTags("<svg><template/></svg></template>ok"),
    "<svg><template/></svg>ok",
  );
  assert.equal(
    balanceTemplateTags(
      '<svg><template></svg></template><style id="escaped">body{color:red}</style>',
    ),
    '<svg><template></svg><style id="escaped">body{color:red}</style>',
  );
  assert.equal(
    balanceTemplateTags("<svg><template><div></template>ok"),
    "<svg><template><div>ok",
  );
  assert.equal(
    balanceTemplateTags("<math><template></math></template>ok"),
    "<math><template></math>ok",
  );
  assert.equal(
    balanceTemplateTags("<svg><style></template></style></svg>ok"),
    "<svg><style></style></svg>ok",
  );
  assert.equal(
    balanceTemplateTags("<svg><template></template></template>ok"),
    "<svg><template></template>ok",
  );
  assert.equal(balanceTemplateTags("<svg></template>ok"), "<svg>ok");
  assert.equal(
    balanceTemplateTags("<textarea>raw</template>"),
    "<textarea>raw</template></textarea>",
  );
  assert.equal(
    balanceTemplateTags('<script>"<!-- <script></script> -->"</script></template>ok'),
    '<script>"<!-- <script></script> -->"</script>ok',
  );
  assert.equal(
    balanceTemplateTags("<script><!--<!--></script></template>ok"),
    "<script><!--<!--></script>ok",
  );
  assert.equal(
    balanceTemplateTags("<SCRIPT>1</SCRIPT></template>ok"),
    "<SCRIPT>1</SCRIPT>ok",
  );
  const clean = "<div><span>hello</span><script>1+1</script></div>";
  assert.strictEqual(balanceTemplateTags(clean), clean);
  assert.equal(balanceTemplateTags("<p>hi<!-- open"), "<p>hi<!-- open-->");
  assert.equal(balanceTemplateTags('<div title="unclosed'), "");
  assert.equal(
    balanceTemplateTags("<plaintext>a < b </template>"),
    "<pre>a &lt; b &lt;/template></pre>",
  );
});

test("createDefaultStylesheetFetch rejects cross-origin, credentialed, and non-HTTP URLs", async () => {
  const fetcher = createDefaultStylesheetFetch("https://guest.test/orders/");
  await assert.rejects(() => fetcher("https://evil.test/a.css"), TypeError);
  await assert.rejects(() => fetcher("http://169.254.169.254/latest"), TypeError);
  await assert.rejects(() => fetcher("https://user:pass@guest.test/a.css"), TypeError);
  await assert.rejects(() => fetcher("file:///etc/passwd"), TypeError);
});

test("materializeStylesheet enforces maxStylesheets and maxStylesheetBytes budgets", async () => {
  const failures: unknown[] = [];
  const css = await materializeStylesheet(
    '@import "a.css"; @import "b.css"; @import "c.css";',
    DOCUMENT,
    {
      maxStylesheets: 2,
      fetchText: async (url) => `.${url.split("/").pop()!.replace(".", "-")}{color:red}`,
      onImportFailure: (failure) => failures.push(failure.error),
    },
  );
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof RangeError);
  assert.ok(css.includes(".a-css{color:red}"));
  assert.ok(!css.includes(".c-css{color:red}"));

  const sizeFailures: unknown[] = [];
  await materializeStylesheet('@import "big.css";', DOCUMENT, {
    maxStylesheetBytes: 10,
    fetchText: async () => "a".repeat(20),
    onImportFailure: (failure) => sizeFailures.push(failure.error),
  });
  assert.equal(sizeFailures.length, 1);
  assert.ok(sizeFailures[0] instanceof RangeError);
});

test("rewriteAssetAttributes decodes entities before rebasing and tolerates malformed inline styles", () => {
  const img = {
    tagName: "img",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    attributes: [["src", "&#x2f;admin?a=1&amp;b=2"]] as [string, string][],
    getAttribute: (name: string) => (name === "src" ? "&#x2f;admin?a=1&amp;b=2" : null),
    hasAttribute: (name: string) => name === "src",
  };
  const assignments = rewriteAssetAttributes(img, DOCUMENT, {
    decode: (value) => value.replace("&#x2f;", "/").replaceAll("&amp;", "&"),
    encode: (value) => value.replaceAll("&", "&amp;"),
  });
  assert.deepEqual(
    assignments.find((entry) => entry.name === "src"),
    { name: "src", value: "https://guest.test/admin?a=1&amp;b=2" },
  );
  assert.deepEqual(
    assignments.find((entry) => entry.name === "data-v-frame-attributes-0"),
    { name: "data-v-frame-attributes-0", value: "&#x2f;admin?a=1&amp;b=2" },
  );
});

test("balanceTemplateTags handles HTML5 comment-end-bang (--!>) without prematurely closing <!--!>", () => {
  // M1: --!> closes an HTML comment per HTML5 comment-end-bang-state, so a
  // following </template> is real markup and must be neutralized.
  assert.equal(
    balanceTemplateTags("<!-- comment --!></template><script>1</script>"),
    "<!-- comment --!><script>1</script>",
  );
  assert.equal(balanceTemplateTags("<!----!></template>ok"), "<!----!>ok");
  // <!--!> and <!---!> are NOT abrupt comment closings in HTML5, so </template>
  // inside them remains comment text and must not be stripped.
  assert.equal(balanceTemplateTags("<!--!></template>-->ok"), "<!--!></template>-->ok");
  assert.equal(balanceTemplateTags("<!---!></template>-->ok"), "<!---!></template>-->ok");
});

test("rewritePreviewAttributes defers iframe, object, and embed active resource attributes", () => {
  const makeElement = (
    tagName: string,
    attrs: [string, string][],
    namespaceURI = "http://www.w3.org/1999/xhtml",
  ) => ({
    tagName,
    namespaceURI,
    attributes: attrs,
    getAttribute: (name: string) => attrs.find(([k]) => k === name)?.[1] ?? null,
    hasAttribute: (name: string) => attrs.some(([k]) => k === name),
  });

  const iframe = rewritePreviewAttributes(
    makeElement("iframe", [
      ["src", "https://guest.test/embed"],
      ["srcdoc", "<script>1</script>"],
      ["title", "Demo"],
    ]),
  );
  assert.deepEqual(iframe.removeAttributes, ["src", "srcdoc"]);
  assert.equal(
    iframe.setAttributes.find((a) => a.name === SSR_PREVIEW_ATTRIBUTES)?.value,
    '["src","srcdoc"]',
  );

  const objectEl = rewritePreviewAttributes(
    makeElement("object", [["data", "/plugin.swf"]]),
  );
  assert.deepEqual(objectEl.removeAttributes, ["data"]);
  assert.equal(
    objectEl.setAttributes.find((a) => a.name === SSR_PREVIEW_ATTRIBUTES)?.value,
    '["data"]',
  );

  const embedEl = rewritePreviewAttributes(makeElement("embed", [["src", "/media.bin"]]));
  assert.deepEqual(embedEl.removeAttributes, ["src"]);
  assert.equal(
    embedEl.setAttributes.find((a) => a.name === SSR_PREVIEW_ATTRIBUTES)?.value,
    '["src"]',
  );

  // Non-HTML elements are not treated as HTML embedded frames/objects.
  const svgEmbed = rewritePreviewAttributes(
    makeElement("embed", [["src", "/media.bin"]], "http://www.w3.org/2000/svg"),
  );
  assert.deepEqual(svgEmbed.removeAttributes, []);
});

test("createDefaultStylesheetFetch fails closed on unparsable, non-HTTP, or credentialed documentURL", async () => {
  for (const invalidDoc of [
    "not a url",
    "file:///etc/passwd",
    "https://user:pass@guest.test/orders/",
    "javascript:alert(1)",
  ]) {
    const fetcher = createDefaultStylesheetFetch(invalidDoc);
    await assert.rejects(() => fetcher("https://guest.test/a.css"), TypeError);
  }
});

test("raceWithAbort and readBoundedBytes reject promptly on abort even for non-cooperative upstreams", async () => {
  const controller = new AbortController();
  const never = new Promise<string>(() => {});
  const raced = raceWithAbort(never, controller.signal);
  const reason = new DOMException("timed out", "TimeoutError");
  controller.abort(reason);
  await assert.rejects(
    () => raced,
    (err) => err === reason,
  );

  let cancelled = false;
  const streamController = new AbortController();
  const stuckBody = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stuckBody);
  const reading = readBoundedBytes(response, 1024, "test", streamController.signal);
  const streamReason = new DOMException("slot timeout", "TimeoutError");
  streamController.abort(streamReason);
  await assert.rejects(
    () => reading,
    (err) => err === streamReason,
  );
  assert.equal(cancelled, true);
});

test("isReservedSSRAttribute matches the full data-v-frame-* namespace case-insensitively", () => {
  assert.equal(isReservedSSRAttribute("data-v-frame-script"), true);
  assert.equal(isReservedSSRAttribute("DATA-V-FRAME-CUSTOM"), true);
  assert.equal(isReservedSSRAttribute("data-v-frame-future-marker"), true);
  assert.equal(isReservedSSRAttribute("data-v-frame"), false);
  assert.equal(isReservedSSRAttribute("data-other"), false);
});
