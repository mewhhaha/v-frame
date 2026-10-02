import assert from "node:assert/strict";
import { defineVFrame, VFrameElement } from "@mewhhaha/v-frame";
import "@mewhhaha/v-frame/register";
import {
  materializeStylesheet,
  rewriteShellElement,
  rewriteScriptElement,
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
console.log(
  "Installed package imports without browser globals and materializes CSS on the server",
);
