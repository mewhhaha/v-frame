import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import type { FragmentChannel } from "../src/channel";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;
interface Payload {
  items: string[];
  date: Date;
}

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<main id="host"></main>'),
      "/dist/index.js": bundleRoute,
      "/channel.js": { type: "text/javascript", file: resolve("dist/channel.js") },
      "/publisher": htmlDocument(`<button>Choose</button><script type="module">
      import { channel } from "/channel.js?publisher";
      const topic = channel("selection.v1");
      window.send = () => {
        const value = {items: ["orbit"], date: new Date(0)};
        topic.publish(value, {retain:true});
        value.items.length = 0;
      };
      document.querySelector("button").onclick = window.send;
    </script>`),
      "/reader": htmlDocument(`<output>waiting</output><script type="module">
      import { channel } from "/channel.js?reader";
      const topic = channel("selection.v1");
      topic.subscribe(({items}) => items.push("private mutation"));
      window.stopReading = topic.subscribe(({items,date}) => {
        document.querySelector("output").textContent = items.join(",") + " " + (date instanceof Date);
        parent.dispatchEvent(new CustomEvent("reader-delivered"));
      });
    </script>`),
      "/nested": htmlDocument('<v-frame src="/reader"></v-frame>'),
    },
  });
});
test.afterAll(() => fixture.close());

test("independent guests, a late nested guest and the host share a selection only within their page", async ({
  page,
  context,
}) => {
  await installBundle(page, fixture.origin);
  const publisher = await mountFrame(page, {
    id: "publisher",
    src: fixture.origin + "/publisher",
  });
  const reader = await mountFrame(page, {
    id: "reader",
    src: fixture.origin + "/reader",
  });
  await publisher.getByRole("button").click();
  await expect(reader.locator("output")).toHaveText("orbit true");
  const nested = await mountFrame(page, {
    id: "nested",
    src: fixture.origin + "/nested",
  });
  await expect(nested.locator("output")).toHaveText("orbit true");
  const hostValue = await page.evaluate(async (url) => {
    const { channel } = (await import(url)) as typeof import("../src/channel");
    const values: string[] = [];
    const stop = channel<Payload>("selection.v1").subscribe(({ items, date }) => {
      values.push(items.join(",") + " " + (date instanceof Date));
    });
    stop();
    return values;
  }, fixture.origin + "/channel.js?host");
  expect(hostValue).toEqual(["orbit true"]);
  const other = await context.newPage();
  await installBundle(other, fixture.origin);
  const isolated = await mountFrame(other, { src: fixture.origin + "/reader" });
  await expect(isolated.locator("output")).toHaveText("waiting");
  await publisher.getByRole("button").click();
  await expect(isolated.locator("output")).toHaveText("waiting");
});

test("reloading and removing fragments release their subscriptions and disable stale publishers", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const publisher = await mountFrame(page, {
    id: "publisher",
    src: fixture.origin + "/publisher",
  });
  const reader = await mountFrame(page, {
    id: "reader",
    src: fixture.origin + "/reader",
  });
  await page.evaluate(() => {
    const host = window as typeof window & { deliveries: number; staleSend?: () => void };
    host.deliveries = 0;
    window.addEventListener("reader-delivered", () => host.deliveries++);
    host.staleSend = (
      (document.querySelector("#publisher") as VFrameElement).contentWindow as Window & {
        send(): void;
      }
    ).send;
  });
  await reader.evaluate((frame: VFrameElement) => frame.reload());
  await publisher.getByRole("button").click();
  await expect(reader.locator("output")).toHaveText("orbit true");
  expect(
    await page.evaluate(
      () => (window as typeof window & { deliveries: number }).deliveries,
    ),
  ).toBe(1);
  await publisher.evaluate((frame) => frame.remove());
  await reader.evaluate((frame) => frame.remove());
  const result = await page.evaluate(async (url) => {
    const { channel } = (await import(url)) as typeof import("../src/channel");
    const topic = channel<unknown>("selection.v1");
    let received = 0;
    const stop = topic.subscribe(() => received++);
    (window as typeof window & { staleSend(): void }).staleSend();
    topic.publish("current");
    stop();
    return received;
  }, fixture.origin + "/channel.js");
  expect(result).toBe(2); // Retained selection, then the active host publication.
  expect(
    await page.evaluate(
      () => (window as typeof window & { deliveries: number }).deliveries,
    ),
  ).toBe(1);
});

test("standalone contracts support transient events, unsubscribe and atomic retained values", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  const values = await page.evaluate(async (url) => {
    const { channel } = (await import(url)) as typeof import("../src/channel");
    const topic: FragmentChannel<unknown> = channel("toString");
    const seen: unknown[] = [];
    topic.publish("one-off");
    const stop = topic.subscribe((value) => seen.push(value));
    topic.publish(undefined, { retain: true });
    stop();
    let errorName = "";
    try {
      topic.publish(() => {}, { retain: true });
    } catch (error) {
      errorName = (error as Error).name;
    }
    const stopLate = topic.subscribe((value) => seen.push(value));
    stopLate();
    channel("other").publish("unrelated");
    topic.publish("transient");
    topic.subscribe((value) => seen.push(value));
    return { seen: seen.map((value) => String(value)), errorName };
  }, fixture.origin + "/channel.js");
  expect(values).toEqual({
    seen: ["undefined", "undefined"],
    errorName: "DataCloneError",
  });
});
