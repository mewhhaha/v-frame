import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index.js";
import { type HTTPFixture } from "./support/http-fixture";
import {
  mountAtSecondDocument,
  startGuestDocumentFixture,
} from "./support/guest-document-fixture";

let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startGuestDocumentFixture();
});

test.afterAll(async () => fixture.close());

const atSecondDocument = (page: Page) => mountAtSecondDocument(page, fixture);

test("cross-document traversal settles after the replacement guest activates", async ({
  page,
}) => {
  const frame = await atSecondDocument(page);
  const result = await frame.evaluate(async (element: VFrameElement) => {
    let navigated = 0;
    element.addEventListener("v-frame-navigated", () => navigated++);
    const snapshot = () => ({
      text: element.contentWindow?.document.querySelector("#target")?.textContent,
      path: new URL(element.currentURL!).pathname,
      status: element.status,
      back: element.canGoBack,
      forward: element.canGoForward,
      navigated,
    });
    await element.back();
    const back = snapshot();
    await element.forward();
    return { back, forward: snapshot() };
  });
  expect(result).toEqual({
    back: {
      text: "First",
      path: "/first",
      status: "ready",
      back: false,
      forward: true,
      navigated: 1,
    },
    forward: {
      text: "Second",
      path: "/second",
      status: "ready",
      back: true,
      forward: false,
      navigated: 2,
    },
  });
});

test("failed document traversal rejects and preserves the active history entry", async ({
  page,
}) => {
  const frame = await atSecondDocument(page);
  await page.route(`${fixture.origin}/first`, (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  const result = await frame.evaluate(async (element: VFrameElement) => {
    let error = "";
    try {
      await element.back();
    } catch (cause) {
      error = (cause as Error).message;
    }
    return {
      error,
      url: element.currentURL,
      status: element.status,
      text: element.contentWindow?.document.querySelector("#target")?.textContent,
      back: element.canGoBack,
    };
  });
  expect(result.error).toContain("503");
  expect(result).toMatchObject({
    url: `${fixture.origin}/second`,
    status: "ready",
    text: "Second",
    back: true,
  });
});

test("disconnecting an in-flight document traversal rejects with AbortError", async ({
  page,
}) => {
  const frame = await atSecondDocument(page);
  let requested!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${fixture.origin}/first`, async (route) => {
    requested();
    await held;
    await route.abort().catch(() => undefined);
  });
  await frame.evaluate((element: VFrameElement) => {
    (window as Window & { traversal?: Promise<string> }).traversal = element.back().then(
      () => "resolved",
      (error: Error) => error.name,
    );
  });
  await reached;
  await frame.evaluate((element) => element.remove());
  release();
  expect(
    await page.evaluate(
      () => (window as Window & { traversal?: Promise<string> }).traversal,
    ),
  ).toBe("AbortError");
});
