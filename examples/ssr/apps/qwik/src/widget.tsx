/** @jsxImportSource @builder.io/qwik */
import { component$, useSignal, useVisibleTask$ } from "@builder.io/qwik";

export type WidgetRoute = "/inventory" | "/catalog";
export type WikipediaArticleKey = "brief" | "migration" | "research";

/** Where the host mounts this application; standalone visits have no prefix. */
const widgetBasePath = "/widgets/qwik";

const wikipediaArticles = {
  migration: {
    title: "Blue–green deployment",
    extract:
      "A release strategy that runs two production environments so traffic can move to a new version with a quick rollback path.",
    href: "https://en.wikipedia.org/wiki/Blue%E2%80%93green_deployment",
  },
  research: {
    title: "Thematic analysis",
    extract:
      "A qualitative method for identifying, analyzing, and reporting recurring patterns within a collection of material.",
    href: "https://en.wikipedia.org/wiki/Thematic_analysis",
  },
  brief: {
    title: "Executive summary",
    extract:
      "A short document or section that presents the purpose, major findings, and recommendations of a longer report.",
    href: "https://en.wikipedia.org/wiki/Executive_summary",
  },
} as const;

export function isWidgetRoute(value: string): value is WidgetRoute {
  return value === "/inventory" || value === "/catalog";
}

/** Reads this application's own route out of whichever path it is mounted at. */
export function routeFromPathname(pathname: string): WidgetRoute | null {
  const route = pathname.startsWith(widgetBasePath)
    ? pathname.slice(widgetBasePath.length)
    : pathname;
  return isWidgetRoute(route) ? route : null;
}

export interface WorkspaceWidgetProps {
  articleKey: WikipediaArticleKey;
  initialRoute: WidgetRoute;
  surface: "definition" | "page" | "profile";
}

export const WorkspaceWidget = component$(
  ({ articleKey, initialRoute, surface }: WorkspaceWidgetProps) => {
    const currentRoute = useSignal<WidgetRoute>(initialRoute);
    const draftMessage = useSignal("");
    const messageStatus = useSignal("Relay can make mistakes. Check important details.");

    // An ordinary client-side router. The shell moves this application with
    // `frame.navigate()`, which arrives here as a popstate at the new URL.
    useVisibleTask$(
      ({ cleanup }) => {
        const followLocation = () => {
          const route = routeFromPathname(location.pathname);
          if (route !== null) currentRoute.value = route;
        };

        addEventListener("popstate", followLocation);
        // Resumption is asynchronous, so publish when this router starts listening.
        document.documentElement.dataset.qwikRouterReady = "true";
        cleanup(() => {
          removeEventListener("popstate", followLocation);
          delete document.documentElement.dataset.qwikRouterReady;
        });
      },
      { strategy: "document-ready" },
    );

    if (surface === "definition") {
      const article = wikipediaArticles[articleKey];
      return (
        <article class="wikipedia-preview">
          <span class="widget-kicker">Wikipedia</span>
          <h2>{article.title}</h2>
          <p>{article.extract}</p>
          <a href={article.href} target="_blank" rel="noreferrer">
            Read the article
          </a>
        </article>
      );
    }

    if (surface === "profile") {
      return (
        <section class="profile-widget" aria-label="Account">
          <button type="button" class="profile-trigger" popovertarget="profile-menu">
            <span class="profile-avatar" aria-hidden="true">
              AM
            </span>
            <span class="profile-copy">
              <strong>Avery Morgan</strong>
              <small>Team workspace</small>
            </span>
            <span class="profile-more" aria-hidden="true">
              ···
            </span>
          </button>
          <div id="profile-menu" class="profile-menu" popover="auto">
            <p>Avery Morgan</p>
            <button type="button">Settings</button>
            <button type="button">Keyboard shortcuts</button>
            <button type="button">Sign out</button>
          </div>
        </section>
      );
    }

    if (currentRoute.value === "/catalog") {
      return (
        <main class="usage-widget" aria-labelledby="usage-title">
          <header class="usage-heading">
            <div>
              <h2 id="usage-title">Usage</h2>
              <p class="usage-copy">Workspace activity for the current billing period.</p>
            </div>
            <button type="button">July 2026⌄</button>
          </header>
          <section id="usage-summary" class="usage-overview" aria-label="Usage summary">
            <article>
              <span>Messages</span>
              <strong>1,284</strong>
              <small>32% of plan</small>
            </article>
            <article>
              <span>Context</span>
              <strong>3.8M</strong>
              <small>tokens processed</small>
            </article>
            <article>
              <span>Plugin calls</span>
              <strong>216</strong>
              <small>this month</small>
            </article>
          </section>
          <section class="usage-breakdown" aria-labelledby="usage-breakdown-title">
            <div class="section-heading">
              <h3 id="usage-breakdown-title">Usage by frontend</h3>
              <span>Messages</span>
            </div>
            <table>
              <tbody>
                <tr>
                  <td>
                    <span class="frontend-mark react-mark" />
                    React conversations
                  </td>
                  <td>937</td>
                  <td>73%</td>
                </tr>
                <tr>
                  <td>
                    <span class="frontend-mark qwik-mark" />
                    Qwik composer and widgets
                  </td>
                  <td>347</td>
                  <td>27%</td>
                </tr>
              </tbody>
            </table>
          </section>
        </main>
      );
    }

    return (
      <form
        class="composer-widget"
        onSubmit$={(event: SubmitEvent) => {
          event.preventDefault();
          if (draftMessage.value.trim() === "") return;
          draftMessage.value = "";
          messageStatus.value = "Message sent.";
        }}
      >
        <div class="composer-row">
          <button type="button" class="attach-button" aria-label="Attach files">
            +
          </button>
          <textarea
            name="message"
            aria-label="Message Relay"
            placeholder="Ask anything"
            value={draftMessage.value}
            onInput$={(event: InputEvent) => {
              const messageInput = event.target as { value: string } | null;
              if (messageInput === null) return;
              draftMessage.value = messageInput.value;
              messageStatus.value = "Relay can make mistakes. Check important details.";
            }}
          />
          <button type="submit" class="send-button" aria-label="Send message">
            ↑
          </button>
        </div>
        <p aria-live="polite">{messageStatus.value}</p>
      </form>
    );
  },
);

export const widgetStyle = `
  :root { color-scheme: only dark; }
  * { box-sizing: border-box; }
  html, body, body > div { height: 100%; margin: 0; }
  button, textarea { font: inherit; }
  button:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; }
  .widget-kicker { color: #6ee7b7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.04em; }
  .composer-widget { display: grid; min-height: 8rem; padding: 0.85rem; background: #151518; color: #f4f4f5; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .composer-widget textarea { width: 100%; min-height: 3rem; resize: none; border: 0; outline: 0; background: transparent; color: #f4f4f5; font-size: 0.875rem; line-height: 1.5; }
  .composer-widget textarea::placeholder { color: #71717a; }
  .usage-widget { min-height: 100%; padding: 1.25rem; background: #0d0d0f; color: #f4f4f5; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .usage-widget h2 { margin: 0.4rem 0 0; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.025em; }
  .usage-copy { margin: 0.45rem 0 0; color: #a1a1aa; font-size: 0.8125rem; line-height: 1.55; }
  .usage-overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; margin-top: 1.5rem; }
  .usage-overview article { min-width: 0; padding: 1rem; border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 0.7rem; background: #151518; }
  .usage-overview article > span { display: block; color: #a1a1aa; font-size: 0.75rem; }
  .usage-overview strong { display: block; margin-top: 0.7rem; font-size: 1.4rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .usage-overview small { color: #71717a; font-size: 0.6875rem; }
  .wikipedia-preview { min-height: 100%; padding: 0.9rem; background: #151518; color: #f4f4f5; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .wikipedia-preview h2 { margin: 0.4rem 0 0; font-family: Georgia, "Times New Roman", serif; font-size: 1.15rem; font-weight: 600; }
  .wikipedia-preview p { margin: 0.55rem 0 0; color: #d4d4d8; font-size: 0.8125rem; line-height: 1.55; }
  .wikipedia-preview a { display: inline-block; margin-top: 0.75rem; color: #6ee7b7; font-size: 0.75rem; text-decoration: none; }
  .wikipedia-preview a:hover { text-decoration: underline; }
  .profile-widget { min-height: 100%; background: #101012; color: #f4f4f5; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .profile-trigger { display: grid; width: 100%; min-height: 3rem; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.6rem; padding: 0.45rem; border: 0; border-radius: 0.5rem; background: transparent; color: inherit; cursor: pointer; text-align: left; }
  .profile-trigger:hover { background: rgba(255, 255, 255, 0.05); }
  .profile-avatar { display: grid; width: 1.9rem; height: 1.9rem; place-items: center; border-radius: 999px; background: #3f3f46; color: white; font-size: 0.625rem; font-weight: 600; }
  .profile-copy { display: grid; min-width: 0; gap: 0.12rem; }
  .profile-copy strong { overflow: hidden; color: #e4e4e7; font-size: 0.75rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .profile-copy small, .profile-more { color: #71717a; font-size: 0.6875rem; }
  .profile-menu { inset: 0 auto auto 0.8rem; width: 14.4rem; margin: 0; padding: 0.45rem; transform: translateY(calc(-100% - 0.6rem)); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 0.7rem; background: #1b1b1f; color: #f4f4f5; }
  .profile-menu p { margin: 0; padding: 0.55rem 0.6rem; border-bottom: 1px solid rgba(255, 255, 255, 0.09); color: #a1a1aa; font-size: 0.75rem; }
  .profile-menu button { display: block; width: 100%; min-height: 2.25rem; padding: 0.45rem 0.6rem; border: 0; border-radius: 0.45rem; background: transparent; color: #e4e4e7; cursor: pointer; font-size: 0.75rem; text-align: left; }
  .profile-menu button:hover { background: rgba(255, 255, 255, 0.05); }
  @media (max-width: 36rem) {
    .composer-widget textarea, .usage-copy, .usage-overview article > span, .wikipedia-preview p { font-size: 1rem; }
    .usage-overview { grid-template-columns: 1fr; }
    .wikipedia-preview a { font-size: 0.875rem; }
  }
  .composer-widget { display: block; height: 100%; min-height: 0; padding: 0.55rem 0.65rem 0.35rem; background: #212121; color: #f5f5f5; }
  .composer-row { display: flex; min-width: 0; height: 3.55rem; align-items: center; gap: 0.45rem; }
  .composer-widget textarea { min-width: 0; height: 2.75rem; min-height: 0; flex: 1; padding: 0.7rem 0.2rem; color: #f5f5f5; font-size: 0.9375rem; line-height: 1.35; }
  .composer-widget textarea::placeholder { color: #a0a0a0; }
  .composer-widget button { display: grid; width: 2rem; height: 2rem; flex: none; min-height: 2rem; padding: 0; place-items: center; border: 0; border-radius: 999px; cursor: pointer; }
  .attach-button { background: transparent; color: #d4d4d4; font-size: 1.35rem; }
  .attach-button:hover { background: #303030; }
  .send-button { background: #f5f5f5; color: #111; font-size: 1.05rem; }
  .composer-widget > p { overflow: hidden; margin: 0; color: #737373; font-size: 0.625rem; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
  .usage-widget { width: min(100%, 48rem); min-height: 100%; margin: 0 auto; padding: 3rem 1.5rem 4rem; background: #000; color: #f5f5f5; }
  .usage-widget h2 { margin: 0; font-size: 1.75rem; font-weight: 500; letter-spacing: -0.035em; }
  .usage-heading { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; }
  .usage-heading button { min-height: 2.35rem; padding: 0.4rem 0.8rem; border: 1px solid #3a3a3a; border-radius: 999px; background: #212121; color: #b4b4b4; cursor: pointer; font-size: 0.8125rem; }
  .usage-copy { margin: 0.4rem 0 0; color: #a0a0a0; font-size: 0.875rem; }
  .usage-overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin-top: 3rem; border-block: 1px solid #252525; }
  .usage-overview article { min-width: 0; padding: 1.25rem 1.5rem; border: 0; border-left: 1px solid #252525; border-radius: 0; background: transparent; }
  .usage-overview article:first-child { padding-left: 0; border-left: 0; }
  .usage-overview article > span { color: #a0a0a0; }
  .usage-overview strong { color: #f5f5f5; font-size: 1.65rem; font-weight: 500; }
  .usage-overview small { color: #737373; }
  .usage-breakdown { margin-top: 2.5rem; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-bottom: 0.65rem; border-bottom: 1px solid #252525; }
  .section-heading h3 { margin: 0; color: #ececec; font-size: 0.875rem; font-weight: 500; }
  .section-heading span { color: #737373; font-size: 0.75rem; }
  table { width: 100%; border-collapse: collapse; }
  td { height: 3.75rem; border-bottom: 1px solid #1d1d1d; color: #a0a0a0; font-size: 0.8125rem; font-variant-numeric: tabular-nums; }
  td:first-child { display: flex; align-items: center; gap: 0.7rem; color: #ececec; }
  td:not(:first-child) { width: 5rem; text-align: right; }
  .frontend-mark { width: 0.6rem; height: 0.6rem; flex: none; border-radius: 0.15rem; }
  .react-mark { background: #3b82f6; }
  .qwik-mark { background: #8b5cf6; }
  .wikipedia-preview { width: min(100%, 24rem); padding: 1rem; background: #212121; color: #f5f5f5; }
  .wikipedia-preview .widget-kicker { color: #a0a0a0; font-family: inherit; text-transform: uppercase; }
  .wikipedia-preview p { color: #d4d4d4; }
  .wikipedia-preview a { color: #ececec; text-decoration: underline; text-underline-offset: 0.18rem; }
  .profile-widget { background: #0d0d0d; color: #f5f5f5; }
  .profile-trigger { display: flex; height: 3.4rem; min-height: 0; gap: 0.65rem; padding: 0.45rem 0.55rem; }
  .profile-avatar { width: 2rem; height: 2rem; flex: none; background: #7c3aed; font-size: 0.6875rem; }
  .profile-copy { gap: 0.08rem; }
  .profile-copy strong { color: #ececec; font-weight: 500; }
  .profile-copy small, .profile-more { color: #737373; }
  .profile-trigger:hover { background: #212121; }
  .profile-more { margin-left: auto; }
  .profile-menu { inset: 0 auto auto 0.75rem; width: 14rem; transform: translateY(calc(-100% - 0.85rem)); border-color: #3a3a3a; border-radius: 0.65rem; background: #212121; color: #f5f5f5; }
  .profile-menu p { border-bottom-color: #333; color: #a0a0a0; }
  .profile-menu button { min-height: 2rem; color: #ececec; }
  .profile-menu button:hover { background: #303030; }
  @media (max-width: 36rem) {
    .usage-widget { padding: 1.5rem 1rem; }
    .usage-heading { align-items: flex-start; flex-direction: column; }
    .usage-heading button { min-height: 3rem; font-size: 1rem; }
    .usage-overview { grid-template-columns: 1fr; }
    .usage-overview article, .usage-overview article:first-child { padding: 1rem 0; border-left: 0; border-top: 1px solid #252525; }
    .usage-overview article:first-child { border-top: 0; }
  }
`;
