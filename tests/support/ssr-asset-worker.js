import { materializeVFrameDocument } from "../../dist/server/index.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/dist/register.js")
      return new Response(
        'import { defineVFrame } from "/dist/index.js"; defineVFrame();',
        { headers: { "content-type": "text/javascript" } },
      );
    if (url.pathname === "/dist/index.js")
      return new Response(env.BUNDLE, { headers: { "content-type": "text/javascript" } });
    if (url.pathname.startsWith("/apps/")) {
      if (url.pathname.endsWith("main.js"))
        return new Response(
          `
        globalThis.authored={src:document.querySelector('#photo').getAttribute('src'),srcset:document.querySelector('#photo').getAttribute('srcset'),style:document.querySelector('#decoration').getAttribute('style'),rel:document.querySelector('#sheet').rel};
        document.querySelector('#interactive').onclick=()=>document.querySelector('#result').textContent='Clicked';
      `,
          { headers: { "content-type": "text/javascript" } },
        );
      return fetch(env.ASSET_ORIGIN + url.pathname);
    }
    const failures = [];
    const fonts = new Set();
    const css = url.searchParams.has("failure") ? "missing.css" : "site.css";
    const guest = `<!doctype html><html lang="en"><head><title>Assets</title>
      <link id="sheet" rel="stylesheet" href="css/${css}" media="screen">
      <base href="../public/">
      <style>html,body{margin:0;background:#fff;color:#172c3a}.inline{border:2px solid #172c3a}label{display:block}</style></head><body>
      <h1 class="copy">Relative assets</h1>
      <img id="photo" src="images/tile.svg" srcset="images/tile.svg 1x, images/tile.svg 2x" alt="Teal tile" width="120" height="40">
      <svg width="120" height="40"><image href="images/tile.svg" width="120" height="40"/></svg>
      <div id="decoration" class="inline" style="width:120px;height:24px;background-image:url(images/tile.svg)"></div>
      <label>Label<input id="field" value="server"></label>
      <button id="interactive">Activate</button><output id="result">Idle</output>
      <script type="module" src="main.js"></script></body></html>`;
    const publicURL = new URL("/apps/guest/page.html", url).href;
    const materialized = await materializeVFrameDocument(new Response(guest), publicURL, {
      async fetchText(href) {
        const resource = new URL(href);
        const response = await fetch(env.ASSET_ORIGIN + resource.pathname);
        if (!response.ok) throw new Error(`Stylesheet returned ${response.status}`);
        const final = new URL(response.url);
        return { text: await response.text(), url: new URL(final.pathname, url).href };
      },
      onImportFailure(failure) {
        failures.push(failure.url);
      },
      onFontFace(css) {
        fonts.add(css);
      },
    }).text();
    return new Response(
      `<!doctype html><html lang="en"><head><title>Host assets</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${Array.from(fonts).join("\n")}</style></head><body style="margin:0"><main>
      <v-frame id="frame" adopt src="${publicURL}" aria-label="Assets" style="display:block;width:320px;height:360px"><template shadowrootmode="open" shadowrootserializable>${materialized}</template></v-frame>
      </main></body></html>`,
      {
        headers: {
          "content-type": "text/html",
          "x-stylesheet-failures": String(failures.length),
        },
      },
    );
  },
};
