import type { IncomingMessage } from "node:http";
import {
  bundleRoute,
  gateRoute,
  htmlDocument as html,
  type HTTPFixture,
  parkRoute,
  registerBundleRoute,
  type Route,
  type RouteResponse,
  startHTTPFixture,
} from "./http-fixture";

/**
 * Hands the dynamic script order fixture to the test: the second script answers
 * immediately, the first one waits until the test releases it.
 */
export interface DynamicScriptOrder {
  /** Resolves once the second script's response has been written in full. */
  secondServed: Promise<void>;
  /** Answers the first-script request, waiting for it to arrive when it has not yet. */
  releaseFirst(): Promise<void>;
}

export interface FixtureServer extends HTTPFixture {
  dynamicScriptOrder: DynamicScriptOrder;
  /**
   * Answers `/assets/async-order.js`. The async script is parked so the test says when it
   * lands relative to the deferred one, rather than a response delay guessing at it.
   */
  releaseAsyncScript(): Promise<void>;
}

export type ContractFixtureServers = HTTPFixture;

const documentRoutes: Record<string, Route> = {
  "/": html('<div id="host"></div>'),
  "/documents/adopted-host.html":
    html(`<v-frame adopt src="/documents/adopted-entry.html">
        <template shadowrootmode="open">
          <v-html lang="en">
            <v-head>
              <style>
                v-html, v-body { display: block; }
                v-head { display: none; }
                #adopted-copy { color: rgb(24, 96, 48); }
              </style>
            </v-head>
            <v-body>
              <p id="adopted-copy">Server-rendered before definition</p>
              <script type="application/vnd.v-frame" data-v-frame-script>
                document.querySelector('#adopted-copy').textContent = 'Activated without an entry fetch';
              </script>
            </v-body>
          </v-html>
        </template>
      </v-frame>`),
  "/documents/nested-adopted-host.html":
    html(`<v-frame id="outer-frame" adopt src="/documents/outer-adopted-entry.html">
        <template shadowrootmode="open" shadowrootserializable>
          <v-html lang="en">
            <v-head></v-head>
            <v-body>
              <v-frame id="inner-frame" adopt src="/documents/inner-adopted-entry.html">
                <template shadowrootmode="open" shadowrootserializable>
                  <v-html lang="en">
                    <v-head></v-head>
                    <v-body>
                      <p id="nested-copy">Server-rendered nested preview</p>
                      <script type="application/vnd.v-frame" data-v-frame-script>
                        document.querySelector('#nested-copy').textContent = 'Nested preview activated';
                      </script>
                    </v-body>
                  </v-html>
                </template>
              </v-frame>
              <script type="application/vnd.v-frame" data-v-frame-script data-v-frame-type="module">
                top.__nestedOuterModuleStarted = true;
                await top.__nestedOuterModuleGate;
              </script>
            </v-body>
          </v-html>
        </template>
      </v-frame>`),
  "/documents/adopted-entry.html": html(
    '<main id="network-reload">Fetched by reload</main>',
  ),
  "/documents/first.html": html(
    '<main id="first">First document <a id="next" href="second.html">next</a></main>',
  ),
  "/documents/second.html": html('<main id="second">Second document</main>'),
  "/first-window-base/first": html(
    '<main id="first-window-document">First window document</main>',
  ),
  "/second-window-base/second": html(
    '<main id="second-window-document">Second window document</main>',
  ),
  "/svg-base/destination.html": html(
    '<main id="svg-destination">SVG destination document</main>',
  ),
  "/documents/scripted.html": html(
    '<main id="before-script">Before script</main><script src="../assets/append-content.js"></script>',
  ),
  "/documents/styled.html": html(
    '<img id="relative-image" src="../assets/pixel.png"><p id="styled-copy">Styled</p>',
    '<link rel="stylesheet" href="../assets/document.css">',
  ),
  "/documents/application.html":
    html(`<button id="load">Load</button><button id="push">Push history</button><output id="result"></output>
        <script>
          document.querySelector('#load').addEventListener('click', async () => {
            document.querySelector('#result').textContent = await (await fetch('../api/message')).text();
          });
          document.querySelector('#push').addEventListener('click', () => history.pushState({}, '', 'history-state'));
        </script>`),
  "/documents/dynamic-insert.html":
    html(`<main id="dynamic-target">Dynamic script fixture</main>
        <script>
          const script = document.createElement('script');
          script.text = "window.__dynamicInsertRealm = window; document.body.insertAdjacentHTML('beforeend', '<output id=\\\"dynamic-insert-result\\\">child realm executed</output>');";
          document.querySelector('#dynamic-target').insertAdjacentElement('afterend', script);
        </script>`),
  "/documents/nested-network.html": html(
    '<v-frame id="nested-network-frame" src="/documents/inner-network.html"></v-frame>',
  ),
  "/documents/inner-network.html": html(
    '<p id="nested-network-copy">Nested network frame loaded</p>',
  ),
  "/documents/inline-module.html": html(`<output id="module-result">pending</output>
        <script type="module">
          await new Promise((resolve) => setTimeout(resolve, 25));
          document.querySelector('#module-result').textContent = 'module settled';
        </script>`),
  "/documents/import-map.html": html(`<output id="import-map-result">pending</output>
        <script type="importmap">
          { "imports": { "fixture-message": "../assets/import-map-message.js" } }
        </script>
        <script type="module">
          import { message } from 'fixture-message';
          document.querySelector('#import-map-result').textContent = message;
        </script>`),
  "/documents/child-custom-elements.html": html(`<div id="dynamic-root"></div>
        <script>
          const label = new URL(location.href).searchParams.get('label');
          class ChildGreeting extends HTMLElement {
            connectedCallback() {
              this.textContent = label;
            }
          }
          customElements.define('child-greeting', ChildGreeting);
          const dynamic = document.createElement('child-greeting');
          dynamic.id = 'dynamic';
          document.querySelector('#dynamic-root').append(dynamic);
          document.querySelector('#dynamic-root').insertAdjacentHTML(
            'beforeend',
            '<child-greeting id="parsed"></child-greeting>',
          );
          window.__childCustomElementState = {
            dynamic: dynamic instanceof ChildGreeting,
            parsed: document.querySelector('#parsed') instanceof ChildGreeting,
            ownerDocument: dynamic.ownerDocument === document,
          };
        </script>`),
  "/documents/script-order.html": html(`<script id="classic-inline">
          window.__scriptEvents = [];
          window.__scriptEvents.push('classic-inline:' + document.currentScript?.id + ':' + document.readyState);
          window.addEventListener('load', () => window.__scriptEvents.push('load:' + document.readyState));
        </script>
        <script id="classic-external" src="../assets/classic-order.js"></script>
        <script id="deferred-external" defer src="../assets/defer-order.js"></script>
        <script id="async-external" async src="../assets/async-order.js"></script>`),
  "/documents/dynamic-external-order.html": html(`<script>
          window.__dynamicExternalEvents = [];
          const first = document.createElement('script');
          first.async = false;
          first.src = '../assets/dynamic-first.js';
          document.body.append(first);
          const second = document.createElement('script');
          second.async = false;
          second.src = '../assets/dynamic-second.js';
          document.body.append(second);
        </script>`),
  "/documents/import-and-root.html": html(
    `<p id="root-colour">Root specificity</p><p id="imported-colour" class="imported">Imported supports</p>`,
    `<style>
          @import url('../assets/imported-supports.css') supports(display: grid);
          :root { color: rgb(8, 9, 10); }
          html { color: rgb(50, 51, 52); }
        </style>`,
  ),
  "/documents/request-abort.html": html(`<output id="request-result">pending</output>
        <script>
          (async () => {
            const controller = new AbortController();
            const original = new Request('../api/slow', {
              credentials: 'include',
              signal: controller.signal,
            });
            const clone = new Request(original);
            const pending = fetch(clone).then(
              () => 'resolved',
              (error) => error.name,
            );
            controller.abort();
            document.querySelector('#request-result').textContent = [
              original.signal.aborted,
              clone.signal.aborted,
              original.credentials,
              clone.credentials,
              await pending,
            ].join(':');
          })();
        </script>`),
  "/documents/base-after-push.html": html(`<script>
          history.pushState({}, '', 'nested/state.html');
          const image = document.createElement('img');
          image.src = 'asset.png';
          image.id = 'created-image';
          document.body.append(image);
          window.__baseAfterPush = { baseURI: document.baseURI, src: image.src };
        </script>`),
  "/documents/explicit-base-after-push.html": html(
    `<script>
          history.pushState({}, '', 'nested/state.html');
          const image = document.createElement('img');
          image.src = 'asset.png';
          image.id = 'created-image';
          document.body.append(image);
          window.__explicitBaseAfterPush = { baseURI: document.baseURI, src: image.src };
        </script>`,
    '<base href="/base-root/">',
  ),
  "/documents/dynamic-base-urls.html": `<!doctype html><html><head>
        <base id="invalid-base" href="http://[">
        <base id="initial-base" href="/initial-base/">
        <base id="secondary-base" href="/secondary-base/">
      </head><body>
        <a id="initial-anchor" href="asset.html">Asset</a>
        <img id="initial-image" src="asset.png">
        <img id="initial-srcset" srcset="small.png 1x, data:image/png;base64,AAAA 2x">
        <form id="initial-form" action="submit"></form>
        <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
          <image id="svg-image" href="image.svg"></image>
          <use id="svg-use" xlink:href="symbols.svg#shape"></use>
          <feImage id="svg-filter-image" href="filter.svg"></feImage>
        </svg>
      </body></html>`,
  "/documents/scroll-events.html":
    html(`<div style="height: 300px">Scrollable fixture</div><script>
          window.__scrollEvents = 0;
          window.addEventListener('scroll', () => window.__scrollEvents += 1);
        </script>`),
  "/documents/nonce.html": html(
    '<p id="nonce-copy">Nonce fixture</p>',
    "<style>#nonce-copy { color: rgb(7, 8, 9); }</style>",
  ),
  "/documents/noscript.html": html(
    '<p id="noscript-copy">Scripted</p><noscript><link rel="stylesheet" href="/assets/noscript-only.css"><p id="noscript-fallback">Fallback</p></noscript>',
    "<noscript><style>#noscript-copy { color: rgb(200, 0, 0); }</style></noscript>",
  ),
  "/documents/direct-location.html": html(
    '<script>location.assign("/documents/second.html");</script>',
  ),
  "/documents/broken.html": { status: 500, type: "text/plain", body: "Fixture failure" },
};

const assetRoutes: Record<string, Route> = {
  "/dist/index.js": bundleRoute,
  "/assets/append-content.js": {
    type: "text/javascript",
    body: `document.body.insertAdjacentHTML('beforeend', '<p id="script-added">Script executed</p>');`,
  },
  "/assets/classic-order.js": {
    type: "text/javascript",
    body: "window.__scriptEvents.push('classic-external:' + document.currentScript?.id + ':' + document.readyState);",
  },
  "/assets/defer-order.js": {
    type: "text/javascript",
    body: "window.__scriptEvents.push('defer-external:' + document.currentScript?.id + ':' + document.readyState);",
  },
  "/assets/import-map-message.js": {
    type: "text/javascript",
    body: "export const message = 'resolved through import map';",
  },
  "/assets/imported-supports.css": {
    type: "text/css",
    body: ".imported { color: rgb(13, 14, 15); }",
  },
  "/assets/document.css": {
    type: "text/css",
    body: "#styled-copy { background-image: url('./pixel.png'); color: rgb(12, 34, 56); }",
  },
  "/assets/pixel.png": {
    type: "image/png",
    body: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9sAAAAABJRU5ErkJggg==",
      "base64",
    ),
  },
  "/api/message": { type: "text/plain", body: "Fetched from fixture" },
  "/api/slow": { type: "text/plain", body: "Too slow", delay: 100 },
};

const dynamicFirstScript: RouteResponse = {
  type: "text/javascript",
  body: "window.__dynamicExternalEvents.push('first');",
};

const dynamicSecondScript: RouteResponse = {
  type: "text/javascript",
  body: "window.__dynamicExternalEvents.push('second');",
};

const asyncOrderScript: RouteResponse = {
  type: "text/javascript",
  body: "window.__scriptEvents.push('async-external:' + document.currentScript?.id + ':' + document.readyState);",
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const dynamicFirst = parkRoute(dynamicFirstScript);
  const dynamicSecond = gateRoute(dynamicSecondScript);
  const asyncOrder = parkRoute(asyncOrderScript);
  const server = await startHTTPFixture({
    routes: {
      ...documentRoutes,
      ...assetRoutes,
      "/assets/async-order.js": asyncOrder.route,
      "/assets/dynamic-first.js": dynamicFirst.route,
      "/assets/dynamic-second.js": dynamicSecond.route,
    },
  });

  const releaseFirst = async () => {
    await dynamicFirst.release();
    dynamicSecond.rearm();
  };

  return {
    ...server,
    dynamicScriptOrder: {
      get secondServed() {
        return dynamicSecond.served;
      },
      releaseFirst,
    },
    releaseAsyncScript: asyncOrder.release,
    // A parked request keeps its socket open, which would otherwise stall the close of a
    // server whose test failed before releasing it.
    close: async () => {
      dynamicFirst.abandon();
      asyncOrder.abandon();
      await server.close();
    },
  };
}

/** The shell only serves the host page to a top-level document request. */
function boundShell(request: IncomingMessage): RouteResponse {
  if (request.headers["sec-fetch-dest"] === "document") {
    return { body: html('<div id="host"></div>') };
  }
  return {
    body: html(`<output id="bound-result">bound</output>
        <script>
          window.__boundPopStates = [];
          window.addEventListener('popstate', (event) => window.__boundPopStates.push(event.state));
        </script>`),
  };
}

const contractRoutes: Record<string, Route> = {
  "/": html(
    '<div id="host"></div><p id="host-isolated">Host CSS</p>',
    "<style>#host-isolated { color: rgb(91, 92, 93); }</style>",
  ),
  "/dist/index.js": bundleRoute,
  "/dist/register.js": registerBundleRoute,
  "/documents/bound-shell.html": boundShell,
  "/documents/reconnect.html": html('<main id="reconnect-copy">Reconnect fixture</main>'),
  "/documents/slow.html": {
    body: html('<main id="slow-copy">Slow document</main>'),
    delay: 500,
  },
  "/documents/fast.html": html('<main id="fast-copy">Fast document</main>'),
  "/documents/redirect.html": {
    status: 302,
    headers: { location: "/documents/redirected.html" },
  },
  "/documents/redirected.html": html(
    '<main id="redirect-copy">Redirect destination</main>',
  ),
  "/documents/dom.html": html(
    '<main id="dom-root"><input id="focus-target"><button id="click-target">Click</button></main>',
  ),
  "/documents/inline-body-load.html": `<!doctype html><html><head><script>
        window.__documentLifecycle = { bodyLoads: 0, readyStates: [] };
        document.onreadystatechange = function (event) {
          window.__documentLifecycle.readyStates.push({
            state: document.readyState,
            target: event.target === document,
            currentTarget: event.currentTarget === document,
            thisValue: this === document,
          });
        };
      </script></head><body onload="window.__documentLifecycle.bodyLoads += 1"></body></html>`,
  "/documents/property-body-load.html": html(`<script>
        window.__bodyPropertyLoads = { replaced: 0, active: 0 };
        document.body.onload = () => window.__bodyPropertyLoads.replaced += 1;
        document.body.onload = null;
        document.body.onload = () => window.__bodyPropertyLoads.active += 1;
      </script>`),
  "/documents/messaging.html": html(`<output id="message-result">waiting</output>
        <script>
          window.addEventListener('message', (event) => {
            document.querySelector('#message-result').textContent = event.data.kind;
            window.parent.postMessage({ kind: event.data.kind, realm: 'child' }, event.origin);
          });
        </script>`),
  "/documents/scripts.html": html('<main id="script-root">Script fixture</main>'),
  "/documents/styles.html": html(
    '<main><p id="host-isolated">Host CSS must not leak here</p></main>',
  ),
  "/documents/history.html": html(`<main>
        <a id="top-link" href="#">Top</a>
        <a id="blocked-link" href="blocked-link.html">Blocked link</a>
        <a id="new-context-link" href="new-context.html">New context link</a>
        <form id="blocked-form" action="blocked-form.html" method="get"><input name="query" value="fixture"><button>Blocked form</button></form>
        <form id="submitter-form" action="ignored-form.html?ignored=action" method="post" target="_self">
          <input name="query" value="fixture">
          <input id="form-file" name="upload" type="file">
          <button id="override-submit" name="submitter" value="override" formaction="override-form.html?ignored=submitter" formmethod="get" formtarget="_blank">Override form</button>
        </form>
        <div style="height: 600px"></div>
      </main>`),
  "/documents/location.html": html(`<script>
        window.__initialLocationSnapshot = {
          href: location.href,
          origin: location.origin,
          globalOrigin: window.origin,
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
          documentURL: document.URL,
          documentURI: document.documentURI,
          localStorage: localStorage.getItem('vframe_origin_storage'),
          sessionStorage: sessionStorage.getItem('vframe_origin_session'),
          cookie: document.cookie,
        };
        window.__originHistoryAnimationFrameCount = 0;
        requestAnimationFrame(() => window.__originHistoryAnimationFrameCount += 1);
      </script>`),
  "/documents/viewport.html": html(`<div style="height: 800px">Viewport fixture</div>
        <script>
          window.__viewportEvents = { resize: 0, scroll: 0, ticks: 0 };
          window.addEventListener('resize', () => window.__viewportEvents.resize += 1);
          window.addEventListener('scroll', () => window.__viewportEvents.scroll += 1);
          window.setInterval(() => window.__viewportEvents.ticks += 1, 10);
        </script>`),
  "/assets/dynamic-linked.css": {
    type: "text/css",
    body: "#dynamic-linked { color: rgb(31, 32, 33); }",
  },
};

export function startContractFixtureServers(): Promise<ContractFixtureServers> {
  return startHTTPFixture({ routes: contractRoutes });
}
