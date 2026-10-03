import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;
test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/events": htmlDocument(
        '<a id="link" href="/destination">Go</a><form id="form" action="/destination"><input name="value" value="submitted"><button>Submit</button></form>',
      ),
      "/destination": htmlDocument('<main id="destination">Destination</main>'),
    },
  });
});
test.afterAll(async () => {
  await fixture.close();
});

async function mount(page: Page) {
  await installBundle(page, fixture.origin);
  await page.evaluate(() => {
    const other = document.createElement("iframe");
    other.id = "other";
    document.body.append(other);
  });
  const frame = await mountFrame(page, { src: fixture.origin + "/events", id: "frame" });
  await frame.evaluate((element) => {
    const observed = element as VFrameElement & { navigations: string[] };
    observed.navigations = [];
    element.addEventListener("v-frame-navigated", (event) => {
      observed.navigations.push((event as CustomEvent<{ kind: string }>).detail.kind);
    });
  });
  return frame;
}

for (const realm of ["host", "guest", "other"] as const) {
  for (const cancelable of [true, false]) {
    for (const canceled of [true, false]) {
      test(`a ${realm} mouse click opens exactly one gated window (cancelable=${cancelable}, canceled=${canceled})`, async ({
        page,
      }) => {
        await mount(page);
        const popups: Page[] = [];
        page.on("popup", (popup) => popups.push(popup));
        const observation = await page.evaluate(
          async ({ realm, cancelable, canceled, destination }) => {
            const element = document.querySelector("#frame") as VFrameElement;
            const child = element.contentWindow!;
            const view = (
              realm === "host"
                ? window
                : realm === "guest"
                  ? child
                  : (document.querySelector("#other") as HTMLIFrameElement).contentWindow!
            ) as Window & typeof globalThis;
            const link = child.document.querySelector("#link") as HTMLAnchorElement;
            link.target = "_blank";
            let gates = 0;
            element.addEventListener("v-frame-navigate", (event) => {
              gates++;
              if (canceled) event.preventDefault();
            });
            // Default actions must use the values chosen by guest listeners, not
            // the attributes that existed when capture intercepted the event.
            const inspected: string[] = [];
            child.addEventListener(
              "click",
              () => {
                inspected.push(link.getAttribute("href")!);
                link.href = destination + "?updated";
              },
              { once: true },
            );
            const event = new view.MouseEvent("click", { bubbles: true, cancelable });
            Object.freeze(event);
            const returned = link.dispatchEvent(event);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            return {
              gates,
              returned,
              inspected,
              href: link.href,
              guestURL: element.currentURL,
            };
          },
          { realm, cancelable, canceled, destination: fixture.origin + "/destination" },
        );
        if (!canceled) {
          await expect.poll(() => popups.length).toBe(1);
          await popups[0]!.waitForLoadState();
          expect(popups[0]!.url()).toBe(fixture.origin + "/destination?updated");
        }
        expect(popups).toHaveLength(canceled ? 0 : 1);
        expect(observation).toEqual({
          gates: 1,
          returned: true,
          inspected: ["/destination"],
          href: fixture.origin + "/destination?updated",
          guestURL: fixture.origin + "/events",
        });
        expect(page.url()).toBe(fixture.origin + "/");
        for (const popup of popups) await popup.close();
      });
    }
  }
  for (const cancelable of [true, false]) {
    test(`routes a ${realm}-constructed mouse click without host navigation (cancelable=${cancelable})`, async ({
      page,
    }) => {
      const frame = await mount(page);
      await frame.evaluate(
        (element: VFrameElement, { realm, cancelable }) => {
          const child = element.contentWindow!;
          const view = (
            realm === "host"
              ? window
              : realm === "guest"
                ? child
                : (document.querySelector("#other") as HTMLIFrameElement).contentWindow!
          ) as Window & typeof globalThis;
          child.document
            .querySelector("#link")!
            .dispatchEvent(
              new view.MouseEvent("click", { bubbles: true, cancelable, button: 0 }),
            );
        },
        { realm, cancelable },
      );
      // WebKit leaves canceled native navigations pending for locator auto-wait.
      // Observe the actual guest document, rather than that protocol state.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                document.querySelector("#frame") as VFrameElement
              )?.contentWindow?.document.querySelector("#destination")?.textContent,
          ),
        )
        .toBe("Destination");
      expect(page.url()).toBe(fixture.origin + "/");
      expect(
        await page.evaluate(() => {
          const element = document.querySelector("#frame") as VFrameElement & {
            navigations: string[];
          };
          return {
            url: element.currentURL,
            length: element.contentWindow!.history.length,
            navigations: element.navigations,
          };
        }),
      ).toEqual({
        url: fixture.origin + "/destination",
        length: 2,
        navigations: ["link"],
      });
    });
  }

  test(`a guest window listener can cancel a ${realm}-constructed mouse click`, async ({
    page,
  }) => {
    const frame = await mount(page);
    const observation = await frame.evaluate(async (element: VFrameElement, realm) => {
      const child = element.contentWindow!;
      const view = (
        realm === "host"
          ? window
          : realm === "guest"
            ? child
            : (document.querySelector("#other") as HTMLIFrameElement).contentWindow!
      ) as Window & typeof globalThis;
      const seen: boolean[] = [];
      child.addEventListener(
        "click",
        (event) => {
          seen.push(event.defaultPrevented);
          event.preventDefault();
          seen.push(event.defaultPrevented);
        },
        { once: true },
      );
      child.document
        .querySelector("#link")!
        .dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // A caller can cancel the original event before dispatch, too. That flag
      // must not be mistaken for the runtime's own default suppression.
      const preCanceled = new view.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      preCanceled.preventDefault();
      child.document
        .querySelector("#link")!
        .addEventListener("click", (event) => seen.push(event.defaultPrevented), {
          once: true,
        });
      child.document.querySelector("#link")!.dispatchEvent(preCanceled);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { seen, url: element.currentURL };
    }, realm);
    expect(observation).toEqual({
      seen: [false, true, true],
      url: fixture.origin + "/events",
    });
    expect(page.url()).toBe(fixture.origin + "/");
    // A later uncanceled action proves the canceled task did not add an entry.
    await frame.locator("#link").click();
    await expect(frame.locator("#destination")).toBeVisible();
    expect(
      await frame.evaluate(
        (element: VFrameElement) => element.contentWindow!.history.length,
      ),
    ).toBe(2);
  });

  for (const cancelable of [true, false]) {
    test(`a ${realm}-constructed submit only notifies, while requestSubmit navigates (cancelable=${cancelable})`, async ({
      page,
    }) => {
      const frame = await mount(page);
      const seen = await frame.evaluate(
        async (element: VFrameElement, { realm, cancelable }) => {
          const child = element.contentWindow!;
          const view = (
            realm === "host"
              ? window
              : realm === "guest"
                ? child
                : (document.querySelector("#other") as HTMLIFrameElement).contentWindow!
          ) as Window & typeof globalThis;
          const form = child.document.querySelector("#form") as HTMLFormElement;
          const seen: Array<{ trusted: boolean; prevented: boolean }> = [];
          child.document.addEventListener(
            "submit",
            (event) =>
              seen.push({ trusted: event.isTrusted, prevented: event.defaultPrevented }),
            { once: true },
          );
          form.dispatchEvent(
            new view.SubmitEvent("submit", {
              bubbles: true,
              cancelable,
              submitter: form.querySelector("button"),
            }),
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          return seen;
        },
        { realm, cancelable },
      );
      expect(seen).toEqual([{ trusted: false, prevented: false }]);
      expect(page.url()).toBe(fixture.origin + "/");
      expect(await frame.evaluate((element: VFrameElement) => element.currentURL)).toBe(
        fixture.origin + "/events",
      );
      await frame.evaluate((element: VFrameElement) =>
        (
          element.contentWindow!.document.querySelector("#form") as HTMLFormElement
        ).requestSubmit(),
      );
      await expect(frame.locator("#destination")).toBeVisible();
      expect(page.url()).toBe(fixture.origin + "/");
      expect(
        await frame.evaluate((element: VFrameElement & { navigations: string[] }) => ({
          url: element.currentURL,
          navigations: element.navigations,
        })),
      ).toEqual({
        url: fixture.origin + "/destination?value=submitted",
        navigations: ["form"],
      });
    });
  }
}

for (const scope of ["window", "document", "body", "link"] as const) {
  for (const immediate of [true, false]) {
    test(`a non-cancelable click cannot duplicate activation after ${scope} stops ${immediate ? "immediate " : ""}propagation`, async ({
      page,
    }) => {
      await mount(page);
      const popups: Page[] = [];
      page.on("popup", (popup) => popups.push(popup));
      await page.evaluate(
        async ({ scope, immediate }) => {
          const element = document.querySelector("#frame") as VFrameElement;
          const child = element.contentWindow! as Window & typeof globalThis;
          const link = child.document.querySelector("#link") as HTMLAnchorElement;
          link.target = "_blank";
          const target =
            scope === "window"
              ? child
              : scope === "document"
                ? child.document
                : scope === "body"
                  ? child.document.body
                  : link;
          target.addEventListener(
            "click",
            (event) => {
              if (immediate) event.stopImmediatePropagation();
              else event.stopPropagation();
              link.href = "/destination?stopped";
            },
            { once: true, capture: true },
          );
          link.dispatchEvent(
            new child.MouseEvent("click", { bubbles: true, cancelable: false }),
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        },
        { scope, immediate },
      );
      await expect.poll(() => popups.length).toBe(1);
      await popups[0]!.waitForLoadState();
      expect(popups).toHaveLength(1);
      expect(popups[0]!.url()).toBe(fixture.origin + "/destination?stopped");
      for (const popup of popups) await popup.close();
    });
  }
}

for (const type of ["click", "submit"] as const) {
  for (const cancellation of [
    "none",
    "listener",
    "original",
    "returnValue",
    "passive",
    "pre-canceled",
  ] as const) {
    test(`${type} dispatch and the original guest event agree on ${cancellation} cancellation`, async ({
      page,
    }) => {
      const frame = await mount(page);
      const result = await frame.evaluate(
        (element: VFrameElement, { type, cancellation }) => {
          const child = element.contentWindow! as Window & typeof globalThis;
          const target = child.document.querySelector(
            type === "click" ? "#link" : "#form",
          )!;
          const event =
            type === "click"
              ? new child.MouseEvent(type, { bubbles: true, cancelable: true })
              : new child.SubmitEvent(type, { bubbles: true, cancelable: true });
          if (cancellation === "pre-canceled") event.preventDefault();
          const seen: boolean[] = [];
          target.addEventListener(
            type,
            (received) => {
              seen.push(received.defaultPrevented);
              if (cancellation === "listener" || cancellation === "passive")
                received.preventDefault();
              if (cancellation === "original") event.preventDefault();
              if (cancellation === "returnValue") event.returnValue = false;
              seen.push(received.defaultPrevented);
            },
            { once: true, passive: cancellation === "passive" },
          );
          return {
            returned: target.dispatchEvent(event),
            prevented: event.defaultPrevented,
            returnValue: event.returnValue,
            seen,
          };
        },
        { type, cancellation },
      );
      const canceled = cancellation !== "none" && cancellation !== "passive";
      expect(result).toEqual({
        returned: !canceled,
        prevented: canceled,
        returnValue: !canceled,
        seen: [cancellation === "pre-canceled", canceled],
      });
    });
  }
}

test("the non-cancelable activation guard is invisible to MutationObserver and retained href Attr nodes", async ({
  page,
}) => {
  const frame = await mount(page);
  const result = await frame.evaluate(async (element: VFrameElement) => {
    const child = element.contentWindow! as Window & typeof globalThis;
    const link = child.document.querySelector("#link") as HTMLAnchorElement;
    link.target = "_blank";
    const attribute = link.getAttributeNode("href");
    const attributeOrder = link.getAttributeNames();
    const records: string[] = [];
    const observer = new child.MutationObserver((mutations) =>
      records.push(...mutations.map((record) => record.attributeName!)),
    );
    observer.observe(link, { attributes: true });
    link.setAttribute("data-before", "before");
    element.addEventListener("v-frame-navigate", (event) => event.preventDefault());
    link.dispatchEvent(
      new child.MouseEvent("click", { bubbles: true, cancelable: false }),
    );
    link.setAttribute("data-after", "after");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const first = [...records];
    link.setAttribute("data-taken", "taken");
    link.dispatchEvent(
      new child.MouseEvent("click", { bubbles: false, cancelable: false }),
    );
    const taken = observer.takeRecords().map((record) => record.attributeName);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    return {
      first,
      taken,
      records,
      sameAttribute: attribute === link.getAttributeNode("href"),
      sameOrder:
        JSON.stringify(
          link.getAttributeNames().filter((name) => !name.startsWith("data-")),
        ) === JSON.stringify(attributeOrder),
      href: link.getAttribute("href"),
    };
  });
  expect(result).toEqual({
    first: ["data-before", "data-after"],
    taken: ["data-taken"],
    records: ["data-before", "data-after"],
    sameAttribute: true,
    sameOrder: true,
    href: "/destination",
  });
});

test("a generic click notification cannot activate a native host link", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const element = document.querySelector("#frame") as VFrameElement;
    const child = element.contentWindow! as Window & typeof globalThis;
    child.document
      .querySelector("#link")!
      .dispatchEvent(new child.Event("click", { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  expect(page.url()).toBe(fixture.origin + "/");
  expect(
    await page.evaluate(
      () => (document.querySelector("#frame") as VFrameElement).currentURL,
    ),
  ).toBe(fixture.origin + "/events");
  await page.evaluate(() =>
    (
      (
        document.querySelector("#frame") as VFrameElement
      ).contentWindow!.document.querySelector("#link") as HTMLElement
    ).click(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            document.querySelector("#frame") as VFrameElement
          )?.contentWindow?.document.querySelector("#destination")?.textContent,
      ),
    )
    .toBe("Destination");
  expect(
    await page.evaluate(
      () =>
        (document.querySelector("#frame") as VFrameElement).contentWindow!.history.length,
    ),
  ).toBe(2);
});
