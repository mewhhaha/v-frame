export const routingProtocol = "v-frame-routing";
export const routingVersion = 1;
export const routingChannelPrefix = `v-frame:routing:v${routingVersion}:`;
export const routingSessionStorageKey = "v-frame:routing-session";

export type NavigationMode = "push" | "replace" | "traverse";

export interface RoutingMessage {
  protocol: typeof routingProtocol;
  version: typeof routingVersion;
  sessionId: string;
  messageId: string;
  source: string;
  target: string;
  kind: "hello" | "navigate-request" | "route-change";
  route?: string;
  mode?: NavigationMode;
}

interface SessionStorageLike {
  getItem(key: string): string | null;
}

function isRoutingId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function routingMessageId(): string | null {
  try {
    return globalThis.crypto?.randomUUID() ?? null;
  } catch {
    return null;
  }
}

function isNavigationMode(value: unknown): value is NavigationMode {
  return value === "push" || value === "replace" || value === "traverse";
}

export function routingSessionId(): string | null {
  const browser = globalThis as typeof globalThis & { sessionStorage?: SessionStorageLike };
  try {
    const sessionId = browser.sessionStorage?.getItem(routingSessionStorageKey) ?? null;
    return sessionId !== null && isRoutingId(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

export function openRoutingChannel(sessionId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel !== "function") {
    return null;
  }

  try {
    return new BroadcastChannel(`${routingChannelPrefix}${sessionId}`);
  } catch {
    return null;
  }
}

export function isRoutingMessage(value: unknown): value is RoutingMessage {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const message = value as Partial<RoutingMessage>;
  if (
    message.protocol !== routingProtocol
    || message.version !== routingVersion
    || typeof message.sessionId !== "string"
    || !isRoutingId(message.sessionId)
    || typeof message.messageId !== "string"
    || !isRoutingId(message.messageId)
    || typeof message.source !== "string"
    || typeof message.target !== "string"
    || (message.kind !== "hello" && message.kind !== "navigate-request" && message.kind !== "route-change")
  ) {
    return false;
  }

  return message.kind === "hello"
    || (typeof message.route === "string" && isNavigationMode(message.mode));
}

export function postRoutingMessage(
  channel: BroadcastChannel,
  message: Omit<RoutingMessage, "messageId">,
): boolean {
  const messageId = routingMessageId();
  if (messageId === null) {
    return false;
  }

  try {
    channel.postMessage({ ...message, messageId });
    return true;
  } catch {
    return false;
  }
}
