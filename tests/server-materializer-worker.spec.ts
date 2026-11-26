import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { rolldown } from "rolldown";

// Runs the real `materializeVFrameDocument` under workerd, where `HTMLRewriter`
// is the genuine lol-html implementation. Workers and Miniflare are pinned by
// the SSR workspace, which CI installs too.
const workspace = createRequire(resolve("examples/ssr/package.json"));
const wrangler = createRequire(workspace.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = wrangler("miniflare") as {
  convertV4MiniflareOptions(options: object): object;
  Miniflare: new (options: object) => { ready: Promise<URL>; dispose(): Promise<void> };
};

let worker: InstanceType<typeof Miniflare>;
let origin: string;

test.beforeAll(async () => {
  const bundle = await rolldown({
    input: resolve("tests/support/server-materializer-worker.js"),
    platform: "neutral",
  });
  let script: string;
  try {
    script = (await bundle.generate({ format: "es" })).output.find(
      (item) => item.type === "chunk",
    )!.code;
  } finally {
    await bundle.close();
  }
  worker = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      workers: [{ modules: true, script, compatibilityDate: "2026-09-30" }],
    }),
  );
  origin = (await worker.ready).origin;
});
test.afterAll(async () => {
  await worker?.dispose();
});

async function run<T>(name: string): Promise<T> {
  const response = await fetch(`${origin}/?case=${name}`);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

test("composes owned slots through one public route and isolates guest failures", async () => {
  const { upstream, markup, headers } = await run<{
    upstream: string[][];
    markup: string;
    headers: Record<string, string>;
  }>("composition");
  expect(upstream.map(([url]) => url).sort()).toEqual([
    "/apps/offline",
    "/apps/orders?a=1&b=2",
    "/apps/theme.css?x=1&y=2",
    "/apps/unavailable",
  ]);
  expect(
    upstream.every(([, , cookie, redirect]) => cookie === null && redirect === "manual"),
  ).toBe(true);
  expect(upstream.find(([url]) => url?.includes("theme.css"))?.[1]).toBe("text/css");
  expect(markup).toContain("Orders</p>");
  expect(markup).not.toContain("private diagnostic");
  expect(markup).toContain('src="offline">fallback</v-frame>');
  expect(markup.match(/shadowrootmode="open"/g)).toHaveLength(3);
  expect(markup).toContain("data-v-frame-fonts");
  expect(markup).toContain('nonce="hostNonce"');
  expect(headers.etag).toBeUndefined();
  expect(headers["content-language"]).toBe("fr");
});

test("starts sibling guest requests together and cancels them with the shell body", async () => {
  expect(await run<string[]>("cancelComposition")).toEqual(["/a", "/b"]);
});

test("transforms only a 200 text/html response and returns anything else untouched", async () => {
  const result = await run<
    Record<
      string,
      {
        same: boolean;
        status: number;
        body: string;
        composable: boolean;
        rejected: boolean;
      }
    >
  >("gate");
  for (const name of ["ok", "ok-uppercase"]) {
    expect(result[name]!.same).toBe(false);
    expect(result[name]!.composable).toBe(true);
    expect(result[name]!.rejected).toBe(false);
    expect(result[name]!.body).toContain("<v-body>");
    expect(result[name]!.body).toContain('data-v-frame-script=""');
  }
  for (const name of [
    "partial",
    "missing",
    "json",
    "plain",
    "noContent",
    "notModified",
    "redirect",
  ]) {
    expect(result[name]!.same, name).toBe(true);
    expect(result[name]!.composable, name).toBe(false);
    expect(result[name]!.rejected, name).toBe(true);
  }
  expect(result.partial!.body).toContain("<body>");
  expect(result.json!.body).toContain("<body>");
  expect(result.notModified!.status).toBe(304);
  expect(result.redirect!.status).toBe(302);
});

test("drops validators and range metadata and declares the UTF-8 output", async () => {
  const { headers, body } = await run<{ headers: Record<string, string>; body: string }>(
    "headers",
  );
  for (const name of [
    "etag",
    "last-modified",
    "accept-ranges",
    "content-md5",
    "digest",
    "content-digest",
    "content-length",
    "content-encoding",
  ]) {
    expect(headers, name).not.toHaveProperty(name);
  }
  expect(headers["cache-control"]).toBe("max-age=60");
  expect(headers["x-guest"]).toBe("kept");
  expect(headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(body).toContain("<v-body>");
});

test("honours a base in a guest without explicit html or head tags", async () => {
  const { body } = await run<{ body: string }>("base");
  expect(body).toContain('src="https://guest.test/apps/public/tile.svg"');
  // The base itself resolves against the document, and a template's is inert.
  expect(body).toContain('href="https://guest.test/apps/public/"');
});

test("takes the first valid base even when it follows other resources", async () => {
  const { body } = await run<{ body: string }>("lateBase");
  expect(body).toContain('src="https://guest.test/first/tile.svg"');
});

test("keeps an inline style as authored and reports it when materializing throws", async () => {
  const { body, failures } = await run<{
    body: string;
    failures: { url: string; message: string }[];
  }>("inlineFailure");
  expect(body).toContain("background:url(a.png)");
  expect(body).toContain("after</v-body>");
  expect(failures).toEqual([
    { url: "https://guest.test/apps/orders/", message: "font sink failed" },
  ]);
});

test("neutralizes a linked stylesheet that fails and reports it through the same callback", async () => {
  const { body, failures } = await run<{
    body: string;
    failures: { url: string; message: string }[];
  }>("linkFailure");
  expect(body).toContain('rel="v-frame-stylesheet"');
  expect(body).toContain('data-v-frame-rel="stylesheet"');
  expect(body).not.toContain("data-v-frame-linked");
  expect(body).toContain("after</v-body>");
  expect(failures).toEqual([
    {
      url: "https://guest.test/apps/orders/missing.css",
      message: "stylesheet unavailable",
    },
  ]);
});

test("names the option when no HTMLRewriter exists, and uses an injected one", async () => {
  const missing = await run<{ error: { name: string; message: string } }>("noRewriter");
  expect(missing.error.name).toBe("TypeError");
  expect(missing.error.message).toContain("options.HTMLRewriter");

  const injected = await run<{ constructed: number; body: string }>("injectedRewriter");
  expect(injected.constructed).toBe(2);
  expect(injected.body).toContain("<v-body>");
});

test("cancelling the response aborts a stylesheet fetch still in flight", async () => {
  const result = await run<{ requested: boolean; before: boolean; aborted: boolean }>(
    "cancel",
  );
  expect(result).toEqual({ requested: true, before: false, aborted: true });
});

test("decodes the guest by BOM, header charset, then meta prescan before rewriting", async () => {
  const result = await run<Record<string, { type: string; body: string }>>("encodings");
  for (const [name, { type, body }] of Object.entries(result)) {
    expect(type, name).toBe("text/html; charset=utf-8");
    expect(body, name).not.toContain("�");
    expect(body, name).toContain("café");
  }
  // Windows-1252 maps 0x80 to the euro sign; ISO-8859-1 labels do too (WHATWG).
  expect(result.headerWindows!.body).toContain("café €");
  // The header outranks a contradicting meta, and a BOM outranks the header.
  expect(result.headerBeatsMeta!.body).toContain("café €");
  expect(result.bomBeatsHeader!.body).toContain("café €");
  expect(result.utf16le!.body).toContain("café €");
  expect(result.utf16be!.body).toContain("café €");
  expect(result.utf8!.body).toContain("café €");
  expect(result.utf8Bare!.body).toContain("café €");
  expect(result.metaUtf16IsUtf8!.body).toContain("café €");
  expect(result.unknownLabel!.body).toContain("café €");
  // The output is UTF-8, so no declaration may claim otherwise.
  expect(result.metaCharset!.body).toContain('<meta charset="utf-8">');
  expect(result.metaHttpEquiv!.body).toContain('content="text/html; charset=utf-8"');
  expect(result.metaCharset!.body).not.toMatch(/iso-8859-1/i);
  expect(result.metaHttpEquiv!.body).not.toMatch(/iso-8859-1/i);
});

test("cancelling reports no failures and aborts a custom fetchText through its signal", async () => {
  const { signals, failures } = await run<{
    signals: { url: string; hasSignal: boolean }[];
    failures: string[];
  }>("cancelQuiet");
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.every((entry) => entry.hasSignal)).toBe(true);
  expect(failures).toEqual([]);
});

test("aborts stylesheet work and the output body when the caller aborts", async () => {
  const { received, failures, readFailed } = await run<{
    received: string[];
    failures: string[];
    readFailed: boolean;
  }>("callerCancel");
  expect(received).toEqual(["https://guest.test/apps/orders/theme.css"]);
  expect(failures).toEqual([]);
  expect(readFailed).toBe(true);
});

test("checks the strongest stylesheet integrity against original bytes", async () => {
  const { body, failures } = await run<{ body: string; failures: string[] }>("integrity");
  expect(body.match(/data-v-frame-linked=/g)).toHaveLength(3);
  expect(body).toContain("#test{color:rebeccapurple}");
  expect(failures).toEqual([
    "v-frame SSR stylesheet https://guest.test/apps/orders/pinned.css failed its integrity check",
    "v-frame SSR stylesheet https://guest.test/apps/orders/malformed.css failed its integrity check",
    "v-frame SSR stylesheet https://guest.test/apps/orders/text-only.css needs original bytes to verify integrity",
  ]);
});

test("fetches linked stylesheets and sibling imports concurrently", async () => {
  const result =
    await run<Record<string, { max: number; urls: string[] }>>("concurrency");
  // Five distinct links (one repeated) are all in flight at once.
  expect(result.links!.max).toBe(5);
  expect(result.links!.urls).toHaveLength(5);
  expect(result.imports!.max).toBe(3);
  // sheet.css, then its three distinct imports together.
  expect(result.nested!.max).toBe(3);
  expect(result.nested!.urls).toHaveLength(4);
  // A late base re-bases the prefetched link, and it is fetched once.
  expect(result.lateBase!.urls).toEqual(["https://guest.test/other/s.css"]);
});

test("marks materialized styles, strips forged markers, and disables alternate previews", async () => {
  const { body, failures } = await run<{ body: string; failures: string[] }>(
    "styleMarkers",
  );
  // The forged marker is dropped and its sheet is left for the runtime.
  expect(body).toMatch(/<style id="forged">@font-face/);
  expect(body).toMatch(/<style id="good" data-v-frame-materialized="">/);
  expect(body).toMatch(/<style id="empty" data-v-frame-materialized="">/);
  expect(body).toContain("<style data-v-frame-materialized>:host");
  expect(failures).toEqual(["https://guest.test/apps/orders/"]);
  const previews = [...body.matchAll(/<style data-v-frame-source="([^"]+)"[^>]*>/g)];
  const alternate = previews.find((match) => match[1]!.endsWith("dark.css"))![0];
  expect(alternate).toContain('media="not all"');
  expect(alternate).toContain('title="Dark"');
  expect(previews.find((match) => match[1]!.endsWith("main.css"))![0]).toContain(
    'media="not all"',
  );
});

test("blocks DSD template breakout, strips forged markers, skips template stylesheets, and decodes entities", async () => {
  const { body, nestedBody, templateFetches, templateFonts } = await run<{
    body: string;
    nestedBody: string;
    templateFetches: string[];
    templateFonts: string[];
  }>("securityHardening");
  // Inert template styles and links never trigger server fetches or host font extraction.
  expect(templateFetches).toEqual(["https://guest.test/apps/orders/titled.css"]);
  expect(templateFonts).toEqual([]);
  // Entity-encoded attributes are decoded once (no double-escaping in preview style title, and &#x2f; resolves to root).
  expect(body).toContain('title="A &amp; B"');
  expect(body).not.toContain("A &amp;amp; B");
  expect(body).toContain('src="https://guest.test/admin?x=1&amp;y=2"');
  // Stray </template> (both direct and via SVG) was dropped, forged outer script got recorded as inert application/vnd.v-frame.
  expect(body).not.toContain('</template><script id="escaped"');
  expect(body).not.toContain("</svg></template>");
  expect(body).toMatch(
    /<script id="forged"[^>]*data-v-frame-type="application\/vnd\.v-frame"/,
  );
  // By default (preserveNestedFrames: false), even nested <v-frame adopt> markers are stripped.
  expect(body).toMatch(
    /<script id="nested-ok"[^>]*data-v-frame-type="application\/vnd\.v-frame"/,
  );
  // With preserveNestedFrames: true, same-origin nested adopting frames preserve their materialized script while neutralizing live scripts.
  expect(nestedBody).toMatch(
    /<script id="nested-ok"[^>]*data-v-frame-script[^>]*data-v-frame-type="module"/,
  );
  expect(nestedBody).toMatch(
    /<script id="nested-live"[^>]*type="application\/vnd\.v-frame"[^>]*data-v-frame-script/,
  );
});

test("composeFrames deduplicates fonts, applies composition-wide slot/concurrency budgets and per-slot timeouts, and reports slot errors", async () => {
  const { markup, slotErrors, maxInFlight } = await run<{
    markup: string;
    slotErrors: Array<{ src: string; name: string }>;
    maxInFlight: number;
  }>("composeHardening");
  expect(markup).toContain("<p>One</p>");
  expect(markup).toContain("<p>Two</p>");
  expect(maxInFlight).toBeLessThanOrEqual(2);
  // Identical @font-face rules across sibling frames are emitted once.
  expect(markup.match(/data-v-frame-fonts/g)).toHaveLength(1);
  // Slow, oversized, and over-budget slots fall back to client loading and report their errors.
  expect(markup).toContain('<v-frame id="slow" src="/apps/slow"></v-frame>');
  expect(markup).toContain('<v-frame id="huge" src="/apps/huge"></v-frame>');
  expect(markup).toContain('<v-frame id="overflow" src="/apps/overflow"></v-frame>');
  expect(slotErrors.sort((a, b) => a.src.localeCompare(b.src))).toEqual([
    { src: "/apps/huge", name: "RangeError" },
    { src: "/apps/overflow", name: "RangeError" },
    { src: "/apps/slow", name: "TimeoutError" },
  ]);
});
