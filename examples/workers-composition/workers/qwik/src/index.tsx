/** @jsxImportSource @builder.io/qwik */
import { component$ } from "@builder.io/qwik";
import { renderToString } from "@builder.io/qwik/server";

const InventoryWidget = component$(() => (
  <section class="inventory-widget" aria-labelledby="inventory-title">
    <span class="widget-kicker">Qwik SSR Worker</span>
    <div class="inventory-heading">
      <div>
        <h2 id="inventory-title">Workspace inventory</h2>
        <p>Resumable markup rendered independently at the edge.</p>
      </div>
      <strong>3 available</strong>
    </div>
    <div class="inventory-grid">
      <article><strong>Edge Notebook</strong><span>Offline-first field notes</span><b>€24</b></article>
      <article><strong>Transit Pack</strong><span>Compact everyday carry</span><b>€68</b></article>
      <article><strong>Signal Lamp</strong><span>Warm, dimmable workspace light</span><b>€42</b></article>
    </div>
  </section>
));

const widgetStyle = `
  .inventory-widget { height: 100%; padding: 1.4rem; border: 1px solid #d0d5dd; border-radius: 1rem; background: #fff; color: #101828; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .widget-kicker { color: #175cd3; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; }
  .inventory-heading { display: flex; align-items: end; justify-content: space-between; gap: 1rem; margin: 0.45rem 0 1.2rem; }
  .inventory-heading h2 { margin: 0; font-size: 1.55rem; }
  .inventory-heading p { margin: 0.3rem 0 0; color: #667085; }
  .inventory-heading > strong { color: #475467; font-size: 0.85rem; white-space: nowrap; }
  .inventory-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
  .inventory-grid article { padding: 1rem; border: 1px solid #e4e7ec; border-radius: 0.8rem; }
  .inventory-grid article > * { display: block; }
  .inventory-grid span { margin-top: 0.3rem; color: #667085; font-size: 0.82rem; }
  .inventory-grid b { margin-top: 1rem; color: #175cd3; }
  @media (max-width: 620px) { .inventory-grid { grid-template-columns: 1fr; } }
`;

async function renderWidget(): Promise<string> {
  const result = await renderToString(<InventoryWidget />, {
    base: "/",
    containerTagName: "div",
    preloader: false,
    qwikLoader: "never",
    snapshot: false,
  });
  return result.html;
}

function materializedDocument(markup: string): string {
  return `<v-html lang="en"><v-head><style>v-html, v-body { display: block; } v-head { display: none; } ${widgetStyle}</style></v-head><v-body>${markup}</v-body></v-html>`;
}

function networkDocument(markup: string): string {
  return `<!doctype html><html lang="en"><head><style>${widgetStyle}</style></head><body>${markup}</body></html>`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
    }

    const pathname = new URL(request.url).pathname;
    if (pathname !== "/preview" && pathname !== "/document") {
      return new Response("Qwik widget not found", { status: 404 });
    }
    const markup = await renderWidget();
    return new Response(
      pathname === "/preview" ? materializedDocument(markup) : networkDocument(markup),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
} satisfies ExportedHandler;
