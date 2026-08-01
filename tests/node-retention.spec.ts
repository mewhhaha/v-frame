// Marking a node makes the facade remember the descriptors it overwrote, so that
// dispose() can hand them back. That bookkeeping used to hold the nodes strongly,
// which meant a guest that churns rows grew for as long as the frame lived. These
// tests pin the two halves of the contract that replaced it: a node the guest has
// dropped is collectable, and a node the guest still holds is still restored.

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
  browserName,
}) => {
  // Only chromium can be told to collect; the retention it proves is not
  // engine-specific, and the leak this guards was in the facade, not the engine.
  test.skip(browserName !== "chromium", "forcing a collection needs a CDP session");

  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: `${fixture.origin}/guest`, id: "churn" });
  const cdp = await page.context().newCDPSession(page);

  const marked = await frame.evaluate(
    (element, churn) => {
      const guest = (element as FrameElement).contentWindow;
      if (guest === null) throw new Error("the settled frame has no realm window");
      const root = guest.document.querySelector("#rows");
      if (root === null) throw new Error("the guest has no row container");

      const probes: Array<WeakRef<Node>> = [];
      for (let cycle = 0; cycle < churn.cycles; cycle += 1) {
        let rows: Element[] = [];
        for (let index = 0; index < churn.rows; index += 1) {
          const row = guest.document.createElement("div");
          row.className = "row";
          row.setAttribute("data-index", String(index));
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
    { rows: ROWS_PER_CYCLE, cycles: CYCLES },
  );

  expect(marked).toBe(ROWS_PER_CYCLE * CYCLES);
  expect(await page.locator("#host v-frame#churn").count()).toBe(1);

  // Two passes: the first clears the weak references, the second collects what
  // their finalizers released.
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");

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
