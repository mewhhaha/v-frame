import { expect, test, type Locator, type Page } from "@playwright/test";

const widgetEntryPaths = new Set([
  "/widgets/qwik/catalog",
  "/widgets/qwik/inventory",
  "/widgets/react-router/activity",
  "/widgets/react-router/brief",
  "/widgets/react-router/plugins",
  "/widgets/react-router/research",
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
  routes: string,
): Promise<void> {
  await expect(page.locator("#host-route")).toHaveText(routes);
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
  await expectHostRoutes(page, "react-router /activity; qwik /inventory");
  expect(entryRequests).toEqual([]);
});

test("hydrates a staged React transcript without recovery", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("React Router widget recovered from a hydration error")) {
      hydrationErrors.push(message.text());
    }
  });

  await page.goto("/plugins");
  await expectReady(reactFrame(page));
  await page.locator(".host-sidebar").getByRole("link", { name: "Platform migration" }).click();
  await expect(reactFrame(page).getByRole("heading", { name: "Migration conversation" })).toBeVisible();
  await expect(reactFrame(page)).toHaveCount(1);
  await expectReady(reactFrame(page));
  await expectReady(nestedQwikFrame(page));

  const widgetDocument = reactFrame(page).locator("v-html").first();
  await expect(widgetDocument).toHaveAttribute("data-react-hydrated", "true");
  await expect(widgetDocument).not.toHaveAttribute("data-react-hydration-error", "true");
  expect(hydrationErrors).toEqual([]);
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

test("removes the closed sidebar from keyboard and accessibility navigation", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator("#host-sidebar");
  const toggle = page.locator("#sidebar-toggle");
  await expect(toggle).toHaveText("Hide sidebar");

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar-closed", "");
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveText("Show sidebar");

  await toggle.click();
  await expect(page.locator("html")).not.toHaveAttribute("data-sidebar-closed", "");
  await expect(sidebar).not.toHaveAttribute("inert", "");
  await expect(sidebar).not.toHaveAttribute("aria-hidden", "");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("Hide sidebar");
});

test("marks only navigation entries as the current page after SPA navigation", async ({ page }) => {
  await page.goto("/plugins");
  await page.locator(".host-sidebar").getByRole("link", { name: "Platform migration" }).click();
  await expect(page).toHaveURL("/");
  await expect(reactFrame(page).getByRole("heading", { name: "Migration conversation" })).toBeVisible();

  const currentLinks = page.locator('[aria-current="page"]');
  await expect(currentLinks).toHaveCount(2);
  await expect(currentLinks.evaluateAll((links) => {
    return links.every((link) => link.classList.contains("host-link"));
  })).resolves.toBe(true);
  await expect(page.locator('.brand[aria-current="page"], .new-thread[aria-current="page"]')).toHaveCount(0);
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
  await popover.evaluate((element) => {
    (element as HTMLElement).style.setProperty("--preview-top", "-64px");
  });

  const popoverBounds = await popover.boundingBox();
  if (popoverBounds === null) throw new Error("The Wikipedia preview has no rendered bounds");
  expect(popoverBounds.y).toBeLessThan(frameBounds.y);
  const hitFrameId = await page.evaluate(({ x, y }) => {
    return document.elementFromPoint(x, y)?.getAttribute("data-frame-id") ?? null;
  }, { x: popoverBounds.x + 20, y: frameBounds.y - 20 });
  expect(hitFrameId).toBe("react-router");
});

test("promotes the account menu beyond its sidebar frame", async ({ page }) => {
  await page.goto("/");
  await expectLoadedWithoutRouting(accountFrame(page));

  const frame = accountFrame(page);
  const menu = frame.locator("#profile-menu");
  await frame.getByRole("button", { name: /Avery Morgan/ }).click();
  await expect(menu).toBeVisible();
  await expect(menu.evaluate((element) => element.matches(":popover-open"))).resolves.toBe(true);

  const frameBounds = await frame.boundingBox();
  const menuBounds = await menu.boundingBox();
  if (frameBounds === null) throw new Error("The account frame has no rendered bounds");
  if (menuBounds === null) throw new Error("The account menu has no rendered bounds");
  expect(menuBounds.y).toBeLessThan(frameBounds.y);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("navigates between page-scoped frontend compositions", async ({ page }) => {
  await page.goto("/");
  await expectReady(reactFrame(page));
  await expectReady(topLevelQwikFrame(page));
  const initialReactFrame = await reactFrame(page).elementHandle();
  const initialQwikFrame = await topLevelQwikFrame(page).elementHandle();
  if (initialReactFrame === null || initialQwikFrame === null) {
    throw new Error("The initial thread composition is missing a frontend");
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-document-marker", "initial"));

  const documentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") {
      documentRequests.push(new URL(request.url()).pathname);
    }
  });

  await page.locator(".host-sidebar").getByRole("link", { name: "Customer research" }).click();
  await expect(page).toHaveURL("/research");
  await expect(page.locator("html")).toHaveAttribute("data-document-marker", "initial");
  await expect(reactFrame(page).getByRole("heading", { name: "Customer research conversation" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("textbox", { name: "Message Relay" })).toBeVisible();
  await expectHostRoutes(page, "react-router /research; qwik /inventory");
  await expect(initialReactFrame.evaluate((frame) => frame.isConnected)).resolves.toBe(false);
  await expect(initialQwikFrame.evaluate((frame) => frame.isConnected)).resolves.toBe(false);

  await page.locator(".host-sidebar").getByRole("link", { name: "Plugins" }).click();
  await expect(page).toHaveURL("/plugins");
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(topLevelQwikFrame(page)).toHaveCount(0);
  await expect(page.locator("#react-surface")).toHaveAttribute("data-composition-label", "React plugins frontend");
  await expectHostRoutes(page, "react-router /plugins");

  await page.locator(".host-sidebar").getByRole("link", { name: "Usage" }).click();
  await expect(page).toHaveURL("/usage");
  await expect(reactFrame(page)).toHaveCount(0);
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expectHostRoutes(page, "qwik /catalog");
  expect(documentRequests).toEqual([]);

  await page.goBack();
  await expect(page).toHaveURL("/plugins");
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(topLevelQwikFrame(page)).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-document-marker", "initial");
});

test("keeps the current composition visible until the destination is ready", async ({ page }) => {
  await page.goto("/plugins");
  await expectReady(reactFrame(page));
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(topLevelQwikFrame(page)).toHaveCount(0);
  await expect(page.getByText("Loading workspace", { exact: false })).toHaveCount(0);
  const pluginFrame = await reactFrame(page).elementHandle();
  if (pluginFrame === null) throw new Error("The Plugins frontend is missing");

  let releaseUsage: () => void = () => {};
  let recordUsageRequest: () => void = () => {};
  const usageReleased = new Promise<void>((resolve) => {
    releaseUsage = resolve;
  });
  const usageRequested = new Promise<void>((resolve) => {
    recordUsageRequest = resolve;
  });
  await page.route("**/widgets/qwik/catalog*", async (route) => {
    recordUsageRequest();
    await usageReleased;
    await route.continue();
  });

  await page.locator(".host-sidebar").getByRole("link", { name: "Usage" }).click();
  await usageRequested;
  try {
    await expect(page).toHaveURL("/plugins");
    await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
    await expect(page.locator(".navigation-stage")).toHaveCount(1);
    await expect(page.locator(".navigation-stage")).toHaveCSS("visibility", "hidden");
    await expect(page.getByText("Loading workspace", { exact: false })).toHaveCount(0);
  } finally {
    releaseUsage();
  }
  await expect(page).toHaveURL("/usage");
  await expect(reactFrame(page)).toHaveCount(0);
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.locator(".navigation-stage")).toHaveCount(0);
  await expect(page.getByText("Loading workspace", { exact: false })).toHaveCount(0);
  await expect(pluginFrame.evaluate((frame) => frame.isConnected)).resolves.toBe(false);
});

test("waits for every top-level frame instead of nested load events", async ({ page }) => {
  await page.goto("/plugins");
  await expectReady(reactFrame(page));

  let releaseComposer: () => void = () => {};
  let recordComposerRequest: () => void = () => {};
  const composerReleased = new Promise<void>((resolve) => {
    releaseComposer = resolve;
  });
  const composerRequested = new Promise<void>((resolve) => {
    recordComposerRequest = resolve;
  });
  await page.route("**/widgets/qwik/inventory?frameId=qwik", async (route) => {
    recordComposerRequest();
    await composerReleased;
    await route.continue();
  });

  await page.locator(".host-sidebar").getByRole("link", { name: "Platform migration" }).click();
  await composerRequested;
  const stagedReactFrame = page.locator(
    '.navigation-stage v-frame[data-frame-id="react-router"]',
  );
  await expect.poll(() => stagedReactFrame.evaluate((frame) => {
    return (frame as HTMLElement & { status: string }).status;
  })).toBe("ready");
  await expect.poll(() => stagedReactFrame.locator("v-frame.nested-workspace-widget").evaluate((frame) => {
    return (frame as HTMLElement & { status: string }).status;
  })).toBe("ready");

  try {
    await expect(page).toHaveURL("/plugins");
    await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
    await expect(page.locator(".navigation-stage")).toHaveCSS("visibility", "hidden");
  } finally {
    releaseComposer();
  }

  await expect(page).toHaveURL("/");
  await expect(reactFrame(page).getByRole("heading", { name: "Migration conversation" })).toBeVisible();
  await expect(page.locator(".navigation-stage")).toHaveCount(0);
});

test("cancels an obsolete staged composition when newer navigation wins", async ({ page }) => {
  await page.goto("/plugins");
  await expectReady(reactFrame(page));
  const pluginFrame = await reactFrame(page).elementHandle();
  if (pluginFrame === null) throw new Error("The Plugins frontend is missing");

  let releaseUsage: () => void = () => {};
  let recordUsageRequest: () => void = () => {};
  const usageReleased = new Promise<void>((resolve) => {
    releaseUsage = resolve;
  });
  const usageRequested = new Promise<void>((resolve) => {
    recordUsageRequest = resolve;
  });
  await page.route("**/widgets/qwik/catalog*", async (route) => {
    recordUsageRequest();
    await usageReleased;
    await route.continue();
  });

  await page.locator(".host-sidebar").getByRole("link", { name: "Usage" }).click();
  await usageRequested;
  const obsoleteUsageFrame = await page.locator(
    '.navigation-stage v-frame[data-frame-id="qwik"]',
  ).elementHandle();
  if (obsoleteUsageFrame === null) throw new Error("The staged Usage frontend is missing");

  await page.locator(".host-sidebar").getByRole("link", { name: "Customer research" }).click();
  releaseUsage();
  await expect(page).toHaveURL("/research");
  await expect(reactFrame(page).getByRole("heading", { name: "Customer research conversation" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("textbox", { name: "Message Relay" })).toBeVisible();
  await expect(page.locator(".navigation-stage")).toHaveCount(0);
  await expect(pluginFrame.evaluate((frame) => frame.isConnected)).resolves.toBe(false);
  await expect(obsoleteUsageFrame.evaluate((frame) => frame.isConnected)).resolves.toBe(false);
});

test("falls back to document navigation when a staged frontend fails", async ({ page }) => {
  await page.goto("/plugins");
  await expectReady(reactFrame(page));
  await page.evaluate(() => document.documentElement.setAttribute("data-document-marker", "initial"));
  await page.route("**/widgets/qwik/catalog*", async (route) => {
    await route.fulfill({ status: 503, body: "Usage frontend unavailable" });
  });

  const navigation = page.waitForNavigation();
  await page.locator(".host-sidebar").getByRole("link", { name: "Usage" }).click();
  await navigation;

  await expect(page).toHaveURL("/usage");
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-document-marker", "initial");
  await expect(page.locator(".navigation-stage")).toHaveCount(0);
});

test("back navigation stages a fresh page composition", async ({ page }) => {
  await page.goto("/plugins");
  await expectReady(reactFrame(page));
  await page.evaluate(() => document.documentElement.setAttribute("data-document-marker", "first"));
  const pluginFrame = await reactFrame(page).elementHandle();
  if (pluginFrame === null) throw new Error("The initial Plugins frontend is missing");

  await page.locator(".host-sidebar").getByRole("link", { name: "Usage" }).click();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  const usageFrame = await topLevelQwikFrame(page).elementHandle();
  if (usageFrame === null) throw new Error("The Usage frontend is missing");
  await page.goBack();

  await expect(page).toHaveURL("/plugins");
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(topLevelQwikFrame(page)).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-document-marker", "first");
  await expect(pluginFrame.evaluate((frame) => frame.isConnected)).resolves.toBe(false);
  await expect(usageFrame.evaluate((frame) => frame.isConnected)).resolves.toBe(false);
});

test("keeps the nested Wikipedia route local to the transcript", async ({ page }) => {
  await page.goto("/");
  await expectReady(nestedQwikFrame(page));
  await openWikipediaPreview(page);
  await expect(topLevelQwikFrame(page).getByRole("textbox", { name: "Message Relay" })).toBeVisible();
  await expect.poll(() => routeParameter(page, "qwik")).toBeNull();
});

test("host paths own initial frontend lifetimes", async ({ page }) => {
  await page.goto("/plugins?react-router=%2Factivity&qwik=%2Fcatalog&unrelated=preserved#status");
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(topLevelQwikFrame(page)).toHaveCount(0);
  await expectHostRoutes(page, "react-router /plugins");
  await expect(page).toHaveURL(/unrelated=preserved#status$/);

  await page.goto("/usage?react-router=%2Fplugins&qwik=%2Finventory");
  await expect(reactFrame(page)).toHaveCount(0);
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expectHostRoutes(page, "qwik /catalog");

  await page.goto("/");
  await expect(reactFrame(page).getByRole("heading", { name: "Migration conversation" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("textbox", { name: "Message Relay" })).toBeVisible();
});

test("ignores malformed routing messages and accepts a valid route", async ({ page }) => {
  await page.goto("/");
  await expectReady(reactFrame(page));

  const navigation = page.waitForURL("**/plugins");
  await page.evaluate(() => {
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
    setTimeout(() => channel.close(), 100);
  });
  await navigation;

  await expect(page).toHaveURL("/plugins");
  await expect.poll(() => routeParameter(page, "react-router")).toBeNull();
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(topLevelQwikFrame(page)).toHaveCount(0);
});

test("processes a routing message identifier only once", async ({ page }) => {
  await page.goto("/");
  await expectReady(topLevelQwikFrame(page));

  const navigation = page.waitForURL("**/usage");
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
    setTimeout(() => channel.close(), 100);
  });
  await navigation;

  await expect(page).toHaveURL("/usage");
  await expect.poll(() => routeParameter(page, "qwik")).toBeNull();
  await expect(reactFrame(page)).toHaveCount(0);
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
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    "width=device-width, initial-scale=1",
  );
  expect(await page.evaluate(() => document.compatMode)).toBe("CSS1Compat");
  expect(await page.evaluate(() => sessionStorage.getItem("v-frame:routing-session"))).toBeNull();

  await page.goto("http://127.0.0.1:44501/plugins");
  await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:44501/plugins");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    "width=device-width, initial-scale=1",
  );
  expect(await page.evaluate(() => document.compatMode)).toBe("CSS1Compat");
  expect(await page.evaluate(() => sessionStorage.getItem("v-frame:routing-session"))).toBeNull();
});

test("keeps React client modules same-origin for protocol-relative basenames", async ({ request }) => {
  const response = await request.get(
    "http://127.0.0.1:44501/document?route=%2Factivity&base=%2F%2Fexample.invalid",
  );
  expect(response.ok()).toBe(true);

  const markup = await response.text();
  expect(markup).toContain('src="/assets/react-router-widget-client.js"');
  expect(markup).not.toContain("example.invalid");
});

test("marks framework-rendered documents as non-cacheable", async ({ request }) => {
  const [reactResponse, qwikResponse] = await Promise.all([
    request.get("http://127.0.0.1:44501/document?route=%2Factivity"),
    request.get("http://127.0.0.1:44502/document?route=%2Finventory"),
  ]);

  expect(reactResponse.headers()["cache-control"]).toBe("no-store");
  expect(qwikResponse.headers()["cache-control"]).toBe("no-store");
});

test("reloads a history target when the replacement routing channel fails", async ({ page }) => {
  await page.goto("/plugins");
  await expectReady(reactFrame(page));
  await page.evaluate(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: undefined,
    });
  });

  await page.locator(".host-sidebar").getByRole("link", { name: "Usage" }).click();
  await expect(page).toHaveURL("/usage");
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await page.evaluate(() => document.documentElement.setAttribute("data-document-marker", "usage"));

  await page.goBack();
  await expect(page).toHaveURL("/plugins");
  await expect(reactFrame(page).getByRole("heading", { name: "Plugins" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-document-marker", "usage");
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
