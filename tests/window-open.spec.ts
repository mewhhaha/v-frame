import { expect, test } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/guest.html": htmlDocument("<p>guest</p>"),
      "/popup.html": htmlDocument("<p>popup</p>"),
    },
  });
});

test.afterAll(async () => {
  await fixture.close();
});

type GuestWindow = Window & typeof globalThis;

test("window.open coerces its arguments like the native signature", async ({ page }) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/guest.html", id: "frame" });

  const result = await page.evaluate(() => {
    const frame = document.querySelector("#frame") as HTMLElement & {
      contentWindow: GuestWindow;
    };
    const view = frame.contentWindow;
    const requested: string[] = [];
    frame.addEventListener("v-frame-navigate", (event) => {
      event.preventDefault();
      requested.push((event as CustomEvent<{ to: string }>).detail.to);
    });

    // null is the string "null": a relative URL opened into a named target.
    const nullArguments = view.open(null as unknown as string, null as unknown as string);
    // The empty string is about:blank.
    const emptyURL = view.open("", "_blank");
    let invalid: string | null = null;
    try {
      view.open("http://[", "_blank");
    } catch (error) {
      invalid = `${(error as Error).name}:${error instanceof view.DOMException}`;
    }
    return { requested, nullArguments, emptyURL, invalid };
  });

  expect(result).toEqual({
    requested: [`${fixture.origin}/null`, "about:blank"],
    nullArguments: null,
    emptyURL: null,
    invalid: "SyntaxError:true",
  });
});

for (const features of [undefined, "width=300,height=300"]) {
  test(`a window.open popup has no opener (features: ${features ?? "none"})`, async ({
    page,
  }, testInfo) => {
    // Firefox does not surface feature-sized popups as Playwright popup events.
    test.skip(
      features !== undefined && testInfo.project.name === "firefox",
      "feature popups are not reported as popup events",
    );
    await installBundle(page, fixture.origin);
    await mountFrame(page, { src: fixture.origin + "/guest.html", id: "frame" });

    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.evaluate(
        ([url, windowFeatures]) => {
          const view = (
            document.querySelector("#frame") as HTMLElement & {
              contentWindow: GuestWindow;
            }
          ).contentWindow;
          view.open(url, "_blank", windowFeatures);
        },
        [fixture.origin + "/popup.html", features] as const,
      ),
    ]);
    await popup.waitForLoadState();
    expect(await popup.evaluate(() => window.opener)).toBeNull();
  });
}
