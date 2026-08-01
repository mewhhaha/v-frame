import { expect, test, type Locator, type Page } from "@playwright/test";

const frameworks = ["react", "angular", "solid", "qwik"] as const;
type Framework = (typeof frameworks)[number];

function frameworkFrame(page: Page, framework: Framework): Locator {
  return page.locator(`v-frame[data-testid="${framework}-frame"]`);
}

function tooltipFor(frame: Locator, framework: Framework): Locator {
  return framework === "angular"
    ? frame.locator(".overlay-tooltip")
    : frame.locator('[data-testid="tooltip-content"]');
}

async function expectReady(frame: Locator): Promise<void> {
  await expect
    .poll(() =>
      frame.evaluate((element) => {
        return (element as HTMLElement & { status: string }).status;
      }),
    )
    .toBe("ready");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const errors: Array<{ message: string; phase?: string; url?: string }> = [];
    Object.defineProperty(window, "__vFrameErrors", {
      configurable: true,
      value: errors,
    });
    document.addEventListener("v-frame-error", (event) => {
      const detail = (
        event as CustomEvent<{
          error?: { message?: string };
          phase?: string;
          url?: string;
        }>
      ).detail;
      errors.push({
        message: detail?.error?.message ?? String(detail?.error),
        phase: detail?.phase,
        url: detail?.url,
      });
    });
  });
  await page.goto("/overlay-lab.html");
  for (const framework of frameworks) {
    await expectReady(frameworkFrame(page, framework));
  }
});

test("framework surfaces load without runtime errors", async ({ page }) => {
  const errors = await page.evaluate(() => {
    return (window as Window & { __vFrameErrors?: unknown[] }).__vFrameErrors ?? [];
  });
  expect(errors).toEqual([]);
});

for (const framework of frameworks) {
  test(`${framework} mounts into its virtual body`, async ({ page }) => {
    const frame = frameworkFrame(page, framework);
    await expect(frame.locator('[data-testid="tooltip-trigger"]')).toBeVisible();
    await expect(frame.locator('[data-testid="popover-trigger"]')).toBeVisible();
    await expect(frame.locator('[data-testid="dialog-trigger"]')).toBeVisible();
    await expect(frame.locator("v-html > v-body")).toHaveCount(1);
    const bodyUsesVirtualElement = await frame.evaluate((element) => {
      const mountedFrame = element as HTMLElement & { contentWindow: Window | null };
      return (
        mountedFrame.contentWindow?.document.body ===
        mountedFrame.shadowRoot?.querySelector("v-body")
      );
    });
    expect(bodyUsesVirtualElement).toBe(true);
  });

  test(`${framework} tooltip opens and closes across the frame boundary`, async ({
    page,
  }) => {
    const frame = frameworkFrame(page, framework);
    const tooltip = tooltipFor(frame, framework);

    await frame.locator('[data-testid="tooltip-trigger"]').hover();
    await expect(tooltip).toBeVisible();
    await page.mouse.move(1, 1);
    await expect(tooltip).toBeHidden();
  });

  test(`${framework} popover closes with Escape and restores focus`, async ({ page }) => {
    const frame = frameworkFrame(page, framework);
    const trigger = frame.locator('[data-testid="popover-trigger"]');
    const popover = frame.locator('[data-testid="popover-content"]');

    await trigger.click();
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test(`${framework} modal traps focus and restores its trigger`, async ({ page }) => {
    const frame = frameworkFrame(page, framework);
    const trigger = frame.locator('[data-testid="dialog-trigger"]');
    const dialog = frame.locator('[data-testid="dialog-content"]');
    const firstControl = frame.locator('[data-testid="dialog-first"]');
    const closeButton = frame.locator('[data-testid="dialog-close"]');

    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(firstControl).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(closeButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(firstControl).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test(`${framework} popover is positioned beside its trigger`, async ({ page }) => {
    const frame = frameworkFrame(page, framework);
    const trigger = frame.locator('[data-testid="popover-trigger"]');
    const popover = frame.locator('[data-testid="popover-content"]');
    await trigger.click();
    await expect(popover).toBeVisible();

    const triggerBounds = await trigger.boundingBox();
    const popoverBounds = await popover.boundingBox();
    if (!triggerBounds || !popoverBounds) {
      throw new Error(`${framework} overlay bounds are missing`);
    }
    const triggerCenterX = triggerBounds.x + triggerBounds.width / 2;
    const popoverCenterX = popoverBounds.x + popoverBounds.width / 2;
    expect(Math.abs(popoverCenterX - triggerCenterX)).toBeLessThan(180);
    expect(Math.abs(popoverBounds.y - triggerBounds.y)).toBeLessThan(180);
  });
}

test("removing frames with active overlays leaves no orphaned surfaces", async ({
  page,
}) => {
  for (const framework of frameworks) {
    const frame = frameworkFrame(page, framework);
    await frame.locator('[data-testid="dialog-trigger"]').click();
    await expect(frame.locator('[data-testid="dialog-content"]')).toBeVisible();
    await frame.evaluate((element) => element.remove());
    await expect(frame).toHaveCount(0);
  }

  await expect(page.locator('[data-testid="dialog-content"]:visible')).toHaveCount(0);
});
