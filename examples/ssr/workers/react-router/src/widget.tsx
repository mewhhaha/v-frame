import { Button } from "@comp0/react";
import { useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router";

import { useWidgetRouteAdapter } from "./routing";

export const widgetRoutes = ["/activity", "/research", "/brief", "/plugins"] as const;

export type WidgetRoute = typeof widgetRoutes[number];

interface ElementBounds {
  bottom: number;
  left: number;
  top: number;
}

interface PreviewTriggerElement extends HTMLButtonElement {
  addEventListener(type: string, listener: EventListener): void;
  getBoundingClientRect(): ElementBounds;
  matches(selectors: string): boolean;
  ownerDocument: { activeElement: unknown };
  removeEventListener(type: string, listener: EventListener): void;
}

interface PreviewPopoverElement extends HTMLDivElement {
  addEventListener(type: string, listener: EventListener): void;
  hidePopover(): void;
  matches(selectors: string): boolean;
  offsetHeight: number;
  removeEventListener(type: string, listener: EventListener): void;
  showPopover(): void;
  style: { setProperty(name: string, value: string): void };
}

interface HostViewport {
  addEventListener(type: string, listener: EventListener): void;
  innerHeight: number;
  innerWidth: number;
  removeEventListener(type: string, listener: EventListener): void;
}

interface TranscriptStep {
  detail: string;
  title: string;
}

interface ThreadTranscript {
  articleKey: "brief" | "migration" | "research";
  articleTitle: string;
  heading: string;
  prompt: string;
  response: string;
  steps: readonly TranscriptStep[];
}

const threadTranscripts = {
  migration: {
    articleKey: "migration",
    articleTitle: "blue–green deployment",
    heading: "Migration conversation",
    prompt: "Help me plan the platform migration. I need a safe rollout sequence that keeps the current API available while teams move over.",
    response: "I’d split the migration into three reversible stages so each team can move independently.",
    steps: [
      { title: "Stabilize the boundary.", detail: "Wrap the current API in a measured compatibility layer." },
      { title: "Mirror read traffic.", detail: "Compare both paths before moving any writes." },
      { title: "Move one owner at a time.", detail: "Keep a short rollback window after every cutover." },
    ],
  },
  research: {
    articleKey: "research",
    articleTitle: "thematic analysis",
    heading: "Customer research conversation",
    prompt: "Turn our customer interviews into a focused readout with themes, evidence, and a clear next decision.",
    response: "I’d organize the interviews around repeated needs, then separate observations from product implications.",
    steps: [
      { title: "Code the evidence.", detail: "Tag concrete statements before translating them into feature requests." },
      { title: "Group repeated needs.", detail: "Cluster observations and note which customer segments share each pattern." },
      { title: "Choose the next question.", detail: "Use the strongest unresolved theme to shape a follow-up study." },
    ],
  },
  brief: {
    articleKey: "brief",
    articleTitle: "executive summary",
    heading: "Weekly brief conversation",
    prompt: "Draft a weekly brief for stakeholders. It should cover progress, risks, and the decisions we need next week.",
    response: "I’d lead with the change in status, then give each risk an owner and a dated next action.",
    steps: [
      { title: "State the movement.", detail: "Open with what changed since last week." },
      { title: "Name the exposure.", detail: "Give each risk an impact, owner, and mitigation." },
      { title: "Request decisions.", detail: "End with the smallest choices that unblock the coming week." },
    ],
  },
} as const satisfies Record<string, ThreadTranscript>;

const browserWindow = globalThis as typeof globalThis & { parent: HostViewport };

export function isWidgetRoute(value: string): value is WidgetRoute {
  return (widgetRoutes as readonly string[]).includes(value);
}

function TranscriptPage({ transcript }: { transcript: ThreadTranscript }) {
  const [responseSaved, setResponseSaved] = useState(false);
  const previewTriggerRef = useRef<PreviewTriggerElement>(null);
  const previewPopoverRef = useRef<PreviewPopoverElement>(null);

  useEffect(() => {
    const previewTrigger = previewTriggerRef.current;
    const previewPopover = previewPopoverRef.current;
    if (previewTrigger === null || previewPopover === null) return;

    let closeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const clearScheduledClose = () => {
      if (closeTimer === undefined) return;
      clearTimeout(closeTimer);
      closeTimer = undefined;
    };
    const positionPreview = () => {
      const anchor = previewTrigger.getBoundingClientRect();
      const hostViewport = browserWindow.parent;
      const horizontalMargin = 16;
      const anchorGap = 8;
      const previewWidth = Math.min(352, hostViewport.innerWidth - horizontalMargin * 2);
      const left = Math.min(
        Math.max(horizontalMargin, anchor.left - 8),
        hostViewport.innerWidth - previewWidth - horizontalMargin,
      );
      const previewHeight = previewPopover.offsetHeight;
      const fitsBelow = anchor.bottom + anchorGap + previewHeight <= hostViewport.innerHeight - horizontalMargin;
      const top = fitsBelow
        ? anchor.bottom + anchorGap
        : Math.max(horizontalMargin, anchor.top - anchorGap - previewHeight);
      previewPopover.style.setProperty("--preview-left", `${left}px`);
      previewPopover.style.setProperty("--preview-top", `${top}px`);
    };
    const openPreview = () => {
      clearScheduledClose();
      if (!previewPopover.matches(":popover-open")) previewPopover.showPopover();
      positionPreview();
    };
    const closePreview = () => {
      clearScheduledClose();
      if (previewPopover.matches(":popover-open")) previewPopover.hidePopover();
    };
    const schedulePreviewClose = () => {
      clearScheduledClose();
      closeTimer = globalThis.setTimeout(() => {
        closeTimer = undefined;
        if (
          previewTrigger.matches(":hover")
          || previewTrigger === previewTrigger.ownerDocument.activeElement
          || previewPopover.matches(":hover")
        ) return;
        closePreview();
      }, 80);
    };
    const closePreviewOnEscape: EventListener = (event) => {
      if ((event as Event & { key?: string }).key === "Escape") closePreview();
    };

    previewTrigger.addEventListener("pointerenter", openPreview);
    previewTrigger.addEventListener("pointerleave", schedulePreviewClose);
    previewTrigger.addEventListener("focus", openPreview);
    previewTrigger.addEventListener("blur", schedulePreviewClose);
    previewTrigger.addEventListener("keydown", closePreviewOnEscape);
    previewPopover.addEventListener("pointerenter", clearScheduledClose);
    previewPopover.addEventListener("pointerleave", schedulePreviewClose);
    browserWindow.parent.addEventListener("resize", positionPreview);
    browserWindow.parent.addEventListener("scroll", positionPreview);

    return () => {
      clearScheduledClose();
      previewTrigger.removeEventListener("pointerenter", openPreview);
      previewTrigger.removeEventListener("pointerleave", schedulePreviewClose);
      previewTrigger.removeEventListener("focus", openPreview);
      previewTrigger.removeEventListener("blur", schedulePreviewClose);
      previewTrigger.removeEventListener("keydown", closePreviewOnEscape);
      previewPopover.removeEventListener("pointerenter", clearScheduledClose);
      previewPopover.removeEventListener("pointerleave", schedulePreviewClose);
      browserWindow.parent.removeEventListener("resize", positionPreview);
      browserWindow.parent.removeEventListener("scroll", positionPreview);
      closePreview();
    };
  }, []);

  return (
    <section id="transcript" aria-labelledby="transcript-title">
      <h2 id="transcript-title" className="sr-only">{transcript.heading}</h2>
      <div className="conversation-thread">
        <article className="conversation-message conversation-message-user">
          <div className="message-content"><p>{transcript.prompt}</p></div>
        </article>
        <article className="conversation-message conversation-message-assistant">
          <div className="message-content">
            <p>{transcript.response}</p>
            <ol className="activity-list">
              {transcript.steps.map((step) => (
                <li key={step.title}><strong>{step.title}</strong><span>{step.detail}</span></li>
              ))}
            </ol>
            <p className="reference-copy">
              A useful reference is{" "}
              <button
                ref={previewTriggerRef}
                type="button"
                className="wikipedia-term"
                aria-describedby="wikipedia-preview"
              >
                {transcript.articleTitle}
              </button>
              . Hover or focus the term for a preview.
            </p>
            <div
              ref={previewPopoverRef}
              id="wikipedia-preview"
              className="preview-popover"
              popover="manual"
              role="tooltip"
            >
              <div className="nested-widget-surface" data-composition-label="Qwik Wikipedia preview frontend">
                <v-frame
                  adopt
                  className="nested-workspace-widget"
                  src={`/widgets/qwik/inventory?surface=definition&article=${transcript.articleKey}`}
                  aria-label={`${transcript.articleTitle} Wikipedia preview from the nested Qwik frontend`}
                />
              </div>
            </div>
            <div className="activity-actions">
              <Button type="button" onClick={() => setResponseSaved(true)}>♡ Save</Button>
              <output aria-live="polite">{responseSaved ? "Saved" : ""}</output>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

function PluginsPage() {
  const [enabledPlugins, setEnabledPlugins] = useState(["wikipedia", "files"]);
  const [searchQuery, setSearchQuery] = useState("");
  const togglePlugin = (plugin: string) => {
    setEnabledPlugins((currentPlugins) => currentPlugins.includes(plugin)
      ? currentPlugins.filter((enabledPlugin) => enabledPlugin !== plugin)
      : [...currentPlugins, plugin]);
  };

  const plugins = [
    ["wikipedia", "W", "Wikipedia", "Preview relevant articles beside terms in a response."],
    ["files", "F", "File search", "Find supporting passages in workspace documents."],
    ["analysis", "D", "Data analysis", "Inspect tables and calculate quick comparisons."],
  ] as const;
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visiblePlugins = plugins.filter(([, , name, description]) => {
    return normalizedSearchQuery === ""
      || `${name} ${description}`.toLocaleLowerCase().includes(normalizedSearchQuery);
  });

  return (
    <section id="plugins" aria-labelledby="plugins-title">
      <header className="plugin-heading">
        <div>
          <h2 id="plugins-title">Plugins</h2>
          <p className="widget-copy">Work across your favorite tools from one conversation.</p>
        </div>
        <label className="plugin-search">
          <span className="sr-only">Search plugins</span>
          <input
            name="plugin-search"
            type="search"
            placeholder="Search plugins"
            value={searchQuery}
            onChange={(event) => {
              const searchInput = event.currentTarget as unknown as { value: string };
              setSearchQuery(searchInput.value);
            }}
          />
        </label>
      </header>
      <section className="installed-plugins" aria-labelledby="installed-plugins-title">
        <h3 id="installed-plugins-title">Installed</h3>
        <div className="installed-row">
          {plugins.filter(([key]) => enabledPlugins.includes(key)).map(([key, mark, name]) => (
            <span className="plugin-mark" title={name} key={key}>{mark}</span>
          ))}
        </div>
      </section>
      <section className="plugin-category" aria-labelledby="featured-plugins-title">
        <h3 id="featured-plugins-title">Featured</h3>
        <div className="plugin-list">
          {visiblePlugins.map(([key, mark, name, description]) => {
            const enabled = enabledPlugins.includes(key);
            return (
              <article className="plugin" key={key}>
                <span className="plugin-mark" aria-hidden="true">{mark}</span>
                <div><strong>{name}</strong><p>{description}</p></div>
                <Button type="button" aria-pressed={enabled} onClick={() => togglePlugin(key)}>
                  {enabled ? "Enabled" : "Enable"}
                </Button>
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}

export interface ReleaseActivityWidgetProps {
  routingFrameId: string;
}

export function ReleaseActivityWidget({ routingFrameId }: ReleaseActivityWidgetProps) {
  useWidgetRouteAdapter(routingFrameId);

  return (
    <main className="activity-widget">
      <Routes>
        <Route path="/activity" element={<TranscriptPage transcript={threadTranscripts.migration} />} />
        <Route path="/research" element={<TranscriptPage transcript={threadTranscripts.research} />} />
        <Route path="/brief" element={<TranscriptPage transcript={threadTranscripts.brief} />} />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="*" element={<Navigate replace to="/activity" />} />
      </Routes>
    </main>
  );
}

export const widgetStyle = `
  :root { color-scheme: only dark; }
  * { box-sizing: border-box; }
  .activity-widget { min-height: 100%; padding: 1.25rem; background: #0d0d0f; color: #f4f4f5; font-family: Inter, ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .widget-kicker { margin: 0 0 0.4rem; color: #6ee7b7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.04em; }
  .activity-widget h2 { margin: 0; color: #f4f4f5; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.025em; }
  .widget-copy { max-width: 62ch; margin: 0.45rem 0 1.2rem; color: #a1a1aa; font-size: 0.8125rem; line-height: 1.6; }
  .conversation-thread { margin-top: 1rem; }
  .conversation-message { display: grid; grid-template-columns: 1.75rem minmax(0, 1fr); gap: 0.85rem; padding: 1rem 0; border-top: 1px solid rgba(255, 255, 255, 0.09); }
  .message-avatar { display: grid; width: 1.75rem; height: 1.75rem; place-items: center; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 0.45rem; font-size: 0.625rem; font-weight: 700; }
  .message-avatar-user { background: #18181b; }
  .message-avatar-relay { border-color: transparent; background: #10a37f; color: white; }
  .message-content > strong { color: #f4f4f5; font-size: 0.8125rem; font-weight: 600; }
  .message-content > p { margin: 0.55rem 0 0; color: #e4e4e7; font-size: 0.875rem; line-height: 1.7; }
  .activity-list { display: grid; gap: 0.8rem; margin: 1rem 0 0; padding-left: 1.25rem; }
  .activity-list li { padding-left: 0.2rem; color: #e4e4e7; font-size: 0.8125rem; line-height: 1.65; }
  .activity-list strong { color: #f4f4f5; font-weight: 600; }
  .activity-list span { margin-left: 0.3rem; color: #a1a1aa; }
  .reference-copy { margin-top: 1rem !important; }
  .wikipedia-term { padding: 0; border: 0; border-bottom: 1px dashed #34d399; background: transparent; color: #6ee7b7; cursor: help; font: inherit; }
  .wikipedia-term:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 3px; }
  .preview-popover { position: fixed; inset: var(--preview-top, 1rem) auto auto var(--preview-left, 1rem); width: min(22rem, calc(100vw - 2rem)); margin: 0; padding: 0.65rem; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 0.75rem; background: #1b1b1f; color: #f4f4f5; }
  .preview-popover:not(:popover-open) { display: none; }
  .preview-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.1rem 0.1rem 0.55rem; }
  .preview-heading .widget-kicker { margin: 0; }
  .preview-heading > span { color: #a78bfa; font-size: 0.625rem; font-weight: 600; }
  .nested-widget-surface { position: relative; border-radius: 0.55rem; }
  .nested-workspace-widget { display: block; min-height: 10.5rem; border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 0.55rem; overflow: hidden; }
  .activity-widget[data-composition-visible] .nested-widget-surface::before { position: absolute; z-index: 4; border: 2px solid #a78bfa; border-radius: inherit; background: color-mix(in srgb, #a78bfa 7%, transparent); content: ""; inset: 0; pointer-events: none; }
  .activity-widget[data-composition-visible] .nested-widget-surface::after { position: absolute; z-index: 5; top: 0.45rem; right: 0.45rem; padding: 0.22rem 0.42rem; border-radius: 999px; background: #a78bfa; color: white; content: attr(data-composition-label); font-size: 0.625rem; font-weight: 600; pointer-events: none; }
  .activity-actions { display: flex; align-items: center; gap: 0.7rem; margin-top: 1rem; }
  .activity-actions button, .plugin button { min-height: 2.125rem; padding: 0.4rem 0.7rem; border: 0; border-radius: 0.5rem; background: #10a37f; color: white; cursor: pointer; font: inherit; font-size: 0.75rem; font-weight: 600; }
  .activity-actions output { color: #71717a; font-size: 0.75rem; }
  .activity-actions button:focus-visible, .plugin button:focus-visible { outline: 2px solid #6ee7b7; outline-offset: 2px; }
  .plugin-list { display: grid; border-top: 1px solid rgba(255, 255, 255, 0.09); }
  .plugin { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.9rem; padding: 1rem 0; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }
  .plugin-mark { display: grid; width: 2rem; height: 2rem; place-items: center; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 0.55rem; background: #18181b; color: #d4d4d8; font-size: 0.75rem; font-weight: 650; }
  .plugin > div { min-width: 0; }
  .plugin strong { color: #e4e4e7; font-size: 0.8125rem; font-weight: 600; }
  .plugin p { margin: 0.25rem 0 0; color: #a1a1aa; font-size: 0.8125rem; line-height: 1.5; }
  .plugin button { min-width: 5.25rem; border: 1px solid rgba(255, 255, 255, 0.12); background: #18181b; color: #e4e4e7; }
  .plugin button[aria-pressed="true"] { border-color: rgba(110, 231, 183, 0.35); color: #6ee7b7; }
  @media (max-width: 36rem) {
    .activity-widget { padding: 1.1rem; }
    .widget-kicker, .activity-actions output { font-size: 0.875rem; }
    .widget-copy, .message-content > p, .activity-list li, .plugin strong, .plugin p { font-size: 1rem; }
    .activity-actions { align-items: flex-start; flex-direction: column; }
    .activity-actions button { min-height: 3rem; font-size: 1rem; }
    .plugin { grid-template-columns: auto minmax(0, 1fr); }
    .plugin button { grid-column: 2; min-height: 3rem; font-size: 1rem; justify-self: start; }
  }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; margin: -1px; padding: 0; border: 0; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  .activity-widget { min-height: 100%; padding: 1rem 0; background: #000; color: #f5f5f5; }
  .activity-widget > section { width: min(100%, 48rem); margin: 0 auto; }
  .conversation-message { display: block; min-width: 0; padding: 1.15rem 0; border: 0; }
  .conversation-message-user { display: flex; justify-content: flex-end; }
  .conversation-message-user .message-content { max-width: min(36rem, 82%); padding: 0.65rem 1rem; border-radius: 1.25rem; background: #2f2f2f; }
  .message-content > p { margin: 0; color: #ececec; font-size: 0.9375rem; line-height: 1.72; }
  .activity-list li { color: #ececec; font-size: 0.9375rem; }
  .activity-list span { color: #b4b4b4; }
  .wikipedia-term { border-bottom-color: #b4b4b4; color: #f5f5f5; }
  .preview-popover { width: min(22.5rem, calc(100vw - 1.5rem)); height: 12.5rem; padding: 0; border-color: #444; border-radius: 0.85rem; background: #212121; color: #f5f5f5; }
  .nested-widget-surface, .nested-workspace-widget { width: 100%; height: 100%; min-height: 0; border: 0; border-radius: inherit; }
  .widget-kicker { color: #a0a0a0; font-family: inherit; text-transform: uppercase; }
  .activity-actions { gap: 0.35rem; margin-top: 0.8rem; }
  .activity-actions button { min-height: 1.9rem; padding: 0.3rem 0.5rem; background: transparent; color: #a0a0a0; font-weight: 400; }
  .activity-actions button:hover { background: #212121; color: white; }
  #transcript { padding: 1.5rem 1.5rem 3rem; }
  .conversation-thread { margin-top: 0; }
  #plugins { padding: 3rem 1.5rem 4rem; }
  .activity-widget h2 { color: #f5f5f5; font-size: 1.75rem; font-weight: 500; }
  .widget-copy { margin: 0.35rem 0 0; color: #b4b4b4; font-size: 0.875rem; }
  .plugin-heading { display: flex; min-width: 0; align-items: flex-end; justify-content: space-between; gap: 1.5rem; }
  .plugin-search { position: relative; display: block; flex: none; }
  .plugin-search::before { position: absolute; top: 50%; left: 0.75rem; color: #8e8e8e; content: "⌕"; font-size: 1rem; transform: translateY(-50%); pointer-events: none; }
  .plugin-search input { width: 15rem; height: 2.35rem; padding: 0.4rem 0.75rem 0.4rem 2rem; border: 1px solid #3f3f3f; border-radius: 999px; background: #212121; color: #f5f5f5; font: inherit; font-size: 0.8125rem; }
  .plugin-search input::placeholder { color: #a0a0a0; }
  .plugin-search input:focus-visible { outline: 2px solid white; outline-offset: 0; }
  .installed-plugins { margin-top: 2.4rem; }
  .installed-plugins h3, .plugin-category > h3 { margin: 0 0 0.65rem; color: #ececec; font-size: 0.8125rem; font-weight: 500; }
  .installed-row { display: flex; flex-wrap: wrap; gap: 0.55rem; }
  .plugin-category { margin-top: 2rem; }
  .plugin-list { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 2rem; border: 0; }
  .plugin { min-width: 0; gap: 0.75rem; padding: 0.8rem 0; border: 0; }
  .plugin-mark { width: 2.35rem; height: 2.35rem; border: 0; border-radius: 0.65rem; background: #242424; color: #ececec; font-size: 0.6875rem; }
  .plugin strong { color: #ececec; font-weight: 500; }
  .plugin p { overflow: hidden; color: #8e8e8e; font-size: 0.72rem; text-overflow: ellipsis; white-space: nowrap; }
  .plugin button { width: 2rem; min-width: 2rem; height: 2rem; min-height: 2rem; padding: 0; border: 0; background: transparent; color: #b4b4b4; overflow: hidden; font-size: 0; }
  .plugin button::after { content: "+"; font-size: 1.15rem; }
  .plugin button[aria-pressed="true"] { border: 0; color: #8e8e8e; }
  .plugin button[aria-pressed="true"]::after { content: "✓"; font-size: 0.8125rem; }
  @media (max-width: 36rem) {
    .activity-widget { padding: 0; }
    #transcript { padding: 0.5rem 1rem 2rem; }
    #plugins { padding: 1.5rem 1rem 3rem; }
    .conversation-message-user .message-content { max-width: 92%; }
    .plugin-heading { align-items: stretch; flex-direction: column; }
    .plugin-search, .plugin-search input { width: 100%; }
    .plugin-search input { min-height: 3rem; font-size: 1rem; }
    .plugin-list { grid-template-columns: 1fr; }
  }
`;
