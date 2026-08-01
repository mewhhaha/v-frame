import { expect, test } from "@playwright/test";
import { bundleRoute, type HTTPFixture, startHTTPFixture } from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;

function documentPage(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

function startCompatibilityFixture(): Promise<HTTPFixture> {
  return startHTTPFixture({
    routes: {
      "/": documentPage('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/documents/restrictive-headers.html": {
        body: documentPage(
          '<output id="script-result">pending</output><script>document.querySelector("#script-result").textContent = "ran";</script>',
        ),
        headers: {
          "content-security-policy":
            "default-src 'none'; script-src 'none'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
        },
      },
      "/documents/native-form.html": documentPage(
        '<form id="native-form" action="/documents/form-target.html" method="get" target="_self"><input name="query" value="compatibility"><button>Submit</button></form>',
      ),
      "/documents/form-target.html": documentPage(
        '<main id="form-target">Form destination</main>',
      ),
    },
  });
}

test.beforeAll(async () => {
  fixture = await startCompatibilityFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

test("rejects a cross-origin application route", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const failure = await page.evaluate(async () => {
    const frame = document.createElement("v-frame") as HTMLElement & { status: string };
    const reported = new Promise<{ message: string; phase: string }>((resolve) => {
      frame.addEventListener(
        "v-frame-error",
        (event) => {
          const detail = (event as CustomEvent<{ error: Error; phase: string }>).detail;
          resolve({ message: detail.error.message, phase: detail.phase });
        },
        { once: true },
      );
    });
    frame.setAttribute("src", "https://application.invalid/orders");
    document.querySelector("#host")?.append(frame);
    return { failure: await reported, status: frame.status };
  });

  expect(failure).toEqual({
    failure: {
      message: `v-frame route https://application.invalid/orders must share host origin ${fixture.origin}`,
      phase: "entry",
    },
    status: "error",
  });
});

test("reconstructs a source that declares restrictive CSP and framing headers", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/restrictive-headers.html`,
    id: "restrictive-headers",
  });

  await expect(frame.locator("#script-result")).toHaveText("ran");
  await expect
    .poll(() =>
      frame.evaluate(
        (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/restrictive-headers.html`);
});

test("loads an allowed same-context GET form inside the guest", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/native-form.html`,
    id: "native-form",
  });
  const hostURL = page.url();
  await page.evaluate(() => {
    document
      .querySelector("#native-form")
      ?.addEventListener("v-frame-navigate", (event) => {
        const detail = (event as CustomEvent<{ kind: string; to: string }>).detail;
        sessionStorage.setItem(
          "compatibility-navigation",
          JSON.stringify({
            kind: detail.kind,
            to: detail.to,
          }),
        );
      });
  });

  await frame.locator("#native-form button").click();
  await expect(frame.locator("#form-target")).toHaveText("Form destination");
  await expect
    .poll(() =>
      frame.evaluate(
        (element) => (element as HTMLElement & { currentURL: string | null }).currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/form-target.html?query=compatibility`);
  expect(page.url()).toBe(hostURL);
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("compatibility-navigation") ?? "null"),
    ),
  ).toEqual({
    kind: "form",
    to: `${fixture.origin}/documents/form-target.html?query=compatibility`,
  });
});
