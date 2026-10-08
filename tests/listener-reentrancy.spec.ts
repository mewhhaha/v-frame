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

test("once listeners cannot re-enter and can re-register during invocation", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow as Window & typeof globalThis;
    const button = guest.document.createElement("button");
    guest.document.body.append(button);
    return [guest.document, guest.document.documentElement, guest, button].map(
      (target) => {
        let reentrant = 0;
        target.addEventListener(
          "reentrant",
          () => {
            reentrant++;
            if (reentrant === 1) target.dispatchEvent(new guest.Event("reentrant"));
          },
          { once: true },
        );
        target.dispatchEvent(new guest.Event("reentrant"));
        let registered = 0;
        const again = () => {
          registered++;
          if (registered === 1) target.addEventListener("again", again, { once: true });
        };
        target.addEventListener("again", again, { once: true });
        target.dispatchEvent(new guest.Event("again"));
        target.dispatchEvent(new guest.Event("again"));
        return { reentrant, registered };
      },
    );
  });
  expect(result).toEqual(
    Array.from({ length: 4 }, () => ({ reentrant: 1, registered: 2 })),
  );
});

test("relayed listener exceptions are reported without skipping later listeners", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow as Window & typeof globalThis;
    const button = guest.document.createElement("button");
    guest.document.body.append(button);
    let reports = 0;
    const seen: string[] = [];
    guest.addEventListener("error", (event) => {
      reports++;
      event.preventDefault();
    });
    for (const [name, target] of [
      ["document", guest.document],
      ["root", guest.document.documentElement],
    ] as const) {
      target.addEventListener("throwing", () => {
        throw new Error(name);
      });
      target.addEventListener("throwing", () => seen.push(name));
    }
    button.dispatchEvent(new guest.Event("throwing", { bubbles: true }));
    return { reports, seen };
  });
  expect(result).toEqual({ reports: 2, seen: ["root", "document"] });
});

test("passive listeners do not cancel logical or physical default actions", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow as Window & typeof globalThis;
    const button = guest.document.createElement("button");
    guest.document.body.append(button);
    const prevented: boolean[] = [];
    for (const target of [
      button,
      guest.document.documentElement,
      guest.document,
      guest,
    ]) {
      target.addEventListener(
        "passive",
        (event) => {
          event.preventDefault();
          event.returnValue = false;
          prevented.push(event.defaultPrevented);
        },
        { passive: true },
      );
    }
    const event = new guest.Event("passive", { cancelable: true, bubbles: true });
    const dispatched = button.dispatchEvent(event);
    return { dispatched, physical: event.defaultPrevented, prevented };
  });
  expect(result).toEqual({
    dispatched: true,
    physical: false,
    prevented: [false, false, false, false],
  });
});
