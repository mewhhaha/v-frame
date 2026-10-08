import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptCategory } from "../../src/script-type.js";

function script(type: string | null, attributes: Record<string, string> = {}) {
  const all = type === null ? attributes : { type, ...attributes };
  return {
    getAttribute: (name: string) => all[name] ?? null,
    hasAttribute: (name: string) => name in all,
  } as unknown as HTMLScriptElement;
}

test("a missing or empty type is a classic script", () => {
  assert.equal(scriptCategory(script(null)), "classic");
  assert.equal(scriptCategory(script("")), "classic");
  assert.equal(scriptCategory(script("   ")), "classic");
});

test("JavaScript MIME type essences are classic scripts", () => {
  for (const type of [
    "text/javascript",
    "application/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "application/x-ecmascript",
    "text/ecmascript",
    "text/x-ecmascript",
    "text/x-javascript",
    "text/jscript",
    "text/livescript",
    "text/javascript1.0",
    "text/javascript1.5",
  ]) {
    assert.equal(scriptCategory(script(type)), "classic", type);
  }
});

test("module and importmap are their own categories", () => {
  assert.equal(scriptCategory(script("module")), "module");
  assert.equal(scriptCategory(script("importmap")), "importmap");
});

test("type matching ignores ASCII case", () => {
  assert.equal(scriptCategory(script("TEXT/JavaScript")), "classic");
  assert.equal(scriptCategory(script("Module")), "module");
  assert.equal(scriptCategory(script("ImportMap")), "importmap");
});

test("type matching ignores surrounding ASCII whitespace", () => {
  assert.equal(scriptCategory(script("  module\n")), "module");
  assert.equal(scriptCategory(script("\ttext/javascript ")), "classic");
  assert.equal(scriptCategory(script(" importmap ")), "importmap");
});

test("data blocks and unknown types are inert", () => {
  for (const type of [
    "speculationrules",
    "application/json",
    "application/ld+json",
    "text/plain",
    "text/template",
    "text/typescript",
    "javascript",
    "text/javascript1.6",
  ]) {
    assert.equal(scriptCategory(script(type)), "inert", type);
  }
});

test("MIME parameters make a script type inert, as in browsers", () => {
  assert.equal(scriptCategory(script("text/javascript; charset=utf-8")), "inert");
  assert.equal(scriptCategory(script("text/javascript;charset=utf-8")), "inert");
  assert.equal(scriptCategory(script("module; foo")), "inert");
});

test("nomodule makes only classic scripts inert", () => {
  assert.equal(scriptCategory(script(null, { nomodule: "" })), "inert");
  assert.equal(scriptCategory(script("text/javascript", { nomodule: "" })), "inert");
  assert.equal(scriptCategory(script("module", { nomodule: "" })), "module");
  assert.equal(scriptCategory(script("importmap", { nomodule: "" })), "importmap");
});

// Browsers strip only ASCII whitespace from the type attribute, so a type padded
// with U+00A0 matches nothing and the script is inert.
test("non-ASCII whitespace around the type is not stripped", () => {
  assert.equal(scriptCategory(script(" text/javascript")), "inert");
  assert.equal(scriptCategory(script(" module")), "inert");
  assert.equal(scriptCategory(script("text/javascript﻿")), "inert");
});
