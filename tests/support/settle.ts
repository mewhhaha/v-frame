import type { Page } from "@playwright/test";

// These helpers run on the Playwright side, so none of them is in scope inside a
// `page.evaluate` body. A wait that has to sit between two steps that share locals
// there is written inline instead, and waiting one task in the realm under test is
// `await new Promise((resolve) => child.setTimeout(resolve, 0))`. That is one line a
// reader can follow in place. Sharing it would take a global every spec had to install
// into the page first, or a function handle passed through every evaluate, which costs
// more lines than the copies it replaces.

/**
 * Resolves after the page has run a task queued now and painted two frames. Work
 * the code under test queued earlier (timers at 0, message and microtask chains,
 * layout-bound callbacks) has run by then, so "nothing happened" checks can follow.
 */
export function flushTasks(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        };
        channel.port2.postMessage(null);
      }),
  );
}

/**
 * Issues one request from the page and then flushes tasks. The response arrives after
 * anything the server already sent for earlier requests, so it orders a "no further
 * request or response was handled" assertion. The request is visible to the fixture,
 * so callers should expect `url`'s path in the recorded requests.
 */
export async function settleAfterRoundTrip(page: Page, url: string): Promise<void> {
  await page.evaluate(async (target) => {
    await fetch(target, { cache: "no-store", mode: "no-cors" });
  }, url);
  await flushTasks(page);
}

/**
 * Waits wall-clock time. Only for proving that a timer-driven callback never fires,
 * where no event exists that is ordered after the thing that must not happen. Keep
 * `milliseconds` just above the timer under test.
 */
export function elapse(page: Page, milliseconds: number): Promise<void> {
  return page.evaluate(
    (delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)),
    milliseconds,
  );
}
