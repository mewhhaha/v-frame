import { renderToString } from "react-dom/server";
import { Route, Routes, StaticRouter, useLocation } from "react-router";

function ActivityWidget() {
  const location = useLocation();

  return (
    <section className="activity-widget" aria-labelledby="activity-title">
      <span className="widget-kicker">React Router SSR Worker</span>
      <h2 id="activity-title">Release activity</h2>
      <p className="widget-copy">Rendered for route <code>{location.pathname}</code>.</p>
      <ol className="activity-list">
        <li><strong>Design tokens</strong><span>Published 12 minutes ago</span></li>
        <li><strong>Checkout shell</strong><span>Promoted to production</span></li>
        <li><strong>Search widget</strong><span>Preview is ready</span></li>
      </ol>
      <button id="activity-refresh" type="button">Acknowledge updates</button>
      <output id="activity-status">3 updates waiting</output>
    </section>
  );
}

function renderWidget(pathname: string): string {
  return renderToString(
    <StaticRouter location={pathname}>
      <Routes>
        <Route path="*" element={<ActivityWidget />} />
      </Routes>
    </StaticRouter>,
  );
}

const widgetStyle = `
  .activity-widget { height: 100%; padding: 1.4rem; border-radius: 1rem; background: #172554; color: #eff6ff; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .widget-kicker { color: #93c5fd; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; }
  .activity-widget h2 { margin: 0.45rem 0 0; font-size: 1.55rem; }
  .widget-copy { margin: 0.35rem 0 1.2rem; color: #bfdbfe; }
  .widget-copy code { color: #fff; }
  .activity-list { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
  .activity-list li { display: flex; justify-content: space-between; gap: 1rem; padding-bottom: 0.7rem; border-bottom: 1px solid #334e83; }
  .activity-list span { color: #bfdbfe; font-size: 0.82rem; text-align: right; }
  #activity-refresh { margin-top: 1.2rem; padding: 0.65rem 0.9rem; border: 0; border-radius: 0.65rem; background: #60a5fa; color: #10204c; font: inherit; font-weight: 800; cursor: pointer; }
  #activity-status { display: block; margin-top: 0.65rem; color: #bfdbfe; font-size: 0.82rem; }
`;

function materializedDocument(markup: string): string {
  return `<v-html lang="en"><v-head><style>v-html, v-body { display: block; } v-head { display: none; } ${widgetStyle}</style></v-head><v-body>${markup}<script type="application/vnd.v-frame" data-v-frame-script>document.querySelector('#activity-refresh').addEventListener('click', () => { document.querySelector('#activity-status').textContent = 'All caught up'; });</script></v-body></v-html>`;
}

function networkDocument(markup: string): string {
  return `<!doctype html><html lang="en"><head><style>${widgetStyle}</style></head><body>${markup}</body></html>`;
}

export default {
  fetch(request: Request): Response {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
    }

    const url = new URL(request.url);
    const markup = renderWidget(url.searchParams.get("route") ?? "/activity");
    if (url.pathname === "/preview") {
      return new Response(materializedDocument(markup), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/document") {
      return new Response(networkDocument(markup), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("React Router widget not found", { status: 404 });
  },
} satisfies ExportedHandler;
