import { expect, type Locator, type Page } from "@playwright/test";
import type { VFrameElement } from "../../src/index.js";

/** The `v-frame-error` detail, minus the non-serializable error itself. */
export interface FrameFailure {
  phase: string;
  url: string;
  fatal: boolean;
}

/** The real element plus the failure log `mountFrame` stashes on it. */
interface FrameElement extends VFrameElement {
  failures: FrameFailure[];
}

export interface MountOptions {
  src: string;
  id?: string;
  nonce?: string;
  credentials?: "omit" | "same-origin" | "include";
  /**
   * "ready" polls the element's status, "load" awaits the `v-frame-load` event inside the
   * page, and "none" returns as soon as the element is connected.
   */
  settle?: "ready" | "load" | "none";
}

/** Loads the host page and defines the element from the bundle the fixture serves. */
export async function installBundle(page: Page, origin: string): Promise<void> {
  await page.goto(origin);
  await page.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
  }, `${origin}/dist/index.js`);
}

/**
 * Creates a `v-frame` inside the host page's `#host` container. Failures reported before
 * the frame settles are stashed on the element so `frameFailures` can read them back —
 * they are only observable if the listener is attached before `src` is assigned.
 */
export async function mountFrame(page: Page, options: MountOptions): Promise<Locator> {
  const settle = options.settle ?? "ready";
  await page.evaluate(
    async (mount) => {
      const frame = document.createElement("v-frame") as FrameElement;
      frame.failures = [];
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (event as CustomEvent<FrameFailure>).detail;
        frame.failures.push({
          phase: detail.phase,
          url: detail.url,
          fatal: detail.fatal,
        });
      });
      const loaded = new Promise<void>((resolveLoaded) => {
        frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
      });
      if (mount.id !== undefined) frame.id = mount.id;
      if (mount.nonce !== undefined) frame.nonce = mount.nonce;
      if (mount.credentials !== undefined) {
        frame.setAttribute("credentials", mount.credentials);
      }
      frame.src = mount.src;
      document.querySelector("#host")?.append(frame);
      if (mount.settle === "load") await loaded;
    },
    { ...options, settle },
  );

  const frame = page.locator(
    options.id === undefined ? "v-frame" : `v-frame#${options.id}`,
  );
  if (settle === "ready") {
    await expect
      .poll(() => frame.evaluate((element: FrameElement) => element.status))
      .toBe("ready");
  }
  return frame;
}

/** Reads back the failures `mountFrame` recorded on a frame. */
export function frameFailures(frame: Locator): Promise<FrameFailure[]> {
  return frame.evaluate((element: FrameElement) => element.failures);
}
