import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { frameFailures, installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;
const receivedPosts: Array<{
  path: string;
  method: string;
  contentType: string;
  body: string;
}> = [];

async function readBody(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/form.html": htmlDocument(
        '<form action="/submitted?discard=1#result"><textarea name="message"></textarea><input id="named"><button id="send">Submit</button></form>',
      ),
      "/post-form.html": htmlDocument(
        `<form id="prg" method="post" action="/post-prg">
          <input name="item" value="apollo-11">
          <button id="send-prg" type="submit" name="intent" value="save">Save</button>
        </form>
        <form id="multipart" method="post" action="/post-inline" enctype="multipart/form-data">
          <input name="note" value="lunar dust">
          <button id="send-multipart" type="submit">Upload</button>
        </form>`,
      ),
      "/post-prg": async (request) => {
        const body = await readBody(request);
        receivedPosts.push({
          path: "/post-prg",
          method: request.method ?? "",
          contentType: String(request.headers["content-type"] ?? ""),
          body,
        });
        return {
          status: 303,
          headers: { location: "/post-done?saved=1" },
          body: "",
        };
      },
      "/post-done": htmlDocument('<main id="prg-done">Saved via PRG</main>'),
      "/post-inline": async (request) => {
        const body = await readBody(request);
        receivedPosts.push({
          path: "/post-inline",
          method: request.method ?? "",
          contentType: String(request.headers["content-type"] ?? ""),
          body,
        });
        return { body: htmlDocument('<main id="inline-done">Inline POST OK</main>') };
      },
      "/named.html": htmlDocument(
        `<form action="done" method="invalid" target="_self">
          <input name="method" value="delivery"><input name="action" value="confirm">
          <input name="target" value="order"><button id="override" formmethod="GET" formaction="override" formtarget="_self">Submit</button>
        </form>`,
        '<base href="/orders/">',
      ),
      "/orders/done": htmlDocument('<main id="submitted">Submitted</main>'),
      "/orders/override": htmlDocument('<main id="submitted">Submitted</main>'),
      "/submitted": htmlDocument('<main id="submitted">Submitted</main>'),
    },
    record: (request) => request.url ?? "/",
  });
});

test.afterAll(async () => {
  await fixture.close();
});

test("a disconnected form cannot navigate the guest", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: fixture.origin + "/form.html" });
  const navigations = await frame.evaluate((element: VFrameElement) => {
    const doc = element.contentWindow!.document;
    const attempts: string[] = [];
    element.addEventListener("v-frame-navigate", (event) =>
      attempts.push(event.detail.to),
    );
    const detached = doc.createElement("form");
    detached.action = "/submitted";
    detached.submit();
    const connected = doc.querySelector("form")!;
    connected.addEventListener("formdata", () => connected.remove(), { once: true });
    connected.submit();
    return attempts;
  });
  expect(navigations).toEqual([]);
  expect(await frame.evaluate((element: VFrameElement) => element.currentURL)).toBe(
    fixture.origin + "/form.html",
  );
  expect(await frameFailures(frame)).toEqual([]);
});

for (const invocation of ["click", "submit"] as const) {
  test(`submits controls named method, action and target (${invocation})`, async ({
    page,
  }) => {
    await installBundle(page, fixture.origin);
    const frame = await mountFrame(page, { src: fixture.origin + "/named.html" });
    let destination = "done";
    if (invocation === "click") {
      destination = "override";
      await frame.locator("#override").click();
    } else {
      await frame.evaluate((element: VFrameElement) => {
        element.contentWindow!.document.querySelector("form")!.submit();
      });
    }
    await expect(frame.locator("#submitted")).toBeVisible();
    expect(await frame.evaluate((element: VFrameElement) => element.currentURL)).toBe(
      fixture.origin +
        `/orders/${destination}?method=delivery&action=confirm&target=order`,
    );
    expect(await frameFailures(frame)).toEqual([]);
  });
}

test("reports non-HTTP links and forms with popup targets without opening a window", async ({
  page,
  context,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: fixture.origin + "/form.html" });
  const results = await frame.evaluate(async (element: VFrameElement) => {
    const win = element.contentWindow! as Window & typeof globalThis;
    const details: Array<{ to: string; kind: string }> = [];
    const reported = new Promise<void>((resolve) => {
      element.addEventListener("v-frame-navigate", (event) => {
        details.push({ to: event.detail.to, kind: event.detail.kind });
        if (details.length === 3) resolve();
      });
    });
    const link = win.document.createElement("a");
    link.href = "about:blank";
    link.target = "_blank";
    const modifiedLink = link.cloneNode() as HTMLAnchorElement;
    modifiedLink.removeAttribute("target");
    win.document.body.append(link, modifiedLink);
    link.click();
    modifiedLink.dispatchEvent(
      new win.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        ctrlKey: true,
      }),
    );
    const form = win.document.querySelector("form")!;
    form.action = "about:blank";
    form.target = "_blank";
    form.submit();
    await reported;
    // Wait for browser popup creation tasks without depending on a fixed delay.
    await fetch("/submitted");
    return details;
  });
  expect(results.map((detail) => detail.kind).sort()).toEqual(["form", "link", "link"]);
  expect(results.every((detail) => detail.to.startsWith("about:blank"))).toBe(true);
  expect(context.pages()).toEqual([page]);
  expect(await frameFailures(frame)).toEqual([]);
});

async function configureForm(page: Page, guest: boolean): Promise<void> {
  await page.evaluate((guest) => {
    const realm = guest
      ? ((document.querySelector("v-frame") as VFrameElement).contentWindow! as Window &
          typeof globalThis)
      : window;
    const form = realm.document.querySelector("form")!;
    form.querySelector("textarea")!.value = "first\r\nsecond\nthird\rfourth";
    const input = form.querySelector("input")!;
    input.name = "field\r\nname";
    input.value = "named value";
    form.addEventListener("formdata", (event) => {
      const data = (event as FormDataEvent).formData;
      data.append("added\rfield", "a\rb\nc\r\nd");
      data.append(
        "file\nfield",
        new realm.File(["bytes"], "one\rtwo\nthree\r\nfour.txt"),
      );
      data.append("repeated", "one");
      data.append("repeated", "two");
    });
  }, guest);
}

for (const invocation of ["click", "submit"] as const) {
  test(`encodes GET field names, multiline values and filenames like native submission (${invocation})`, async ({
    page,
  }) => {
    const requestsBefore = fixture.requests.length;
    await page.goto(fixture.origin + "/form.html");
    await configureForm(page, false);
    const nativeNavigation = page.waitForURL((url) => url.pathname === "/submitted");
    if (invocation === "click") await page.locator("#send").click();
    else await page.evaluate(() => document.querySelector("form")!.submit());
    await nativeNavigation;
    const nativeURL = page.url();

    await installBundle(page, fixture.origin);
    const frame = await mountFrame(page, { src: fixture.origin + "/form.html" });
    await configureForm(page, true);
    if (invocation === "click") await frame.locator("#send").click();
    else
      await frame.evaluate((element: VFrameElement) => {
        element.contentWindow!.document.querySelector("form")!.submit();
      });
    await expect(frame.locator("#submitted")).toBeVisible();
    expect(await frame.evaluate((element: VFrameElement) => element.currentURL)).toBe(
      nativeURL,
    );
    const params = new URL(nativeURL).searchParams;
    expect(params.get("message")).toBe("first\r\nsecond\r\nthird\r\nfourth");
    expect(params.get("added\r\nfield")).toBe("a\r\nb\r\nc\r\nd");
    expect(params.get("file\r\nfield")).toBe("one\r\ntwo\r\nthree\r\nfour.txt");
    expect(params.getAll("repeated")).toEqual(["one", "two"]);
    expect(params.has("discard")).toBe(false);
    const submissions = fixture.requests
      .slice(requestsBefore)
      .filter((url) => url.startsWith("/submitted?"));
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toBe(submissions[0]);
    expect(await frameFailures(frame)).toEqual([]);
    expect(page.url()).toBe(fixture.origin + "/");
  });
}

for (const mode of ["modal", "non-modal", "outside-dialog"] as const) {
  test(`keeps imperative dialog form submission native (${mode})`, async ({ page }) => {
    await installBundle(page, fixture.origin);
    const frame = await mountFrame(page, { src: fixture.origin + "/form.html" });
    const result = await frame.evaluate((element: VFrameElement, mode) => {
      const navigationEvents: string[] = [];
      for (const type of ["v-frame-navigate", "v-frame-navigated"])
        element.addEventListener(type, () => navigationEvents.push(type));
      const run = (realm: Window & typeof globalThis) => {
        const dialog = realm.document.createElement("dialog");
        const form = realm.document.createElement("form");
        const input = realm.document.createElement("input");
        input.required = true;
        form.append(input);
        input.name = "method";
        form.setAttribute("method", "DIALOG");
        form.action = "http://[";
        form.target = "_blank";
        dialog.returnValue = "unchanged";
        if (mode === "outside-dialog") realm.document.body.append(form);
        else {
          dialog.append(form);
          realm.document.body.append(dialog);
          if (mode === "modal") dialog.showModal();
          else dialog.show();
        }
        let submitEvents = 0;
        form.addEventListener("submit", () => submitEvents++);
        let error: string | null = null;
        try {
          form.submit();
        } catch (failure) {
          error = (failure as Error).name;
        }
        const snapshot = {
          open: dialog.open,
          returnValue: dialog.returnValue,
          submitEvents,
          error,
        };
        dialog.remove();
        form.remove();
        return snapshot;
      };
      return {
        native: run(window),
        guest: run(element.contentWindow! as Window & typeof globalThis),
        navigationEvents,
        status: element.status,
        url: element.currentURL,
      };
    }, mode);

    expect(result.guest).toEqual(result.native);
    expect(result.guest).toMatchObject({
      open: false,
      returnValue: mode === "outside-dialog" ? "unchanged" : "",
      submitEvents: 0,
    });
    if (mode !== "outside-dialog") expect(result.guest.error).toBeNull();
    expect(result.navigationEvents).toEqual([]);
    expect(result.status).toBe("ready");
    expect(result.url).toBe(fixture.origin + "/form.html");
    expect(await frameFailures(frame)).toEqual([]);
    expect(page.url()).toBe(fixture.origin + "/");
  });
}

test("submits same-origin POST forms with urlencoded PRG redirects and multipart HTML responses", async ({
  page,
}) => {
  receivedPosts.length = 0;
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: fixture.origin + "/post-form.html" });

  await frame.locator("#send-prg").click();
  await expect(frame.locator("#prg-done")).toHaveText("Saved via PRG");
  expect(await frame.evaluate((el: VFrameElement) => el.currentURL)).toBe(
    fixture.origin + "/post-done?saved=1",
  );
  expect(receivedPosts[0]).toMatchObject({
    path: "/post-prg",
    method: "POST",
    body: "item=apollo-11&intent=save",
  });
  expect(receivedPosts[0]!.contentType).toContain("application/x-www-form-urlencoded");

  await frame.evaluate((el: VFrameElement) => el.back());
  await expect(frame.locator("#send-multipart")).toBeVisible();
  await frame.locator("#send-multipart").click();
  await expect(frame.locator("#inline-done")).toHaveText("Inline POST OK");
  expect(receivedPosts[1]).toMatchObject({
    path: "/post-inline",
    method: "POST",
  });
  expect(receivedPosts[1]!.contentType).toContain("multipart/form-data");
  expect(receivedPosts[1]!.body).toContain('name="note"');
  expect(receivedPosts[1]!.body).toContain("lunar dust");
  expect(await frameFailures(frame)).toEqual([]);
  expect(page.url()).toBe(fixture.origin + "/");
});
