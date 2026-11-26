import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  bundleRoute,
  htmlDocument,
  parkRoute,
  type HTTPFixture,
  startHTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";
import type { VFrameElement } from "../src/index";

let fixture: HTTPFixture;
const preloadScripts = ["classic", "module"].map((kind) => {
  const body = `globalThis.log.push('${kind}');`;
  return {
    kind,
    integrity: `sha256-${createHash("sha256").update(body).digest("base64")}`,
    gate: parkRoute({
      type: "text/javascript",
      body,
      headers: { "cache-control": "public, max-age=60" },
    }),
  };
});

const inlinePreloadGate = {
  first: parkRoute({
    type: "text/javascript",
    body: "globalThis.log.push('first');",
    headers: { "cache-control": "public, max-age=60" },
  }),
  dep: parkRoute({
    type: "text/javascript",
    body: "export const tag = 'inline-dep';",
    headers: { "cache-control": "public, max-age=60" },
  }),
};

function script(body: string, delay = 0) {
  return { type: "text/javascript", body, delay };
}

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      // The dependency is slow so an engine that starts evaluation per script as soon
      // as its own graph is ready would run the later script first.
      "/scripts/slow-dependency.js": script("export const ready = true;", 300),
      "/scripts/slow-module.js": script("globalThis.log.push('external-module');", 300),
      "/documents/inline-modules.html": htmlDocument(`
        <script>globalThis.log = [];</script>
        <script type="module">import "/scripts/slow-dependency.js"; log.push("A");</script>
        <script type="module">log.push("B");</script>
      `),
      "/documents/mixed-deferred.html": htmlDocument(`
        <script>globalThis.log = [];</script>
        <script type="module" src="/scripts/slow-module.js"></script>
        <script type="module">log.push("inline-module");</script>
        <script defer src="/scripts/fast-classic.js"></script>
      `),
      "/scripts/fast-classic.js": script("globalThis.log.push('defer-classic');"),
      "/documents/inline-preload.html": htmlDocument(`
        <script>globalThis.log = [];</script>
        <script type="module" src="/scripts/inline-first.js"></script>
        <script type="module">
          // import "/scripts/ignored-comment.js";
          import { tag } from "/scripts/inline-dep.js";
          log.push(tag);
        </script>
      `),
      "/scripts/inline-first.js": inlinePreloadGate.first.route,
      "/scripts/inline-dep.js": inlinePreloadGate.dep.route,
      "/documents/preload-options.html": htmlDocument(`
        <script>globalThis.log = [];</script>
        ${preloadScripts.map(({ kind, integrity }) => `<script ${kind === "module" ? 'type="module"' : "defer"} src="/scripts/preload-${kind}.js" integrity="${integrity}" referrerpolicy="no-referrer" fetchpriority="high"></script>`).join("")}
      `),
      ...Object.fromEntries(
        preloadScripts.map(({ kind, gate }) => [
          `/scripts/preload-${kind}.js`,
          gate.route,
        ]),
      ),
    },
  });
});

test.afterAll(async () => {
  for (const { gate } of preloadScripts) gate.abandon();
  inlinePreloadGate.first.abandon();
  inlinePreloadGate.dep.abandon();
  await fixture.close();
});

test("deferred preloads preserve fetch options and share their script requests", async ({
  page,
}) => {
  const referrers: Array<string | undefined> = [];
  page.on("request", (request) => {
    if (request.url().includes("/scripts/preload-"))
      referrers.push(request.headers().referer || undefined);
  });
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/preload-options.html`,
    settle: "none",
  });
  const preloads = () =>
    frame.evaluate((element) => {
      const iframe = element.shadowRoot?.querySelector("iframe");
      if (!iframe?.contentDocument) return [];
      // Borrow the host method to inspect the execution document's physical head.
      const links = Document.prototype.querySelectorAll.call(
        iframe.contentDocument,
        'link[rel="preload"],link[rel="modulepreload"]',
      );
      return Array.from(links, (link) => ({
        integrity: link.getAttribute("integrity"),
        referrerpolicy: link.getAttribute("referrerpolicy"),
        fetchpriority: link.getAttribute("fetchpriority"),
      }));
    });
  await expect.poll(preloads).toEqual(
    preloadScripts.map(({ integrity }) => ({
      integrity,
      referrerpolicy: "no-referrer",
      fetchpriority: "high",
    })),
  );
  await Promise.all(preloadScripts.map(({ gate }) => gate.release()));
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  expect(
    await frame.evaluate(
      (element) =>
        (element as VFrameElement & { contentWindow: Window & { log: string[] } })
          .contentWindow.log,
    ),
  ).toEqual(["classic", "module"]);
  expect(referrers).toEqual([undefined, undefined]);
  for (const { kind } of preloadScripts) {
    expect(
      fixture.requests.filter((path) => path === `/scripts/preload-${kind}.js`),
    ).toHaveLength(1);
  }
});

for (const [name, path, expected] of [
  ["inline modules with a slow import", "inline-modules.html", ["A", "B"]],
  [
    "external module, inline module and defer classic",
    "mixed-deferred.html",
    ["external-module", "inline-module", "defer-classic"],
  ],
] as const) {
  test(`executes initial deferred scripts in document order: ${name}`, async ({
    page,
  }) => {
    await installBundle(page, fixture.origin);
    const frame = await mountFrame(page, {
      src: `${fixture.origin}/documents/${path}`,
    });
    const log = await frame.evaluate(
      (element) =>
        (element as unknown as { contentWindow: { log: string[] } }).contentWindow.log,
    );
    expect(log).toEqual(expected);
  });
}

test("preloads static imports of later inline module scripts while earlier scripts are still loading", async ({
  page,
}) => {
  fixture.requests.length = 0;
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/inline-preload.html`,
    settle: "none",
  });
  await expect.poll(() => fixture.requests.includes("/scripts/inline-dep.js")).toBe(true);
  expect(fixture.requests).not.toContain("/scripts/ignored-comment.js");
  await inlinePreloadGate.dep.release();
  await inlinePreloadGate.first.release();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  expect(
    await frame.evaluate(
      (element) =>
        (element as unknown as { contentWindow: { log: string[] } }).contentWindow.log,
    ),
  ).toEqual(["first", "inline-dep"]);
});
