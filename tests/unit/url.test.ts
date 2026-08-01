import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSameDocumentFragment,
  parseEntryURL,
  resolveHistoryURL,
} from "../../src/url.js";

const ENTRY_BASE = "https://host.test/app/index.html";

const entryURLCases: Array<{ name: string; value: string; href: string }> = [
  {
    name: "resolves a relative path",
    value: "guest.html",
    href: "https://host.test/app/guest.html",
  },
  {
    name: "resolves a root-relative path",
    value: "/guest",
    href: "https://host.test/guest",
  },
  {
    name: "keeps an absolute URL",
    value: "http://other.test/x",
    href: "http://other.test/x",
  },
  {
    name: "follows a protocol-relative reference to another host",
    value: "//other.test/x",
    href: "https://other.test/x",
  },
  {
    name: "normalizes an uppercase scheme",
    value: "HTTPS://host.test/",
    href: "https://host.test/",
  },
  {
    name: "trims surrounding whitespace",
    value: "  /guest  ",
    href: "https://host.test/guest",
  },
  {
    name: "percent-encodes a non-ASCII path",
    value: "/guäst",
    href: "https://host.test/gu%C3%A4st",
  },
  {
    name: "preserves an empty query and fragment",
    value: "/guest?#",
    href: "https://host.test/guest?#",
  },
];

for (const entryCase of entryURLCases) {
  test(`parseEntryURL ${entryCase.name}`, () => {
    assert.equal(parseEntryURL(entryCase.value, ENTRY_BASE).href, entryCase.href);
  });
}

const malformedEntryURLs = ["", "http://", ":", "https://%%"];

for (const value of malformedEntryURLs) {
  test(`parseEntryURL rejects the malformed URL ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseEntryURL(value, ""), {
      name: "TypeError",
      message: `v-frame src ${JSON.stringify(value)} is not a valid URL`,
    });
  });
}

const nonHTTPEntryURLs = [
  "data:text/html,<p>x",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "blob:https://host.test/2f1c",
  "about:blank",
];

for (const value of nonHTTPEntryURLs) {
  test(`parseEntryURL rejects the non-HTTP URL ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseEntryURL(value, ENTRY_BASE), {
      name: "TypeError",
      message: /must use http: or https:/,
    });
  });
}

test("parseEntryURL names the caller's label in both messages", () => {
  assert.throws(() => parseEntryURL("nope:", ENTRY_BASE, "adopt"), {
    message: /^v-frame adopt "nope:"/,
  });
  assert.throws(() => parseEntryURL("http://", "", "adopt"), {
    message: /^v-frame adopt "http:\/\/"/,
  });
});

const HISTORY_BASE = "https://host.test/app/";
const HISTORY_CURRENT = "https://host.test/app/page?tab=one#top";
const historyRealm = { URL, DOMException, TypeError };

function resolveHistory(value: string | URL | null | undefined): string {
  return resolveHistoryURL(value, HISTORY_BASE, HISTORY_CURRENT, historyRealm);
}

const historyURLCases: Array<{
  name: string;
  value: string | URL | null | undefined;
  href: string;
}> = [
  { name: "treats null as the current URL", value: null, href: HISTORY_CURRENT },
  {
    name: "treats undefined as the current URL",
    value: undefined,
    href: HISTORY_CURRENT,
  },
  {
    name: "treats the empty string as the current URL",
    value: "",
    href: HISTORY_CURRENT,
  },
  { name: "resolves a relative path", value: "next", href: "https://host.test/app/next" },
  {
    name: "resolves a root-relative path",
    value: "/next",
    href: "https://host.test/next",
  },
  {
    name: "resolves a bare query against the base, dropping the current path",
    value: "?tab=two",
    href: "https://host.test/app/?tab=two",
  },
  {
    name: "resolves a bare fragment against the base, dropping the current query",
    value: "#other",
    href: "https://host.test/app/#other",
  },
  {
    name: "accepts a URL object",
    value: new URL("https://host.test/absolute"),
    href: "https://host.test/absolute",
  },
  {
    name: "resolves dot segments",
    value: "../sibling",
    href: "https://host.test/sibling",
  },
];

for (const historyCase of historyURLCases) {
  test(`resolveHistoryURL ${historyCase.name}`, () => {
    assert.equal(resolveHistory(historyCase.value), historyCase.href);
  });
}

const crossOriginHistoryURLs = [
  "https://other.test/app/",
  "http://host.test/app/",
  "https://host.test:8443/app/",
  "https://sub.host.test/app/",
];

for (const value of crossOriginHistoryURLs) {
  test(`resolveHistoryURL refuses the cross-origin URL ${value}`, () => {
    assert.throws(() => resolveHistory(value), {
      name: "SecurityError",
      message: /does not share the current origin https:\/\/host\.test$/,
    });
  });
}

test("resolveHistoryURL wraps a value that cannot be stringified", () => {
  const hostile = {
    toString() {
      throw new Error("no string for you");
    },
  } as unknown as URL;
  assert.throws(() => resolveHistory(hostile), {
    name: "TypeError",
    message: "History URL cannot be converted to a string",
  });
});

test("resolveHistoryURL lets a malformed URL reject as a plain TypeError", () => {
  // Nothing wraps this one: the realm's own URL parser rejects before the
  // origin check, which is the same failure a real History method reports.
  assert.throws(() => resolveHistory("http://"), { name: "TypeError" });
});

const sameDocumentCases: Array<{
  name: string;
  from: string;
  to: string;
  same: boolean;
}> = [
  {
    name: "a fragment added to the same path",
    from: "https://host.test/a",
    to: "https://host.test/a#one",
    same: true,
  },
  {
    name: "a different fragment on the same path",
    from: "https://host.test/a#one",
    to: "https://host.test/a#two",
    same: true,
  },
  {
    name: "an empty fragment marker",
    from: "https://host.test/a",
    to: "https://host.test/a#",
    same: true,
  },
  {
    name: "the same path with no fragment at all",
    from: "https://host.test/a",
    to: "https://host.test/a",
    same: false,
  },
  {
    name: "dropping a fragment",
    from: "https://host.test/a#one",
    to: "https://host.test/a",
    same: false,
  },
  {
    name: "a fragment on a different path",
    from: "https://host.test/a",
    to: "https://host.test/b#one",
    same: false,
  },
  {
    name: "a fragment with a different query",
    from: "https://host.test/a?x=1",
    to: "https://host.test/a?x=2#one",
    same: false,
  },
  {
    name: "a fragment on a different origin",
    from: "https://host.test/a",
    to: "https://other.test/a#one",
    same: false,
  },
  {
    name: "a fragment on a different port",
    from: "https://host.test/a",
    to: "https://host.test:8443/a#one",
    same: false,
  },
];

for (const fragmentCase of sameDocumentCases) {
  test(`isSameDocumentFragment sees ${fragmentCase.name}`, () => {
    assert.equal(
      isSameDocumentFragment(fragmentCase.from, fragmentCase.to),
      fragmentCase.same,
    );
  });
}
