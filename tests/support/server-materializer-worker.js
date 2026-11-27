import {
  isVFrameDocumentResponse,
  composeFrames,
  materializeVFrameDocument,
} from "../../dist/server/index.js";

const html = (body, init = {}) =>
  new Response(body, {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
const headersOf = (response) => Object.fromEntries(response.headers);
const guestURL = "https://guest.test/apps/orders/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each case runs the real materializer under workerd and reports what a caller
// could observe: status, headers, body, and the failures it was told about.
const cases = {
  async composition() {
    const upstream = [];
    const shell = html(
      `<!doctype html><html><body><svg/><math/>
      <v-frame id="healthy" nonce="hostNonce" src="orders?a=1&amp;b=2#detail"><v-frame src="nested-fallback"><template shadowrootmode="open"></template></v-frame></v-frame>
      <v-frame id="cached" adopt src="old"><template shadowrootmode="open"><v-frame src="hidden"></v-frame></template></v-frame>
      <template><v-frame src="inert"></v-frame></template>
      <v-frame src="https://external.example/off"></v-frame>
      <v-frame src="offline">fallback</v-frame><v-frame src="unavailable"></v-frame>
      <base href="/apps/"></body></html>`,
      { headers: { etag: "stale", "content-language": "fr" } },
    );
    const composed = await composeFrames(shell, {
      request: new Request("https://host.test/page", {
        headers: { Cookie: "session=a" },
      }),
      async fetchGuest(request) {
        const url = new URL(request.url);
        upstream.push([
          url.pathname + url.search,
          request.headers.get("Accept"),
          request.headers.get("Cookie"),
          request.redirect,
        ]);
        if (url.pathname === "/apps/offline")
          return html("private diagnostic", { status: 503 });
        if (url.pathname === "/apps/unavailable") throw new Error("offline");
        if (url.pathname === "/apps/orders")
          return html(
            '<html><head><link rel="stylesheet" href="theme.css?x=1&amp;y=2"></head><body><svg/><p id="detail">Orders</p></body></html>',
          );
        if (url.pathname === "/apps/theme.css")
          return new Response(
            "@font-face{font-family:Example;src:url(font.woff)}p{color:green}",
          );
        throw new Error("unexpected mount");
      },
    });
    const markup = await composed.text();
    return { upstream, markup, headers: headersOf(composed) };
  },
  async cancelComposition() {
    let stop;
    const stopped = new Promise((resolve) => {
      stop = resolve;
    });
    const started = [];
    const composed = await composeFrames(
      html('<v-frame src="/a"></v-frame><v-frame src="/b"></v-frame>'),
      {
        request: new Request("https://host.test/"),
        fetchGuest(request) {
          started.push(new URL(request.url).pathname);
          return new Promise((_, reject) =>
            request.signal.addEventListener(
              "abort",
              () => {
                stop();
                reject(request.signal.reason);
              },
              { once: true },
            ),
          );
        },
      },
    );
    await composed.body.cancel("consumer disconnected");
    await stopped;
    return started;
  },
  async gate() {
    const body = "<html><body><script>1</script></body></html>";
    const variants = {
      ok: html(body),
      "ok-uppercase": html(body, { headers: { "content-type": "TEXT/HTML" } }),
      partial: html(body, { status: 206 }),
      missing: html(body, { status: 404 }),
      json: new Response(body, { headers: { "content-type": "application/json" } }),
      plain: new Response(body),
      noContent: new Response(null, { status: 204 }),
      notModified: new Response(null, { status: 304 }),
      redirect: Response.redirect("https://guest.test/elsewhere", 302),
    };
    const result = {};
    for (const [name, response] of Object.entries(variants)) {
      let rejected = false;
      try {
        await (
          await materializeVFrameDocument(response.clone(), guestURL, {
            requireDocument: true,
          })
        ).text();
      } catch (error) {
        if (!(error instanceof TypeError) || !error.message.includes("200 text/html"))
          throw error;
        rejected = true;
      }
      const materialized = await materializeVFrameDocument(response, guestURL);
      result[name] = {
        rejected,
        composable: isVFrameDocumentResponse(response),
        same: materialized === response,
        status: materialized.status,
        body: await materialized.text(),
      };
    }
    return result;
  },
  async headers() {
    const response = await materializeVFrameDocument(
      html("<html><body>x</body></html>", {
        headers: {
          etag: '"v1"',
          "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
          "accept-ranges": "bytes",
          "content-md5": "abc",
          digest: "sha-256=abc",
          "content-digest": "sha-256=:abc=:",
          "cache-control": "max-age=60",
          "x-guest": "kept",
          "content-type": "text/html; charset=latin1",
        },
      }),
      guestURL,
    );
    return { headers: headersOf(response), body: await response.text() };
  },
  async base() {
    // No <html> or <head> tag: the parser implies both around the base.
    const response = await materializeVFrameDocument(
      html(
        '<base href="../public/"><img id="a" src="tile.svg"><template><base href="/in-template/"></template>',
      ),
      guestURL,
    );
    return { body: await response.text() };
  },
  async lateBase() {
    const response = await materializeVFrameDocument(
      html(
        '<body><img src="tile.svg"><base href="/first/"><base href="/second/"></body>',
      ),
      guestURL,
    );
    return { body: await response.text() };
  },
  async inlineFailure() {
    const failures = [];
    const response = await materializeVFrameDocument(
      html(
        "<html><head><style>@font-face{font-family:X;src:url(x.woff)}body{background:url(a.png)}</style></head><body>after</body></html>",
      ),
      guestURL,
      {
        onFontFace() {
          throw new Error("font sink failed");
        },
        onImportFailure: (failure) =>
          failures.push({ url: failure.url, message: failure.error.message }),
      },
    );
    return { body: await response.text(), failures };
  },
  async linkFailure() {
    const failures = [];
    const response = await materializeVFrameDocument(
      html(
        '<html><head><link rel="stylesheet" href="missing.css"></head><body>after</body></html>',
      ),
      guestURL,
      {
        async fetchText() {
          throw new Error("stylesheet unavailable");
        },
        onImportFailure: (failure) =>
          failures.push({ url: failure.url, message: failure.error.message }),
      },
    );
    return { body: await response.text(), failures };
  },
  async encodings() {
    const latin1 = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));
    const utf16 = (text, littleEndian) => {
      const view = new DataView(new ArrayBuffer(2 + text.length * 2));
      view.setUint16(0, 0xfeff, littleEndian);
      for (let i = 0; i < text.length; i++)
        view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
      return new Uint8Array(view.buffer);
    };
    const page = (head) => `<html><head>${head}</head><body>caf\xe9 €</body></html>`;
    const variants = {
      header: [latin1(page("")).map((byte) => byte), "text/html; charset=iso-8859-1"],
      headerWindows: [
        latin1(page("").replace("€", "\x80")),
        "text/html; charset=windows-1252",
      ],
      metaCharset: [
        latin1(page('<meta charset="iso-8859-1">').replace("€", "?")),
        "text/html",
      ],
      metaHttpEquiv: [
        latin1(
          page(
            '<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">',
          ).replace("€", "?"),
        ),
        "text/html",
      ],
      headerBeatsMeta: [
        new TextEncoder().encode(page('<meta charset="iso-8859-1">')),
        "text/html; charset=utf-8",
      ],
      bomBeatsHeader: [
        Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(page(""))]),
        "text/html; charset=iso-8859-1",
      ],
      utf16le: [utf16(page(""), true), "text/html"],
      utf16be: [utf16(page(""), false), "text/html; charset=iso-8859-1"],
      utf8: [new TextEncoder().encode(page("")), "text/html; charset=utf-8"],
      utf8Bare: [new TextEncoder().encode(page("")), "text/html"],
      metaUtf16IsUtf8: [
        new TextEncoder().encode(page('<meta charset="utf-16">')),
        "text/html",
      ],
      unknownLabel: [new TextEncoder().encode(page("")), "text/html; charset=bogus"],
    };
    const result = {};
    for (const [name, [bytes, type]] of Object.entries(variants)) {
      const response = await materializeVFrameDocument(
        new Response(bytes, { headers: { "content-type": type } }),
        guestURL,
      );
      result[name] = {
        type: response.headers.get("content-type"),
        body: new TextDecoder("utf-8").decode(await response.arrayBuffer()),
      };
    }
    return result;
  },
  async cancelQuiet() {
    const failures = [];
    const signals = [];
    const response = await materializeVFrameDocument(
      html(
        '<html><head><link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css"><style>@import "c.css";</style></head><body>x</body></html>',
      ),
      guestURL,
      {
        fetchText(url, { signal } = {}) {
          signals.push({ url, hasSignal: signal instanceof AbortSignal });
          return new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          });
        },
        onImportFailure: (failure) => failures.push(failure.url),
      },
    );
    const reader = response.body.getReader();
    const pending = reader.read().catch(() => {});
    await sleep(50);
    await reader.cancel("client left");
    await sleep(50);
    await pending;
    return { signals, failures };
  },
  async callerCancel() {
    const controller = new AbortController();
    const failures = [];
    const received = [];
    const response = await materializeVFrameDocument(
      html('<html><head><style>@import "theme.css";</style></head><body>x</body></html>'),
      guestURL,
      {
        signal: controller.signal,
        fetchText(url, { signal } = {}) {
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              received.push(url);
              reject(signal.reason);
            });
          });
        },
        onImportFailure: (failure) => failures.push(failure.url),
      },
    );
    const read = response.text();
    controller.abort();
    let readFailed = false;
    try {
      await read;
    } catch {
      readFailed = true;
    }
    return { received, failures, readFailed };
  },
  async integrity() {
    const css = "#test { color: rebeccapurple; }";
    const bytes = new TextEncoder().encode(css).buffer;
    const hash = async (algorithm, value) =>
      btoa(
        String.fromCharCode(
          ...new Uint8Array(
            await crypto.subtle.digest(algorithm, new TextEncoder().encode(value)),
          ),
        ),
      );
    const sha256 = `sha256-${await hash("SHA-256", css)}`;
    const sha384 = `sha384-${await hash("SHA-384", css)}`;
    const sha256url = sha256.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const differentSHA384 = `sha384-${await hash("SHA-384", "other")}`;
    const failures = [];
    const input = `<html><head>
      <link rel="stylesheet" href="pinned.css" integrity="${sha256} ${differentSHA384}">
      <link rel="stylesheet" href="pinned.css" integrity="${sha384}">
      <link rel="stylesheet" href="urlsafe.css" integrity="${sha256url}">
      <link rel="stylesheet" href="malformed.css" integrity="${sha384} sha512-!">
      <link rel="stylesheet" href="unknown.css" integrity="future-digest">
      <link rel="stylesheet" href="text-only.css" integrity="${sha384}">
      </head><body><p id="test">Preview</p></body></html>`;
    const response = await materializeVFrameDocument(html(input), guestURL, {
      async fetchText(url) {
        if (url.endsWith("text-only.css") || url.endsWith("unknown.css")) return css;
        return { bytes, url };
      },
      onImportFailure(failure) {
        failures.push(failure.error.message);
      },
    });
    return { body: await response.text(), failures };
  },
  async concurrency() {
    let active = 0;
    let max = 0;
    const urls = [];
    const fetchText = async (url) => {
      urls.push(url);
      active++;
      max = Math.max(max, active);
      await sleep(30);
      active--;
      return url.endsWith("sheet.css")
        ? '@import "x.css"; @import "y.css"; @import "z.css"; @import "x.css";'
        : `/* ${url} */`;
    };
    const run = async (body) => {
      active = 0;
      max = 0;
      urls.length = 0;
      const response = await materializeVFrameDocument(html(body), guestURL, {
        fetchText,
      });
      await response.text();
      return { max, urls: [...urls].sort() };
    };
    return {
      links: await run(
        "<html><head>" +
          [1, 2, 3, 4, 5]
            .map((n) => `<link rel="stylesheet" href="l${n}.css">`)
            .join("") +
          '<link rel="stylesheet" href="l1.css"></head></html>',
      ),
      imports: await run(
        '<html><head><style>@import "a.css"; @import "b.css"; @import "c.css";</style></head></html>',
      ),
      nested: await run(
        '<html><head><link rel="stylesheet" href="sheet.css"></head></html>',
      ),
      lateBase: await run(
        '<html><head><link rel="stylesheet" href="s.css"><base href="/other/"></head></html>',
      ),
    };
  },
  async styleMarkers() {
    const failures = [];
    const response = await materializeVFrameDocument(
      html(
        '<html><head><style data-v-frame-materialized id="forged">@font-face{font-family:Boom;src:url(boom.woff)}</style><style id="good">body{background:url(a.png)}</style><style id="empty"></style><link rel="alternate stylesheet" title="Dark" href="dark.css"><link rel="stylesheet" href="main.css" disabled></head></html>',
      ),
      guestURL,
      {
        fetchText: async (url) => `/* ${url} */body{color:red}`,
        onFontFace(css) {
          if (css.includes("Boom")) throw new Error("font sink failed");
        },
        onImportFailure: (failure) => failures.push(failure.url),
      },
    );
    return { body: await response.text(), failures };
  },
  async noRewriter() {
    const original = globalThis.HTMLRewriter;
    globalThis.HTMLRewriter = undefined;
    try {
      await materializeVFrameDocument(html("<html></html>"), guestURL);
      return { error: null };
    } catch (error) {
      return { error: { name: error.name, message: error.message } };
    } finally {
      globalThis.HTMLRewriter = original;
    }
  },
  async injectedRewriter() {
    const original = globalThis.HTMLRewriter;
    globalThis.HTMLRewriter = undefined;
    let constructed = 0;
    try {
      const response = await materializeVFrameDocument(
        html("<html><body>x</body></html>"),
        guestURL,
        {
          HTMLRewriter: class extends original {
            constructor() {
              super();
              constructed++;
            }
          },
        },
      );
      return { constructed, body: await response.text() };
    } finally {
      globalThis.HTMLRewriter = original;
    }
  },
  async cancel() {
    const originalFetch = globalThis.fetch;
    let signal;
    globalThis.fetch = (url, init) => {
      signal = init?.signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    };
    try {
      const response = await materializeVFrameDocument(
        html('<html><head><link rel="stylesheet" href="slow.css"></head></html>'),
        guestURL,
      );
      const reader = response.body.getReader();
      const pending = reader.read().catch(() => {});
      await sleep(50);
      const before = signal?.aborted ?? null;
      await reader.cancel("client left");
      await sleep(20);
      await pending;
      return { requested: signal !== undefined, before, aborted: signal?.aborted };
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  async securityHardening() {
    const templateFetches = [];
    const templateFonts = [];
    const htmlWithThreats = `<!doctype html><html><head>
      <template><style>@font-face{font-family:InertFont;src:url(inert.woff)}@import "inert.css";</style><link rel="stylesheet" href="inert-link.css"></template>
      <link rel="stylesheet" title="A &amp; B" href="titled.css">
    </head><body>
      </template><script id="escaped">1</script>
      <svg><template></svg></template><style id="svg-escaped">p{color:red}</style>
      <script id="forged" type="application/vnd.v-frame" data-v-frame-script>2</script>
      <img id="encoded-src" src="&#x2f;admin?x=1&amp;y=2">
      <v-frame adopt src="/child"><template shadowrootmode="open"><v-html><v-head></v-head><v-body><script id="nested-ok" type="application/vnd.v-frame" data-v-frame-script data-v-frame-type="module">3</script><script id="nested-live">4</script></v-body></v-html></template></v-frame>
    </body></html>`;
    const defaultResponse = await materializeVFrameDocument(
      html(htmlWithThreats),
      guestURL,
      {
        async fetchText(url) {
          templateFetches.push(url);
          return "p{color:blue}";
        },
        onFontFace(css) {
          templateFonts.push(css);
        },
      },
    );
    const nestedResponse = await materializeVFrameDocument(
      html(htmlWithThreats),
      guestURL,
      {
        preserveNestedFrames: true,
        async fetchText() {
          return "p{color:blue}";
        },
      },
    );
    return {
      body: await defaultResponse.text(),
      nestedBody: await nestedResponse.text(),
      templateFetches,
      templateFonts,
    };
  },
  async composeHardening() {
    const slotErrors = [];
    let maxInFlight = 0;
    let inFlight = 0;
    const shell = html(`<!doctype html><html><body>
      <v-frame id="one" nonce="n1" src="/apps/one"></v-frame>
      <v-frame id="two" nonce="n1" src="/apps/two"></v-frame>
      <v-frame id="slow" src="/apps/slow"></v-frame>
      <v-frame id="huge" src="/apps/huge"></v-frame>
      <v-frame id="overflow" src="/apps/overflow"></v-frame>
    </body></html>`);
    const composed = await composeFrames(shell, {
      request: new Request("https://host.test/"),
      timeoutMs: 80,
      maxSlots: 4,
      maxConcurrency: 2,
      maxDocumentBytes: 512,
      onSlotError(failure) {
        slotErrors.push({
          src: failure.src,
          name: failure.error?.name ?? String(failure.error),
        });
      },
      async fetchGuest(request) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const path = new URL(request.url).pathname;
          if (path === "/apps/one") {
            await sleep(10);
            return html(
              '<html><head><link rel="stylesheet" href="/apps/shared.css"></head><body></template><p>One</p></body></html>',
            );
          }
          if (path === "/apps/two") {
            await sleep(10);
            return html(
              '<html><head><link rel="stylesheet" href="/apps/shared.css"><style id="too-big">' +
                "a".repeat(200) +
                "</style></head><body><p>Two</p></body></html>",
            );
          }
          if (path === "/apps/shared.css") {
            return new Response(
              "@font-face{font-family:Shared;src:url(/apps/f.woff2)}p{color:green}",
              { headers: { "content-type": "text/css" } },
            );
          }
          if (path === "/apps/slow") {
            return await new Promise((_, reject) =>
              request.signal.addEventListener("abort", () =>
                reject(request.signal.reason),
              ),
            );
          }
          if (path === "/apps/huge") {
            return html("<html><body>" + "x".repeat(1024) + "</body></html>");
          }
          return new Response("Not found", { status: 404 });
        } finally {
          inFlight -= 1;
        }
      },
    });
    return { markup: await composed.text(), slotErrors, maxInFlight };
  },
  async securityAuditHardening() {
    // M1 (--!>), M4 (iframe/object/embed preview deferral), Hardening #3 (data-v-frame-* prefix & credentialed nested v-frame)
    const guestDoc = `<!doctype html><html><body>
      <!-- bang comment --!></template><script id="after-bang">1</script>
      <div id="forged-prefix" data-v-frame-custom="evil" data-keep="ok"></div>
      <iframe id="guest-iframe" src="https://guest.test/embed" srcdoc="<p>hi</p>"></iframe>
      <object id="guest-obj" data="/plugin.swf"></object>
      <embed id="guest-embed" src="/media.bin">
      <v-frame id="cred-nested" adopt src="https://user:pass@guest.test/child"><template shadowrootmode="open"><v-html><v-head></v-head><v-body><script id="cred-script" type="application/vnd.v-frame" data-v-frame-script>2</script></v-body></v-html></template></v-frame>
    </body></html>`;
    const materialized = await (
      await materializeVFrameDocument(html(guestDoc), guestURL, {
        preserveNestedFrames: true,
      })
    ).text();

    // L1 (preserve adopt="interaction" / adopt="visible"), M7 (non-cooperative upstream timeout),
    // Hardening #2 (font CSS byte cap), Hardening #3 (allowNestedComposition predicate)
    const slotErrors = [];
    const shell = html(`<!doctype html><html><body>
      <v-frame id="deferred" adopt="interaction" src="/apps/fast"></v-frame>
      <v-frame id="visible" adopt="visible" src="/apps/nested-host"></v-frame>
      <v-frame id="eager" src="/apps/nested-denied"></v-frame>
      <v-frame id="hang-fetch" src="/apps/hang-fetch"></v-frame>
      <v-frame id="hang-body" src="/apps/hang-body"></v-frame>
    </body></html>`);
    const startedAt = Date.now();
    const composed = await composeFrames(shell, {
      request: new Request("https://host.test/"),
      timeoutMs: 60,
      maxStylesheetBytes: 120,
      allowNestedComposition: ({ url }) => url.pathname === "/apps/nested-host",
      onSlotError(failure) {
        slotErrors.push({
          src: failure.src,
          name: failure.error?.name ?? String(failure.error),
        });
      },
      async fetchGuest(request) {
        const path = new URL(request.url).pathname;
        if (path === "/apps/fast") {
          return html(
            "<html><head><style>@font-face{font-family:F1;src:url(/f1.woff2)}</style></head><body><p>Fast</p></body></html>",
          );
        }
        if (path === "/apps/nested-host") {
          return html(
            '<html><head><style>@font-face{font-family:F2;src:url(/very-long-font-name-that-exceeds-budget-12345678901234567890.woff2)}</style></head><body><v-frame adopt src="/apps/child"><template shadowrootmode="open"><v-html><v-head></v-head><v-body><script id="allowed-nested" type="application/vnd.v-frame" data-v-frame-script>3</script></v-body></v-html></template></v-frame></body></html>',
          );
        }
        if (path === "/apps/nested-denied") {
          return html(
            '<html><body><v-frame adopt src="/apps/child"><template shadowrootmode="open"><v-html><v-head></v-head><v-body><script id="denied-nested" type="application/vnd.v-frame" data-v-frame-script>4</script></v-body></v-html></template></v-frame></body></html>',
          );
        }
        if (path === "/apps/hang-fetch") {
          // Intentionally ignores request.signal!
          return await new Promise(() => {});
        }
        if (path === "/apps/hang-body") {
          // Intentionally returns a stream that ignores signal and never closes!
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("<html><body>partial"));
              },
            }),
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const markup = await composed.text();
    const elapsedMs = Date.now() - startedAt;
    return { materialized, markup, slotErrors, elapsedMs };
  },
};

// A host page that embeds the materialized output the way a server would, for
// the browser tests in ssr-styles.spec.ts.
async function hostPage(url) {
  const guestPage = new URL("/apps/orders/", url).href;
  const guest = `<!doctype html><html><head><title>Guest</title>
    <style id="good">.good{background:url(good.png)}</style>
    <style id="failed">@font-face{font-family:Boom;src:url(boom.woff)}.failed{background:url(failed.png)}</style>
    <link id="alternate" rel="alternate stylesheet" title="Dark" href="dark.css">
    </head><body><p id="alt" class="alt">alt</p></body></html>`;
  const materialized = await (
    await materializeVFrameDocument(
      new Response(guest, { headers: { "content-type": "text/html" } }),
      guestPage,
      {
        fetchText: async () => ".alt{color:rgb(1,2,3)}",
        onFontFace(css) {
          if (css.includes("Boom")) throw new Error("font sink failed");
        },
      },
    )
  ).text();
  return new Response(
    `<!doctype html><html><head><title>Host</title></head><body><v-frame id="frame" adopt src="${guestPage}"><template shadowrootmode="open" shadowrootserializable>${materialized}</template></v-frame></body></html>`,
    { headers: { "content-type": "text/html" } },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/host") return hostPage(url);
    if (url.pathname === "/dist/index.js")
      return new Response(env.BUNDLE, { headers: { "content-type": "text/javascript" } });
    const name = url.searchParams.get("case");
    const run = cases[name];
    if (!run) return new Response("unknown case", { status: 404 });
    return Response.json(await run());
  },
};
