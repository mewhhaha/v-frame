import type { IncomingMessage, ServerResponse } from "node:http";
import {
  V_FRAME_GATEWAY_HEADER,
  V_FRAME_GATEWAY_VERSION,
  V_FRAME_REALM_MARKER,
} from "../../src/gateway-contract.js";

export function serveRealmMarker(
  request: IncomingMessage,
  response: ServerResponse,
  headers: Record<string, string> = {},
): boolean {
  if (request.headers["sec-fetch-dest"] !== "iframe") {
    return false;
  }

  response.writeHead(200, {
    ...headers,
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "vary": "Sec-Fetch-Dest",
    [V_FRAME_GATEWAY_HEADER]: V_FRAME_GATEWAY_VERSION,
  });
  response.end(
    `<!doctype html><meta name="${V_FRAME_REALM_MARKER}" content="${V_FRAME_GATEWAY_VERSION}">`,
  );
  return true;
}
