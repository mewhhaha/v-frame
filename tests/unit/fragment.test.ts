import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findFragmentTarget,
  fragmentIdentifiers,
  fragmentTargetRank,
} from "../../src/fragment.js";

const HTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";

function element(
  localName: string,
  attributes: Record<string, string> = {},
  namespaceURI: string | null = HTML,
) {
  return {
    localName,
    namespaceURI,
    getAttribute: (name: string) => attributes[name] ?? null,
  };
}

test("fragmentIdentifiers is empty without a fragment or with an empty one", () => {
  assert.deepEqual(fragmentIdentifiers("https://guest.test/page"), []);
  assert.deepEqual(fragmentIdentifiers("https://guest.test/page#"), []);
});

test("fragmentIdentifiers returns the raw fragment alone when decoding changes nothing", () => {
  assert.deepEqual(fragmentIdentifiers("https://guest.test/page#section"), ["section"]);
  assert.deepEqual(fragmentIdentifiers("https://guest.test/page?x=1#a-b_c"), ["a-b_c"]);
});

test("fragmentIdentifiers returns the raw fragment before its percent-decoded form", () => {
  assert.deepEqual(fragmentIdentifiers("https://guest.test/#A%20B"), ["A%20B", "A B"]);
  assert.deepEqual(fragmentIdentifiers("https://guest.test/#tw%6F"), ["tw%6F", "two"]);
  assert.deepEqual(fragmentIdentifiers("https://guest.test/#%E2%9C%93"), [
    "%E2%9C%93",
    "✓",
  ]);
});

test("fragmentIdentifiers keeps only the raw fragment when it is not valid percent-encoding", () => {
  assert.deepEqual(fragmentIdentifiers("https://guest.test/#%E0%A4%A"), ["%E0%A4%A"]);
  assert.deepEqual(fragmentIdentifiers("https://guest.test/#%"), ["%"]);
});

test("fragmentIdentifiers does not treat #top specially and preserves case", () => {
  assert.deepEqual(fragmentIdentifiers("https://guest.test/#top"), ["top"]);
  assert.deepEqual(fragmentIdentifiers("https://guest.test/#ToP"), ["ToP"]);
  assert.deepEqual(fragmentIdentifiers("https://guest.test/#%74op"), ["%74op", "top"]);
});

test("fragmentIdentifiers only decodes the fragment, not earlier URL components", () => {
  assert.deepEqual(fragmentIdentifiers("https://guest.test/a%20b?q=%20#x"), ["x"]);
});

test("fragmentTargetRank ranks raw ids first, raw names second, decoded ids third, decoded names fourth", () => {
  const identifiers = ["A%20B", "A B"];
  assert.equal(fragmentTargetRank(element("div", { id: "A%20B" }), identifiers), 0);
  assert.equal(fragmentTargetRank(element("a", { name: "A%20B" }), identifiers), 1);
  assert.equal(fragmentTargetRank(element("div", { id: "A B" }), identifiers), 2);
  assert.equal(fragmentTargetRank(element("a", { name: "A B" }), identifiers), 3);
});

test("fragmentTargetRank accepts a name attribute only on HTML a elements", () => {
  const identifiers = ["alias"];
  assert.equal(
    fragmentTargetRank(element("div", { name: "alias" }), identifiers),
    Infinity,
  );
  assert.equal(
    fragmentTargetRank(element("a", { name: "alias" }, SVG), identifiers),
    Infinity,
  );
  assert.equal(
    fragmentTargetRank(element("a", { name: "alias" }, null), identifiers),
    Infinity,
  );
  assert.equal(fragmentTargetRank(element("a", { name: "alias" }), identifiers), 1);
});

test("fragmentTargetRank accepts an id on any element, in any namespace", () => {
  assert.equal(fragmentTargetRank(element("circle", { id: "dot" }, SVG), ["dot"]), 0);
});

test("fragmentTargetRank is case sensitive", () => {
  assert.equal(fragmentTargetRank(element("div", { id: "Two" }), ["two"]), Infinity);
  assert.equal(fragmentTargetRank(element("a", { name: "Two" }), ["two"]), Infinity);
});

test("fragmentTargetRank is Infinity without identifiers or matching attributes", () => {
  assert.equal(fragmentTargetRank(element("div", { id: "x" }), []), Infinity);
  assert.equal(fragmentTargetRank(element("div"), ["x"]), Infinity);
});

test("fragmentTargetRank prefers the id when an a element carries both id and name", () => {
  assert.equal(fragmentTargetRank(element("a", { id: "x", name: "y" }), ["x", "y"]), 0);
  assert.equal(fragmentTargetRank(element("a", { id: "y", name: "x" }), ["x", "y"]), 1);
});

test("findFragmentTarget picks the first element at the best rank", () => {
  const first = element("div", { id: "one" });
  const duplicate = element("div", { id: "one" });
  assert.equal(findFragmentTarget([first, duplicate], "https://guest.test/#one"), first);
});

test("findFragmentTarget prefers an id over an earlier named anchor", () => {
  const named = element("a", { name: "one" });
  const identified = element("div", { id: "one" });
  assert.equal(
    findFragmentTarget([named, identified], "https://guest.test/#one"),
    identified,
  );
});

test("findFragmentTarget prefers the raw match over a decoded match", () => {
  const decoded = element("div", { id: "A B" });
  const raw = element("div", { id: "A%20B" });
  assert.equal(findFragmentTarget([decoded, raw], "https://guest.test/#A%20B"), raw);
  assert.equal(findFragmentTarget([decoded], "https://guest.test/#A%20B"), decoded);
});

test("findFragmentTarget returns null for no fragment, an empty fragment or no match", () => {
  const candidates = [element("div", { id: "" }), element("div", { id: "one" })];
  assert.equal(findFragmentTarget(candidates, "https://guest.test/"), null);
  assert.equal(findFragmentTarget(candidates, "https://guest.test/#"), null);
  assert.equal(findFragmentTarget(candidates, "https://guest.test/#missing"), null);
});
