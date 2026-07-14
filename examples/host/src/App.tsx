import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
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

type FrameSlot = "primary" | "secondary";

interface PendingFrameRequest {
  key: MicrofrontendKey;
  slot: FrameSlot;
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
  const [activeSlot, setActiveSlot] = useState<FrameSlot>("primary");
  const [pendingKey, setPendingKey] = useState<MicrofrontendKey | null>(null);
  const [status, setStatus] = useState<VFrameStatusValue>(VFrameStatus.Idle);
  const [currentURL, setCurrentURL] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<LastFrameEvent | null>(null);
  const primaryFrameRef = useRef<VFrameElement>(null);
  const secondaryFrameRef = useRef<VFrameElement>(null);
  const activeSlotRef = useRef<FrameSlot>("primary");
  const pendingRequestRef = useRef<PendingFrameRequest | null>(null);

  useEffect(() => {
    const primaryFrame = primaryFrameRef.current;
    const secondaryFrame = secondaryFrameRef.current;
    if (!primaryFrame || !secondaryFrame) return;

    const frameForSlot = (slot: FrameSlot) =>
      slot === "primary" ? primaryFrame : secondaryFrame;

    const recordEvent = (event: CustomEvent<unknown>) => {
      setLastEvent({ type: event.type, detail: stringifyEventDetail(event.detail) });
    };

    const handleLoadStart = (
      slot: FrameSlot,
      event: CustomEvent<VFrameLoadStartEventDetail>,
    ) => {
      const pendingRequest = pendingRequestRef.current;
      if (slot !== activeSlotRef.current && pendingRequest?.slot !== slot) return;

      setStatus(VFrameStatus.Loading);
      recordEvent(event);
    };
    const handleLoad = (slot: FrameSlot, event: CustomEvent<VFrameLoadEventDetail>) => {
      const pendingRequest = pendingRequestRef.current;
      if (pendingRequest?.slot === slot) {
        const commitLoadedFrame = () => {
          if (pendingRequestRef.current !== pendingRequest) return;

          activeSlotRef.current = slot;
          pendingRequestRef.current = null;
          flushSync(() => {
            setActiveSlot(slot);
            setActiveKey(pendingRequest.key);
            setPendingKey(null);
            setStatus(VFrameStatus.Ready);
            setCurrentURL(event.detail.url);
            recordEvent(event);
          });

          const previousSlot = slot === "primary" ? "secondary" : "primary";
          frameForSlot(previousSlot).src = "";
        };

        if (document.startViewTransition) {
          document.startViewTransition(commitLoadedFrame);
        } else {
          commitLoadedFrame();
        }
        return;
      }

      if (slot !== activeSlotRef.current) return;
      setStatus(VFrameStatus.Ready);
      setCurrentURL(event.detail.url);
      recordEvent(event);
    };
    const handleError = (slot: FrameSlot, event: CustomEvent<VFrameErrorEventDetail>) => {
      const pendingRequest = pendingRequestRef.current;
      if (pendingRequest?.slot === slot && event.detail.fatal) {
        pendingRequestRef.current = null;
        frameForSlot(slot).src = "";
        setPendingKey(null);
        setStatus(VFrameStatus.Error);
        recordEvent(event);
        return;
      }

      if (slot !== activeSlotRef.current && pendingRequest?.slot !== slot) return;
      if (event.detail.fatal) setStatus(VFrameStatus.Error);
      recordEvent(event);
    };
    const handleNavigate = (
      slot: FrameSlot,
      event: CustomEvent<VFrameNavigateEventDetail>,
    ) => {
      if (slot !== activeSlotRef.current) return;
      setCurrentURL(event.detail.to);
      recordEvent(event);
    };

    const attachListeners = (slot: FrameSlot, frame: VFrameElement) => {
      const onLoadStart = (event: CustomEvent<VFrameLoadStartEventDetail>) =>
        handleLoadStart(slot, event);
      const onLoad = (event: CustomEvent<VFrameLoadEventDetail>) => handleLoad(slot, event);
      const onError = (event: CustomEvent<VFrameErrorEventDetail>) => handleError(slot, event);
      const onNavigate = (event: CustomEvent<VFrameNavigateEventDetail>) =>
        handleNavigate(slot, event);

      frame.addEventListener("v-frame-loadstart", onLoadStart);
      frame.addEventListener("v-frame-load", onLoad);
      frame.addEventListener("v-frame-error", onError);
      frame.addEventListener("v-frame-navigate", onNavigate);

      return () => {
        frame.removeEventListener("v-frame-loadstart", onLoadStart);
        frame.removeEventListener("v-frame-load", onLoad);
        frame.removeEventListener("v-frame-error", onError);
        frame.removeEventListener("v-frame-navigate", onNavigate);
      };
    };

    const detachPrimaryListeners = attachListeners("primary", primaryFrame);
    const detachSecondaryListeners = attachListeners("secondary", secondaryFrame);
    if (primaryFrame.src === "") {
      primaryFrame.src = microfrontends.angular.url;
    }

    return () => {
      detachPrimaryListeners();
      detachSecondaryListeners();
    };
  }, []);

  const activeTarget = microfrontends[activeKey];
  const selectMicrofrontend = (key: MicrofrontendKey) => {
    if (key === activeKey || pendingRequestRef.current) return;

    const slot = activeSlotRef.current === "primary" ? "secondary" : "primary";
    const frame = slot === "primary" ? primaryFrameRef.current : secondaryFrameRef.current;
    if (!frame) return;

    pendingRequestRef.current = { key, slot };
    setPendingKey(key);
    frame.src = microfrontends[key].url;
  };

  return (
    <div className="host-app">
      <header className="host-chrome">
        <nav className="tab-nav" aria-label="Microfrontend selection">
          {microfrontendKeys.map((key) => (
            <button
              key={key}
              type="button"
              className={
                key === activeKey
                  ? "tab tab-active"
                  : key === pendingKey
                    ? "tab tab-pending"
                    : "tab"
              }
              aria-pressed={key === activeKey}
              aria-busy={key === pendingKey}
              disabled={pendingKey !== null}
              onClick={() => selectMicrofrontend(key)}
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

      <section
        className="frame-viewport"
        aria-label={`${activeTarget.label} microfrontend`}
        aria-busy={pendingKey !== null}
      >
        <v-frame
          ref={primaryFrameRef}
          className={
            activeSlot === "primary"
              ? "frame-slot frame-slot-active"
              : "frame-slot frame-slot-inactive"
          }
          aria-hidden={activeSlot !== "primary"}
          credentials="omit"
        />
        <v-frame
          ref={secondaryFrameRef}
          className={
            activeSlot === "secondary"
              ? "frame-slot frame-slot-active"
              : "frame-slot frame-slot-inactive"
          }
          aria-hidden={activeSlot !== "secondary"}
          credentials="omit"
        />
      </section>
    </div>
  );
}
