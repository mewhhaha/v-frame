import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStylesheetContext,
  CSSOMImportRuleError,
  rewriteCSSOMAddRule,
  rewriteCSSOMInsertRule,
  rewriteCSSOMSelectorText,
  rewriteStyleAttribute,
  rewriteStylesheet,
  type StylesheetImportFailure,
  translateShellSelector,
  unScopeCSSOMRuleText,
} from "../../src/css.js";

const BASE = "https://host.test/app/page.css";
const ROOT_SELECTOR = ":where(v-html):nth-child(n)";

test("temporary CSS scope removal preserves serialization and declaration strings", () => {
  const scope = ":host > v-html:nth-of-type(2)";
  const guard = `:where(${scope},${scope} *)`;
  assert.equal(
    unScopeCSSOMRuleText(
      `p${guard}::before { content: ${JSON.stringify(guard)}; }`,
      scope,
    ),
    `p::before { content: ${JSON.stringify(guard)}; }`,
  );
});

test("temporary CSS scopes are removed from nested selectors without changing nested declarations", () => {
  const scope = ":host > v-html:nth-of-type(2)";
  const guard = `:where(${scope},${scope} *)`;
  assert.equal(
    unScopeCSSOMRuleText(`p${guard} { color: red; & b${guard} { color: blue; } }`, scope),
    "p { color: red; & b { color: blue; } }",
  );
});

interface SelectorCase {
  selector: string;
  /** What `translateShellSelector` produces — shadow-only pseudo-classes survive. */
  translated: string;
  /** What the CSSOM rewriters produce — shadow-only pseudo-classes are neutered. */
  cssom?: string;
}

const selectorCases: SelectorCase[] = [
  { selector: "body", translated: "v-body" },
  { selector: "BODY", translated: "v-body" },
  { selector: "HTML > BODY p", translated: "v-html>v-body p" },
  { selector: "head link", translated: "v-head link" },
  { selector: "body:not(.x)", translated: "v-body:not(.x)" },
  { selector: "body::before", translated: "v-body::before" },
  { selector: ":root", translated: ROOT_SELECTOR },
  {
    selector: ":root .a, body .b",
    translated: `${ROOT_SELECTOR} .a,v-body .b`,
  },
  { selector: ":host", translated: ":host", cssom: ":not(*)" },
  {
    selector: ":host-context(.dark)",
    translated: ":host-context(.dark)",
    cssom: ":not(*)",
  },
  // Only element names are shell names; a class, id or attribute value that reads
  // "body" belongs to the guest and must survive untouched.
  { selector: ".body", translated: ".body" },
  { selector: "#body", translated: "#body" },
  { selector: 'a[href$="body"]', translated: 'a[href$="body"]' },
  { selector: "*", translated: "*" },
  // Namespace-qualified names are not shell elements, but escaped spellings are.
  { selector: "svg|body", translated: "svg|body" },
  { selector: "\\62 ody", translated: "v-body" },
  { selector: ":r\\6f ot", translated: ROOT_SELECTOR },
  { selector: ":ta\\72 get", translated: "[data-v-frame-target]" },
  { selector: ":not(:ta\\72 get)", translated: ":not([data-v-frame-target])" },
  { selector: ":h\\6f st", translated: ":h\\6f st", cssom: ":not(*)" },
  {
    selector: ":host\\2d context(.dark)",
    translated: ":host\\2d context(.dark)",
    cssom: ":not(*)",
  },
];

for (const selectorCase of selectorCases) {
  test(`translateShellSelector rewrites ${selectorCase.selector}`, () => {
    assert.equal(translateShellSelector(selectorCase.selector), selectorCase.translated);
  });

  test(`rewriteCSSOMSelectorText rewrites ${selectorCase.selector}`, () => {
    assert.equal(
      rewriteCSSOMSelectorText(selectorCase.selector),
      selectorCase.cssom ?? selectorCase.translated,
    );
  });
}

test("rewriteCSSOMSelectorText rejects a selector that cannot be parsed", () => {
  assert.throws(() => rewriteCSSOMSelectorText("!!!"), { name: "SyntaxError" });
});

const styleAttributeCases: Array<{ name: string; source: string; rewritten: string }> = [
  {
    name: "rebases a relative url()",
    source: "background: url(a.png)",
    rewritten: "background:url(https://host.test/app/a.png)",
  },
  {
    name: "rebases a quoted url() and escapes the space",
    source: "background: url('a b.png')",
    rewritten: "background:url(https://host.test/app/a%20b.png)",
  },
  {
    name: "walks out of the stylesheet directory",
    source: 'background: url("../x/y.png")',
    rewritten: "background:url(https://host.test/x/y.png)",
  },
  {
    name: "leaves an empty url() alone rather than inventing a request",
    source: "background: url('')",
    rewritten: "background:url()",
  },
  {
    name: "leaves a fragment-only url() alone",
    source: "filter: url(#f)",
    rewritten: "filter:url(#f)",
  },
  {
    name: "leaves a data: url() alone",
    source: "background: url(data:image/gif;base64,AAA)",
    rewritten: "background:url(data:image/gif;base64,AAA)",
  },
  {
    name: "keeps an unresolvable url() so the rest of the declaration survives",
    source: "background: url(http://[)",
    rewritten: "background:url(http://[)",
  },
  {
    name: "descends into a custom property",
    source: "--custom: url(a.png)",
    rewritten: "--custom:url(https://host.test/app/a.png)",
  },
  {
    name: "descends into a function argument",
    source: "background: image-set(url(a.png) 1x)",
    rewritten: "background:image-set(url(https://host.test/app/a.png)1x)",
  },
  {
    name: "preserves a brace inside a string",
    source: 'content: "}"',
    rewritten: 'content:"}"',
  },
  {
    name: "resolves a string escape",
    source: "content: '\\201C'",
    rewritten: 'content:"“"',
  },
];

for (const styleCase of styleAttributeCases) {
  test(`rewriteStyleAttribute ${styleCase.name}`, () => {
    assert.equal(rewriteStyleAttribute(styleCase.source, BASE), styleCase.rewritten);
  });
}

const insertRuleCases: Array<{ name: string; source: string; rewritten: string }> = [
  {
    name: "rewrites a shell selector",
    source: "body { color: red }",
    rewritten: "v-body{color:red}",
  },
  {
    name: "rewrites inside an at-rule and rebases its url()",
    source: "@media screen { body { background: url(a.png) } }",
    rewritten: "@media screen{v-body{background:url(https://host.test/app/a.png)}}",
  },
  {
    name: "rewrites :root",
    source: ":root { --x: 1 }",
    rewritten: `${ROOT_SELECTOR}{--x:1}`,
  },
  {
    name: "neuters a shadow-only pseudo-class",
    source: "@supports (display:grid) { :host { color: red } }",
    rewritten: "@supports (display:grid){:not(*){color:red}}",
  },
];

for (const insertCase of insertRuleCases) {
  test(`rewriteCSSOMInsertRule ${insertCase.name}`, () => {
    assert.equal(rewriteCSSOMInsertRule(insertCase.source, BASE), insertCase.rewritten);
  });
}

const cssomImportForms = [
  "@import url(a.css);",
  "@import 'a.css';",
  "@media screen { p { color: red } }\n@import url(a.css);",
];

for (const source of cssomImportForms) {
  test(`rewriteCSSOMInsertRule refuses ${JSON.stringify(source)}`, () => {
    assert.throws(() => rewriteCSSOMInsertRule(source, BASE), CSSOMImportRuleError);
  });
}

test("rewriteCSSOMAddRule rewrites the selector and the declarations apart", () => {
  assert.deepEqual(rewriteCSSOMAddRule("body", "background: url(a.png)", BASE), {
    selector: "v-body",
    declarations: "background:url(https://host.test/app/a.png)",
  });
});

const MAIN = "https://host.test/app/main.css";

test("redirected imports resolve nested imports and assets from their final response URLs", async () => {
  const requests: string[] = [];
  const context = createStylesheetContext(async (url) => {
    requests.push(url);
    if (url === "https://host.test/old/theme.css") {
      return {
        text: '@import "nested.css"; p { background: url(asset.png) }',
        url: "https://host.test/new/theme.css",
      };
    }
    assert.equal(url, "https://host.test/new/nested.css");
    return {
      text: "body { background: url(nested.png) }",
      url: "https://host.test/final/nested.css",
    };
  });
  const rewritten = await rewriteStylesheet('@import "/old/theme.css";', MAIN, context);
  assert.equal(
    rewritten,
    "v-body{background:url(https://host.test/final/nested.png)}p{background:url(https://host.test/new/asset.png)}",
  );
  assert.deepEqual(requests, [
    "https://host.test/old/theme.css",
    "https://host.test/new/nested.css",
  ]);
});

test("redirect aliases cannot evade import cycle detection", async () => {
  let fetches = 0;
  const context = createStylesheetContext(async () => {
    fetches++;
    return { text: '@import "/alias.css"; p { color: red }', url: MAIN };
  });
  assert.equal(
    await rewriteStylesheet('@import "/alias.css"; body { color: blue }', MAIN, context),
    "v-body{color:blue}",
  );
  assert.equal(fetches, 1);
});

const importedSheets: Record<string, string> = {
  "https://host.test/app/a.css": "body { background: url(img/a.png) }",
  "https://host.test/app/b.css": "@import url(a.css);\np { color: blue }",
  "https://host.test/app/self.css": "@import url(self.css);\np { color: red }",
};

interface StylesheetHarness {
  context: ReturnType<typeof createStylesheetContext>;
  failures: StylesheetImportFailure[];
  fetched: string[];
}

function stylesheetHarness(): StylesheetHarness {
  const failures: StylesheetImportFailure[] = [];
  const fetched: string[] = [];
  const context = createStylesheetContext(
    async (url) => {
      fetched.push(url);
      const source = importedSheets[url];
      if (source === undefined) throw new Error(`no stylesheet at ${url}`);
      return source;
    },
    (failure) => failures.push(failure),
  );
  return { context, failures, fetched };
}

/** The inlined body of a.css, rebased against a.css rather than the importer. */
const INLINED_A = "v-body{background:url(https://host.test/app/img/a.png)}";

const stylesheetCases: Array<{ name: string; source: string; rewritten: string }> = [
  {
    name: "inlines a url() import",
    source: "@import url(a.css);",
    rewritten: INLINED_A,
  },
  {
    name: "inlines a bare-string import",
    source: "@import 'a.css';",
    rewritten: INLINED_A,
  },
  {
    name: "wraps a media-qualified import",
    source: "@import url(a.css) screen and (min-width: 40em);",
    rewritten: `@media screen and (min-width:40em){${INLINED_A}}`,
  },
  {
    name: "wraps an anonymous layer import",
    source: "@import url(a.css) layer;",
    rewritten: `@layer{${INLINED_A}}`,
  },
  {
    name: "wraps a named layer import",
    source: "@import url(a.css) layer(base);",
    rewritten: `@layer base{${INLINED_A}}`,
  },
  {
    name: "parenthesizes a bare supports condition",
    source: "@import url(a.css) supports(display: grid);",
    rewritten: `@supports (display:grid){${INLINED_A}}`,
  },
  {
    name: "nests layer, supports and media in that order",
    source: "@import url(a.css) layer(base) supports(display: grid) screen;",
    rewritten: `@layer base{@supports (display:grid){@media screen{${INLINED_A}}}}`,
  },
  {
    name: "still inlines after a @charset",
    source: '@charset "utf-8";\n@import url(a.css);',
    rewritten: `@charset "utf-8";${INLINED_A}`,
  },
  {
    name: "inlines transitively",
    source: "@import url(b.css);",
    rewritten: `${INLINED_A}p{color:blue}`,
  },
  {
    // A late @import is inert per the CSS spec, so it is left in place with only
    // its URL rebased — exactly what a browser would ignore.
    name: "leaves an @import that follows a rule uninlined",
    source: "p { color: red }\n@import url(a.css);",
    rewritten: "p{color:red}@import url(https://host.test/app/a.css);",
  },
  {
    name: "rewrites shell selectors and rebases urls in the sheet itself",
    source: ":root { color: red }\nbody { background: url(x.png) }",
    rewritten: `${ROOT_SELECTOR}{color:red}v-body{background:url(https://host.test/app/x.png)}`,
  },
];

for (const stylesheetCase of stylesheetCases) {
  test(`rewriteStylesheet ${stylesheetCase.name}`, async () => {
    const harness = stylesheetHarness();
    assert.equal(
      await rewriteStylesheet(stylesheetCase.source, MAIN, harness.context),
      stylesheetCase.rewritten,
    );
    assert.deepEqual(harness.failures, []);
  });
}

test("rewriteStylesheet drops an import that fails to load and reports it", async () => {
  const harness = stylesheetHarness();
  const rewritten = await rewriteStylesheet(
    "@import url(missing.css);\np { color: red }",
    MAIN,
    harness.context,
  );
  assert.equal(rewritten, "p{color:red}");
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0]?.url, "https://host.test/app/missing.css");
});

test("rewriteStylesheet breaks an import cycle without reporting a failure", async () => {
  const harness = stylesheetHarness();
  const rewritten = await rewriteStylesheet(
    importedSheets["https://host.test/app/self.css"] ?? "",
    "https://host.test/app/self.css",
    harness.context,
  );
  assert.equal(rewritten, "p{color:red}");
  assert.deepEqual(harness.failures, []);
});

test("rewriteStylesheet fetches a shared import once per context", async () => {
  const harness = stylesheetHarness();
  await rewriteStylesheet("@import url(a.css);", MAIN, harness.context);
  await rewriteStylesheet("@import url(b.css);", MAIN, harness.context);
  assert.deepEqual(harness.fetched, [
    "https://host.test/app/a.css",
    "https://host.test/app/b.css",
  ]);
});

const malformedStylesheets: Array<{ source: string; rewritten: string }> = [
  { source: "@@@ {", rewritten: "@@@{}" },
  { source: "body { color: }", rewritten: "v-body{color:}" },
  { source: "}{", rewritten: "}{}" },
  { source: "@media {", rewritten: "@media{}" },
];

for (const malformed of malformedStylesheets) {
  test(`rewriteStylesheet tolerates ${JSON.stringify(malformed.source)}`, async () => {
    const harness = stylesheetHarness();
    assert.equal(
      await rewriteStylesheet(malformed.source, MAIN, harness.context),
      malformed.rewritten,
    );
  });
}
