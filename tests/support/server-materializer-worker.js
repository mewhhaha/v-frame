import { materializeVFrameDocument } from "../../dist/server/index.js";

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
      const materialized = await materializeVFrameDocument(response, guestURL);
      result[name] = {
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
