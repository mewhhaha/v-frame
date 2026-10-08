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

test("transforms only a 200 text/html response and returns anything else untouched", async () => {
  const result =
    await run<Record<string, { same: boolean; status: number; body: string }>>("gate");
  for (const name of ["ok", "ok-uppercase"]) {
    expect(result[name]!.same).toBe(false);
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
