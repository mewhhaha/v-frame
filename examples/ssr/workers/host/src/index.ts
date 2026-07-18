import vFrameInlineScript from "../generated/v-frame-inline.txt";
import {
  routingChannelPrefix,
  routingProtocol,
  routingSessionStorageKey,
  routingVersion,
} from "../../shared/routing";

const embeddedVFrameScript = vFrameInlineScript.replace(/<\/script/gi, "<\\/script");
const reactRoutes = new Set(["/activity", "/research", "/brief", "/plugins"]);
const qwikRoutes = new Set(["/inventory", "/catalog"]);
const hostSections = {
  migration: {
    path: "/",
    kicker: "Thread",
    title: "Platform migration",
    description: "Plan a reversible rollout and keep the implementation decisions in one place.",
  },
  research: {
    path: "/research",
    kicker: "Thread",
    title: "Customer research",
    description: "Turn interview evidence into themes and a focused next decision.",
  },
  brief: {
    path: "/brief",
    kicker: "Thread",
    title: "Weekly brief",
    description: "Shape this week’s progress, risks, and decisions into a concise update.",
  },
  plugins: {
    path: "/plugins",
    kicker: "Workspace",
    title: "Plugins",
    description: "Connect focused capabilities to Relay conversations.",
  },
  usage: {
    path: "/usage",
    kicker: "Workspace",
    title: "Usage",
    description: "Review message volume, context consumption, and plan limits.",
  },
} as const;

type HostSectionKey = keyof typeof hostSections;
type PageFrameId = "react-router" | "qwik";

const hostSectionRoutes = {
  migration: { "react-router": "/activity", qwik: "/inventory" },
  research: { "react-router": "/research", qwik: "/inventory" },
  brief: { "react-router": "/brief", qwik: "/inventory" },
  plugins: { "react-router": "/plugins" },
  usage: { qwik: "/catalog" },
} as const;

function shell(hostSection: HostSectionKey): string {
  const section = hostSections[hostSection];
  const sectionRoutes = hostSectionRoutes[hostSection];
  const frameIds = Object.keys(sectionRoutes) as PageFrameId[];
  const threadSection = hostSection === "migration" || hostSection === "research" || hostSection === "brief";
  const compositionClasses = threadSection
    ? "page-composition"
    : `page-composition widget-grid-single widget-grid-${hostSection}`;
  const workspaceSurfaces = frameIds.map((frameId) => {
    if (frameId === "react-router") {
      const label = hostSection === "plugins"
        ? "React plugins frontend"
        : "React transcript frontend";
      return `<div id="react-surface" class="widget-surface widget-react" data-composition-label="${label}"><div id="react-router-widget"></div></div>`;
    }
    const label = hostSection === "usage"
      ? "Qwik usage frontend"
      : "Qwik composer frontend";
    return `<div id="qwik-surface" class="widget-surface widget-qwik" data-composition-label="${label}"><div id="qwik-widget"></div></div>`;
  }).join("");
  const hostSectionDefinitions = JSON.stringify(hostSections).replaceAll("<", "\\u003c");
  const hostSectionRouteDefinitions = JSON.stringify(hostSectionRoutes).replaceAll("<", "\\u003c");
  const initialRoutes = JSON.stringify(sectionRoutes).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en" class="scheme-only-dark">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${section.title} · Relay</title>
    <style>
      :root { color-scheme: only dark; --canvas: #000; --surface: #212121; --surface-raised: #2a2a2a; --text: #f5f5f5; --muted: #b4b4b4; --subtle: #858585; --line: rgba(255, 255, 255, 0.1); --composition-host: #f59e0b; --composition-react: #3b82f6; --composition-qwik: #8b5cf6; color: var(--text); background: var(--canvas); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { min-width: 20rem; min-height: 100dvh; margin: 0; background: var(--canvas); -webkit-font-smoothing: antialiased; }
      a:focus-visible, button:focus-visible, summary:focus-visible, h1:focus-visible { outline: 2px solid white; outline-offset: 2px; }
      .app-shell { display: flex; min-height: 100dvh; isolation: isolate; }
      .host-sidebar { position: fixed; inset: 0 auto 0 0; z-index: 10; display: flex; width: 16rem; height: 100dvh; min-width: 0; flex-direction: column; padding: 0.65rem 0.45rem 0.45rem; background: #0d0d0d; color: var(--text); transition: transform 180ms ease; }
      html[data-sidebar-closed] .host-sidebar { transform: translateX(-100%); }
      .brand-row { display: flex; min-width: 0; align-items: center; justify-content: space-between; padding: 0 0.35rem 0.65rem; }
      .brand { color: inherit; font-size: 0.9375rem; font-weight: 600; text-decoration: none; }
      .brand-product { color: var(--muted); font-weight: 400; }
      .sidebar-icon-button { display: grid; width: 2rem; min-width: 2rem; height: 2rem; padding: 0; place-items: center; border: 0; border-radius: 0.45rem; background: transparent; color: var(--muted); cursor: pointer; }
      .sidebar-icon-button svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.75; }
      .sidebar-icon-button:hover { background: var(--surface); color: var(--text); }
      .new-thread { display: flex; width: 100%; min-height: 2.25rem; align-items: center; gap: 0.65rem; padding: 0.45rem 0.65rem; border: 0; border-radius: 0.5rem; background: #1f1f1f; color: var(--text); font-size: 0.8125rem; text-decoration: none; }
      .new-thread:hover { background: var(--surface-raised); }
      .host-navigation { min-height: 0; overflow: auto; margin-top: 0.45rem; }
      .navigation-group + .navigation-group { margin-top: 1.3rem; }
      .navigation-label { margin: 0 0 0.35rem; padding: 0 0.65rem; color: var(--muted); font-size: 0.75rem; font-weight: 500; }
      .host-navigation ul { display: grid; gap: 0.08rem; margin: 0; padding: 0; list-style: none; }
      .host-link { display: flex; min-width: 0; min-height: 2.25rem; align-items: center; gap: 0.65rem; padding: 0.45rem 0.65rem; border-radius: 0.5rem; color: var(--text); font-size: 0.8125rem; font-weight: 400; text-decoration: none; }
      .host-link:hover { background: rgba(255, 255, 255, 0.045); color: var(--text); }
      .host-link-active { background: var(--surface); color: var(--text); }
      .host-link-mark { display: grid; width: 1.15rem; height: 1.15rem; flex: none; place-items: center; color: var(--subtle); font-size: 0.6875rem; }
      .host-link-active .host-link-mark { color: white; }
      .host-link-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .host-link-owner { flex: none; color: #6f6f6f; font-size: 0.6rem; letter-spacing: 0.01em; }
      .host-link-active .host-link-owner { color: #a0a0a0; }
      .account-menu { position: relative; min-width: 0; margin-top: auto; padding-top: 0.35rem; border-top: 1px solid var(--line); }
      .account-menu v-frame { display: block; width: 100%; height: 3.4rem; overflow: visible; }
      .host-content { width: calc(100% - 16rem); min-width: 0; margin-left: 16rem; transition: width 180ms ease, margin-left 180ms ease; }
      html[data-sidebar-closed] .host-content { width: 100%; margin-left: 0; }
      .mobile-header { display: none; }
      .mobile-navigation-title, .mobile-menu-close { display: none; }
      .shell { min-width: 0; }
      .shell-header { display: flex; min-width: 0; min-height: 3.25rem; align-items: center; justify-content: space-between; gap: 1.5rem; padding: 0.5rem 0.75rem; }
      .shell-heading { display: flex; min-width: 0; align-items: center; gap: 0.9rem; }
      .shell-heading > div { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
      .sidebar-toggle, .composition-toggle { min-height: 2.125rem; flex: none; padding: 0.4rem 0.65rem; border: 0; border-radius: 0.5rem; background: transparent; color: var(--muted); cursor: pointer; font: 500 0.75rem Inter, ui-sans-serif, system-ui, sans-serif; }
      .sidebar-toggle:hover, .composition-toggle:hover { background: var(--surface); color: var(--text); }
      .shell-kicker { margin: 0 0 0.15rem; color: var(--subtle); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.625rem; font-weight: 600; letter-spacing: 0.04em; }
      .shell-header h1 { overflow: hidden; margin: 0; color: var(--text); font-size: 0.9375rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .shell-copy { overflow: hidden; max-width: 62ch; margin: 0.18rem 0 0; color: var(--subtle); font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
      .header-actions { display: flex; flex: none; align-items: center; gap: 0.45rem; }
      .composition-toggle { display: flex; align-items: center; gap: 0.5rem; }
      .composition-toggle[aria-pressed="true"] { border-color: rgba(245, 158, 11, 0.42); color: #fbbf24; }
      .composition-swatches { display: flex; align-items: center; }
      .composition-swatches span { width: 0.45rem; height: 0.65rem; margin-left: -0.1rem; border: 1px solid #18181b; border-radius: 0.12rem; }
      .composition-swatches span:first-child { margin-left: 0; background: var(--composition-react); }
      .composition-swatches span:last-child { background: var(--composition-qwik); }
      .widget-grid { position: relative; width: min(100%, 58rem); height: calc(100dvh - 3.25rem); min-height: 0; margin: 0 auto; }
      .page-composition { display: flex; width: 100%; height: 100%; min-height: 0; flex-direction: column; }
      .navigation-stage { position: absolute; visibility: hidden; pointer-events: none; inset: 0; }
      .widget-surface { position: relative; min-width: 0; overflow: hidden; }
      .widget-react { min-height: 0; flex: 1; }
      .widget-qwik { width: min(calc(100% - 2rem), 48rem); height: 6.6rem; flex: none; align-self: center; margin-bottom: 1rem; border: 1px solid #333; border-radius: 1.5rem; background: var(--surface); }
      v-frame { display: block; width: 100%; height: 100%; min-width: 0; border: 0; background: var(--canvas); overflow: hidden; }
      .widget-grid-single .widget-surface { width: 100%; height: 100%; flex: 1; margin: 0; border: 0; border-radius: 0; background: var(--canvas); }
      .host-route { display: none; }
      html[data-composition-visible] .host-sidebar::before, html[data-composition-visible] .widget-surface::before { position: absolute; z-index: 4; border: 2px solid var(--composition-color); border-radius: inherit; background: color-mix(in srgb, var(--composition-color) 7%, transparent); content: ""; inset: 0; pointer-events: none; }
      html[data-composition-visible] .host-sidebar::after, html[data-composition-visible] .widget-surface::after { position: absolute; z-index: 5; top: 0.45rem; right: 0.45rem; padding: 0.22rem 0.42rem; border-radius: 999px; background: var(--composition-color); color: white; content: attr(data-composition-label); font-size: 0.625rem; font-weight: 600; pointer-events: none; }
      html[data-composition-visible] .account-menu::before { position: absolute; z-index: 6; border: 2px solid var(--composition-qwik); border-radius: 0.5rem; background: color-mix(in srgb, var(--composition-qwik) 7%, transparent); content: ""; inset: 0; pointer-events: none; }
      html[data-composition-visible] .account-menu::after { position: absolute; z-index: 7; top: 0.35rem; right: 0.35rem; padding: 0.22rem 0.42rem; border-radius: 999px; background: var(--composition-qwik); color: white; content: attr(data-composition-label); font-size: 0.625rem; font-weight: 600; pointer-events: none; }
      html[data-composition-visible] .host-sidebar { --composition-color: var(--composition-host); }
      html[data-composition-visible] .widget-react { --composition-color: var(--composition-react); }
      html[data-composition-visible] .widget-qwik { --composition-color: var(--composition-qwik); }
      @media (max-width: 63.99rem) {
        .host-sidebar { display: none; }
        .host-content, html[data-sidebar-closed] .host-content { width: 100%; margin-left: 0; }
        .mobile-header { display: flex; min-height: 3.5rem; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.5rem 0.75rem; background: #0d0d0d; }
        .mobile-navigation summary { display: flex; min-height: 3rem; align-items: center; padding: 0.45rem 0.65rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); color: var(--text); cursor: pointer; font-size: 1rem; list-style: none; }
        .mobile-navigation[open] { position: fixed; z-index: 20; display: grid; width: min(28rem, calc(100% - 1rem)); min-height: 100dvh; grid-template-columns: 1fr auto; align-content: start; margin: 0 0 0 auto; padding: 1rem; border-left: 1px solid var(--line); background: #0d0d0d; box-shadow: -100vmax 0 0 100vmax rgba(0, 0, 0, 0.72); inset: 0 0 0 auto; }
        .mobile-navigation[open] summary { grid-column: 2; grid-row: 1; align-self: start; }
        .mobile-navigation[open] .mobile-navigation-title { display: block; grid-column: 1; grid-row: 1; align-self: center; margin: 0; font-size: 1.0625rem; font-weight: 600; }
        .mobile-navigation[open] .mobile-menu-open { display: none; }
        .mobile-navigation[open] .mobile-menu-close { display: inline; }
        .mobile-navigation[open] .new-thread { grid-column: 1 / -1; margin-top: 0.75rem; }
        .mobile-navigation[open] nav { position: static; grid-column: 1 / -1; width: auto; margin-top: 0.65rem; padding: 0; border: 0; background: transparent; }
        .sidebar-toggle { display: none; }
      }
      @media (max-width: 39.99rem) {
        .shell-header { align-items: flex-start; padding: 0.75rem; }
        .shell-copy { display: none; }
        .composition-toggle { min-height: 3rem; padding: 0.5rem; font-size: 0.8125rem; }
        .composition-swatches { display: none; }
        .widget-grid { width: 100%; height: calc(100dvh - 6.75rem); }
        .widget-qwik { width: calc(100% - 1rem); }
      }
      @media (prefers-reduced-motion: reduce) { .host-sidebar, .host-content { transition-duration: 1ms; } }
    </style>
  </head>
  <body>
    <div class="app-shell">
      <aside id="host-sidebar" class="host-sidebar" data-composition-label="React host shell">
        <div class="brand-row">
          <a href="/" aria-label="Homepage" class="brand" data-host-section="migration">Relay <span class="brand-product">Pro</span></a>
          <button class="sidebar-icon-button" type="button" aria-label="Search threads"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m15.5 15.5 4.5 4.5"></path></svg></button>
        </div>
        <a href="/" class="new-thread" data-host-section="migration"><span aria-hidden="true">+</span><span class="host-link-label">New thread</span><span class="host-link-owner">React</span></a>
        <nav class="host-navigation" aria-label="Relay navigation">
          <ul>
            <li><a class="host-link${hostSection === "plugins" ? " host-link-active" : ""}" href="/plugins" data-host-section="plugins"${hostSection === "plugins" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">⌘</span><span class="host-link-label">Plugins</span><span class="host-link-owner">React</span></a></li>
            <li><a class="host-link${hostSection === "usage" ? " host-link-active" : ""}" href="/usage" data-host-section="usage"${hostSection === "usage" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">◫</span><span class="host-link-label">Usage</span><span class="host-link-owner">Qwik</span></a></li>
          </ul>
          <div class="navigation-group">
            <p class="navigation-label">Recent</p>
            <ul>
              <li><a class="host-link${hostSection === "migration" ? " host-link-active" : ""}" href="/" data-host-section="migration"${hostSection === "migration" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">P</span><span class="host-link-label">Platform migration</span><span class="host-link-owner">React</span></a></li>
              <li><a class="host-link${hostSection === "research" ? " host-link-active" : ""}" href="/research" data-host-section="research"${hostSection === "research" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">S</span><span class="host-link-label">Customer research</span><span class="host-link-owner">React</span></a></li>
              <li><a class="host-link${hostSection === "brief" ? " host-link-active" : ""}" href="/brief" data-host-section="brief"${hostSection === "brief" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">D</span><span class="host-link-label">Weekly brief</span><span class="host-link-owner">React</span></a></li>
            </ul>
          </div>
        </nav>
        <div class="account-menu" data-composition-label="Qwik account frontend"><div id="account-widget"></div></div>
      </aside>
      <div class="host-content">
        <header class="mobile-header">
          <a href="/" aria-label="Homepage" class="brand" data-host-section="migration"><span>Relay</span><span class="brand-product">Pro</span></a>
          <details class="mobile-navigation">
            <summary><span class="mobile-menu-open">Menu</span><span class="mobile-menu-close">Close</span></summary>
            <h2 class="mobile-navigation-title">Navigation</h2>
            <a class="new-thread" href="/" data-host-section="migration"><span aria-hidden="true">＋</span><span class="host-link-label">New thread</span><span class="host-link-owner">React</span></a>
            <nav class="host-navigation" aria-label="Mobile workspace navigation">
              <ul class="utility-navigation">
                <li><a class="host-link${hostSection === "plugins" ? " host-link-active" : ""}" href="/plugins" data-host-section="plugins"${hostSection === "plugins" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">⌘</span><span class="host-link-label">Plugins</span><span class="host-link-owner">React</span></a></li>
                <li><a class="host-link${hostSection === "usage" ? " host-link-active" : ""}" href="/usage" data-host-section="usage"${hostSection === "usage" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">◫</span><span class="host-link-label">Usage</span><span class="host-link-owner">Qwik</span></a></li>
              </ul>
              <div class="thread-navigation">
                <p>Recent</p>
                <ul>
                  <li><a class="host-link${hostSection === "migration" ? " host-link-active" : ""}" href="/" data-host-section="migration"${hostSection === "migration" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">P</span><span class="host-link-label">Platform migration</span><span class="host-link-owner">React</span></a></li>
                  <li><a class="host-link${hostSection === "research" ? " host-link-active" : ""}" href="/research" data-host-section="research"${hostSection === "research" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">S</span><span class="host-link-label">Customer research</span><span class="host-link-owner">React</span></a></li>
                  <li><a class="host-link${hostSection === "brief" ? " host-link-active" : ""}" href="/brief" data-host-section="brief"${hostSection === "brief" ? ' aria-current="page"' : ""}><span class="host-link-mark" aria-hidden="true">D</span><span class="host-link-label">Weekly brief</span><span class="host-link-owner">React</span></a></li>
                </ul>
              </div>
            </nav>
          </details>
        </header>
        <main class="shell">
          <header class="shell-header">
            <div class="shell-heading">
              <button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-controls="host-sidebar" aria-expanded="true">Hide sidebar</button>
              <div>
                <p id="host-section-kicker" class="shell-kicker">${section.kicker}</p>
                <h1 id="host-section-title" tabindex="-1" aria-live="polite">${section.title}</h1>
                <p id="host-section-description" class="shell-copy">${section.description}</p>
              </div>
            </div>
            <div class="header-actions">
              <button id="composition-toggle" class="composition-toggle" type="button" aria-pressed="false">
                <span class="composition-swatches" aria-hidden="true"><span></span><span></span></span>
                <span id="composition-toggle-label">Show frontends</span>
              </button>
            </div>
          </header>
          <div id="host-workspace" class="widget-grid">
            <div id="host-composition" class="${compositionClasses}" data-host-composition>
              ${workspaceSurfaces}
            </div>
          </div>
          <p class="host-route">Host routes: <output id="host-route" aria-live="polite">${Object.entries(sectionRoutes).map(([frameId, route]) => `${frameId} ${route}`).join("; ")}</output></p>
        </main>
      </div>
    </div>
    <script data-v-frame-runtime>${embeddedVFrameScript}</script>
    <script>
      const protocol = ${JSON.stringify(routingProtocol)};
      const version = ${routingVersion};
      const sessionKey = ${JSON.stringify(routingSessionStorageKey)};
      const channelPrefix = ${JSON.stringify(routingChannelPrefix)};
      const hostSectionDefinitions = ${hostSectionDefinitions};
      const hostSectionRoutes = ${hostSectionRouteDefinitions};
      const initialRoutes = ${initialRoutes};
      let frameRoutes = { ...initialRoutes };
      const allowedRoutes = {
        "react-router": new Set(["/activity", "/research", "/brief", "/plugins"]),
        qwik: new Set(["/inventory", "/catalog"]),
      };
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      let sessionId = "";
      let channel = null;
      try {
        if (typeof BroadcastChannel === "function") {
          sessionId = crypto.randomUUID();
          sessionStorage.setItem(sessionKey, sessionId);
          channel = new BroadcastChannel(channelPrefix + sessionId);
        }
      } catch {
        sessionId = "";
      }
      const seenMessages = new Set();
      const hostSidebar = document.querySelector("#host-sidebar");
      const sidebarToggle = document.querySelector("#sidebar-toggle");
      const compositionToggle = document.querySelector("#composition-toggle");
      const compositionToggleLabel = document.querySelector("#composition-toggle-label");
      const compositionStorageKey = "v-frame:composition-visible";
      const hostWorkspace = document.querySelector("#host-workspace");
      const hostSectionKicker = document.querySelector("#host-section-kicker");
      const hostSectionTitle = document.querySelector("#host-section-title");
      const hostSectionDescription = document.querySelector("#host-section-description");
      const routeOutput = document.querySelector("#host-route");
      let pendingNavigation = null;

      sidebarToggle?.addEventListener("click", () => {
        const sidebarClosed = !document.documentElement.hasAttribute("data-sidebar-closed");
        document.documentElement.toggleAttribute("data-sidebar-closed", sidebarClosed);
        sidebarToggle.setAttribute("aria-expanded", String(!sidebarClosed));
        sidebarToggle.textContent = sidebarClosed ? "Show sidebar" : "Hide sidebar";
        hostSidebar?.toggleAttribute("inert", sidebarClosed);
        if (sidebarClosed) {
          hostSidebar?.setAttribute("aria-hidden", "true");
        } else {
          hostSidebar?.removeAttribute("aria-hidden");
        }
      });

      const updateNestedCompositionSurface = (visible) => {
        const reactFrame = document.querySelector('v-frame[data-frame-id="react-router"]');
        const reactWidget = reactFrame?.shadowRoot?.querySelector(".activity-widget");
        reactWidget?.toggleAttribute("data-composition-visible", visible);
      };

      const showComposition = (visible) => {
        document.documentElement.toggleAttribute("data-composition-visible", visible);
        compositionToggle?.setAttribute("aria-pressed", String(visible));
        if (compositionToggleLabel !== null) {
          compositionToggleLabel.textContent = visible ? "Hide frontends" : "Show frontends";
        }
        updateNestedCompositionSurface(visible);
        try {
          sessionStorage.setItem(compositionStorageKey, String(visible));
        } catch (error) {
          console.warn("Could not persist the composition preference", error);
        }
      };
      let compositionVisible = false;
      try {
        compositionVisible = sessionStorage.getItem(compositionStorageKey) === "true";
      } catch (error) {
        console.warn("Could not restore the composition preference", error);
      }
      showComposition(compositionVisible);
      compositionToggle?.addEventListener("click", () => {
        showComposition(!document.documentElement.hasAttribute("data-composition-visible"));
      });

      const routeFor = (frameId) => {
        const route = frameRoutes[frameId];
        return allowedRoutes[frameId]?.has(route) ? route : null;
      };
      const postRoute = (frameId, route, mode) => {
        channel?.postMessage({
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

      const cancelPendingNavigation = () => {
        if (pendingNavigation === null) return;
        pendingNavigation.composition.remove();
        pendingNavigation = null;
        try {
          sessionStorage.setItem(sessionKey, sessionId);
        } catch (error) {
          console.warn("Could not restore the current routing session", error);
        }
      };

      const beginHostSectionTransition = (sectionKey, mode) => {
        const section = hostSectionDefinitions[sectionKey];
        const sectionRoutes = hostSectionRoutes[sectionKey];
        if (section === undefined || sectionRoutes === undefined || hostWorkspace === null) return;
        if (pendingNavigation?.sectionKey === sectionKey) return;

        cancelPendingNavigation();
        let nextSessionId;
        try {
          nextSessionId = crypto.randomUUID();
          sessionStorage.setItem(sessionKey, nextSessionId);
        } catch (error) {
          console.warn("Could not prepare the destination routing session", error);
          if (mode === "push") {
            location.assign(section.path);
          } else {
            location.replace(section.path);
          }
          return;
        }

        const threadSection = sectionKey === "migration" || sectionKey === "research" || sectionKey === "brief";
        const composition = document.createElement("div");
        composition.className = threadSection
          ? "page-composition navigation-stage"
          : "page-composition widget-grid-single widget-grid-" + sectionKey + " navigation-stage";
        composition.dataset.hostComposition = "";
        composition.dataset.navigationSession = nextSessionId;
        composition.setAttribute("aria-hidden", "true");
        composition.setAttribute("inert", "");

        for (const [frameId, route] of Object.entries(sectionRoutes)) {
          const reactFrame = frameId === "react-router";
          const label = reactFrame
            ? sectionKey === "plugins" ? "React plugins frontend" : "React transcript frontend"
            : sectionKey === "usage" ? "Qwik usage frontend" : "Qwik composer frontend";
          const surface = document.createElement("div");
          surface.className = reactFrame
            ? "widget-surface widget-react"
            : "widget-surface widget-qwik";
          surface.dataset.compositionLabel = label;
          surface.dataset.surfaceId = reactFrame ? "react-surface" : "qwik-surface";

          const frame = document.createElement("v-frame");
          frame.dataset.frameId = frameId;
          frame.dataset.pendingFrame = "";
          frame.setAttribute(
            "src",
            reactFrame
              ? "/widgets/react-router" + route
              : "/widgets/qwik" + route + "?frameId=qwik",
          );
          frame.setAttribute("aria-label", label);
          surface.append(frame);
          composition.append(surface);
        }

        const destination = new URL(location.href);
        destination.pathname = section.path;
        destination.hash = "";
        for (const frameId of Object.keys(allowedRoutes)) {
          destination.searchParams.delete(frameId);
        }
        pendingNavigation = {
          composition,
          destination: destination.pathname + destination.search,
          expectedFrames: Object.keys(sectionRoutes).length,
          loadedFrames: new Set(),
          mode,
          routes: sectionRoutes,
          sectionKey,
          sessionId: nextSessionId,
        };
        document.querySelector(".mobile-navigation")?.removeAttribute("open");
        hostWorkspace.append(composition);
      };

      const commitPendingNavigation = () => {
        const completedNavigation = pendingNavigation;
        if (completedNavigation === null) return;
        pendingNavigation = null;

        const outgoingComposition = document.querySelector(
          '[data-host-composition]:not(.navigation-stage)',
        );
        completedNavigation.composition.classList.remove("navigation-stage");
        completedNavigation.composition.removeAttribute("aria-hidden");
        completedNavigation.composition.removeAttribute("inert");
        completedNavigation.composition.id = "host-composition";
        for (const surface of completedNavigation.composition.querySelectorAll("[data-surface-id]")) {
          surface.id = surface.dataset.surfaceId;
          delete surface.dataset.surfaceId;
        }
        for (const frame of completedNavigation.composition.querySelectorAll("v-frame[data-frame-id]")) {
          frame.id = frame.dataset.frameId + "-frontend";
          delete frame.dataset.pendingFrame;
        }
        outgoingComposition?.remove();

        const section = hostSectionDefinitions[completedNavigation.sectionKey];
        document.title = section.title + " · Relay";
        if (hostSectionKicker !== null) hostSectionKicker.textContent = section.kicker;
        if (hostSectionTitle !== null) hostSectionTitle.textContent = section.title;
        if (hostSectionDescription !== null) {
          hostSectionDescription.textContent = section.description;
        }
        for (const link of document.querySelectorAll(".host-link[data-host-section]")) {
          const active = link.getAttribute("data-host-section") === completedNavigation.sectionKey;
          link.classList.toggle("host-link-active", active);
          if (active) {
            link.setAttribute("aria-current", "page");
          } else {
            link.removeAttribute("aria-current");
          }
        }

        frameRoutes = { ...completedNavigation.routes };
        if (routeOutput !== null) {
          routeOutput.textContent = Object.entries(frameRoutes)
            .map(([frameId, route]) => frameId + " " + route)
            .join("; ");
        }
        if (completedNavigation.mode === "push") {
          history.pushState(null, "", completedNavigation.destination);
        } else if (completedNavigation.mode === "replace") {
          history.replaceState(null, "", completedNavigation.destination);
        }

        channel?.removeEventListener("message", receiveRoutingMessage);
        channel?.close();
        sessionId = completedNavigation.sessionId;
        seenMessages.clear();
        try {
          channel = new BroadcastChannel(channelPrefix + sessionId);
          channel.addEventListener("message", receiveRoutingMessage);
        } catch (error) {
          channel = null;
          console.warn("Could not activate the destination routing channel", error);
        }
        showComposition(document.documentElement.hasAttribute("data-composition-visible"));
        for (const [frameId, route] of Object.entries(frameRoutes)) {
          postRoute(frameId, route, "replace");
        }
        hostSectionTitle?.focus();
      };

      document.addEventListener("v-frame-load", (event) => {
        if (!(event.target instanceof Element)) return;
        const stagedComposition = event.target.closest(".navigation-stage");
        if (stagedComposition !== null && pendingNavigation?.composition === stagedComposition) {
          const frameId = event.target.getAttribute("data-frame-id");
          if (frameId === null) return;
          pendingNavigation.loadedFrames.add(frameId);
          if (pendingNavigation.loadedFrames.size === pendingNavigation.expectedFrames) {
            commitPendingNavigation();
          }
          return;
        }
        if (event.target.matches('v-frame[data-frame-id="react-router"]')) {
          updateNestedCompositionSurface(
            document.documentElement.hasAttribute("data-composition-visible"),
          );
        }
      });

      document.addEventListener("v-frame-error", (event) => {
        if (
          !(event.target instanceof Element)
          || pendingNavigation === null
          || !pendingNavigation.composition.contains(event.target)
        ) return;

        const failedNavigation = pendingNavigation;
        cancelPendingNavigation();
        if (failedNavigation.mode === "push") {
          location.assign(failedNavigation.destination);
        } else {
          location.replace(failedNavigation.destination);
        }
      });

      document.addEventListener("click", (event) => {
        if (
          event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey
        ) return;
        const link = event.target instanceof Element
          ? event.target.closest("a[data-host-section]")
          : null;
        if (!(link instanceof HTMLAnchorElement) || link.origin !== location.origin) return;

        const sectionKey = link.dataset.hostSection;
        const section = hostSectionDefinitions[sectionKey];
        if (section === undefined || channel === null) return;
        event.preventDefault();
        if (location.pathname === section.path) {
          cancelPendingNavigation();
          document.querySelector(".mobile-navigation")?.removeAttribute("open");
          return;
        }
        beginHostSectionTransition(sectionKey, "push");
      });

      function receiveRoutingMessage(event) {
        const message = event.data;
        if (event.origin !== location.origin || !validBase(message)) return;
        if (seenMessages.has(message.messageId)) return;
        rememberMessage(message.messageId);

        if (message.kind === "route-ready") {
          const route = routeFor(message.source);
          if (route === null || route !== message.route) return;
          document.querySelector(
            'v-frame[data-frame-id="' + message.source + '"]',
          )?.setAttribute("data-routing-ready", "");
          return;
        }

        const route = routeFor(message.source);
        if (message.kind === "hello") {
          if (route === null) return;
          postRoute(message.source, route, "replace");
          return;
        }
        if (
          message.kind !== "navigate-request" ||
          !allowedRoutes[message.source].has(message.route) ||
          (message.mode !== "push" && message.mode !== "replace")
        ) return;
        if (route !== null && message.route === route) {
          postRoute(message.source, route, "replace");
          return;
        }

        const currentHostSection = Object.keys(hostSectionDefinitions).find(
          (sectionKey) => hostSectionDefinitions[sectionKey].path === location.pathname,
        );
        const matchingSections = Object.keys(hostSectionRoutes).filter(
          (sectionKey) => hostSectionRoutes[sectionKey][message.source] === message.route,
        );
        const sectionKey = currentHostSection !== undefined && matchingSections.includes(currentHostSection)
          ? currentHostSection
          : matchingSections[0];
        if (sectionKey === undefined) return;

        beginHostSectionTransition(sectionKey, message.mode);
      }

      channel?.addEventListener("message", receiveRoutingMessage);
      addEventListener("popstate", () => {
        const sectionKey = Object.keys(hostSectionDefinitions).find(
          (candidate) => hostSectionDefinitions[candidate].path === location.pathname,
        );
        if (sectionKey === undefined) return;
        if (channel === null) {
          location.reload();
          return;
        }
        beginHostSectionTransition(sectionKey, "traverse");
      });
      addEventListener("pagehide", () => {
        cancelPendingNavigation();
        channel?.close();
      }, { once: true });
      addEventListener("pageshow", (event) => {
        if (event.persisted) location.reload();
      });

    </script>
  </body>
</html>`;
}

interface WidgetDefinition {
  frameId: string;
  label: string;
  source: string;
}

interface PageWidget {
  frameId: PageFrameId;
  response: Response;
  route: string;
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
        `<v-frame adopt id="${definition.frameId}-frontend" data-frame-id="${definition.frameId}" src="${definition.source}" aria-label="${definition.label}"><template shadowrootmode="open" shadowrootserializable>`,
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
      let componentPath = mountedPath + url.search;
      if (qwikRoutes.has(mountedPath)) {
        const componentParameters = new URLSearchParams({
          route: mountedPath,
          base: "/widgets/qwik/build/",
        });
        if (url.searchParams.get("frameId") === "qwik") {
          componentParameters.set("frameId", "qwik");
        }
        const surface = url.searchParams.get("surface");
        if (surface === "definition" || surface === "profile") {
          componentParameters.set("surface", surface);
        }
        const article = url.searchParams.get("article");
        if (surface === "definition" && article !== null) {
          componentParameters.set("article", article);
        }
        componentPath = `/document?${componentParameters}`;
      }
      return env.QWIK_WIDGET.fetch(serviceRequest("qwik-widget", componentPath));
    }
    const hostSection = (Object.keys(hostSections) as HostSectionKey[]).find(
      (sectionKey) => hostSections[sectionKey].path === url.pathname,
    );
    if (hostSection === undefined) {
      return new Response("page not found", { status: 404 });
    }

    const sectionRoutes = hostSectionRoutes[hostSection];
    const pageWidgetsPromise: Promise<PageWidget[]> = Promise.all(
      (Object.entries(sectionRoutes) as [PageFrameId, string][]).map(
        async ([frameId, route]) => {
          const response = frameId === "react-router"
            ? await env.REACT_ROUTER_WIDGET.fetch(
              serviceRequest(
                "react-router-widget",
                `/preview?route=${encodeURIComponent(route)}&base=/widgets/react-router&frameId=react-router`,
              ),
            )
            : await env.QWIK_WIDGET.fetch(
              serviceRequest(
                "qwik-widget",
                `/preview?route=${encodeURIComponent(route)}&base=/widgets/qwik/build/&frameId=qwik`,
              ),
            );
          return { frameId, response, route };
        },
      ),
    );
    const accountPromise: Promise<Response> = env.QWIK_WIDGET.fetch(
      serviceRequest(
        "qwik-widget",
        "/preview?route=%2Finventory&base=%2Fwidgets%2Fqwik%2Fbuild%2F&surface=profile",
      ),
    );
    const [pageWidgets, account] = await Promise.all([
      pageWidgetsPromise,
      accountPromise,
    ]);
    let failure = pageWidgets
      .map(({ frameId, response }) => failedWidget(frameId, response))
      .find((candidate) => candidate !== null) ?? null;
    if (failure === null) {
      failure = failedWidget("account", account);
    }
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

    const shellResponse = new Response(shell(hostSection), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
    const rewriter = new HTMLRewriter();
    for (const { frameId, response, route } of pageWidgets) {
      let label = "Qwik composer frontend";
      if (frameId === "react-router") {
        label = hostSection === "plugins"
          ? "React plugins frontend"
          : "React transcript frontend";
      } else if (hostSection === "usage") {
        label = "Qwik usage frontend";
      }
      rewriter.on(
        frameId === "react-router" ? "#react-router-widget" : "#qwik-widget",
        widgetContent(response, {
          frameId,
          label,
          source: frameId === "react-router"
            ? `/widgets/react-router${route}`
            : `/widgets/qwik${route}?frameId=qwik`,
        }),
      );
    }
    rewriter.on(
      "#account-widget",
      widgetContent(account, {
        frameId: "account",
        label: "Qwik account frontend",
        source: "/widgets/qwik/inventory?surface=profile",
      }),
    );
    return rewriter.transform(shellResponse);
  },
} satisfies ExportedHandler<Env>;
