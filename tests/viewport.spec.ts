import { expect, test } from "@playwright/test";
import {
  type ContractFixtureServers,
  startContractFixtureServers,
} from "./support/fixture-server";
import { childValue, mountContractFrame } from "./support/guest-frames";
import { installBundle } from "./support/mount-frame";
import { elapse } from "./support/settle";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

test("uses the page viewport and frame scroll state then stops child timers when disposed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "viewport",
    `${fixture.origin}/documents/viewport.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  await frame.evaluate((element) => {
    element.setAttribute("style", "width: 320px; height: 120px;");
    element.scrollTop = 40;
  });
  const resizeEventsBeforePageResize = await childValue(
    frame,
    (window) =>
      (window as Window & typeof globalThis & { __viewportEvents: { resize: number } })
        .__viewportEvents.resize,
  );
  await page.setViewportSize({ width: 760, height: 520 });
  await expect
    .poll(() =>
      childValue(
        frame,
        (window) =>
          (
            window as Window &
              typeof globalThis & { __viewportEvents: { resize: number } }
          ).__viewportEvents.resize,
      ),
    )
    .toBeGreaterThan(resizeEventsBeforePageResize);
  await expect
    .poll(() =>
      childValue(
        frame,
        (window) =>
          (
            window as Window &
              typeof globalThis & { __viewportEvents: { scroll: number } }
          ).__viewportEvents.scroll,
      ),
    )
    .toBeGreaterThan(0);
  expect(await childValue(frame, (window) => window.scrollY)).toBe(40);
  const childViewport = await childValue(frame, (window) => ({
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    outerHeight: window.outerHeight,
    outerWidth: window.outerWidth,
    visualHeight: window.visualViewport?.height ?? null,
    visualWidth: window.visualViewport?.width ?? null,
    widthMediaMatches: window.matchMedia(`(width: ${window.innerWidth}px)`).matches,
  }));
  const pageViewport = await page.evaluate(() => ({
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    outerHeight: window.outerHeight,
    outerWidth: window.outerWidth,
    visualHeight: window.visualViewport?.height ?? null,
    visualWidth: window.visualViewport?.width ?? null,
    widthMediaMatches: window.matchMedia(`(width: ${window.innerWidth}px)`).matches,
  }));
  expect(childViewport).toEqual(pageViewport);
  expect(childViewport.innerWidth).not.toBe(320);
  await expect
    .poll(() =>
      childValue(
        frame,
        (window) =>
          (window as Window & typeof globalThis & { __viewportEvents: { ticks: number } })
            .__viewportEvents.ticks,
      ),
    )
    .toBeGreaterThan(2);

  type ViewportEvents = { scroll: number; ticks: number };
  type ViewportProbe = {
    frame: HTMLElement & { contentWindow: unknown };
    events: ViewportEvents;
    stoppedAt: number;
    scrollAtRemoval: number;
  };
  await page.evaluate(() => {
    const frame = document.querySelector("#viewport") as HTMLElement & {
      contentWindow: (Window & { __viewportEvents: ViewportEvents }) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("Viewport fixture did not expose a child window");
    }
    const events = child.__viewportEvents;
    frame.remove();
    (window as Window & { viewportProbe?: ViewportProbe }).viewportProbe = {
      frame,
      events,
      stoppedAt: events.ticks,
      scrollAtRemoval: events.scroll,
    };
    frame.dispatchEvent(new Event("scroll"));
  });
  // The guest's 10ms interval must stay silent, which only elapsed time can show.
  await elapse(page, 50);
  const teardown = await page.evaluate(() => {
    const probe = (window as unknown as { viewportProbe: ViewportProbe }).viewportProbe;
    return {
      stoppedAt: probe.stoppedAt,
      afterWait: probe.events.ticks,
      scrollAtRemoval: probe.scrollAtRemoval,
      scrollAfterHostEvent: probe.events.scroll,
      hasContentWindow: probe.frame.contentWindow !== null,
    };
  });

  expect(teardown).toEqual({
    stoppedAt: teardown.stoppedAt,
    afterWait: teardown.stoppedAt,
    scrollAtRemoval: teardown.scrollAtRemoval,
    scrollAfterHostEvent: teardown.scrollAtRemoval,
    hasContentWindow: false,
  });
});

test("uses the virtual document element as the scrolling element", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "viewport-scroll",
    `${fixture.origin}/documents/viewport.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  await frame.evaluate((element) => element.setAttribute("style", "height: 100px;"));
  const scrollingElement = await childValue(frame, (window) => ({
    isDocumentElement:
      window.document.scrollingElement === window.document.documentElement,
    isBody: window.document.scrollingElement === window.document.body,
    tagName: window.document.scrollingElement?.tagName,
  }));
  expect(scrollingElement).toEqual({
    isDocumentElement: true,
    isBody: false,
    tagName: "V-HTML",
  });

  await childValue(frame, (window) => window.scrollTo({ top: 30, left: 0 }));
  await expect.poll(() => frame.evaluate((element) => element.scrollTop)).toBe(30);
  await childValue(frame, (window) => window.scrollBy({ top: 20, left: 0 }));
  await expect.poll(() => frame.evaluate((element) => element.scrollTop)).toBe(50);
});
