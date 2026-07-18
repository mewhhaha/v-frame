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

async function expectReady(frame: Locator): Promise<void> {
  await expect.poll(() => frame.evaluate((element) =>
    (element as HTMLElement & { status: string }).status
  )).toBe("ready");
}

async function routeParameter(page: Page, frameId: string): Promise<string | null> {
  return page.evaluate((id) => new URL(location.href).searchParams.get(id), frameId);
}

async function expectHostRoutes(
  page: Page,
  reactRoute: "/activity" | "/history",
  qwikRoute: "/inventory" | "/catalog",
): Promise<void> {
  await expect(page.locator("#host-route")).toHaveText(
    `react-router ${reactRoute}; qwik ${qwikRoute}`,
  );
}

test("delivers every initial widget without fetching an entry document", async ({ page }) => {
  const entryRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (widgetEntryPaths.has(pathname)) {
      entryRequests.push(pathname);
    }
  });

  await page.goto("/");
  await expectReady(reactFrame(page));
  await expectReady(topLevelQwikFrame(page));
  await expectReady(nestedQwikFrame(page));

  await expect(reactFrame(page).getByRole("heading", { name: "Release activity" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
  await expect(nestedQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
  await expectHostRoutes(page, "/activity", "/inventory");
  expect(entryRequests).toEqual([]);
});

test("keeps nested Qwik routing local to the React widget", async ({ page }) => {
  await page.goto("/");
  await expectReady(nestedQwikFrame(page));

  await nestedQwikFrame(page).getByRole("button", { name: "View catalog" }).click();

  await expect(nestedQwikFrame(page).getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
  await expect.poll(() => routeParameter(page, "qwik")).toBeNull();
});

test("routes top-level widgets independently", async ({ page }) => {
  await page.goto("/");
  await expectReady(nestedQwikFrame(page));

  await topLevelQwikFrame(page).getByRole("button", { name: "View catalog" }).click();
  await expect.poll(() => routeParameter(page, "qwik")).toBe("/catalog");
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
  await expect(nestedQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
  await expect(reactFrame(page).getByRole("heading", { name: "Release activity" })).toBeVisible();
  await expectHostRoutes(page, "/activity", "/catalog");

  await reactFrame(page).getByRole("link", { name: "History" }).click();
  await expect.poll(() => routeParameter(page, "react-router")).toBe("/history");
  await expect(reactFrame(page).getByRole("heading", { name: "Release history" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
  await expect(nestedQwikFrame(page)).toHaveCount(0);
  await expectHostRoutes(page, "/history", "/catalog");
});

test("restores each top-level widget during browser history traversal", async ({ page }) => {
  const nestedEntryRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/widgets/qwik/inventory") {
      nestedEntryRequests.push(url.href);
    }
  });

  await page.goto("/");
  await expectReady(nestedQwikFrame(page));

  await nestedQwikFrame(page).getByRole("button", { name: "View catalog" }).click();
  await expect(nestedQwikFrame(page).getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
  await topLevelQwikFrame(page).getByRole("button", { name: "View catalog" }).click();
  await expect.poll(() => routeParameter(page, "qwik")).toBe("/catalog");
  await reactFrame(page).getByRole("link", { name: "History" }).click();
  await expect.poll(() => routeParameter(page, "react-router")).toBe("/history");

  await page.goBack();
  await expect(reactFrame(page).getByRole("heading", { name: "Release activity" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
  await expectReady(nestedQwikFrame(page));
  await expect(nestedQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
  await expect.poll(() => nestedEntryRequests).toHaveLength(1);
  expect(new URL(nestedEntryRequests[0]).searchParams.get("frameId")).toBeNull();
  await expectHostRoutes(page, "/activity", "/catalog");

  await page.goBack();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
  await expect(reactFrame(page).getByRole("heading", { name: "Release activity" })).toBeVisible();
  await expectHostRoutes(page, "/activity", "/inventory");

  await page.goForward();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
  await expectHostRoutes(page, "/activity", "/catalog");
  await page.goForward();
  await expect(reactFrame(page).getByRole("heading", { name: "Release history" })).toBeVisible();
  await expectHostRoutes(page, "/history", "/catalog");
});

test("honors valid initial routes and falls back from invalid routes", async ({ page }) => {
  await page.goto("/?react-router=%2Fhistory&qwik=%2Fcatalog&unrelated=preserved#status");
  await expect(reactFrame(page).getByRole("heading", { name: "Release history" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
  await expectHostRoutes(page, "/history", "/catalog");
  await expect(page).toHaveURL(/unrelated=preserved#status$/);

  await page.goto("/?react-router=%2Fmissing&qwik=%2Fmissing");
  await expect(reactFrame(page).getByRole("heading", { name: "Release activity" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
  await expectReady(nestedQwikFrame(page));
});

test("ignores malformed and misdirected routing messages", async ({ page }) => {
  await page.goto("/");
  await expectReady(topLevelQwikFrame(page));

  await page.evaluate(async () => {
    const sessionId = sessionStorage.getItem("v-frame:routing-session");
    if (sessionId === null) {
      throw new Error("Routing session was not initialized");
    }
    const channel = new BroadcastChannel(`v-frame:routing:v1:${sessionId}`);
    const validMessage = {
      protocol: "v-frame-routing",
      version: 1,
      sessionId,
      messageId: crypto.randomUUID(),
      source: "qwik",
      target: "host",
      kind: "navigate-request",
      route: "/catalog",
      mode: "push",
    };
    const rejectedMessages = [
      { ...validMessage, protocol: "other-protocol", messageId: crypto.randomUUID() },
      { ...validMessage, version: 2, messageId: crypto.randomUUID() },
      { ...validMessage, sessionId: crypto.randomUUID(), messageId: crypto.randomUUID() },
      { ...validMessage, messageId: "not-a-uuid" },
      { ...validMessage, source: "unknown", messageId: crypto.randomUUID() },
      { ...validMessage, target: "react-router", messageId: crypto.randomUUID() },
      { ...validMessage, route: "/unknown", messageId: crypto.randomUUID() },
      { ...validMessage, mode: "traverse", messageId: crypto.randomUUID() },
      { ...validMessage, kind: "route-change", messageId: crypto.randomUUID() },
      null,
      "navigate-request",
    ];
    for (const rejectedMessage of rejectedMessages) {
      channel.postMessage(rejectedMessage);
    }
    const acknowledgment = new Promise<void>((resolve) => {
      channel.addEventListener("message", (event) => {
        const response = event.data as { kind?: unknown; route?: unknown; target?: unknown };
        if (
          response.kind === "route-change"
          && response.route === "/history"
          && response.target === "react-router"
        ) {
          resolve();
        }
      });
    });
    channel.postMessage({
      ...validMessage,
      messageId: crypto.randomUUID(),
      source: "react-router",
      route: "/history",
    });
    await acknowledgment;
    channel.close();
  });

  await expect.poll(() => routeParameter(page, "qwik")).toBeNull();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
  await expect(reactFrame(page).getByRole("heading", { name: "Release history" })).toBeVisible();
});

test("children ignore malformed and misdirected host route changes", async ({ page }) => {
  await page.goto("/");
  await expectReady(topLevelQwikFrame(page));

  await page.evaluate(() => {
    const sessionId = sessionStorage.getItem("v-frame:routing-session");
    if (sessionId === null) {
      throw new Error("Routing session was not initialized");
    }
    const channel = new BroadcastChannel(`v-frame:routing:v1:${sessionId}`);
    const validMessage = {
      protocol: "v-frame-routing",
      version: 1,
      sessionId,
      messageId: crypto.randomUUID(),
      source: "host",
      target: "qwik",
      kind: "route-change",
      route: "/catalog",
      mode: "replace",
    };
    const rejectedMessages = [
      { ...validMessage, protocol: "other-protocol", messageId: crypto.randomUUID() },
      { ...validMessage, version: 2, messageId: crypto.randomUUID() },
      { ...validMessage, sessionId: crypto.randomUUID(), messageId: crypto.randomUUID() },
      { ...validMessage, messageId: "not-a-uuid" },
      { ...validMessage, source: "unknown", messageId: crypto.randomUUID() },
      { ...validMessage, target: "react-router", messageId: crypto.randomUUID() },
      { ...validMessage, kind: "navigate-request", messageId: crypto.randomUUID() },
      { ...validMessage, route: "/unknown", messageId: crypto.randomUUID() },
      { ...validMessage, mode: "unknown", messageId: crypto.randomUUID() },
      null,
      "route-change",
    ];
    for (const rejectedMessage of rejectedMessages) {
      channel.postMessage(rejectedMessage);
    }
    channel.postMessage({
      ...validMessage,
      messageId: crypto.randomUUID(),
      target: "react-router",
      route: "/history",
    });
    setTimeout(() => channel.close(), 0);
  });

  await expect(reactFrame(page).getByRole("heading", { name: "Release history" })).toBeVisible();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
  await expect.poll(() => routeParameter(page, "qwik")).toBeNull();
});

test("processes a routing message identifier only once", async ({ page }) => {
  await page.goto("/");
  await expectReady(topLevelQwikFrame(page));

  await page.evaluate(() => {
    const sessionId = sessionStorage.getItem("v-frame:routing-session");
    if (sessionId === null) {
      throw new Error("Routing session was not initialized");
    }
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
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
});

test("rejects messages from a routing session replaced by reload", async ({ page }) => {
  await page.goto("/");
  const previousSessionId = await page.evaluate(() =>
    sessionStorage.getItem("v-frame:routing-session")
  );
  await page.reload();
  await expectReady(topLevelQwikFrame(page));

  const currentSessionId = await page.evaluate(() =>
    sessionStorage.getItem("v-frame:routing-session")
  );
  expect(currentSessionId).not.toBe(previousSessionId);
  await page.evaluate((sessionId) => {
    if (sessionId === null) {
      throw new Error("Previous routing session was not initialized");
    }
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
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace inventory" })).toBeVisible();
});

test("keeps framework routing functional without a host session", async ({ page }) => {
  await page.goto("http://127.0.0.1:44502/inventory");
  await page.getByRole("button", { name: "View catalog" }).click();
  await expect(page.getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:44502/inventory");
  expect(await page.evaluate(() =>
    sessionStorage.getItem("v-frame:routing-session")
  )).toBeNull();

  await page.goto("http://127.0.0.1:44501/activity");
  await page.getByRole("link", { name: "History" }).click();
  await expect(page.getByRole("heading", { name: "Release history" })).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:44501/history");
  expect(await page.evaluate(() =>
    sessionStorage.getItem("v-frame:routing-session")
  )).toBeNull();
});

test("keeps widget routing local when BroadcastChannel is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");
  await expectReady(topLevelQwikFrame(page));
  await expectReady(nestedQwikFrame(page));

  await topLevelQwikFrame(page).getByRole("button", { name: "View catalog" }).click();
  await expect(topLevelQwikFrame(page).getByRole("heading", { name: "Workspace catalog" })).toBeVisible();
  await reactFrame(page).getByRole("link", { name: "History" }).click();
  await expect(reactFrame(page).getByRole("heading", { name: "Release history" })).toBeVisible();

  expect(await page.evaluate(() =>
    sessionStorage.getItem("v-frame:routing-session")
  )).toBeNull();
  await expect(page).toHaveURL("/");
  await expectHostRoutes(page, "/activity", "/inventory");
});
