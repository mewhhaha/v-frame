import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index.js";
import { type HTTPFixture } from "./support/http-fixture";
import {
  mountGuestDocument,
  startGuestDocumentFixture,
} from "./support/guest-document-fixture";

let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startGuestDocumentFixture();
});

test.afterAll(async () => fixture.close());

const mounted = (page: Page, route?: string) => mountGuestDocument(page, fixture, route);

test("contextual fragments preserve tables, SVG, raw text and inert scripts", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow as Window & typeof globalThis;
    const doc = guest.document;
    const table = doc.createElement("table");
    table.innerHTML = "<tr><td>First</td></tr>";
    table
      .querySelector("tbody")!
      .insertAdjacentHTML("beforeend", "<tr><td>Second</td></tr>");
    table.querySelector("td")!.outerHTML = "<td>Replaced</td>";
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML = '<circle r="5" />';
    svg.insertAdjacentHTML("beforeend", '<path d="M0 0"/>');
    const textarea = doc.createElement("textarea");
    textarea.innerHTML = "<b>literal</b>&amp;";
    const inert = doc.createElement("div");
    inert.innerHTML = "<script>window.__fragmentExecuted = true</script>";
    doc.body.append(table, svg, textarea, inert);
    return {
      table: table.innerHTML,
      namespaces: Array.from(svg.children, (child) => child.namespaceURI),
      text: textarea.value,
      scripts: inert.querySelectorAll("script").length,
      ran:
        (guest as Window & { __fragmentExecuted?: boolean }).__fragmentExecuted === true,
    };
  });
  expect(result).toEqual({
    table: "<tbody><tr><td>Replaced</td></tr><tr><td>Second</td></tr></tbody>",
    namespaces: ["http://www.w3.org/2000/svg", "http://www.w3.org/2000/svg"],
    text: "<b>literal</b>&",
    scripts: 1,
    ran: false,
  });
});

test("document links, anchors and scripts contain HTML elements only and stay live", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const doc = element.contentWindow!.document;
    const box = doc.createElement("div");
    box.innerHTML =
      '<a id="html-link" href="#target" name="html"></a><script id="html-script" type="text/plain"></script><svg><a id="svg-link" href="#target" name="svg"></a><script id="svg-script" type="text/plain"></script><foreignObject><a id="nested-html" href="#target" name="nested"></a></foreignObject></svg>';
    doc.body.append(box);
    const collections: HTMLCollectionOf<Element>[] = [
      doc.links,
      doc.anchors,
      doc.scripts,
    ];
    const snapshot = () =>
      collections.map((collection) =>
        Array.from(collection)
          .filter((node) => box.contains(node))
          .map((node) => node.id),
      );
    const before = snapshot();
    box.querySelector("#nested-html")!.remove();
    box.querySelector("#html-script")!.remove();
    const after = snapshot();
    box.remove();
    return { before, after };
  });
  expect(result).toEqual({
    before: [["html-link", "nested-html"], ["html-link", "nested-html"], ["html-script"]],
    after: [["html-link"], ["html-link"], []],
  });
});

test("live collections reflect synchronous mutations without repeated full-tree queries", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow!;
    const doc = guest.document;
    const container = doc.createElement("div");
    container.innerHTML = Array.from(
      { length: 100 },
      (_value, index) => `<a id="row-${index}" class="row" href="/row" name="row"></a>`,
    ).join("");
    doc.body.append(container);
    const tags = doc.getElementsByTagName("a");
    const classes = doc.getElementsByClassName("row");
    const links = doc.links;
    let snapshots = 0;
    const originalArrayFrom = Array.from;
    Array.from = ((...args: unknown[]) => {
      const brand = Object.prototype.toString.call(args[0]);
      if (brand === "[object NodeList]" || brand === "[object HTMLCollection]")
        snapshots++;
      return Reflect.apply(originalArrayFrom, Array, args);
    }) as typeof Array.from;
    const first = doc.querySelector("#row-0") === tags[1];
    let indexed = 0;
    for (let index = 0; index < links.length; index++) if (links[index]) indexed++;
    Array.from = originalArrayFrom;
    const before = { tags: tags.length, classes: classes.length, links: links.length };
    const row = container.firstElementChild!;
    row.removeAttribute("href");
    row.classList.remove("row");
    row.remove();
    return {
      first,
      snapshots,
      indexed,
      before,
      after: { tags: tags.length, classes: classes.length, links: links.length },
      named: classes.namedItem("row-1")?.id,
    };
  });
  expect(result).toEqual({
    first: true,
    snapshots: 1,
    indexed: 101,
    before: { tags: 101, classes: 100, links: 101 },
    after: { tags: 100, classes: 99, links: 100 },
    named: "row-1",
  });
});
