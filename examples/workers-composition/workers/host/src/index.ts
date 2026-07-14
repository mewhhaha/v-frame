const shell = `<!doctype html>
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
      <p class="delivery-note">Both widget bodies arrived in the host HTML. The browser made no entry-document fetch before activation.</p>
    </main>
    <script type="module">import { defineVFrame } from "/index.js"; defineVFrame();</script>
  </body>
</html>`;

interface WidgetDefinition {
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
        `<v-frame adopt src="${definition.source}" aria-label="${definition.label}"><template shadowrootmode="open">`,
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
    if (url.pathname === "/index.js") {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === "/widgets/react-router") {
      return env.REACT_ROUTER_WIDGET.fetch(serviceRequest("react-router-widget", "/document"));
    }
    if (url.pathname === "/widgets/qwik") {
      return env.QWIK_WIDGET.fetch(serviceRequest("qwik-widget", "/document"));
    }
    if (url.pathname !== "/") {
      return new Response("page not found", { status: 404 });
    }

    const [reactRouter, qwik] = await Promise.all([
      env.REACT_ROUTER_WIDGET.fetch(
        serviceRequest("react-router-widget", "/preview?route=/activity"),
      ),
      env.QWIK_WIDGET.fetch(serviceRequest("qwik-widget", "/preview")),
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

    const shellResponse = new Response(shell, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
    return new HTMLRewriter()
      .on(
        "#react-router-widget",
        widgetContent(reactRouter, {
          label: "React Router release activity widget",
          source: "/widgets/react-router",
        }),
      )
      .on(
        "#qwik-widget",
        widgetContent(qwik, {
          label: "Qwik workspace inventory widget",
          source: "/widgets/qwik",
        }),
      )
      .transform(shellResponse);
  },
} satisfies ExportedHandler<Env>;
