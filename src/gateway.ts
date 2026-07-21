import {
  V_FRAME_GATEWAY_HEADER,
  V_FRAME_GATEWAY_VERSION,
  V_FRAME_REALM_MARKER,
} from "./gateway-contract.js";

export interface VFrameRouteOptions {
  request: Request;
  realmHeaders?: HeadersInit;
  loadDocument(): Response | Promise<Response>;
}

function varyByFetchDestination(headers: Headers): void {
  const vary = headers.get("Vary");
  if (vary === null) {
    headers.set("Vary", "Sec-Fetch-Dest");
    return;
  }

  const fields = vary.split(",").map((field) => field.trim().toLowerCase());
  if (fields.includes("*") || fields.includes("sec-fetch-dest")) {
    return;
  }
  headers.set("Vary", `${vary}, Sec-Fetch-Dest`);
}

export async function serveVFrameRoute(options: VFrameRouteOptions): Promise<Response> {
  if (options.request.headers.get("Sec-Fetch-Dest") === "iframe") {
    const headers = new Headers(options.realmHeaders);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    headers.set(V_FRAME_GATEWAY_HEADER, V_FRAME_GATEWAY_VERSION);
    varyByFetchDestination(headers);
    return new Response(
      `<!doctype html><meta name="${V_FRAME_REALM_MARKER}" content="${V_FRAME_GATEWAY_VERSION}">`,
      { headers },
    );
  }

  const documentResponse = await options.loadDocument();
  const headers = new Headers(documentResponse.headers);
  headers.set(V_FRAME_GATEWAY_HEADER, V_FRAME_GATEWAY_VERSION);
  varyByFetchDestination(headers);
  return new Response(documentResponse.body, {
    status: documentResponse.status,
    statusText: documentResponse.statusText,
    headers,
  });
}

export {
  V_FRAME_GATEWAY_HEADER,
  V_FRAME_GATEWAY_VERSION,
  V_FRAME_REALM_MARKER,
};
