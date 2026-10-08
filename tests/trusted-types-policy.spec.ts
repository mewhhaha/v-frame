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

test("changing or clearing a live Trusted Types policy object reloads exactly once", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate(async (element: VFrameElement) => {
    let starts = 0;
    const originalWindow = element.contentWindow;
    element.addEventListener("v-frame-loadstart", () => starts++);
    const policy = {
      name: "review-policy",
      createHTML: (source: string) => source,
      createScript: (source: string) => source,
      createScriptURL: (source: string) => source,
    };
    const changed = new Promise<void>((resolve) =>
      element.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    element.trustedTypesPolicy = policy;
    await changed;
    const replaced = element.contentWindow !== originalWindow;
    element.trustedTypesPolicy = policy;
    const afterSame = starts;
    const cleared = new Promise<void>((resolve) =>
      element.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    element.trustedTypesPolicy = null;
    await cleared;
    return { replaced, afterSame, starts, policy: element.trustedTypesPolicy };
  });
  expect(result).toEqual({ replaced: true, afterSame: 1, starts: 2, policy: null });
});
