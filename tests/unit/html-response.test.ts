import assert from "node:assert/strict";
import test from "node:test";
import { readHTMLDocument } from "../../src/html-response.js";

test("recognizes real charset declarations and skips invalid encodings", async () => {
  const markup = [
    '<!-- <meta charset="windows-1252"> -->',
    `<div data-label='<meta charset="windows-1252">'></div>`,
    '<meta charset="unknown">',
    '<meta charset="utf-8">',
    "<p>café</p>",
  ].join("");
  assert.equal(await readHTMLDocument(new Response(markup)), markup);
});

test("continues past an unknown charset to a supported legacy declaration", async () => {
  const prefix = '<meta charset="unknown"><meta charset="windows-1252"><p>';
  const bytes = Uint8Array.from([...new TextEncoder().encode(prefix), 0x80]);
  assert.equal(await readHTMLDocument(new Response(bytes)), prefix + "€");
});
