import vFrameInlineScript from "../generated/v-frame-inline.txt";

const embeddedVFrameScript = vFrameInlineScript.replace(/<\/script/gi, "<\\/script");
const reactRoutes = new Set(["/activity", "/history"]);
const qwikRoutes = new Set(["/inventory", "/catalog"]);

function requestedRoute(
  url: URL,
  frameId: "react-router" | "qwik",
  fallback: string,
): string {
  const route = url.searchParams.get(frameId);
  const allowedRoutes = frameId === "react-router" ? reactRoutes : qwikRoutes;
  return route !== null && allowedRoutes.has(route) ? route : fallback;
}

function shell(reactRoute: string, qwikRoute: string): string {
  const initialRoutes = JSON.stringify({
    "react-router": reactRoute,
    qwik: qwikRoute,
  }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Server-composed v-frame widgets</title>
    <style>
      :root { color: #101828; background: #f2f4f7; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; }
      .shell { width: min(1120px, calc(100% - 2rem)); margin: 0 auto; padding: 2.5rem 0 3rem; }
      .shell-header { display: flex; justify-content: space-between; gap: 2rem; align-items: end; padding-bottom: 2rem; }
      .shell-kicker { color: #175cd3; font-size: 0.78rem; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
      .shell-header h1 { max-width: 760px; margin: 0.4rem 0 0; font-size: clamp(2.1rem, 5vw, 4.2rem); line-height: 0.98; letter-spacing: -0.055em; }
      .shell-runtime { padding: 0.65rem 0.8rem; border: 1px solid #d0d5dd; border-radius: 999px; background: #fff; color: #475467; font: 700 0.75rem ui-monospace, monospace; white-space: nowrap; }
      .widget-grid { display: grid; grid-template-columns: minmax(280px, 0.85fr) minmax(0, 1.4fr); gap: 1rem; align-items: stretch; }
      v-frame { display: block; min-width: 0; min-height: 26rem; }
      .delivery-note { display: flex; align-items: center; gap: 0.7rem; margin-top: 1rem; padding: 0.9rem 1rem; border: 1px solid #d0d5dd; border-radius: 0.8rem; background: #fff; color: #475467; font-size: 0.85rem; }
      .delivery-note::before { width: 0.65rem; height: 0.65rem; border-radius: 50%; background: #12b76a; content: ""; box-shadow: 0 0 0 0.25rem #d1fadf; }
      .host-route { margin: 0.75rem 0 0; color: #475467; font: 700 0.8rem ui-monospace, monospace; }
      @media (max-width: 820px) {
        .shell-header { display: grid; }
        .shell-runtime { width: max-content; }
        .widget-grid { grid-template-columns: 1fr; }
        v-frame { min-height: 22rem; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="shell-header">
        <div>
          <span class="shell-kicker">SSR microfrontends</span>
          <h1>Separate runtimes. One server-composed first paint.</h1>
        </div>
        <span class="shell-runtime">service bindings → DSD → v-frame</span>
      </header>
      <div class="widget-grid">
        <div id="react-router-widget"></div>
        <div id="qwik-widget"></div>
      </div>
      <p class="delivery-note">Both widget bodies and the v-frame runtime arrived in the host HTML. The browser made no activation fetch.</p>
      <p class="host-route">Host route: <output id="host-route" aria-live="polite">react-router ${reactRoute}</output></p>
    </main>
    <script data-v-frame-runtime>${embeddedVFrameScript}</script>
    <script>
      const protocol = "v-frame-routing";
      const version = 1;
      const sessionKey = "v-frame:routing-session";
      const initialRoutes = ${initialRoutes};
      const frameRoutes = { ...initialRoutes };
      const allowedRoutes = {
        "react-router": new Set(["/activity", "/history"]),
        qwik: new Set(["/inventory", "/catalog"]),
      };
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const sessionId = crypto.randomUUID();
      sessionStorage.setItem(sessionKey, sessionId);

      const channel = new BroadcastChannel("v-frame:routing:v1:" + sessionId);
      const seenMessages = new Set();
      const routeOutput = document.querySelector("#host-route");

      const routeFor = (frameId) => {
        const route = new URL(location.href).searchParams.get(frameId);
        return allowedRoutes[frameId]?.has(route) ? route : initialRoutes[frameId];
      };
      const showRoute = (frameId, route) => {
        if (routeOutput !== null) routeOutput.textContent = frameId + " " + route;
      };
      const postRoute = (frameId, route, mode) => {
        channel.postMessage({
          protocol,
          version,
          sessionId,
          messageId: crypto.randomUUID(),
          source: "host",
          target: frameId,
          kind: "route-change",
          route,
          mode,
        });
      };
      const rememberMessage = (messageId) => {
        seenMessages.add(messageId);
        if (seenMessages.size > 100) {
          seenMessages.delete(seenMessages.values().next().value);
        }
      };
      const validBase = (message) => {
        return message !== null &&
          typeof message === "object" &&
          message.protocol === protocol &&
          message.version === version &&
          message.sessionId === sessionId &&
          typeof message.messageId === "string" &&
          uuid.test(message.messageId) &&
          typeof message.source === "string" &&
          Object.hasOwn(allowedRoutes, message.source) &&
          message.target === "host";
      };

      channel.addEventListener("message", (event) => {
        const message = event.data;
        if (event.origin !== location.origin || !validBase(message)) return;
        if (seenMessages.has(message.messageId)) return;
        rememberMessage(message.messageId);

        const route = routeFor(message.source);
        if (message.kind === "hello") {
          postRoute(message.source, route, "replace");
          return;
        }
        if (
          message.kind !== "navigate-request" ||
          !allowedRoutes[message.source].has(message.route) ||
          (message.mode !== "push" && message.mode !== "replace")
        ) return;
        if (message.route === route) {
          postRoute(message.source, route, "replace");
          return;
        }

        frameRoutes[message.source] = message.route;
        const next = new URL(location.href);
        next.searchParams.set(message.source, message.route);
        history[message.mode === "replace" ? "replaceState" : "pushState"](
          null,
          "",
          next.pathname + next.search + next.hash,
        );
        showRoute(message.source, message.route);
        postRoute(message.source, message.route, message.mode);
      });

      addEventListener("popstate", () => {
        for (const frameId of Object.keys(frameRoutes)) {
          const route = routeFor(frameId);
          frameRoutes[frameId] = route;
          postRoute(frameId, route, "traverse");
        }
      });
      addEventListener("pagehide", () => channel.close(), { once: true });

    </script>
  </body>
</html>`;
}

interface WidgetDefinition {
  frameId: string;
  label: string;
  source: string;
}

function serviceRequest(service: string, path: string): Request {
  return new Request(`https://${service}.internal${path}`, {
    headers: { Accept: "text/html" },
  });
}

function widgetContent(
  response: Response,
  definition: WidgetDefinition,
): HTMLRewriterElementContentHandlers {
  return {
    element(element) {
      element.before(
        `<v-frame adopt data-frame-id="${definition.frameId}" src="${definition.source}" aria-label="${definition.label}"><template shadowrootmode="open">`,
        { html: true },
      );
      element.replace(response, { html: true });
      element.after("</template></v-frame>", { html: true });
    },
  };
}

function failedWidget(
  name: string,
  response: Response,
): { name: string; response: Response } | null {
  return response.ok ? null : { name, response };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/widgets/react-router/")) {
      const mountedPath = url.pathname.slice("/widgets/react-router".length);
      const componentPath = reactRoutes.has(mountedPath)
        ? `/document?route=${encodeURIComponent(mountedPath)}&base=/widgets/react-router&frameId=react-router`
        : mountedPath + url.search;
      return env.REACT_ROUTER_WIDGET.fetch(serviceRequest("react-router-widget", componentPath));
    }
    if (url.pathname.startsWith("/widgets/qwik/")) {
      const mountedPath = url.pathname.slice("/widgets/qwik".length);
      const componentPath = qwikRoutes.has(mountedPath)
        ? `/document?route=${encodeURIComponent(mountedPath)}&base=/widgets/qwik/build/`
        : mountedPath + url.search;
      return env.QWIK_WIDGET.fetch(serviceRequest("qwik-widget", componentPath));
    }
    if (url.pathname !== "/") {
      return new Response("page not found", { status: 404 });
    }

    const reactRoute = requestedRoute(url, "react-router", "/activity");
    const qwikRoute = requestedRoute(url, "qwik", "/inventory");
    const [reactRouter, qwik] = await Promise.all([
      env.REACT_ROUTER_WIDGET.fetch(
        serviceRequest(
          "react-router-widget",
          `/preview?route=${encodeURIComponent(reactRoute)}&base=/widgets/react-router&frameId=react-router`,
        ),
      ),
      env.QWIK_WIDGET.fetch(
        serviceRequest(
          "qwik-widget",
          `/preview?route=${encodeURIComponent(qwikRoute)}&base=/widgets/qwik/build/`,
        ),
      ),
    ]);
    const failure = failedWidget("react-router", reactRouter) ?? failedWidget("qwik", qwik);
    if (failure !== null) {
      console.error(JSON.stringify({
        message: "SSR widget composition failed",
        widget: failure.name,
        status: failure.response.status,
      }));
      return new Response(
        `SSR widget ${failure.name} returned status ${failure.response.status}`,
        { status: 502 },
      );
    }

    const shellResponse = new Response(shell(reactRoute, qwikRoute), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
    return new HTMLRewriter()
      .on(
        "#react-router-widget",
        widgetContent(reactRouter, {
          frameId: "react-router",
          label: "React Router release activity widget",
          source: `/widgets/react-router${reactRoute}`,
        }),
      )
      .on(
        "#qwik-widget",
        widgetContent(qwik, {
          frameId: "qwik",
          label: "Qwik workspace inventory widget",
          source: `/widgets/qwik${qwikRoute}`,
        }),
      )
      .transform(shellResponse);
  },
} satisfies ExportedHandler<Env>;
