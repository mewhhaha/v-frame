import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { serveRealmMarker } from "./gateway-fixture.js";

export interface FixtureServer {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

const html = (body: string, head = "") => `<!doctype html>
<html><head>${head}</head><body>${body}</body></html>`;

function reply(response: ServerResponse, status: number, type: string, body: string | Buffer) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function pathname(request: IncomingMessage) {
  return new URL(request.url ?? "/", "http://fixture.test").pathname;
}

function pageFor(path: string) {
  switch (path) {
    case "/documents/adopted-host.html":
      return html(`<v-frame adopt src="/documents/adopted-entry.html">
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
      </v-frame>`);
    case "/documents/nested-adopted-host.html":
      return html(`<v-frame id="outer-frame" adopt src="/documents/outer-adopted-entry.html">
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
      </v-frame>`);
    case "/documents/adopted-entry.html":
      return html('<main id="network-reload">Fetched by reload</main>');
    case "/documents/first.html":
      return html('<main id="first">First document <a id="next" href="second.html">next</a></main>');
    case "/documents/second.html":
      return html('<main id="second">Second document</main>');
    case "/first-window-base/first":
      return html('<main id="first-window-document">First window document</main>');
    case "/second-window-base/second":
      return html('<main id="second-window-document">Second window document</main>');
    case "/svg-base/destination.html":
      return html('<main id="svg-destination">SVG destination document</main>');
    case "/documents/scripted.html":
      return html('<main id="before-script">Before script</main><script src="../assets/append-content.js"></script>');
    case "/documents/styled.html":
      return html('<img id="relative-image" src="../assets/pixel.png"><p id="styled-copy">Styled</p>', '<link rel="stylesheet" href="../assets/document.css">');
    case "/documents/application.html":
      return html(`<button id="load">Load</button><button id="push">Push history</button><output id="result"></output>
        <script>
          document.querySelector('#load').addEventListener('click', async () => {
            document.querySelector('#result').textContent = await (await fetch('../api/message')).text();
          });
          document.querySelector('#push').addEventListener('click', () => history.pushState({}, '', 'history-state'));
        </script>`);
    case "/documents/dynamic-insert.html":
      return html(`<main id="dynamic-target">Dynamic script fixture</main>
        <script>
          const script = document.createElement('script');
          script.text = "window.__dynamicInsertRealm = window; document.body.insertAdjacentHTML('beforeend', '<output id=\\\"dynamic-insert-result\\\">child realm executed</output>');";
          document.querySelector('#dynamic-target').insertAdjacentElement('afterend', script);
        </script>`);
    case "/documents/nested-network.html":
      return html('<v-frame id="nested-network-frame" src="/documents/inner-network.html"></v-frame>');
    case "/documents/inner-network.html":
      return html('<p id="nested-network-copy">Nested network frame loaded</p>');
    case "/documents/inline-module.html":
      return html(`<output id="module-result">pending</output>
        <script type="module">
          await new Promise((resolve) => setTimeout(resolve, 25));
          document.querySelector('#module-result').textContent = 'module settled';
        </script>`);
    case "/documents/import-map.html":
      return html(`<output id="import-map-result">pending</output>
        <script type="importmap">
          { "imports": { "fixture-message": "../assets/import-map-message.js" } }
        </script>
        <script type="module">
          import { message } from 'fixture-message';
          document.querySelector('#import-map-result').textContent = message;
        </script>`);
    case "/documents/child-custom-elements.html":
      return html(`<div id="dynamic-root"></div>
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
        </script>`);
    case "/documents/script-order.html":
      return html(`<script id="classic-inline">
          window.__scriptEvents = [];
          window.__scriptEvents.push('classic-inline:' + document.currentScript?.id + ':' + document.readyState);
          window.addEventListener('load', () => window.__scriptEvents.push('load:' + document.readyState));
        </script>
        <script id="classic-external" src="../assets/classic-order.js"></script>
        <script id="deferred-external" defer src="../assets/defer-order.js"></script>
        <script id="async-external" async src="../assets/async-order.js"></script>`);
    case "/documents/dynamic-external-order.html":
      return html(`<script>
          window.__dynamicExternalEvents = [];
          const first = document.createElement('script');
          first.async = false;
          first.src = '../assets/dynamic-first.js';
          document.body.append(first);
          const second = document.createElement('script');
          second.async = false;
          second.src = '../assets/dynamic-second.js';
          document.body.append(second);
        </script>`);
    case "/documents/import-and-root.html":
      return html(`<p id="root-colour">Root specificity</p><p id="imported-colour" class="imported">Imported supports</p>`, `<style>
          @import url('../assets/imported-supports.css') supports(display: grid);
          :root { color: rgb(8, 9, 10); }
          html { color: rgb(50, 51, 52); }
        </style>`);
    case "/documents/request-abort.html":
      return html(`<output id="request-result">pending</output>
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
        </script>`);
    case "/documents/base-after-push.html":
      return html(`<script>
          history.pushState({}, '', 'nested/state.html');
          const image = document.createElement('img');
          image.src = 'asset.png';
          image.id = 'created-image';
          document.body.append(image);
          window.__baseAfterPush = { baseURI: document.baseURI, src: image.src };
        </script>`);
    case "/documents/explicit-base-after-push.html":
      return html(`<script>
          history.pushState({}, '', 'nested/state.html');
          const image = document.createElement('img');
          image.src = 'asset.png';
          image.id = 'created-image';
          document.body.append(image);
          window.__explicitBaseAfterPush = { baseURI: document.baseURI, src: image.src };
        </script>`, '<base href="/base-root/">');
    case "/documents/dynamic-base-urls.html":
      return `<!doctype html><html><head>
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
      </body></html>`;
    case "/documents/scroll-events.html":
      return html(`<div style="height: 300px">Scrollable fixture</div><script>
          window.__scrollEvents = 0;
          window.addEventListener('scroll', () => window.__scrollEvents += 1);
        </script>`);
    case "/documents/nonce.html":
      return html('<p id="nonce-copy">Nonce fixture</p>', '<style>#nonce-copy { color: rgb(7, 8, 9); }</style>');
    case "/documents/noscript.html":
      return html(
        '<p id="noscript-copy">Scripted</p><noscript><link rel="stylesheet" href="/assets/noscript-only.css"><p id="noscript-fallback">Fallback</p></noscript>',
        '<noscript><style>#noscript-copy { color: rgb(200, 0, 0); }</style></noscript>',
      );
    case "/documents/direct-location.html":
      return html('<script>location.assign("/documents/second.html");</script>');
    case "/documents/broken.html":
      return null;
    default:
      return undefined;
  }
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  const distFile = resolve(process.cwd(), "dist/index.js");
  const server = createServer((request, response) => {
    if (serveRealmMarker(request, response)) return;
    const path = pathname(request);
    requests.push(path);

    if (path === "/") return reply(response, 200, "text/html", html('<div id="host"></div>'));
    if (path === "/dist/index.js") {
      if (!existsSync(distFile)) return reply(response, 404, "text/plain", "Build output not found");
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      createReadStream(distFile).pipe(response);
      return;
    }
    if (path === "/assets/append-content.js") {
      return reply(response, 200, "text/javascript", `document.body.insertAdjacentHTML('beforeend', '<p id="script-added">Script executed</p>');`);
    }
    if (path === "/assets/classic-order.js") {
      return reply(response, 200, "text/javascript", "window.__scriptEvents.push('classic-external:' + document.currentScript?.id + ':' + document.readyState);");
    }
    if (path === "/assets/defer-order.js") {
      return reply(response, 200, "text/javascript", "window.__scriptEvents.push('defer-external:' + document.currentScript?.id + ':' + document.readyState);");
    }
    if (path === "/assets/async-order.js") {
      setTimeout(() => reply(response, 200, "text/javascript", "window.__scriptEvents.push('async-external:' + document.currentScript?.id + ':' + document.readyState);"), 50);
      return;
    }
    if (path === "/assets/dynamic-first.js") {
      setTimeout(() => reply(response, 200, "text/javascript", "window.__dynamicExternalEvents.push('first');"), 50);
      return;
    }
    if (path === "/assets/dynamic-second.js") {
      return reply(response, 200, "text/javascript", "window.__dynamicExternalEvents.push('second');");
    }
    if (path === "/assets/import-map-message.js") {
      return reply(response, 200, "text/javascript", "export const message = 'resolved through import map';");
    }
    if (path === "/assets/imported-supports.css") {
      return reply(response, 200, "text/css", ".imported { color: rgb(13, 14, 15); }");
    }
    if (path === "/assets/document.css") {
      return reply(response, 200, "text/css", "#styled-copy { background-image: url('./pixel.png'); color: rgb(12, 34, 56); }");
    }
    if (path === "/assets/pixel.png") {
      return reply(response, 200, "image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9sAAAAABJRU5ErkJggg==", "base64"));
    }
    if (path === "/api/message") return reply(response, 200, "text/plain", "Fetched from fixture");
    if (path === "/api/slow") {
      setTimeout(() => reply(response, 200, "text/plain", "Too slow"), 100);
      return;
    }

    const page = pageFor(path);
    if (page === null) return reply(response, 500, "text/plain", "Fixture failure");
    if (page !== undefined) return reply(response, 200, "text/html", page);
    return reply(response, 404, "text/plain", `No fixture for ${path}`);
  });

  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP address");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed())),
  };
}

export interface ContractFixtureServers {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

function contractHTML(body: string, head = "") {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function contractPathname(request: IncomingMessage) {
  return new URL(request.url ?? "/", "http://contract-fixture.test").pathname;
}

function contractReply(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
) {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  response.end(body);
}

function contractPageFor(path: string) {
  switch (path) {
    case "/documents/reconnect.html":
      return contractHTML('<main id="reconnect-copy">Reconnect fixture</main>');
    case "/documents/slow.html":
      return contractHTML('<main id="slow-copy">Slow document</main>');
    case "/documents/fast.html":
      return contractHTML('<main id="fast-copy">Fast document</main>');
    case "/documents/redirected.html":
      return contractHTML('<main id="redirect-copy">Redirect destination</main>');
    case "/documents/dom.html":
      return contractHTML('<main id="dom-root"><input id="focus-target"><button id="click-target">Click</button></main>');
    case "/documents/inline-body-load.html":
      return `<!doctype html><html><head><script>
        window.__documentLifecycle = { bodyLoads: 0, readyStates: [] };
        document.onreadystatechange = function (event) {
          window.__documentLifecycle.readyStates.push({
            state: document.readyState,
            target: event.target === document,
            currentTarget: event.currentTarget === document,
            thisValue: this === document,
          });
        };
      </script></head><body onload="window.__documentLifecycle.bodyLoads += 1"></body></html>`;
    case "/documents/property-body-load.html":
      return contractHTML(`<script>
        window.__bodyPropertyLoads = { replaced: 0, active: 0 };
        document.body.onload = () => window.__bodyPropertyLoads.replaced += 1;
        document.body.onload = null;
        document.body.onload = () => window.__bodyPropertyLoads.active += 1;
      </script>`);
    case "/documents/messaging.html":
      return contractHTML(`<output id="message-result">waiting</output>
        <script>
          window.addEventListener('message', (event) => {
            document.querySelector('#message-result').textContent = event.data.kind;
            window.parent.postMessage({ kind: event.data.kind, realm: 'child' }, event.origin);
          });
        </script>`);
    case "/documents/scripts.html":
      return contractHTML('<main id="script-root">Script fixture</main>');
    case "/documents/styles.html":
      return contractHTML('<main><p id="host-isolated">Host CSS must not leak here</p></main>');
    case "/documents/history.html":
      return contractHTML(`<main>
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
      </main>`);
    case "/documents/location.html":
      return contractHTML(`<script>
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
      </script>`);
    case "/documents/viewport.html":
      return contractHTML(`<div style="height: 800px">Viewport fixture</div>
        <script>
          window.__viewportEvents = { resize: 0, scroll: 0, ticks: 0 };
          window.addEventListener('resize', () => window.__viewportEvents.resize += 1);
          window.addEventListener('scroll', () => window.__viewportEvents.scroll += 1);
          window.setInterval(() => window.__viewportEvents.ticks += 1, 10);
        </script>`);
    default:
      return undefined;
  }
}

function closeContractServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

export async function startContractFixtureServers(): Promise<ContractFixtureServers> {
  const requests: string[] = [];
  const distFile = resolve(process.cwd(), "dist/index.js");
  const server = createServer((request, response) => {
    if (serveRealmMarker(request, response)) return;
    const path = contractPathname(request);
    requests.push(path);

    if (path === "/") {
      return contractReply(
        response,
        200,
        "text/html",
        contractHTML('<div id="host"></div><p id="host-isolated">Host CSS</p>', '<style>#host-isolated { color: rgb(91, 92, 93); }</style>'),
      );
    }
    if (path === "/documents/bound-shell.html") {
      if (request.headers["sec-fetch-dest"] === "document") {
        return contractReply(
          response,
          200,
          "text/html",
          contractHTML('<div id="host"></div>'),
        );
      }
      return contractReply(response, 200, "text/html", contractHTML(`<output id="bound-result">bound</output>
        <script>
          window.__boundPopStates = [];
          window.addEventListener('popstate', (event) => window.__boundPopStates.push(event.state));
        </script>`));
    }
    if (path === "/dist/index.js") {
      if (!existsSync(distFile)) {
        return contractReply(response, 404, "text/plain", "Build output not found");
      }
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      createReadStream(distFile).pipe(response);
      return;
    }
    if (path === "/documents/slow.html") {
      setTimeout(() => contractReply(response, 200, "text/html", contractPageFor(path) ?? ""), 500);
      return;
    }
    if (path === "/documents/redirect.html") {
      response.writeHead(302, { location: "/documents/redirected.html", "cache-control": "no-store" });
      response.end();
      return;
    }
    if (path === "/assets/dynamic-linked.css") {
      return contractReply(response, 200, "text/css", "#dynamic-linked { color: rgb(31, 32, 33); }");
    }

    const page = contractPageFor(path);
    if (page !== undefined) {
      return contractReply(response, 200, "text/html", page);
    }
    return contractReply(response, 404, "text/plain", `No contract fixture for ${path}`);
  });

  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeContractServer(server);
    throw new Error("Contract fixture server did not expose a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeContractServer(server),
  };
}
