import { expect, test, type Locator, type Page } from "@playwright/test";
import { bundleRoute, startHTTPFixture, type HTTPFixture } from "./support/http-fixture";
import { bundleKobalteLab } from "./support/kobalte-bundle";
import { installBundle, mountFrame } from "./support/mount-frame";
import type { VFrameElement } from "../src/index";

const documentFor = (search: string) => {
  const parameters = new URLSearchParams(search);
  const placement = parameters.get("placement") ?? "bottom-start";
  return `<!doctype html><html lang="en"><head><title>Positioning lab</title><style>
    * { box-sizing: border-box; }
    body { position: relative; margin: 0; height: 720px; color: #111; background: white; font: 16px system-ui; }
    .lab-button { position: absolute; left: 200px; top: 140px; width: 80px; height: 32px; font: inherit; }
    .overlay-content { width: 160px; height: 64px; padding: 8px; background: #fff; color: #111; border: 1px solid #111; }
  </style></head><body><main id="kobalte-root" data-placement="${placement}" data-collisions="${parameters.has("collisions")}" data-interactive="${parameters.has("interactive")}" data-modal="${parameters.has("modal")}"></main>
  <script type="module" src="/kobalte.js"></script></body></html>`;
};

let fixture: HTTPFixture;
test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": '<!doctype html><html lang="en"><head><title>Host</title></head><body style="margin:0;min-height:1800px"><main><div id="host"></div><button id="outside">Outside</button></main></body></html>',
      "/dist/index.js": bundleRoute,
      "/kobalte.js": { type: "text/javascript", body: await bundleKobalteLab() },
      "/lab": (request) => ({
        body: documentFor(new URL(request.url!, "http://fixture").search),
      }),
    },
  });
});
test.afterAll(async () => fixture.close());
test.beforeEach(async ({ page }) => installBundle(page, fixture.origin));

async function mount(page: Page, search = ""): Promise<Locator> {
  const frame = await mountFrame(page, {
    id: "positioned",
    src: `${fixture.origin}/lab${search}`,
  });
  await frame.evaluate((element) => {
    element.style.cssText =
      "position:absolute;left:120px;top:80px;width:512px;height:360px;overflow:hidden";
  });
  return frame;
}

async function expectPlacement(frame: Locator, placement: string): Promise<void> {
  const [side, alignment] = placement.split("-");
  await expect
    .poll(async () => {
      const trigger = await frame.getByTestId("kobalte-trigger").boundingBox();
      const content = await frame.getByTestId("kobalte-content").boundingBox();
      if (!trigger || !content) return Number.POSITIVE_INFINITY;
      const vertical = side === "top" || side === "bottom";
      const crossStart = vertical ? trigger.x : trigger.y;
      const crossSize = vertical ? trigger.width : trigger.height;
      const contentSize = vertical ? content.width : content.height;
      const cross =
        crossStart +
        (alignment === "start"
          ? 0
          : alignment === "end"
            ? crossSize - contentSize
            : (crossSize - contentSize) / 2);
      const main =
        side === "top"
          ? trigger.y - content.height - 8
          : side === "bottom"
            ? trigger.y + trigger.height + 8
            : side === "left"
              ? trigger.x - content.width - 8
              : trigger.x + trigger.width + 8;
      return Math.max(
        Math.abs((vertical ? content.x : content.y) - cross),
        Math.abs((vertical ? content.y : content.x) - main),
      );
    })
    .toBeLessThan(1);
}

for (const side of ["top", "bottom", "left", "right"]) {
  for (const alignment of ["", "-start", "-end"]) {
    const placement = side + alignment;
    test(`Floating UI places ${placement} in physical screen coordinates`, async ({
      page,
    }) => {
      const frame = await mount(page, `?placement=${placement}`);
      await frame.getByTestId("kobalte-trigger").click();
      await expect(frame.getByRole("dialog", { name: "Kobalte popover" })).toBeVisible();
      await expectPlacement(frame, placement);
    });
  }
}

for (const [placement, position, flipped] of [
  ["bottom-start", { left: 200, top: 670 }, "top-start"],
  ["top-start", { left: 200, top: 8 }, "bottom-start"],
  ["right-start", { left: 1180, top: 140 }, "left-start"],
  ["left-start", { left: 8, top: 140 }, "right-start"],
] as const) {
  test(`collision detection flips ${placement} at the page viewport edge`, async ({
    page,
  }) => {
    const frame = await mount(page, `?placement=${placement}&collisions`);
    await frame.evaluate((element) => {
      element.style.cssText =
        "position:absolute;inset:0;width:100vw;height:100vh;overflow:hidden";
    });
    await frame.getByTestId("kobalte-trigger").evaluate((element, point) => {
      (element as HTMLElement).style.left = `${point.left}px`;
      (element as HTMLElement).style.top = `${point.top}px`;
    }, position);
    await frame.getByTestId("kobalte-trigger").click();
    await expectPlacement(frame, flipped);
  });
}

test("collision sliding keeps the surface inside the right page edge", async ({
  page,
}) => {
  const frame = await mount(page, "?collisions");
  await frame.evaluate((element) => {
    element.style.cssText =
      "position:absolute;inset:0;width:100vw;height:100vh;overflow:hidden";
  });
  await frame.getByTestId("kobalte-trigger").evaluate((element) => {
    (element as HTMLElement).style.left = "1180px";
  });
  await frame.getByTestId("kobalte-trigger").click();
  await expect
    .poll(async () => {
      const host = await frame.boundingBox();
      const content = await frame.getByTestId("kobalte-content").boundingBox();
      return host && content
        ? content.x + content.width - (host.x + host.width)
        : Infinity;
    })
    .toBeLessThanOrEqual(-1);
});

test("positioning updates after guest scrolling", async ({ page }) => {
  const frame = await mount(page);
  await frame.evaluate((element) => {
    element.style.overflow = "auto";
  });
  await frame.getByTestId("kobalte-trigger").click();
  await expectPlacement(frame, "bottom-start");
  await frame.evaluate((element) => {
    (element as VFrameElement).contentWindow!.scrollTo(0, 80);
  });
  await expect.poll(() => frame.evaluate((element) => element.scrollTop)).toBe(80);
  await expectPlacement(frame, "bottom-start");
});

test("positioning stays aligned after host scrolling and resizing", async ({ page }) => {
  const frame = await mount(page);
  await frame.evaluate((element) => {
    element.style.top = "420px";
  });
  await frame.getByTestId("kobalte-trigger").click();
  await page.evaluate(() => scrollTo(0, 300));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(300);
  await expectPlacement(frame, "bottom-start");
  await page.setViewportSize({ width: 1000, height: 680 });
  await expectPlacement(frame, "bottom-start");
});

test("positioning accounts for frame borders and CSS scaling", async ({ page }) => {
  const frame = await mount(page);
  await frame.evaluate((element) => {
    element.style.border = "6px solid black";
    element.style.transformOrigin = "top left";
    element.style.transform = "scale(1.25)";
  });
  await frame.getByTestId("kobalte-trigger").click();
  await expect
    .poll(async () => {
      const trigger = await frame.getByTestId("kobalte-trigger").boundingBox();
      const content = await frame.getByTestId("kobalte-content").boundingBox();
      return trigger && content
        ? Math.max(
            Math.abs(content.x - trigger.x),
            Math.abs(content.y - trigger.y - trigger.height - 10),
          )
        : Infinity;
    })
    .toBeLessThan(1);
});

test("Kobalte keyboard opening, focus, Escape and close-button restoration work", async ({
  page,
}) => {
  const frame = await mount(page, "?interactive");
  const trigger = frame.getByRole("button", { name: "Popover", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(frame.getByRole("textbox", { name: "Delivery name" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Space");
  await frame.getByRole("button", { name: "Close popover" }).click();
  await expect(trigger).toBeFocused();
});

test("Kobalte outside-pointer dismissal can cross into the host", async ({ page }) => {
  const frame = await mount(page, "?interactive");
  await frame.getByTestId("kobalte-trigger").click();
  await page.getByRole("button", { name: "Outside", exact: true }).click();
  await expect(frame.getByRole("dialog", { name: "Kobalte popover" })).toBeHidden();
});

test("Kobalte's modal focus scope traps both Tab directions", async ({ page }) => {
  const frame = await mount(page, "?interactive&modal");
  await frame.getByTestId("kobalte-trigger").click();
  const input = frame.getByRole("textbox", { name: "Delivery name" });
  const close = frame.getByRole("button", { name: "Close popover" });
  await expect(input).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
});
