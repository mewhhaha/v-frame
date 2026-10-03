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

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/form.html": htmlDocument(
        '<form action="/submitted?discard=1#result"><textarea name="message"></textarea><input id="named"><button id="send">Submit</button></form>',
      ),
      "/submitted": htmlDocument('<main id="submitted">Submitted</main>'),
    },
    record: (request) => request.url ?? "/",
  });
});

test.afterAll(async () => {
  await fixture.close();
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
        form.method = "DIALOG";
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
