import { expect, test, type Locator, type Page } from "@playwright/test";

const widgetEntryPaths = new Set([
  "/widgets/qwik/inventory",
  "/widgets/react-router/activity",
]);

function reactFrame(page: Page): Locator {
  return page.locator('v-frame[data-frame-id="react-router"]');
}

function topLevelQwikFrame(page: Page): Locator {
  return page.locator('v-frame[data-frame-id="qwik"]');
}

function nestedQwikFrame(page: Page): Locator {
  return reactFrame(page).locator("v-frame.nested-workspace-widget").last();
}

function accountFrame(page: Page): Locator {
  return page.locator('v-frame[data-frame-id="account"]');
}

async function expectReady(frame: Locator): Promise<void> {
  await expect.poll(() => frame.evaluate((element) => {
    const frameElement = element as HTMLElement & { status: string };
    const routingFrame = frameElement.hasAttribute("data-frame-id");
    return frameElement.status === "ready"
      && (!routingFrame || frameElement.hasAttribute("data-routing-ready"));
  })).toBe(true);
}

async function expectLoadedWithoutRouting(frame: Locator): Promise<void> {
  await expect.poll(() => frame.evaluate((element) => {
    return (element as HTMLElement & { status: string }).status;
  })).toBe("ready");
}

async function openWikipediaPreview(page: Page): Promise<void> {
  const popover = reactFrame(page).locator(".preview-popover");
  await expect(popover).toHaveCount(1);
  await reactFrame(page).getByRole("button", { name: "blue–green deployment" }).hover();
  await expect(popover).toBeVisible();
  await expect(
    nestedQwikFrame(page).getByRole("heading", { name: "Blue–green deployment" }),
  ).toBeVisible();
}

async function routeParameter(page: Page, frameId: string): Promise<string | null> {
  return page.evaluate((id) => new URL(location.href).searchParams.get(id), frameId);
}

async function expectHostRoutes(
  page: Page,
  reactRoute: "/activity" | "/brief" | "/plugins" | "/research",
  qwikRoute: "/inventory" | "/catalog",
): Promise<void> {
  await expect(page.locator("#host-route")).toHaveText(
    `react-router ${reactRoute}; qwik ${qwikRoute}`,
  );
}

test("delivers the transcript, composer, account, and preview without entry document requests", async ({ page }) => {
  const entryRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (widgetEntryPaths.has(pathname)) entryRequests.push(pathname);
  });

  await page.goto("/");
  await expectReady(reactFrame(page));
  await expectReady(topLevelQwikFrame(page));
  await expectReady(nestedQwikFrame(page));

  await expect(reactFrame(page).getByRole("heading", { name: "Migration conversation" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("textbox", { name: "Message Relay" })).toBeVisible();
  await expect(nestedQwikFrame(page)).toBeHidden();
  await expect(accountFrame(page).getByRole("button", { name: /Avery Morgan/ })).toBeVisible();
  await openWikipediaPreview(page);
  await expectHostRoutes(page, "/activity", "/inventory");
  expect(entryRequests).toEqual([]);
});

test("reveals frontend ownership without technical sidebar copy", async ({ page }) => {
  await page.goto("/");
  await expectReady(reactFrame(page));
  await expectReady(topLevelQwikFrame(page));
  await expect(page.getByText("Server composed")).toHaveCount(0);
  await expect(page.getByText(/Service bindings/)).toHaveCount(0);

  const toggle = page.locator("#composition-toggle");
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-composition-visible", "");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#react-surface")).toHaveAttribute(
    "data-composition-label",
    "React transcript frontend",
  );
  await expect(page.locator("#qwik-surface")).toHaveAttribute(
    "data-composition-label",
    "Qwik composer frontend",
  );

  await openWikipediaPreview(page);
  const nestedSurface = reactFrame(page).locator(".nested-widget-surface");
  await expect(nestedSurface).toHaveAttribute(
    "data-composition-label",
    "Qwik Wikipedia preview frontend",
  );
  await expect(nestedSurface.evaluate((surface) =>
    getComputedStyle(surface, "::before").borderTopColor
  )).resolves.toBe("rgb(167, 139, 250)");

  await toggle.click();
  await expect(page.locator("html")).not.toHaveAttribute("data-composition-visible", "");
});

test("shows the Wikipedia preview only while its term is hovered or focused", async ({ page }) => {
  await page.goto("/");
  await expectReady(nestedQwikFrame(page));

  const trigger = reactFrame(page).getByRole("button", { name: "blue–green deployment" });
  const popover = reactFrame(page).locator(".preview-popover");
  await expect(popover).toBeHidden();
  await trigger.hover();
  await expect(popover).toBeVisible();
  await expect(popover.evaluate((element) => element.matches(":popover-open"))).resolves.toBe(true);
  await page.mouse.move(1, 1);
  await expect(popover).toBeHidden();
  await trigger.focus();
  await expect(popover).toBeVisible();
  await trigger.press("Escape");
  await expect(popover).toBeHidden();
});

test("promotes the Wikipedia preview beyond the React frame clipping boundary", async ({ page }) => {
  await page.goto("/");
  await expectReady(nestedQwikFrame(page));
  await openWikipediaPreview(page);

  const frame = reactFrame(page);
  const popover = frame.locator(".preview-popover");
  const frameBounds = await frame.boundingBox();
  if (frameBounds === null) throw new Error("The React frame has no rendered bounds");
  await popover.evaluate((element, top) => {
    (element as HTMLElement).style.setProperty("--preview-top", `${top}px`);
  }, Math.max(4, frameBounds.y - 64));

  const popoverBounds = await popover.boundingBox();
  if (popoverBounds === null) throw new Error("The Wikipedia preview has no rendered bounds");
  expect(popoverBounds.y).toBeLessThan(frameBounds.y);
  const hitFrameId = await page.evaluate(({ x, y }) => {
    return document.elementFromPoint(x, y)?.getAttribute("data-frame-id") ?? null;
  }, { x: popoverBounds.x + 20, y: frameBounds.y - 20 });
  expect(hitFrameId).toBe("react-router");
});

test("navigates threads, plugins, and usage as host-owned SPA sections", async ({ page }) => {
  await page.goto("/");
  await expectReady(reactFrame(page));
  await expectReady(topLevelQwikFrame(page));
  await page.evaluate(() => document.documentElement.setAttribute("data-spa-document", "mounted"));

  const documentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentRequests.push(request.url());
  });

  await page.locator(".host-sidebar").getByRole("link", { name: "Customer research" }).click();
  await expect(page).toHaveURL("/research");
  await expect(reactFrame(page).getByRole("heading", { name: "Customer research conversation" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("textbox", { name: "Message Relay" })).toBeVisible();
  await expectHostRoutes(page, "/research", "/inventory");

  await page.locator(".host-sidebar").getByRole("link", { name: "Plugins" }).click();
  await expect(page).toHaveURL("/plugins");
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(topLevelQwikFrame(page)).toBeHidden();
  await expect(page.locator("#react-surface")).toHaveAttribute("data-composition-label", "React plugins frontend");

  await page.locator(".host-sidebar").getByRole("link", { name: "Usage" }).click();
  await expect(page).toHaveURL("/usage");
  await expect(reactFrame(page)).toBeHidden();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-spa-document", "mounted");
  expect(documentRequests).toEqual([]);

  await page.goBack();
  await expect(page).toHaveURL("/plugins");
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  expect(documentRequests).toEqual([]);
});

test("reveals plugin and usage surfaces only after their routes commit", async ({ page }) => {
  await page.goto("/");
  await expectReady(reactFrame(page));
  await expectReady(topLevelQwikFrame(page));

  await page.locator(".host-sidebar").getByRole("link", { name: "Plugins" }).click();
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await page.evaluate(() => {
    const reveals: string[] = [];
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const surface = mutation.target;
        if (!(surface instanceof HTMLElement) || surface.hidden) continue;
        const frame = surface.querySelector("v-frame");
        const root = frame?.shadowRoot;
        const route = root?.querySelector("#plugins-title") !== null
          ? "plugins"
          : root?.querySelector("#usage-title") !== null
            ? "usage"
            : root?.querySelector("textarea") !== null
              ? "composer"
              : "transcript";
        reveals.push(`${surface.id}:${route}`);
      }
    });
    observer.observe(document.querySelector("#host-workspace") ?? document.body, {
      attributes: true,
      attributeFilter: ["hidden"],
      subtree: true,
    });
    Object.assign(window, { routeRevealObserver: observer, routeRevealRecords: reveals });
  });

  await page.locator(".host-sidebar").getByRole("link", { name: "Usage" }).click();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await page.locator(".host-sidebar").getByRole("link", { name: "Plugins" }).click();
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();

  const reveals = await page.evaluate(() => {
    const trackedWindow = window as typeof window & {
      routeRevealObserver: MutationObserver;
      routeRevealRecords: string[];
    };
    trackedWindow.routeRevealObserver.disconnect();
    return trackedWindow.routeRevealRecords;
  });
  expect(reveals).toEqual(["qwik-surface:usage", "react-surface:plugins"]);
});

test("keeps the nested Wikipedia route local to the transcript", async ({ page }) => {
  await page.goto("/");
  await expectReady(nestedQwikFrame(page));
  await openWikipediaPreview(page);
  await expect(topLevelQwikFrame(page).getByRole("textbox", { name: "Message Relay" })).toBeVisible();
  await expect.poll(() => routeParameter(page, "qwik")).toBeNull();
});

test("honors valid initial routes and falls back from invalid routes", async ({ page }) => {
  await page.goto("/?react-router=%2Fplugins&qwik=%2Fcatalog&unrelated=preserved#status");
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expectHostRoutes(page, "/plugins", "/catalog");
  await expect(page).toHaveURL(/unrelated=preserved#status$/);

  await page.goto("/?react-router=%2Fmissing&qwik=%2Fmissing");
  await expect(reactFrame(page).getByRole("heading", { name: "Migration conversation" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("textbox", { name: "Message Relay" })).toBeVisible();
});

test("ignores malformed routing messages and accepts a valid route", async ({ page }) => {
  await page.goto("/");
  await expectReady(reactFrame(page));

  await page.evaluate(async () => {
    const sessionId = sessionStorage.getItem("v-frame:routing-session");
    if (sessionId === null) throw new Error("Routing session was not initialized");
    const channel = new BroadcastChannel(`v-frame:routing:v1:${sessionId}`);
    const validMessage = {
      protocol: "v-frame-routing",
      version: 1,
      sessionId,
      messageId: crypto.randomUUID(),
      source: "react-router",
      target: "host",
      kind: "navigate-request",
      route: "/plugins",
      mode: "push",
    };
    channel.postMessage({ ...validMessage, messageId: "not-a-uuid" });
    channel.postMessage({ ...validMessage, route: "/unknown", messageId: crypto.randomUUID() });
    channel.postMessage({ ...validMessage, source: "unknown", messageId: crypto.randomUUID() });
    channel.postMessage(validMessage);
    await new Promise<void>((resolve) => {
      channel.addEventListener("message", (event) => {
        const response = event.data as { kind?: unknown; route?: unknown; target?: unknown };
        if (response.kind === "route-change" && response.route === "/plugins" && response.target === "react-router") resolve();
      });
    });
    channel.close();
  });

  await expect.poll(() => routeParameter(page, "react-router")).toBe("/plugins");
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
});

test("processes a routing message identifier only once", async ({ page }) => {
  await page.goto("/");
  await expectReady(topLevelQwikFrame(page));

  await page.evaluate(() => {
    const sessionId = sessionStorage.getItem("v-frame:routing-session");
    if (sessionId === null) throw new Error("Routing session was not initialized");
    const channel = new BroadcastChannel(`v-frame:routing:v1:${sessionId}`);
    const messageId = crypto.randomUUID();
    const routingMessage = {
      protocol: "v-frame-routing",
      version: 1,
      sessionId,
      messageId,
      source: "qwik",
      target: "host",
      kind: "navigate-request",
      route: "/catalog",
      mode: "push",
    };
    channel.postMessage(routingMessage);
    channel.postMessage({ ...routingMessage, route: "/inventory" });
    setTimeout(() => channel.close(), 0);
  });

  await expect.poll(() => routeParameter(page, "qwik")).toBe("/catalog");
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
});

test("rejects messages from a routing session replaced by reload", async ({ page }) => {
  await page.goto("/");
  const previousSessionId = await page.evaluate(() => sessionStorage.getItem("v-frame:routing-session"));
  await page.reload();
  await expectReady(topLevelQwikFrame(page));
  await page.evaluate((sessionId) => {
    if (sessionId === null) throw new Error("Previous routing session was not initialized");
    const channel = new BroadcastChannel(`v-frame:routing:v1:${sessionId}`);
    channel.postMessage({
      protocol: "v-frame-routing",
      version: 1,
      sessionId,
      messageId: crypto.randomUUID(),
      source: "qwik",
      target: "host",
      kind: "navigate-request",
      route: "/catalog",
      mode: "push",
    });
    setTimeout(() => channel.close(), 0);
  }, previousSessionId);

  await page.waitForTimeout(100);
  await expect.poll(() => routeParameter(page, "qwik")).toBeNull();
  await expect(topLevelQwikFrame(page).getByRole("textbox", { name: "Message Relay" })).toBeVisible();
});

test("renders framework routes directly without a host session", async ({ page }) => {
  await page.goto("http://127.0.0.1:44502/catalog");
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:44502/catalog");
  expect(await page.evaluate(() => sessionStorage.getItem("v-frame:routing-session"))).toBeNull();

  await page.goto("http://127.0.0.1:44501/plugins");
  await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:44501/plugins");
  expect(await page.evaluate(() => sessionStorage.getItem("v-frame:routing-session"))).toBeNull();
});

test("falls back to document navigation when BroadcastChannel is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
  });
  await page.goto("/");
  await expectLoadedWithoutRouting(topLevelQwikFrame(page));
  await expectLoadedWithoutRouting(nestedQwikFrame(page));

  const navigationPromise = page.waitForNavigation();
  await page.locator(".host-sidebar").getByRole("link", { name: "Usage" }).click();
  await navigationPromise;
  await expect(page).toHaveURL("/usage");
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("v-frame:routing-session"))).toBeNull();
});
