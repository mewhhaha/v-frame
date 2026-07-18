import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

import {
  isRoutingMessage,
  openRoutingChannel,
  postRoutingMessage,
  routingProtocol,
  routingSessionId,
  routingVersion,
} from "../../shared/routing";
import { isWidgetRoute, type WidgetRoute } from "./widget";

function routeFromLocation(location: { pathname: string }): WidgetRoute | null {
  return isWidgetRoute(location.pathname) ? location.pathname : null;
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
    if (routingFrameId === "") {
      return;
    }

    const sessionId = routingSessionId();
    if (sessionId === null) {
      return;
    }

    const channel = openRoutingChannel(sessionId);
    if (channel === null) {
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
        || !isWidgetRoute(message.route)
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
    const didPostHello = postRoutingMessage(channel, {
      protocol: routingProtocol,
      version: routingVersion,
      sessionId,
      source: routingFrameId,
      target: "host",
      kind: "hello",
    });
    if (!didPostHello) {
      channel.removeEventListener("message", receiveRouteChange);
      channel.close();
      channelReference.current = null;
      sessionReference.current = null;
      return;
    }

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
