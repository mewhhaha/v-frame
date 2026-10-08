import assert from "node:assert/strict";
import { defineVFrame, VFrameElement } from "@mewhhaha/v-frame";
import "@mewhhaha/v-frame/register";
import {
  materializeStylesheet,
  materializeVFrameDocument,
  rewriteShellElement,
  rewriteScriptElement,
  fragmentIdentifiers,
  fragmentTargetRank,
  FRAGMENT_TARGET_ATTRIBUTE,
  NEUTRALIZED_STYLESHEET_REL,
  SSR_LINK_REL,
  SSR_LINK_SOURCE,
  SSR_LINK_STYLE,
  SSR_STYLE,
  createStylesheetContext,
  rewriteStylesheet,
} from "@mewhhaha/v-frame/server";

assert.equal(typeof defineVFrame, "function");
assert.equal(typeof VFrameElement, "function");
assert.deepEqual(
  {
    NEUTRALIZED_STYLESHEET_REL,
    SSR_LINK_REL,
    SSR_LINK_SOURCE,
    SSR_LINK_STYLE,
    SSR_STYLE,
  },
  {
    NEUTRALIZED_STYLESHEET_REL: "v-frame-stylesheet",
    SSR_LINK_REL: "data-v-frame-rel",
    SSR_LINK_SOURCE: "data-v-frame-source",
    SSR_LINK_STYLE: "data-v-frame-linked",
    SSR_STYLE: "data-v-frame-materialized",
  },
);
const controller = new AbortController();
let stylesheetFetches = 0;
const stylesheetContext = createStylesheetContext(
  async (url, options) => {
    stylesheetFetches++;
    assert.equal(url, "https://consumer.test/guest/theme.css");
    assert.equal(options.signal, controller.signal);
    return "body{color:blue}";
  },
  undefined,
  controller.signal,
);
assert.equal(stylesheetContext.signal, controller.signal);
assert.match(
  await rewriteStylesheet(
    '@import "theme.css";',
    "https://consumer.test/guest/",
    stylesheetContext,
  ),
  /v-body/,
);
assert.equal(stylesheetFetches, 1);
assert.equal(rewriteShellElement("body").tagName, "v-body");
assert.match(
  await materializeStylesheet("body{color:red}", "https://consumer.test/guest/"),
  /v-body/,
);
assert.ok(
  rewriteScriptElement({
    getAttribute: () => "module",
    hasAttribute: () => false,
  }).setAttributes.some(
    ({ name, value }) => name === "type" && value === "application/vnd.v-frame",
  ),
);
// Without a global HTMLRewriter (Node) the entry imports, and fails by name.
await assert.rejects(
  materializeVFrameDocument(
    new Response("<html></html>"),
    "https://consumer.test/guest/",
  ),
  { name: "TypeError", message: /options\.HTMLRewriter/ },
);
const identifiers = fragmentIdentifiers("https://consumer.test/guest/#some%20id");
assert.deepEqual(identifiers, ["some%20id", "some id"]);
assert.equal(
  fragmentTargetRank(
    {
      localName: "div",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      getAttribute: (name) => (name === "id" ? "some id" : null),
    },
    identifiers,
  ),
  2,
);
assert.match(
  await materializeStylesheet("body:target{color:red}", "https://consumer.test/guest/"),
  new RegExp(`v-body\\[${FRAGMENT_TARGET_ATTRIBUTE}\\]`),
);
console.log(
  "Installed package imports without browser globals and materializes CSS on the server",
);
