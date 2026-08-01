import { expect, type Locator, type Page, test } from "@playwright/test";
import { bundleRoute, type HTTPFixture, startHTTPFixture } from "./support/http-fixture";
import { frameFailures, installBundle, mountFrame } from "./support/mount-frame";

/**
 * The three shapes every headless overlay library reduces to inside a v-frame: a plain
 * body portal (Radix and Kobalte tooltips), a native top-layer popover, and a portalled
 * modal that owns its own focus cycle. The guest positions each one from the rects the
 * facade reports, which is what a real library does with its positioning engine.
 */
const overlayLabDocument = `<!doctype html><html><head><style>
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      body { position: relative; margin: 0; background: #101010; color: #f5f5f5; font: 14px system-ui, sans-serif; }
      .overlay-lab { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px; }
      .lab-button { min-height: 28px; padding: 4px 10px; border: 0; border-radius: 6px; background: #303030; color: #f5f5f5; font: inherit; }
      .overlay-content { position: absolute; width: 140px; margin: 0; padding: 8px; border: 0; background: #242424; color: #f5f5f5; }
      .overlay-popover { position: fixed; inset: auto; }
      .overlay-popover input { width: 100%; font: inherit; }
      .dialog-overlay { position: absolute; display: grid; inset: 0; place-items: center; background: rgba(0, 0, 0, 0.55); }
      .dialog-content { display: grid; width: 180px; gap: 8px; padding: 12px; background: #1b1b1b; }
      .dialog-content input, .dialog-content button { font: inherit; }
    </style></head><body>
    <main class="overlay-lab">
      <button class="lab-button" type="button" data-testid="tooltip-trigger">Tooltip</button>
      <button class="lab-button" type="button" data-testid="popover-trigger">Popover</button>
      <button class="lab-button" type="button" data-testid="dialog-trigger">Modal</button>
    </main>
    <script>
      const tooltipTrigger = document.querySelector('[data-testid="tooltip-trigger"]');
      const popoverTrigger = document.querySelector('[data-testid="popover-trigger"]');
      const dialogTrigger = document.querySelector('[data-testid="dialog-trigger"]');

      function bodyRelativeOffset(trigger) {
        const triggerRect = trigger.getBoundingClientRect();
        const bodyRect = document.body.getBoundingClientRect();
        return {
          left: triggerRect.left - bodyRect.left,
          top: triggerRect.bottom - bodyRect.top + 8,
        };
      }

      // A plain body portal. It is a descendant of the virtual body, so the frame's own
      // overflow still clips it — the boundary a library has to opt out of deliberately.
      const tooltip = document.createElement('div');
      tooltip.className = 'overlay-content';
      tooltip.dataset.testid = 'tooltip-content';
      tooltip.textContent = 'Portal tooltip';
      tooltip.hidden = true;
      document.body.append(tooltip);

      tooltipTrigger.addEventListener('pointerenter', function showTooltip() {
        const offset = bodyRelativeOffset(tooltipTrigger);
        tooltip.style.left = offset.left + 'px';
        tooltip.style.top = offset.top + 'px';
        tooltip.hidden = false;
      });
      tooltipTrigger.addEventListener('pointerleave', function hideTooltip() {
        tooltip.hidden = true;
      });

      // A native popover, positioned in frame-local coordinates. The browser promotes it
      // to the top layer, where the CSS viewport is the host page's.
      const popover = document.createElement('div');
      popover.className = 'overlay-content overlay-popover';
      popover.dataset.testid = 'popover-content';
      popover.setAttribute('popover', 'auto');
      const popoverInput = document.createElement('input');
      popoverInput.dataset.testid = 'popover-input';
      popoverInput.value = 'Relay';
      popover.append(popoverInput);
      document.body.append(popover);

      popoverTrigger.addEventListener('click', function openPopover() {
        const triggerRect = popoverTrigger.getBoundingClientRect();
        popover.style.left = triggerRect.left + 'px';
        popover.style.top = triggerRect.bottom + 8 + 'px';
        popover.showPopover();
      });
      // Headless libraries read the overlay's next state off the toggle event; moving
      // focus from it is what keeps the trigger reachable after a light dismiss.
      popover.addEventListener('toggle', function trackPopoverState(event) {
        if (event.newState === 'open') popoverInput.focus();
        else popoverTrigger.focus();
      });

      const dialogOverlay = document.createElement('div');
      dialogOverlay.className = 'dialog-overlay';
      dialogOverlay.hidden = true;
      const dialogContent = document.createElement('div');
      dialogContent.className = 'dialog-content';
      dialogContent.dataset.testid = 'dialog-content';
      dialogContent.role = 'dialog';
      dialogContent.ariaModal = 'true';
      const dialogFirst = document.createElement('input');
      dialogFirst.dataset.testid = 'dialog-first';
      dialogFirst.value = 'Relay';
      const dialogClose = document.createElement('button');
      dialogClose.type = 'button';
      dialogClose.className = 'lab-button';
      dialogClose.dataset.testid = 'dialog-close';
      dialogClose.textContent = 'Close';
      dialogContent.append(dialogFirst, dialogClose);
      dialogOverlay.append(dialogContent);
      document.body.append(dialogOverlay);

      function cycleDialogFocus(event) {
        if (event.key === 'Escape') {
          closeDialog();
          return;
        }
        if (event.key !== 'Tab') return;
        // A portalled modal cycles focus itself: the guest tree lives inside the host's
        // shadow root, so sequential focus navigation would walk straight out of it.
        event.preventDefault();
        const focusable = [dialogFirst, dialogClose];
        const step = event.shiftKey ? -1 : 1;
        const index = focusable.indexOf(event.target);
        focusable[(index + step + focusable.length) % focusable.length].focus();
      }

      function openDialog() {
        dialogOverlay.hidden = false;
        dialogFirst.focus();
        // Delegated on the document, the way a dismiss layer registers itself.
        document.addEventListener('keydown', cycleDialogFocus, true);
      }

      function closeDialog() {
        document.removeEventListener('keydown', cycleDialogFocus, true);
        dialogOverlay.hidden = true;
        dialogTrigger.focus();
      }

      dialogTrigger.addEventListener('click', openDialog);
      dialogClose.addEventListener('click', closeDialog);
    </script>
  </body></html>`;

let fixture: HTTPFixture;

function startFixture(): Promise<HTTPFixture> {
  return startHTTPFixture({
    routes: {
      "/": '<!doctype html><div id="host"></div>',
      "/dist/index.js": bundleRoute,
      "/documents/overlay-lab.html": overlayLabDocument,
    },
  });
}

test.beforeAll(async () => {
  fixture = await startFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

test.beforeEach(async ({ page }) => {
  await installBundle(page, fixture.origin);
});

/** Every lab card is a deliberately clipped viewport, the way a host lays a widget out. */
async function mountOverlayFrame(page: Page, id: string, left: number): Promise<Locator> {
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/overlay-lab.html`,
    id,
  });
  await frame.evaluate((element, cardLeft) => {
    element.style.cssText = [
      "position: fixed",
      "top: 60px",
      `left: ${cardLeft}px`,
      "width: 320px",
      "height: 240px",
      "overflow: hidden",
    ].join(";");
  }, left);
  return frame;
}

test("the overlay surface mounts into the virtual body without errors", async ({
  page,
}) => {
  const frame = await mountOverlayFrame(page, "overlay-frame", 40);

  await expect(frame.locator('[data-testid="tooltip-trigger"]')).toBeVisible();
  await expect(frame.locator('[data-testid="popover-trigger"]')).toBeVisible();
  await expect(frame.locator('[data-testid="dialog-trigger"]')).toBeVisible();
  await expect(frame.locator("v-html > v-body")).toHaveCount(1);

  const bodyUsesVirtualElement = await frame.evaluate((element) => {
    const mounted = element as HTMLElement & { contentWindow: Window | null };
    return (
      mounted.contentWindow?.document.body === mounted.shadowRoot?.querySelector("v-body")
    );
  });
  expect(bodyUsesVirtualElement).toBe(true);
  expect(await frameFailures(frame)).toEqual([]);
});

test("a body portal opens and closes across the frame boundary", async ({ page }) => {
  const frame = await mountOverlayFrame(page, "overlay-frame", 40);
  const tooltip = frame.locator('[data-testid="tooltip-content"]');

  await frame.locator('[data-testid="tooltip-trigger"]').hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(tooltip).toBeHidden();
});

test("a body portal stays inside the frame's clipping boundary", async ({ page }) => {
  const frame = await mountOverlayFrame(page, "overlay-frame", 40);
  await frame.locator('[data-testid="tooltip-trigger"]').hover();
  await expect(frame.locator('[data-testid="tooltip-content"]')).toBeVisible();

  const containment = await frame.evaluate((element) => {
    // Guest nodes carry the child realm's prototypes, so the host realm cannot
    // `instanceof` them — only a presence check is meaningful here.
    const portal = element.shadowRoot?.querySelector('[data-testid="tooltip-content"]');
    if (portal === null || portal === undefined) {
      throw new Error("The tooltip portal is missing from the frame's shadow tree");
    }
    // The guest realm's prototypes report frame-local rects, so physical comparisons
    // have to go through the host realm's own implementation.
    const portalRect = Element.prototype.getBoundingClientRect.call(portal);
    const frameRect = element.getBoundingClientRect();
    return {
      parent: portal.parentElement?.localName,
      insideFrameBox:
        portalRect.left >= frameRect.left &&
        portalRect.right <= frameRect.right &&
        portalRect.top >= frameRect.top &&
        portalRect.bottom <= frameRect.bottom,
    };
  });

  expect(containment.parent).toBe("v-body");
  expect(containment.insideFrameBox).toBe(true);
});

test("a native popover closes with Escape and restores focus", async ({ page }) => {
  const frame = await mountOverlayFrame(page, "overlay-frame", 40);
  const trigger = frame.locator('[data-testid="popover-trigger"]');
  const popover = frame.locator('[data-testid="popover-content"]');

  await trigger.click();
  await expect(popover).toBeVisible();
  await expect(frame.locator('[data-testid="popover-input"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("a native popover lands beside its trigger in the top layer", async ({ page }) => {
  const frame = await mountOverlayFrame(page, "overlay-frame", 40);
  const trigger = frame.locator('[data-testid="popover-trigger"]');
  const popover = frame.locator('[data-testid="popover-content"]');

  await trigger.click();
  await expect(popover).toBeVisible();

  const triggerBounds = await trigger.boundingBox();
  const popoverBounds = await popover.boundingBox();
  if (triggerBounds === null || popoverBounds === null) {
    throw new Error("The overlay bounds are missing");
  }
  expect(popoverBounds.x).toBeCloseTo(triggerBounds.x, 0);
  expect(popoverBounds.y).toBeCloseTo(triggerBounds.y + triggerBounds.height + 8, 0);
});

test("a portalled modal cycles focus and restores its trigger", async ({ page }) => {
  const frame = await mountOverlayFrame(page, "overlay-frame", 40);
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

test("removing frames with open overlays leaves no orphaned surfaces", async ({
  page,
}) => {
  // One frame is torn down with a portalled surface open and the other with a
  // top-layer one, because the two leave by different routes.
  const portalFrame = await mountOverlayFrame(page, "overlay-frame-portal", 40);
  const topLayerFrame = await mountOverlayFrame(page, "overlay-frame-top-layer", 400);

  await portalFrame.locator('[data-testid="dialog-trigger"]').click();
  await expect(portalFrame.locator('[data-testid="dialog-content"]')).toBeVisible();
  await topLayerFrame.locator('[data-testid="popover-trigger"]').click();
  await expect(topLayerFrame.locator('[data-testid="popover-content"]')).toBeVisible();

  for (const frame of [portalFrame, topLayerFrame]) {
    await frame.evaluate((element) => element.remove());
    await expect(frame).toHaveCount(0);
  }

  await expect(page.locator('[data-testid="dialog-content"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="popover-content"]')).toHaveCount(0);
});
