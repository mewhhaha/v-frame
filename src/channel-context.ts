import type { VFrameWindow } from "./types.js";

// Independently bundled guests and the host agree on this key across realms.
export const channelContext = Symbol.for("@mewhhaha/v-frame/channel-context/1");

export type ChannelWindow = VFrameWindow & {
  [channelContext]?: { page: ChannelWindow; signal: AbortSignal } | null;
};

export function connectChannels(
  guest: ChannelWindow,
  host: ChannelWindow,
  signal: AbortSignal,
): () => void {
  guest[channelContext] = { page: host[channelContext]?.page ?? host, signal };
  return () => {
    // A detached guest must release the host and stay disconnected when an
    // application still holds one of its callbacks.
    guest[channelContext] = null;
  };
}
