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
    const foreignBase = url.searchParams.has("foreign-base");
    const target = url.searchParams.has("target");
    const deepTarget = url.searchParams.get("target") === "deep";
    const previewActions = url.searchParams.has("preview-actions");
    const staleIntegrity = url.searchParams.has("stale-integrity");
    let provenance = "";
    if (url.searchParams.has("provenance")) {
      provenance = `
        <button id="encoded-handler" onclick="this.dataset.result = &quot;Encoded&#32;&amp; &#92;&#x22; &amp;quot;&quot;">Encoded</button>
        <button id="literal-handler" onclick='this.dataset.result = "Literal &amp; numeric &#38;"'>Literal</button>
        <a id="quoted-link" href='next.html?quote="yes"&amp;n=&#34;&amp;entity=&amp;quot;'>Next</a>
        <img id="quoted-image" alt="Quoted URL" src='images/tile.svg?quote="yes"&amp;n=&#x22;&amp;entity=&amp;quot;'>
        <button id="legacy-handler" data-v-frame-preview-attributes='{"onclick":"this.dataset.result = \\"Legacy\\""}'>Legacy</button>
        <img id="legacy-image" alt="Legacy URL" src="images/tile.svg" data-v-frame-attributes='{"src":"images/tile.svg?legacy=1"}'>`;
    }
    const lazy = url.searchParams.has("lazy")
      ? `<img id="lazy" loading="lazy" src="images/lazy.svg" alt="Lazy tile" width="120" height="40" style="display:block;margin-top:${url.searchParams.get("lazy") === "visible" ? "0" : "10000"}px">`
      : "";
    const guest = `<!doctype html><html lang="en"><head><title>Assets</title>
      <link id="sheet" rel="stylesheet" href="css/${css}" media="screen">
      ${staleIntegrity ? '<link id="stale-sheet" rel="v-frame-stylesheet" data-v-frame-rel="stylesheet" href="css/site.css" integrity="sha384-v6TUuizt5gALVcaaErpVPHTv53VKcTna5T9r0+fpnIyGJAcqyfogAHke3t31qGJa"><style data-v-frame-linked data-v-frame-integrity="sha384-old">#result{color:rgb(98,1,2)}</style>' : ""}
      ${foreignBase ? "" : '<base href="../public/">'}
      <style>html,body{margin:0;background:#fff;color:#172c3a}.inline{border:2px solid #172c3a}label{display:block}</style></head><body>
      ${target ? '<template><h1 id="copy">Inert duplicate</h1></template>' : ""}
      <h1 id="copy" class="copy">Relative assets</h1>
      ${foreignBase ? '<svg width="0" height="0"><head><base href="/foreign/" target="_parent"></base></head></svg>' : ""}
      <img id="photo" src="images/tile.svg" srcset="images/tile.svg 1x, images/tile.svg 2x" alt="Teal tile" width="120" height="40">
      <svg xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="40"><image href="images/tile.svg" width="120" height="40"/><defs><rect id="inline-icon" width="24" height="24" fill="#bd501d"/></defs><use id="local-icon" href="#inline-icon" x="4" y="8"/><use id="local-xlink" xlink:href="#inline-icon" x="36" y="8"/></svg>
      <div id="decoration" class="inline" style="width:120px;height:24px;background-image:url(images/tile.svg)"></div>
      <label>Label<input id="field" value="server"></label>
      <button id="interactive">Activate</button><output id="result">Idle</output>
      ${provenance}
      ${
        previewActions
          ? `<a id="preview-link" href="#copy" onclick="this.dataset.clicked='yes'">Jump</a>
        <form id="preview-form" action="/submitted" onsubmit="this.dataset.submitted='yes';return false"><input id="preview-field" name="query" value="initial"><button id="preview-submit" formmethod="get">Submit</button></form>
        <template id="preview-template"><a id="cloned-link" href="#copy" onclick="this.dataset.clicked='yes'">From template</a></template>`
          : ""
      }
      ${deepTarget ? '<div style="height:1000px"></div><h2 id="deep" class="copy">Deep target</h2><div style="height:1500px"></div>' : ""}
      ${lazy}
      <script type="module" src="main.js"></script></body></html>`;
    const publicURL = new URL(
      foreignBase ? "/apps/public/page.html" : "/apps/guest/page.html",
      url,
    );
    if (target) publicURL.hash = deepTarget ? "deep" : "copy";
    const guestSource = target
      ? guest.replace(
          "</style></head>",
          ".copy:ta\\72 get{background:rgb(240,200,100)}</style></head>",
        )
      : guest;
    const materialized = await (
      await materializeVFrameDocument(
        new Response(guestSource, { headers: { "content-type": "text/html" } }),
        publicURL.href,
        {
          async fetchText(href) {
            const resource = new URL(href);
            const response = await fetch(env.ASSET_ORIGIN + resource.pathname);
            if (!response.ok) throw new Error(`Stylesheet returned ${response.status}`);
            const final = new URL(response.url);
            return {
              text: await response.text(),
              url: new URL(final.pathname, url).href,
            };
          },
          onImportFailure(failure) {
            failures.push(failure.url);
          },
          onFontFace(css) {
            fonts.add(css);
          },
        },
      )
    ).text();
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
