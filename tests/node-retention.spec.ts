// The facade keeps several registries keyed by guest element: the descriptors
// marking overwrote, the authored style and URL attributes rebasing has to answer
// with, and the targets dispose() has to take native listeners back off. Every one
// of them used to hold its elements strongly, which meant a guest that churns rows
// grew for as long as the frame lived. These tests pin the two halves of the
// contract that replaced them: a node the guest has dropped is collectable, and a
// node the guest still holds is still restored.
//
// The churned rows therefore carry one of everything a registry admits an element
// for — a URL attribute, a handler property, a listener, and a style attribute on
// every tenth — so that a registry going back to strong keys fails here rather than
// in a benchmark. Against the strong registries this reported all 2,000 rows alive.

import { expect, test } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  type HTTPFixture,
  startHTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

/** Rows per churn cycle, and cycles — enough that a leak is unmistakable. */
const ROWS_PER_CYCLE = 500;
const CYCLES = 4;
/**
 * Every nth row carries a style attribute. Writing one rebuilds the whole inline
 * stylesheet from the elements the facade is still holding, so styling all 2,000
 * would make this test quadratic and time out; 200 is far more than enough for a
 * strong registry to hold on to them.
 */
const STYLED_EVERY = 10;

interface FrameElement extends HTMLElement {
  readonly contentWindow: (Window & typeof globalThis) | null;
}

interface ProbeWindow extends Window {
  churnProbes?: Array<WeakRef<Node>>;
  heldRow?: Element;
}

let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/guest": htmlDocument('<div id="rows"></div>'),
      "/dist/index.js": bundleRoute,
    },
  });
});

test.afterAll(async () => {
  await fixture.close();
});

test("releases marked nodes once the guest has removed and dropped them", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: `${fixture.origin}/guest`, id: "churn" });

  const marked = await frame.evaluate(
    (element, churn) => {
      const guest = (element as FrameElement).contentWindow;
      if (guest === null) throw new Error("the settled frame has no realm window");
      const root = guest.document.querySelector("#rows");
      if (root === null) throw new Error("the guest has no row container");

      const probes: Array<WeakRef<Node>> = [];
      const handler = () => undefined;
      for (let cycle = 0; cycle < churn.cycles; cycle += 1) {
        let rows: Element[] = [];
        for (let index = 0; index < churn.rows; index += 1) {
          const row = guest.document.createElement("a");
          row.className = "row";
          row.setAttribute("data-index", String(index));
          row.setAttribute("href", `/row-${index}`);
          if (index % churn.styledEvery === 0) {
            row.setAttribute("style", "color: rgb(1, 2, 3)");
          }
          row.onclick = handler;
          row.addEventListener("pointerdown", handler);
          row.append(guest.document.createTextNode(`row ${index}`));
          root.append(row);
          rows.push(row);
          probes.push(new WeakRef(row));
        }
        for (const row of rows) {
          row.remove();
        }
        rows = [];
      }
      (window as ProbeWindow).churnProbes = probes;
      return probes.length;
    },
    { rows: ROWS_PER_CYCLE, cycles: CYCLES, styledEvery: STYLED_EVERY },
  );

  expect(marked).toBe(ROWS_PER_CYCLE * CYCLES);
  expect(await page.locator("#host v-frame#churn").count()).toBe(1);

  // Two passes: the first clears the weak references, the second collects what
  // their finalizers released. `page.requestGC()` reaches both engines — it is
  // `HeapProfiler.collectGarbage` over CDP on chromium and the juggler
  // `Heap.collectGarbage` on firefox — so this case is not chromium-only. Only
  // reading how many *bytes* are retained is, which is why `pnpm bench` still
  // opens a CDP session and this test does not.
  await page.requestGC();
  await page.requestGC();

  const live = await page.evaluate(
    () =>
      (window as ProbeWindow).churnProbes?.filter((probe) => probe.deref() !== undefined)
        .length ?? -1,
  );
  expect(live).toBe(0);
});

test("still restores a removed node the guest kept a reference to", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: `${fixture.origin}/guest`, id: "held" });

  const held = await frame.evaluate((element) => {
    const guest = (element as FrameElement).contentWindow;
    if (guest === null) throw new Error("the settled frame has no realm window");
    const root = guest.document.querySelector("#rows");
    if (root === null) throw new Error("the guest has no row container");
    const row = guest.document.createElement("div");
    root.append(row);
    row.remove();
    (window as ProbeWindow).heldRow = row;
    return {
      ownerDocument: row.ownerDocument === guest.document,
      rootNode: row.getRootNode() === row,
    };
  });
  expect(held).toEqual({ ownerDocument: true, rootNode: true });

  await frame.evaluate((element) => element.remove());

  const restored = await page.evaluate(() => {
    const row = (window as ProbeWindow).heldRow;
    if (row === undefined) throw new Error("the held row was lost");
    return {
      ownerDocument: row.ownerDocument === document,
      rootNode: row.getRootNode() === row,
    };
  });
  expect(restored).toEqual({ ownerDocument: true, rootNode: true });
});
