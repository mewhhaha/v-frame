import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * Axe scans the host and guest together. Guest-facing rectangles are local, so
 * supplying them to that host-side scan invents overlaps with host controls.
 * Temporarily give the scanner browser-native screen rectangles; restore every
 * descriptor even when the audit fails. No accessibility rules are disabled.
 */
export async function auditAccessibility(page: Page) {
  await page.evaluate(() => {
    const restore: Array<() => void> = [];
    const visit = (root: Document | ShadowRoot) => {
      for (const element of root.querySelectorAll("*")) {
        if (root instanceof ShadowRoot) {
          for (const name of ["getBoundingClientRect", "getClientRects"] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(element, name);
            Object.defineProperty(element, name, {
              configurable: true,
              value: Element.prototype[name],
            });
            restore.push(() => {
              if (descriptor) Object.defineProperty(element, name, descriptor);
              else delete (element as unknown as Record<string, unknown>)[name];
            });
          }
        }
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    (
      window as Window & typeof globalThis & { restoreAuditGeometry(): void }
    ).restoreAuditGeometry = () => {
      for (const restoreDescriptor of restore) restoreDescriptor();
    };
  });
  try {
    return await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
  } finally {
    await page.evaluate(() => {
      const host = window as Window &
        typeof globalThis & { restoreAuditGeometry?: () => void };
      host.restoreAuditGeometry?.();
      delete host.restoreAuditGeometry;
    });
  }
}
