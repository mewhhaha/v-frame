import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;

const scrollDocument = (name: string, next: string) =>
  htmlDocument(
    `<main id="${name}" style="width:2200px;height:3200px">
      <a id="next" href="${next}">Next document</a>
      <script>
        function recordFirstVisibleScroll() {
          if (getComputedStyle(document.body).visibility === 'hidden') {
            requestAnimationFrame(recordFirstVisibleScroll);
          } else {
            window.firstVisibleScroll = [scrollX, scrollY];
          }
        }
        requestAnimationFrame(recordFirstVisibleScroll);
      </script>
    </main>`,
    "<style>html,body{margin:0}</style>",
  );

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/downloads.html": htmlDocument(
        '<main id="live">Live guest <a id="download" href="/report.txt" download="report.txt">Download</a></main>',
      ),
      "/report.txt": { type: "text/plain", body: "Exported report\n" },
      "/first.html": scrollDocument("first", "/second.html"),
      "/second.html": scrollDocument("second", "/first.html"),
    },
  });
});

test.afterAll(async () => {
  await fixture.close();
});

async function mount(page: Page, src: string): Promise<Locator> {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: fixture.origin + src });
  await frame.evaluate((element) => {
    element.style.cssText = "width:400px;height:200px;scroll-behavior:smooth";
  });
  return frame;
}

async function scroll(frame: Locator, x: number, y: number): Promise<void> {
  await frame.evaluate(
    (element: VFrameElement, [left, top]) => {
      element.contentWindow!.scrollTo({ left, top, behavior: "instant" });
    },
    [x, y] as const,
  );
  expect(await position(frame)).toEqual([x, y]);
}

function position(frame: Locator): Promise<number[]> {
  return frame.evaluate((element: VFrameElement) => [
    element.contentWindow!.scrollX,
    element.contentWindow!.scrollY,
  ]);
}

for (const target of ["", "_blank"]) {
  test(`downloads a same-origin file without navigating the guest (target=${target || "default"})`, async ({
    page,
  }) => {
    const frame = await mount(page, "/downloads.html");
    await frame.evaluate((element: VFrameElement, target) => {
      element.contentWindow!.document.querySelector("a")!.setAttribute("target", target);
      const recorded = element as VFrameElement & { navigationEvents: string[] };
      recorded.navigationEvents = [];
      for (const type of ["v-frame-navigate", "v-frame-navigated"])
        element.addEventListener(type, () => {
          recorded.navigationEvents.push(type);
        });
    }, target);
    const downloading = page.waitForEvent("download");
    await frame.locator("#download").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("report.txt");
    expect(await readFile((await download.path())!, "utf8")).toBe("Exported report\n");
    await expect(frame.locator("#live")).toBeVisible();
    expect(
      await frame.evaluate((element: VFrameElement) => ({
        url: element.currentURL,
        length: element.contentWindow!.history.length,
        status: element.status,
      })),
    ).toEqual({ url: fixture.origin + "/downloads.html", length: 1, status: "ready" });
    expect(page.url()).toBe(fixture.origin + "/");
    expect(
      await frame.evaluate(
        (element) =>
          (element as VFrameElement & { navigationEvents: string[] }).navigationEvents,
      ),
    ).toEqual([]);
  });
}

test("lets a guest document listener cancel a native download", async ({ page }) => {
  const frame = await mount(page, "/downloads.html");
  const requestsBefore = fixture.requests.filter((path) => path === "/report.txt").length;
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await frame.evaluate((element: VFrameElement) => {
    element.contentWindow!.document.addEventListener(
      "click",
      (event) => event.preventDefault(),
      { once: true },
    );
  });
  await frame.locator("#download").click();
  await expect(frame.locator("#live")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await frame.locator("#download").click();
  await downloading;
  expect(downloads).toEqual(["report.txt"]);
  expect(
    fixture.requests.filter((path) => path === "/report.txt").length - requestsBefore,
  ).toBe(1);
  expect(await frame.evaluate((element: VFrameElement) => element.currentURL)).toBe(
    fixture.origin + "/downloads.html",
  );
});

test("uses the filename and URL chosen by the guest click handler", async ({ page }) => {
  const frame = await mount(page, "/downloads.html");
  await frame.evaluate((element: VFrameElement) => {
    const link = element.contentWindow!.document.querySelector("a")!;
    link.addEventListener("click", () => {
      link.href = "/report.txt?updated";
      link.download = "updated.txt";
    });
  });
  const downloading = page.waitForEvent("download");
  await frame.locator("#download").click();
  const download = await downloading;
  expect(download.url()).toBe(fixture.origin + "/report.txt?updated");
  expect(download.suggestedFilename()).toBe("updated.txt");
  await expect(frame.locator("#live")).toBeVisible();
});

test("keeps navigation virtual if a guest listener removes download", async ({
  page,
}) => {
  const frame = await mount(page, "/downloads.html");
  await frame.evaluate((element: VFrameElement) => {
    const link = element.contentWindow!.document.querySelector("a")!;
    link.addEventListener("click", () => {
      link.removeAttribute("download");
      link.href = "/second.html";
    });
  });
  await frame.locator("#download").click();
  await expect(frame.locator("#second")).toBeVisible();
  expect(page.url()).toBe(fixture.origin + "/");
});

for (const traversal of ["host", "guest"] as const) {
  test(`restores both scroll axes on ${traversal} back and forward, before hashchange`, async ({
    page,
  }) => {
    const frame = await mount(page, "/first.html");
    await scroll(frame, 120, 300);
    await frame.evaluate((element: VFrameElement) => {
      element.contentWindow!.history.pushState({ step: 1 }, "", "#next");
    });
    await scroll(frame, 240, 1000);
    const events = await frame.evaluate(async (element: VFrameElement, traversal) => {
      const child = element.contentWindow!;
      const events: Array<[string, number]> = [];
      child.addEventListener("popstate", () => events.push(["popstate", child.scrollY]));
      child.addEventListener("hashchange", () =>
        events.push(["hashchange", child.scrollY]),
      );
      if (traversal === "host") {
        await element.back();
      } else {
        await new Promise<void>((resolve) => {
          child.addEventListener("popstate", () => resolve(), { once: true });
          child.history.back();
        });
      }
      return events;
    }, traversal);
    expect(await position(frame)).toEqual([120, 300]);
    expect(events).toEqual([
      ["popstate", 1000],
      ["hashchange", 300],
    ]);
    await frame.evaluate((element: VFrameElement) => element.forward());
    expect(await position(frame)).toEqual([240, 1000]);
  });
}

test("inherits manual restoration without changing either scroll axis on traversal", async ({
  page,
}) => {
  const frame = await mount(page, "/first.html");
  await scroll(frame, 120, 300);
  await frame.evaluate((element: VFrameElement) => {
    const child = element.contentWindow!;
    child.history.scrollRestoration = "manual";
    child.history.pushState(null, "", "#manual");
  });
  await scroll(frame, 240, 1000);
  await frame.evaluate((element: VFrameElement) => element.back());
  expect(await position(frame)).toEqual([240, 1000]);
  expect(
    await frame.evaluate(
      (element: VFrameElement) => element.contentWindow!.history.scrollRestoration,
    ),
  ).toBe("manual");
  await frame.evaluate((element: VFrameElement) => element.forward());
  expect(await position(frame)).toEqual([240, 1000]);
});

test("keeps scroll restoration mode specific to each entry", async ({ page }) => {
  const frame = await mount(page, "/first.html");
  await scroll(frame, 120, 300);
  await frame.evaluate((element: VFrameElement) => {
    const child = element.contentWindow!;
    child.history.pushState(null, "", "#manual");
    child.history.scrollRestoration = "manual";
  });
  await scroll(frame, 240, 1000);
  await frame.evaluate((element: VFrameElement) => element.back());
  expect(await position(frame)).toEqual([120, 300]);
  expect(
    await frame.evaluate(
      (element: VFrameElement) => element.contentWindow!.history.scrollRestoration,
    ),
  ).toBe("auto");
  await frame.evaluate((element: VFrameElement) => element.forward());
  expect(await position(frame)).toEqual([120, 300]);
  expect(
    await frame.evaluate(
      (element: VFrameElement) => element.contentWindow!.history.scrollRestoration,
    ),
  ).toBe("manual");
});

for (const action of ["manual", "push", "replace"] as const) {
  test(`respects a popstate handler that ${action === "manual" ? "takes over scrolling" : action === "push" ? "pushes history" : "replaces history"}`, async ({
    page,
  }) => {
    const frame = await mount(page, "/first.html");
    await scroll(frame, 120, 300);
    await frame.evaluate((element: VFrameElement) =>
      element.contentWindow!.history.pushState(null, "", "#next"),
    );
    await scroll(frame, 240, 1000);
    await frame.evaluate(async (element: VFrameElement, action) => {
      const child = element.contentWindow!;
      child.addEventListener(
        "popstate",
        () => {
          if (action === "manual") child.history.scrollRestoration = "manual";
          else
            child.history[action === "push" ? "pushState" : "replaceState"](
              { router: true },
              "",
              "?router",
            );
        },
        { once: true },
      );
      await element.back();
    }, action);
    expect(await position(frame)).toEqual(
      action === "replace" ? [120, 300] : [240, 1000],
    );
  });
}

test("restores cross-document back and forward before the first visible animation frame", async ({
  page,
}) => {
  const frame = await mount(page, "/first.html");
  await scroll(frame, 120, 300);
  await frame.evaluate((element: VFrameElement) =>
    (element.contentWindow!.document.querySelector("#next") as HTMLAnchorElement).click(),
  );
  await expect(frame.locator("#second")).toBeVisible();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  await scroll(frame, 240, 1000);
  await frame.evaluate((element: VFrameElement) => element.back());
  expect(await position(frame)).toEqual([120, 300]);
  await expect
    .poll(() =>
      frame.evaluate(
        (element: VFrameElement) =>
          (element.contentWindow as Window & { firstVisibleScroll?: number[] })
            .firstVisibleScroll,
      ),
    )
    .toEqual([120, 300]);
  await frame.evaluate((element: VFrameElement) => element.forward());
  expect(await position(frame)).toEqual([240, 1000]);
  await expect
    .poll(() =>
      frame.evaluate(
        (element: VFrameElement) =>
          (element.contentWindow as Window & { firstVisibleScroll?: number[] })
            .firstVisibleScroll,
      ),
    )
    .toEqual([240, 1000]);
});

test("retains a manual entry across document replacement without restoring its saved position", async ({
  page,
}) => {
  const frame = await mount(page, "/first.html");
  await scroll(frame, 120, 300);
  await frame.evaluate((element: VFrameElement) => {
    const child = element.contentWindow!;
    child.history.scrollRestoration = "manual";
    (child.document.querySelector("#next") as HTMLAnchorElement).click();
  });
  await expect(frame.locator("#second")).toBeVisible();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  expect(
    await frame.evaluate(
      (element: VFrameElement) => element.contentWindow!.history.scrollRestoration,
    ),
  ).toBe("auto");
  await scroll(frame, 240, 1000);
  await frame.evaluate((element: VFrameElement) => element.back());
  expect(await position(frame)).toEqual([240, 1000]);
  expect(
    await frame.evaluate(
      (element: VFrameElement) => element.contentWindow!.history.scrollRestoration,
    ),
  ).toBe("manual");
});
