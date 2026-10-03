import assert from "node:assert/strict";
import { defineVFrame, VFrameElement } from "@mewhhaha/v-frame";
import "@mewhhaha/v-frame/register";
import {
  materializeStylesheet,
  rewriteShellElement,
  rewriteScriptElement,
  fragmentIdentifiers,
  fragmentTargetRank,
  FRAGMENT_TARGET_ATTRIBUTE,
} from "@mewhhaha/v-frame/server";

assert.equal(typeof defineVFrame, "function");
assert.equal(typeof VFrameElement, "function");
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
