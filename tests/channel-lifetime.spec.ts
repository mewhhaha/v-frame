import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  parkRoute,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

const stage = parkRoute({ type: "text/plain", body: "ready" });
let fixture: HTTPFixture;

function guest(name: "outgoing" | "incoming") {
  let startup = "";
  if (name === "incoming") {
    startup = `
      selections.publish("startup", { retain: true });
      await fetch("/stage");
    `;
  }
  return htmlDocument(`<script type="module">
    import { channel } from "/channel.js?${name}";
    const name = "${name}";
    const selections = channel("order.selected");
    const record = parent.recordSelection;
    const duringDisconnect = parent.publishDuringDisconnect;
    customElements.define("order-selection", class extends HTMLElement {
      connectedCallback() {
        selections.subscribe(value => record(name + ": " + value));
      }
      disconnectedCallback() {
        record(name + ": disconnected");
        duringDisconnect();
        const unsubscribe = selections.subscribe(value => record(name + " late: " + value));
        selections.publish("retired", { retain: true });
        unsubscribe();
      }
    });
    document.body.append(document.createElement("order-selection"));
    ${startup}
  </script>`);
}

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<main id="host"></main>'),
      "/dist/index.js": bundleRoute,
      "/channel.js": { type: "text/javascript", file: resolve("dist/channel.js") },
      "/outgoing": guest("outgoing"),
      "/incoming": guest("incoming"),
      "/stage": stage.route,
    },
  });
});
test.afterAll(async () => {
  stage.abandon();
  await fixture.close();
});

interface Host extends Window {
  selections: string[];
  recordSelection(value: string): void;
  publishDuringDisconnect(): void;
  readRetainedSelection(): string[];
}

async function mountOutgoing(page: Page) {
  await installBundle(page, fixture.origin);
  await page.evaluate(async (url) => {
    const { channel } = (await import(url)) as typeof import("../src/channel");
    const topic = channel<string>("order.selected");
    const host = window as unknown as Host;
    host.selections = [];
    host.recordSelection = (value) => host.selections.push(value);
    host.publishDuringDisconnect = () => topic.publish("current", { retain: true });
    host.readRetainedSelection = () => {
      const values: string[] = [];
      topic.subscribe((value) => values.push(value))();
      return values;
    };
    topic.subscribe((value) => host.recordSelection("host: " + value));
    topic.publish("initial", { retain: true });
  }, fixture.origin + "/channel.js?host");
  const frame = await mountFrame(page, { src: fixture.origin + "/outgoing" });
  expect(await deliveries(page)).toEqual(["host: initial", "outgoing: initial"]);
  return frame;
}

function deliveries(page: Page) {
  return page.evaluate(() => (window as unknown as Host).selections.splice(0));
}

function retained(page: Page) {
  return page.evaluate(() => (window as unknown as Host).readRetainedSelection());
}

test("replacement keeps both subscriptions during startup and disconnects the retired guest before its teardown", async ({
  page,
}) => {
  const frame = await mountOutgoing(page);
  const staged = page.waitForRequest(fixture.origin + "/stage");
  await frame.evaluate((element: VFrameElement) => {
    element.src = "/incoming";
  });
  await staged;
  expect(await deliveries(page)).toEqual([
    "incoming: initial",
    "host: startup",
    "outgoing: startup",
    "incoming: startup",
  ]);
  await stage.release();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  expect(await deliveries(page)).toEqual([
    "outgoing: disconnected",
    "host: current",
    "incoming: current",
  ]);
  expect(await retained(page)).toEqual(["current"]);
});

test("clearing the frame source disables its channel before the guest's disconnected callback", async ({
  page,
}) => {
  const frame = await mountOutgoing(page);
  await frame.evaluate((element) => element.removeAttribute("src"));
  expect(await deliveries(page)).toEqual(["outgoing: disconnected", "host: current"]);
  expect(await retained(page)).toEqual(["current"]);
});
