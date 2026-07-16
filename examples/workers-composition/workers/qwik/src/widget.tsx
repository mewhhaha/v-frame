/** @jsxImportSource @builder.io/qwik */
import { $, component$, useSignal } from "@builder.io/qwik";

const routingProtocol = "v-frame-routing";
const routingVersion = 1;

export type WidgetRoute = "/inventory" | "/catalog";

export function isWidgetRoute(value: string): value is WidgetRoute {
  return value === "/inventory" || value === "/catalog";
}

const requestHostNavigation = $((route: WidgetRoute) => {
  const sessionId = sessionStorage.getItem("v-frame:routing-session");
  if (sessionId === null) {
    return;
  }

  const channel = new BroadcastChannel(`v-frame:routing:v1:${sessionId}`);
  channel.postMessage({
    protocol: routingProtocol,
    version: routingVersion,
    sessionId,
    messageId: crypto.randomUUID(),
    source: "qwik",
    target: "host",
    kind: "navigate-request",
    route,
    mode: "push",
  });
  setTimeout(() => channel.close(), 0);
});

export interface WorkspaceWidgetProps {
  initialRoute: WidgetRoute;
}

export const WorkspaceWidget = component$(({ initialRoute }: WorkspaceWidgetProps) => {
  const availableItems = useSignal(3);
  const currentRoute = useSignal<WidgetRoute>(initialRoute);

  if (currentRoute.value === "/catalog") {
    return (
      <section class="inventory-widget" aria-labelledby="catalog-title">
        <span class="widget-kicker">Qwik SSR Worker</span>
        <div class="inventory-heading">
          <div>
            <h2 id="catalog-title">Workspace catalog</h2>
            <p>This route is rendered and resumed by the independent Qwik application.</p>
          </div>
          <strong>3 collections</strong>
        </div>
        <div class="inventory-grid">
          <article><strong>Field work</strong><span>Portable tools for notes and travel</span></article>
          <article><strong>Everyday carry</strong><span>Compact essentials for the commute</span></article>
          <article><strong>Studio light</strong><span>Warm lighting for focused work</span></article>
        </div>
        <div class="inventory-actions">
          <button
            type="button"
            class="inventory-link"
            onClick$={async () => {
              currentRoute.value = "/inventory";
              await requestHostNavigation("/inventory");
            }}
          >
            Back to inventory
          </button>
        </div>
      </section>
    );
  }

  return (
    <section class="inventory-widget" aria-labelledby="inventory-title">
      <span class="widget-kicker">Qwik SSR Worker</span>
      <div class="inventory-heading">
        <div>
          <h2 id="inventory-title">Workspace inventory</h2>
          <p>Resumable markup rendered independently at the edge.</p>
        </div>
        <strong>{availableItems.value} available</strong>
      </div>
      <div class="inventory-grid">
        <article><strong>Edge Notebook</strong><span>Offline-first field notes</span><b>€24</b></article>
        <article><strong>Transit Pack</strong><span>Compact everyday carry</span><b>€68</b></article>
        <article><strong>Signal Lamp</strong><span>Warm, dimmable workspace light</span><b>€42</b></article>
      </div>
      <div class="inventory-actions">
        <button
          type="button"
          onClick$={() => {
            availableItems.value += 1;
          }}
        >
          Restock one item
        </button>
        <button
          type="button"
          class="inventory-link"
          onClick$={async () => {
            currentRoute.value = "/catalog";
            await requestHostNavigation("/catalog");
          }}
        >
          View catalog
        </button>
      </div>
    </section>
  );
});

export const widgetStyle = `
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
  .inventory-actions { display: flex; flex-wrap: wrap; gap: 0.65rem; margin-top: 1.2rem; }
  .inventory-actions button { padding: 0.65rem 0.9rem; border: 0; border-radius: 0.65rem; background: #175cd3; color: #fff; font: inherit; font-weight: 800; cursor: pointer; }
  .inventory-actions .inventory-link { background: #eaf2ff; color: #175cd3; }
  @media (max-width: 620px) { .inventory-grid { grid-template-columns: 1fr; } }
`;
