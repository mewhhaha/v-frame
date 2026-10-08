import type { Locator, Page } from "@playwright/test";
import { mountFrame } from "./mount-frame";

/** Mounts a v-frame without waiting for it to settle, so a test can watch it load. */
export function mountContractFrame(
  page: Page,
  id: string,
  source: string,
  credentials?: "omit" | "same-origin" | "include",
): Promise<Locator> {
  return mountFrame(page, {
    src: source,
    id,
    settle: "none",
    ...(credentials === undefined ? {} : { credentials }),
  });
}

/** Evaluates `expression` against the guest's window and returns its result. */
export function childValue<T>(
  frame: Locator,
  expression: (window: Window & typeof globalThis) => T,
) {
  return frame.evaluate((element, source) => {
    const evaluate = new Function("window", `return (${source})(window)`);
    return evaluate(
      (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
        .contentWindow,
    );
  }, expression.toString()) as Promise<T>;
}
