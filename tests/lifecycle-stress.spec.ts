import { expect, test, type Route } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";
import type { VFrameElement } from "../src/index";
import { settleAfterRoundTrip } from "./support/settle";

let fixture: HTTPFixture;
// Snapshot recording retains detached execution realms and adds rendering work.
// Keep collection and CPU measurements free of that instrumentation.
test.use({ trace: "off" });
const rows = Array.from(
  { length: 500 },
  (_, i) =>
    `<tr><td>Order ${i}</td><td><a href="/orders/${i}">Details</a></td><td>${i % 2 ? "Ready" : "Pending"}</td></tr>`,
).join("");
test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/guest": () => ({
        body: htmlDocument(
          `<h1>Orders</h1><table><tbody>${rows}</tbody></table><button id="counter">Count</button><output id="count">0</output><script>
      const id=new URL(location.href).searchParams.get('id') || 'initial';
      top.probeCounts ||= {};top.probeCounts[id]=0;
          window.addEventListener('resize',()=>{if(top.probing)top.probeCounts[id]++;});
      document.querySelector('#counter').onclick=()=>document.querySelector('#count').textContent=String(+document.querySelector('#count').textContent+1);
      </script>`,
          `<style>body{margin:0;font:16px system-ui}table{border-collapse:collapse}td{padding:4px}</style>`,
        ),
      }),
    },
  });
});
test.afterAll(async () => fixture.close());

test("twenty document replacements leave one live realm and no stale resize listeners", async ({
  page,
  browserName,
}) => {
  test.setTimeout(45_000);
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "stress",
    src: fixture.origin + "/guest?id=0",
    settle: "load",
  });
  await frame.evaluate((element) => {
    const host = window as Window &
      typeof globalThis & { oldBodies: WeakRef<Node>[]; oldDocuments: Document[] };
    host.oldBodies = [];
    host.oldDocuments = [];
    element.style.cssText = "width:600px;height:320px;overflow:auto";
  });
  for (let index = 1; index <= 20; index++) {
    await frame.evaluate(async (element, url) => {
      const control = element as VFrameElement;
      (
        window as Window & typeof globalThis & { oldBodies: WeakRef<Node>[] }
      ).oldBodies.push(new WeakRef(control.contentWindow!.document.body));
      (
        window as Window & typeof globalThis & { oldDocuments: Document[] }
      ).oldDocuments.push(control.contentWindow!.document);
      const loaded = new Promise<void>((resolve) =>
        control.addEventListener("v-frame-load", () => resolve(), { once: true }),
      );
      control.contentWindow!.location.assign(url);
      await loaded;
    }, `${fixture.origin}/guest?id=${index}`);
    await expect(frame.locator("iframe")).toHaveCount(1);
    await expect(frame.locator("v-html")).toHaveCount(1);
    await frame.locator("#counter").click();
    await expect(frame.locator("#count")).toHaveText("1");
    await page.evaluate(() => {
      const host = window as Window & typeof globalThis & { probing: boolean };
      host.probing = true;
      dispatchEvent(new Event("resize"));
      host.probing = false;
    });
  }
  const counts = await page.evaluate(
    () =>
      (window as Window & typeof globalThis & { probeCounts: Record<string, number> })
        .probeCounts,
  );
  expect(counts).toEqual(
    Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [String(i), i === 0 ? 0 : 1]),
    ),
  );
  expect(
    await page.evaluate(() =>
      (
        window as Window & typeof globalThis & { oldDocuments: Document[] }
      ).oldDocuments.every(
        (doc) => !Object.hasOwn(doc, "body") && doc.getElementById("counter") === null,
      ),
    ),
  ).toBe(true);
  await page.evaluate(() => {
    // Holding old documents can keep their engine-side accessor caches alive.
    // Their facade was restored above; now drop the caller's realm references.
    (window as Window & typeof globalThis & { oldDocuments: Document[] }).oldDocuments =
      [];
  });
  if (browserName !== "webkit") {
    // Realm finalization and cross-document cycle collection may span tasks.
    // A bounded retry still fails a strong reference leak of any old body.
    await expect
      .poll(async () => {
        await page.requestGC();
        return page.evaluate(() =>
          (
            window as Window & typeof globalThis & { oldBodies: WeakRef<Node>[] }
          ).oldBodies.flatMap((probe, index) => (probe.deref() ? [index] : [])),
        );
      })
      .toEqual([]);
  }
  await frame.evaluate((element) => element.remove());
  await page.evaluate(() => {
    const host = window as Window & typeof globalThis & { probing: boolean };
    host.probing = true;
    dispatchEvent(new Event("resize"));
    host.probing = false;
  });
  expect(
    await page.evaluate(
      () =>
        (window as Window & typeof globalThis & { probeCounts: Record<string, number> })
          .probeCounts,
    ),
  ).toEqual(counts);
});

test("a network timeout rolls back to the interactive guest and a retry succeeds", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "recovery",
    src: fixture.origin + "/guest?id=initial",
  });
  await page.route("**/guest?id=retry", (route) => route.abort("timedout"));
  const failure = await frame.evaluate(async (element, url) => {
    try {
      const control = element as VFrameElement;
      return await new Promise<string | null>((resolve) => {
        const lifetime = new AbortController();
        control.addEventListener(
          "v-frame-load",
          () => {
            lifetime.abort();
            resolve(null);
          },
          { signal: lifetime.signal },
        );
        control.addEventListener(
          "v-frame-error",
          (event) => {
            lifetime.abort();
            resolve(String(event.detail.error));
          },
          { signal: lifetime.signal },
        );
        control.contentWindow!.location.assign(url);
      });
    } catch (error) {
      return String(error);
    }
  }, fixture.origin + "/guest?id=retry");
  expect(failure).not.toBeNull();
  expect(await frame.evaluate((element) => (element as VFrameElement).currentURL)).toBe(
    fixture.origin + "/guest?id=initial",
  );
  await expect(frame.locator("iframe")).toHaveCount(1);
  await frame.locator("#counter").click();
  await expect(frame.locator("#count")).toHaveText("1");
  await page.unroute("**/guest?id=retry");
  await frame.evaluate(async (element, url) => {
    const control = element as VFrameElement;
    const loaded = new Promise<void>((resolve) =>
      control.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    control.contentWindow!.location.assign(url);
    await loaded;
  }, fixture.origin + "/guest?id=retry");
  await expect(frame.locator("#count")).toHaveText("0");
  expect(await frame.evaluate((element) => (element as VFrameElement).status)).toBe(
    "ready",
  );
});

test("superseding a stalled request never lets its eventual response replace the new guest", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "stall",
    src: fixture.origin + "/guest?id=initial",
  });
  let stalled: Route | undefined;
  await page.route("**/guest?id=stalled", (route) => {
    stalled = route;
  });
  await frame.evaluate((element, url) => {
    (element as VFrameElement).contentWindow!.location.assign(url);
  }, fixture.origin + "/guest?id=stalled");
  await expect.poll(() => stalled !== undefined).toBe(true);
  await expect(frame.locator("#counter")).toBeVisible();
  await frame.evaluate((element, url) => {
    (element as VFrameElement).src = url;
  }, fixture.origin + "/guest?id=recovered");
  await expect
    .poll(() => frame.evaluate((element) => (element as VFrameElement).currentURL))
    .toBe(fixture.origin + "/guest?id=recovered");
  await expect
    .poll(() => frame.evaluate((element) => (element as VFrameElement).status))
    .toBe("ready");
  await expect(frame.locator("iframe")).toHaveCount(1);
  await stalled!.fulfill({
    contentType: "text/html",
    body: htmlDocument('<h1 id="stale">The superseded response</h1>'),
  });
  await settleAfterRoundTrip(page, `${fixture.origin}/sentinel`);
  await expect(frame.locator("#stale")).toHaveCount(0);
  await frame.locator("#counter").click();
  await expect(frame.locator("#count")).toHaveText("1");
  expect(await frame.evaluate((element) => (element as VFrameElement).currentURL)).toBe(
    fixture.origin + "/guest?id=recovered",
  );
});

test("realistic table activation and mutation stay within a 4× CPU regression budget", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "CPU throttling requires Chromium CDP");
  test.setTimeout(30_000);
  await installBundle(page, fixture.origin);
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    const result = await page.evaluate(async (url) => {
      const frame = document.createElement("v-frame") as VFrameElement;
      frame.style.cssText = "display:block;width:640px;height:400px";
      frame.src = url;
      const loaded = new Promise<void>((resolve) =>
        frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
      );
      const start = performance.now();
      document.querySelector("#host")!.append(frame);
      await loaded;
      const activated = performance.now() - start;
      const doc = frame.contentWindow!.document;
      const initialRows = doc.querySelectorAll("tr").length;
      const mutationStart = performance.now();
      const fragment = doc.createDocumentFragment();
      for (let i = 0; i < 100; i++) {
        const row = doc.createElement("tr");
        row.innerHTML = `<td>New ${i}</td><td><a href="/orders/new-${i}">Details</a></td><td>Ready</td>`;
        fragment.append(row);
      }
      doc.querySelector("tbody")!.append(fragment);
      const mutated = performance.now() - mutationStart;
      return {
        activated,
        mutated,
        initialRows,
        finalRows: doc.querySelectorAll("tr").length,
      };
    }, fixture.origin + "/guest?id=performance");
    await test.info().attach("cpu-throttled-performance", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
    expect(result).toMatchObject({ initialRows: 500, finalRows: 600 });
    expect(result.activated).toBeLessThan(5000);
    expect(result.mutated).toBeLessThan(1000);
  } finally {
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.detach();
  }
});
