import { useEffect, useRef, useState } from "react";
import { VFrameStatus } from "v-frame";
import type {
  VFrameElement,
  VFrameErrorEventDetail,
  VFrameLoadEventDetail,
  VFrameLoadStartEventDetail,
  VFrameNavigateEventDetail,
  VFrameStatusValue,
} from "v-frame";
import { microfrontends, type MicrofrontendKey } from "./microfrontends";
import "./App.css";

const microfrontendKeys = Object.keys(microfrontends) as MicrofrontendKey[];

interface LastFrameEvent {
  type: string;
  detail: string;
}

function stringifyEventDetail(detail: unknown): string {
  return JSON.stringify(
    detail,
    (_key, value: unknown) =>
      value instanceof Error ? { name: value.name, message: value.message } : value,
    2,
  );
}

export function App() {
  const [activeKey, setActiveKey] = useState<MicrofrontendKey>("angular");
  const [status, setStatus] = useState<VFrameStatusValue>(VFrameStatus.Idle);
  const [currentURL, setCurrentURL] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<LastFrameEvent | null>(null);
  const frameRef = useRef<VFrameElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    // The element's connectedCallback starts its initial load, and dispatches
    // v-frame-loadstart, synchronously during React's commit phase, before this
    // effect can subscribe. Seed the panel from the element's own getters so the
    // initial "loading" state isn't lost to that race.
    setStatus(frame.status);
    setCurrentURL(frame.currentURL);

    const handleLoadStart = (event: CustomEvent<VFrameLoadStartEventDetail>) => {
      setStatus(VFrameStatus.Loading);
      setLastEvent({ type: event.type, detail: stringifyEventDetail(event.detail) });
    };
    const handleLoad = (event: CustomEvent<VFrameLoadEventDetail>) => {
      setStatus(VFrameStatus.Ready);
      setCurrentURL(event.detail.url);
      setLastEvent({ type: event.type, detail: stringifyEventDetail(event.detail) });
    };
    const handleError = (event: CustomEvent<VFrameErrorEventDetail>) => {
      if (event.detail.fatal) setStatus(VFrameStatus.Error);
      setLastEvent({ type: event.type, detail: stringifyEventDetail(event.detail) });
    };
    const handleNavigate = (event: CustomEvent<VFrameNavigateEventDetail>) => {
      setCurrentURL(event.detail.to);
      setLastEvent({ type: event.type, detail: stringifyEventDetail(event.detail) });
    };

    frame.addEventListener("v-frame-loadstart", handleLoadStart);
    frame.addEventListener("v-frame-load", handleLoad);
    frame.addEventListener("v-frame-error", handleError);
    frame.addEventListener("v-frame-navigate", handleNavigate);

    return () => {
      frame.removeEventListener("v-frame-loadstart", handleLoadStart);
      frame.removeEventListener("v-frame-load", handleLoad);
      frame.removeEventListener("v-frame-error", handleError);
      frame.removeEventListener("v-frame-navigate", handleNavigate);
    };
  }, []);

  const activeTarget = microfrontends[activeKey];

  return (
    <div className="host-app">
      <header className="host-chrome">
        <nav className="tab-nav" aria-label="Microfrontend selection">
          {microfrontendKeys.map((key) => (
            <button
              key={key}
              type="button"
              className={key === activeKey ? "tab tab-active" : "tab"}
              aria-pressed={key === activeKey}
              onClick={() => setActiveKey(key)}
            >
              {microfrontends[key].label}
            </button>
          ))}
        </nav>

        <dl className="status-panel">
          <div className="status-row">
            <dt>Status</dt>
            <dd className={`status-value status-${status}`}>{status}</dd>
          </div>
          <div className="status-row">
            <dt>URL</dt>
            <dd>{currentURL ?? "—"}</dd>
          </div>
          <div className="status-row">
            <dt>Last event</dt>
            <dd className="last-event">
              {lastEvent ? (
                <>
                  <code>{lastEvent.type}</code>
                  <pre>{lastEvent.detail}</pre>
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
      </header>

      <section className="frame-viewport" aria-label={`${activeTarget.label} microfrontend`}>
        <v-frame ref={frameRef} src={activeTarget.url} credentials="omit" />
      </section>
    </div>
  );
}
