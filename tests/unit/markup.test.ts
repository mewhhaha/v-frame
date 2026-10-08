import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isSrcsetAttribute,
  isURLAttribute,
  rewriteAssetAttribute,
  XLINK_NAMESPACE,
} from "../../src/asset-urls.js";

const BASE = "https://host.test/app/page.html";

/** `rewriteAssetAttribute` reports an unchanged attribute as null. */
function rebaseSrcset(source: string): string {
  const img = { localName: "img", namespaceURI: "http://www.w3.org/1999/xhtml" };
  return rewriteAssetAttribute(img, "srcset", null, source, BASE) ?? source;
}

const srcsetCases: Array<{ name: string; source: string; rewritten: string }> = [
  {
    name: "rebases every candidate",
    source: "a.png 1x, b.png 2x",
    rewritten: "https://host.test/app/a.png 1x, https://host.test/app/b.png 2x",
  },
  {
    name: "accepts a single candidate with no descriptor",
    source: "a.png",
    rewritten: "https://host.test/app/a.png",
  },
  {
    name: "normalizes runs of whitespace and newlines",
    source: "  a.png   1x  \n,   b.png   2x  ",
    rewritten: "https://host.test/app/a.png 1x, https://host.test/app/b.png 2x",
  },
  {
    name: "keeps width descriptors",
    source: "a.png 100w, b.png 200w",
    rewritten: "https://host.test/app/a.png 100w, https://host.test/app/b.png 200w",
  },
  {
    name: "keeps a fractional density descriptor",
    source: "a.png 1.5x",
    rewritten: "https://host.test/app/a.png 1.5x",
  },
  {
    name: "resolves dot segments and root-relative references",
    source: "../up.png 2x, /root.png 3x",
    rewritten: "https://host.test/up.png 2x, https://host.test/root.png 3x",
  },
  // The HTML srcset grammar splits candidates on whitespace, not on commas, so a
  // reference containing commas is one candidate — which is what keeps data: URLs
  // and their base64 payloads intact.
  {
    name: "treats a comma inside an unspaced reference as part of the URL",
    source: "a.png,b.png",
    rewritten: "https://host.test/app/a.png,b.png",
  },
  {
    name: "keeps a data: URL whole",
    source: "data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, b.png 2x",
    rewritten:
      "data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, https://host.test/app/b.png 2x",
  },
  {
    name: "keeps a data: URL that carries its own quotes and angle brackets",
    source: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/> 1x",
    rewritten: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/> 1x",
  },
  {
    name: "strips leading and trailing commas",
    source: ",a.png,",
    rewritten: "https://host.test/app/a.png",
  },
  {
    name: "balances parentheses inside a descriptor",
    source: "a.png (max-width: 100px), b.png",
    rewritten:
      "https://host.test/app/a.png (max-width: 100px), https://host.test/app/b.png",
  },
  {
    name: "keeps an unresolvable reference verbatim",
    source: "http://[ 1x",
    rewritten: "http://[ 1x",
  },
  { name: "drops an empty value", source: "", rewritten: "" },
  { name: "drops a whitespace-only value", source: "   ", rewritten: "" },
  { name: "drops a comma-only value", source: ",,,", rewritten: "" },
];

for (const srcsetCase of srcsetCases) {
  test(`rewriteAssetAttribute srcset ${srcsetCase.name}`, () => {
    assert.equal(rebaseSrcset(srcsetCase.source), srcsetCase.rewritten);
  });
}

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** The predicates only read `namespaceURI` and `localName`, so a stub is enough. */
function element(namespaceURI: string | null, localName: string): Element {
  return { namespaceURI, localName } as unknown as Element;
}

interface AttributeCase {
  name: string;
  element: Element;
  attribute: string;
  namespace?: string | null;
  url: boolean;
  srcset: boolean;
}

const attributeCases: AttributeCase[] = [
  {
    name: "a[href]",
    element: element(HTML_NAMESPACE, "a"),
    attribute: "href",
    url: true,
    srcset: false,
  },
  {
    name: "an uppercase attribute name",
    element: element(HTML_NAMESPACE, "a"),
    attribute: "HREF",
    url: true,
    srcset: false,
  },
  {
    name: "video[poster]",
    element: element(HTML_NAMESPACE, "video"),
    attribute: "poster",
    url: true,
    srcset: false,
  },
  {
    name: "input[formaction]",
    element: element(HTML_NAMESPACE, "input"),
    attribute: "formaction",
    url: true,
    srcset: false,
  },
  {
    name: "img[src]",
    element: element(HTML_NAMESPACE, "img"),
    attribute: "src",
    url: true,
    srcset: false,
  },
  {
    name: "img[srcset]",
    element: element(HTML_NAMESPACE, "img"),
    attribute: "srcset",
    url: false,
    srcset: true,
  },
  {
    name: "source[srcset]",
    element: element(HTML_NAMESPACE, "source"),
    attribute: "srcset",
    url: false,
    srcset: true,
  },
  {
    name: "srcset on an element that has no srcset",
    element: element(HTML_NAMESPACE, "div"),
    attribute: "srcset",
    url: false,
    srcset: false,
  },
  {
    name: "an attribute the element does not treat as a URL",
    element: element(HTML_NAMESPACE, "img"),
    attribute: "href",
    url: false,
    srcset: false,
  },
  {
    name: "an element with no URL attributes at all",
    element: element(HTML_NAMESPACE, "div"),
    attribute: "href",
    url: false,
    srcset: false,
  },
  // A namespaced attribute on an HTML element is not the HTML content attribute.
  {
    name: "a namespaced href on an HTML element",
    element: element(HTML_NAMESPACE, "a"),
    attribute: "href",
    namespace: XLINK_NAMESPACE,
    url: false,
    srcset: false,
  },
  {
    name: "a namespaced srcset on an img",
    element: element(HTML_NAMESPACE, "img"),
    attribute: "srcset",
    namespace: XLINK_NAMESPACE,
    url: false,
    srcset: false,
  },
  {
    name: "svg use[href]",
    element: element(SVG_NAMESPACE, "use"),
    attribute: "href",
    url: true,
    srcset: false,
  },
  {
    // Callers pass the local name, so the xlink form arrives as "href" plus its
    // namespace rather than as the qualified "xlink:href".
    name: "svg use[xlink:href]",
    element: element(SVG_NAMESPACE, "use"),
    attribute: "href",
    namespace: XLINK_NAMESPACE,
    url: true,
    srcset: false,
  },
  {
    name: "svg feImage[href], whose local name is case-sensitive",
    element: element(SVG_NAMESPACE, "feImage"),
    attribute: "href",
    url: true,
    srcset: false,
  },
  {
    name: "svg feimage[href] spelled in lowercase",
    element: element(SVG_NAMESPACE, "feimage"),
    attribute: "href",
    url: false,
    srcset: false,
  },
  {
    name: "an svg element that loads no external resource",
    element: element(SVG_NAMESPACE, "rect"),
    attribute: "href",
    url: false,
    srcset: false,
  },
  {
    name: "svg image[srcset], which the HTML rule must not reach",
    element: element(SVG_NAMESPACE, "image"),
    attribute: "srcset",
    url: false,
    srcset: false,
  },
  {
    name: "an element with no namespace",
    element: element(null, "a"),
    attribute: "href",
    url: false,
    srcset: false,
  },
];

for (const attributeCase of attributeCases) {
  test(`isURLAttribute sees ${attributeCase.name}`, () => {
    assert.equal(
      isURLAttribute(
        attributeCase.element,
        attributeCase.attribute,
        attributeCase.namespace ?? null,
      ),
      attributeCase.url,
    );
  });

  test(`isSrcsetAttribute sees ${attributeCase.name}`, () => {
    assert.equal(
      isSrcsetAttribute(
        attributeCase.element,
        attributeCase.attribute,
        attributeCase.namespace ?? null,
      ),
      attributeCase.srcset,
    );
  });
}

const HTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";

test("rewriteAssetAttribute rebases link imagesrcset like srcset", () => {
  assert.equal(
    rewriteAssetAttribute(
      { localName: "link", namespaceURI: HTML },
      "imagesrcset",
      null,
      "p1.png 1x, p2.png 2x",
      BASE,
    ),
    "https://host.test/app/p1.png 1x, https://host.test/app/p2.png 2x",
  );
});

test("rewriteAssetAttribute leaves imagesizes and non-link imagesrcset alone", () => {
  assert.equal(
    rewriteAssetAttribute(
      { localName: "link", namespaceURI: HTML },
      "imagesizes",
      null,
      "100vw",
      BASE,
    ),
    null,
  );
  assert.equal(
    rewriteAssetAttribute(
      { localName: "img", namespaceURI: HTML },
      "imagesrcset",
      null,
      "p1.png 1x",
      BASE,
    ),
    null,
  );
});

test("rewriteAssetAttribute rebases svg a href and xlink:href including fragments", () => {
  const anchor = { localName: "a", namespaceURI: SVG };
  assert.equal(
    rewriteAssetAttribute(anchor, "href", null, "next.html", BASE),
    "https://host.test/app/next.html",
  );
  assert.equal(
    rewriteAssetAttribute(anchor, "href", XLINK_NAMESPACE, "next.html", BASE),
    "https://host.test/app/next.html",
  );
  for (const namespace of [null, XLINK_NAMESPACE]) {
    assert.equal(
      rewriteAssetAttribute(anchor, "href", namespace, "#section", BASE),
      `${BASE}#section`,
    );
    for (const localName of ["use", "image", "feImage"]) {
      assert.equal(
        rewriteAssetAttribute(
          { localName, namespaceURI: SVG },
          "href",
          namespace,
          "#section",
          BASE,
        ),
        null,
      );
    }
  }
});

for (const [localName, attribute] of [
  ["object", "data"],
  ["embed", "src"],
  ["video", "poster"],
  ["input", "src"],
  ["form", "action"],
  ["button", "formaction"],
  ["input", "formaction"],
  ["blockquote", "cite"],
  ["q", "cite"],
  ["del", "cite"],
  ["ins", "cite"],
  ["area", "href"],
  ["base", "href"],
] as const) {
  test(`rewriteAssetAttribute rebases ${localName}[${attribute}]`, () => {
    assert.equal(
      rewriteAssetAttribute(
        { localName, namespaceURI: HTML },
        attribute,
        null,
        "rel/value",
        BASE,
      ),
      "https://host.test/app/rel/value",
    );
  });
}
