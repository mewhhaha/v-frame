import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

import { isWidgetRoute, type WidgetRoute } from "./widget";

const routingSessionStorageKey = "v-frame:routing-session";
const routingProtocol = "v-frame-routing";
const routingVersion = 1;

type NavigationMode = "push" | "replace" | "traverse";

interface RoutingMessage {
  protocol: typeof routingProtocol;
  version: typeof routingVersion;
  sessionId: string;
  messageId: string;
  source: string;
  target: string;
  kind: "hello" | "navigate-request" | "route-change";
  route?: WidgetRoute;
  mode?: NavigationMode;
}

interface SessionStorageLike {
  getItem(key: string): string | null;
}

function sessionStorage(): SessionStorageLike | null {
  const candidate = globalThis as typeof globalThis & { sessionStorage?: SessionStorageLike };
  return candidate.sessionStorage ?? null;
}

function routingSessionId(): string | null {
  try {
    const storage = sessionStorage();
    const sessionId = storage?.getItem(routingSessionStorageKey) ?? null;
    return sessionId !== null && isRoutingSessionId(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

function isRoutingSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function routingMessageId(): string | null {
  return globalThis.crypto?.randomUUID() ?? null;
}

function routeFromLocation(location: { pathname: string }): WidgetRoute | null {
  return isWidgetRoute(location.pathname) ? location.pathname : null;
}

function isNavigationMode(value: unknown): value is NavigationMode {
  return value === "push" || value === "replace" || value === "traverse";
}

function isRoutingMessage(value: unknown): value is RoutingMessage {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const message = value as Partial<RoutingMessage>;
  if (
    message.protocol !== routingProtocol
    || message.version !== routingVersion
    || typeof message.sessionId !== "string"
    || !isRoutingSessionId(message.sessionId)
    || typeof message.messageId !== "string"
    || !isRoutingSessionId(message.messageId)
    || typeof message.source !== "string"
    || typeof message.target !== "string"
    || (message.kind !== "hello" && message.kind !== "navigate-request" && message.kind !== "route-change")
  ) {
    return false;
  }

  return message.kind === "hello"
    || (typeof message.route === "string" && isWidgetRoute(message.route) && isNavigationMode(message.mode));
}

function postRoutingMessage(
  channel: BroadcastChannel,
  message: Omit<RoutingMessage, "messageId">,
): void {
  const messageId = routingMessageId();
  if (messageId !== null) {
    channel.postMessage({ ...message, messageId });
  }
}

export function useWidgetRouteAdapter(routingFrameId: string): void {
  const location = useLocation();
  const navigate = useNavigate();
  const channelReference = useRef<BroadcastChannel | null>(null);
  const currentRouteReference = useRef<WidgetRoute | null>(routeFromLocation(location));
  const hostRouteReference = useRef<WidgetRoute | null>(null);
  const navigateReference = useRef(navigate);
  const sessionReference = useRef<string | null>(null);
  currentRouteReference.current = routeFromLocation(location);
  navigateReference.current = navigate;

  useEffect(() => {
    const sessionId = routingSessionId();
    if (routingFrameId === "" || sessionId === null || typeof BroadcastChannel !== "function") {
      return;
    }

    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(`v-frame:routing:v1:${sessionId}`);
    } catch {
      return;
    }
    const receiveRouteChange = (event: MessageEvent<unknown>) => {
      if (event.origin !== globalThis.location.origin || !isRoutingMessage(event.data)) {
        return;
      }
      const message = event.data;
      if (
        message.sessionId !== sessionId
        || message.source !== "host"
        || message.target !== routingFrameId
        || message.kind !== "route-change"
        || message.route === undefined
        || message.mode === undefined
      ) {
        return;
      }
      if (currentRouteReference.current === message.route) {
        return;
      }
      hostRouteReference.current = message.route;
      navigateReference.current(message.route, { replace: message.mode !== "push" });
    };

    channel.addEventListener("message", receiveRouteChange);
    channelReference.current = channel;
    sessionReference.current = sessionId;
    postRoutingMessage(channel, {
      protocol: routingProtocol,
      version: routingVersion,
      sessionId,
      source: routingFrameId,
      target: "host",
      kind: "hello",
    });

    return () => {
      channel.removeEventListener("message", receiveRouteChange);
      channel.close();
      channelReference.current = null;
      sessionReference.current = null;
    };
  }, [routingFrameId]);

  useEffect(() => {
    const route = routeFromLocation(location);
    const channel = channelReference.current;
    const sessionId = sessionReference.current;
    if (route === null || channel === null || sessionId === null) {
      return;
    }
    if (hostRouteReference.current === route) {
      hostRouteReference.current = null;
      return;
    }

    postRoutingMessage(channel, {
      protocol: routingProtocol,
      version: routingVersion,
      sessionId,
      source: routingFrameId,
      target: "host",
      kind: "navigate-request",
      route,
      mode: "push",
    });
  }, [location, routingFrameId]);
}
