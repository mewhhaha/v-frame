import { expect, test } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import type { FragmentChannel } from "../src/channel";
import type * as TestingModule from "../src/testing";
import {
  bundleRoute,
  channelBundleRoute,
  htmlDocument,
  startHTTPFixture,
  testingBundleRoute,
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
      "/dist/testing.js": testingBundleRoute,
      "/channel.js": channelBundleRoute,
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
  const hostValue = await page.evaluate(async (origin) => {
    const { channel } = (await import(
      `${origin}/channel.js?host`
    )) as typeof import("../src/channel");
    const { resetChannels, shadowScreen, withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;

    // Dogfood shadowScreen + withinFrame across sibling and nested channel guests.
    const allStatuses = shadowScreen
      .getAllByRole("status")
      .map((element) => element.textContent);
    const readerFrame = document.querySelector<VFrameElement>("#reader")!;
    const readerStatus = withinFrame(readerFrame).getByRole("status").textContent;

    const values: string[] = [];
    const stop = channel<Payload>("selection.v1").subscribe(({ items, date }) => {
      values.push(items.join(",") + " " + (date instanceof Date));
    });
    stop();

    // Dogfood resetChannels(): clears retained state so a fresh check sees undefined,
    // then re-publish through the publisher guest button for the isolation check below.
    resetChannels();
    const clearedRetained = channel<Payload>("selection.v1").get();
    const publisherFrame = document.querySelector<VFrameElement>("#publisher")!;
    withinFrame(publisherFrame).getByRole("button", { name: "Choose" }).click();

    return { values, allStatuses, readerStatus, clearedRetained };
  }, fixture.origin);
  expect(hostValue).toEqual({
    values: ["orbit true"],
    allStatuses: ["orbit true", "orbit true"],
    readerStatus: "orbit true",
    clearedRetained: undefined,
  });
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

test("a listener can republish without leaving other teams on an older selection", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  const result = await page.evaluate(async (url) => {
    const first = (await import(url + "?archive")) as typeof import("../src/channel");
    const second = (await import(url + "?flight")) as typeof first;
    const archive = first.channel<{ id: number }>("photo");
    const flight = second.channel<{ id: number }>("photo");
    const unrelated = second.channel<string>("status");
    const order: string[] = [];
    const joined: number[] = [];
    unrelated.subscribe((value) => order.push(value));
    archive.subscribe(({ id }) => {
      order.push(`archive ${id}`);
      if (id !== 1) return;
      const next = { id: 2 };
      flight.publish(next, { retain: true });
      next.id = 99;
      flight.subscribe((value) => joined.push(value.id));
      unrelated.publish("status");
    });
    flight.subscribe(({ id }) => order.push(`flight ${id}`));
    archive.publish({ id: 1 }, { retain: true });
    order.push("returned");
    flight.subscribe(({ id }) => order.push(`late ${id}`));
    return { order, joined };
  }, fixture.origin + "/channel.js");
  expect(result).toEqual({
    order: [
      "archive 1",
      "status",
      "flight 1",
      "archive 2",
      "flight 2",
      "returned",
      "late 2",
    ],
    joined: [1, 2],
  });
});

test("supports get(), clear(), AbortSignal unsubscription, non-reentrant initial replay, and bounded re-entrant publish queues", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  const result = await page.evaluate(async (url) => {
    const { channel } = (await import(url)) as typeof import("../src/channel");
    const topic = channel<{ id: number }>("ergonomics");
    const before = topic.get();
    topic.publish({ id: 1 }, { retain: true });
    const snapshot = topic.get();
    if (snapshot) snapshot.id = 999;
    const afterMutation = topic.get();

    const controller = new AbortController();
    const seen: number[] = [];
    topic.subscribe(
      (value) => {
        seen.push(value.id);
        if (value.id === 1) {
          // Synchronous publish during initial replay must not re-enter this listener.
          topic.publish({ id: 2 }, { retain: true });
        }
      },
      { signal: controller.signal },
    );
    topic.publish({ id: 3 }, { retain: true });
    controller.abort();
    topic.publish({ id: 4 }, { retain: true });
    topic.clear();
    const afterClear = topic.get();

    const loop = channel<number>("loop");
    let loopError = "";
    loop.subscribe((count) => {
      try {
        loop.publish(count + 1);
      } catch (error) {
        loopError = (error as Error).name;
      }
    });
    loop.publish(0);

    return { before, afterMutation, seen, afterClear, loopError };
  }, fixture.origin + "/channel.js");

  expect(result).toEqual({
    before: undefined,
    afterMutation: { id: 1 },
    seen: [1, 3],
    afterClear: undefined,
    loopError: "RangeError",
  });
});

test("routes guest subscriber errors to the guest realm instead of host window.onerror", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await page.evaluate(() => {
    (window as typeof window & { __hostWindowErrors: string[] }).__hostWindowErrors = [];
    window.addEventListener("error", (event) => {
      (
        window as typeof window & { __hostWindowErrors: string[] }
      ).__hostWindowErrors.push(event.message);
    });
  });

  const frame = await mountFrame(page, { src: fixture.origin + "/reader" });
  await page.evaluate(async (url) => {
    const { channel } = (await import(url)) as typeof import("../src/channel");
    const topic = channel<string>("errors.v1");
    (window as typeof window & { __hostSeen: string[] }).__hostSeen = [];
    topic.subscribe((value) =>
      (window as typeof window & { __hostSeen: string[] }).__hostSeen.push(value),
    );
  }, fixture.origin + "/channel.js?host-err");

  await frame.evaluate((element: VFrameElement) => {
    element.addEventListener("v-frame-error", (event) => {
      const detail = (event as CustomEvent<{ phase: string; error: Error }>).detail;
      (window as typeof window & { __frameErrors?: string[] }).__frameErrors = [
        ...((window as typeof window & { __frameErrors?: string[] }).__frameErrors ?? []),
        `${detail.phase}:${detail.error.message}`,
      ];
    });
  });

  await frame.evaluate(async (element: VFrameElement) => {
    const child = element.contentWindow! as Window & typeof globalThis;
    const mod = (await child.eval(
      'import("/channel.js?guest-err")',
    )) as typeof import("../src/channel");
    mod.channel<string>("errors.v1").subscribe(() => {
      throw new Error("guest subscriber boom");
    });
  });

  await page.evaluate(async (url) => {
    const { channel } = (await import(url)) as typeof import("../src/channel");
    channel<string>("errors.v1").publish("ping");
  }, fixture.origin + "/channel.js?host-err");

  const outcome = await page.evaluate(() => ({
    hostSeen: (window as typeof window & { __hostSeen: string[] }).__hostSeen,
    frameErrors:
      (window as typeof window & { __frameErrors?: string[] }).__frameErrors ?? [],
    hostWindowErrors: (window as typeof window & { __hostWindowErrors: string[] })
      .__hostWindowErrors,
  }));
  expect(outcome.hostSeen).toEqual(["ping"]);
  expect(outcome.frameErrors).toEqual(["runtime:guest subscriber boom"]);
  expect(outcome.hostWindowErrors).toEqual([]);
});
