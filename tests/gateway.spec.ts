import { expect, test } from "@playwright/test";
import {
  serveVFrameRoute,
  V_FRAME_GATEWAY_HEADER,
  V_FRAME_GATEWAY_VERSION,
  V_FRAME_REALM_MARKER,
} from "../src/gateway.js";

test("serves an inert realm document for iframe route requests", async () => {
  let documentLoads = 0;
  const response = await serveVFrameRoute({
    request: new Request("https://host.test/widgets/orders", {
      headers: { "Sec-Fetch-Dest": "iframe" },
    }),
    realmHeaders: {
      "Content-Security-Policy": "script-src 'self' 'nonce-realm'",
    },
    loadDocument() {
      documentLoads += 1;
      return new Response("application document");
    },
  });

  expect(documentLoads).toBe(0);
  expect(response.headers.get(V_FRAME_GATEWAY_HEADER)).toBe(V_FRAME_GATEWAY_VERSION);
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "script-src 'self' 'nonce-realm'",
  );
  expect(response.headers.get("Vary")).toBe("Sec-Fetch-Dest");
  expect(await response.text()).toContain(
    `<meta name="${V_FRAME_REALM_MARKER}" content="${V_FRAME_GATEWAY_VERSION}">`,
  );
});

test("advertises ordinary fragment documents without changing their response", async () => {
  const response = await serveVFrameRoute({
    request: new Request("https://host.test/widgets/orders"),
    loadDocument: () => new Response("application document", {
      status: 202,
      statusText: "Accepted",
      headers: {
        "Vary": "Accept-Encoding",
        "X-Application": "orders",
      },
    }),
  });

  expect(response.status).toBe(202);
  expect(response.statusText).toBe("Accepted");
  expect(response.headers.get("X-Application")).toBe("orders");
  expect(response.headers.get("Vary")).toBe("Accept-Encoding, Sec-Fetch-Dest");
  expect(response.headers.get(V_FRAME_GATEWAY_HEADER)).toBe(V_FRAME_GATEWAY_VERSION);
  expect(await response.text()).toBe("application document");
});

test("serves the composed shell for a bound top-level navigation", async () => {
  let applicationLoads = 0;
  const response = await serveVFrameRoute({
    request: new Request("https://host.test/orders/42", {
      headers: { "Sec-Fetch-Dest": "document" },
    }),
    loadDocument() {
      applicationLoads += 1;
      return new Response("application document");
    },
    loadShell: () => new Response("composed shell", {
      headers: { "X-Shell": "true" },
    }),
  });

  expect(applicationLoads).toBe(0);
  expect(response.headers.get("X-Shell")).toBe("true");
  expect(response.headers.get("Vary")).toBe("Sec-Fetch-Dest");
  expect(await response.text()).toBe("composed shell");
});

test("preserves an existing wildcard cache variance", async () => {
  const response = await serveVFrameRoute({
    request: new Request("https://host.test/widgets/orders", {
      headers: { "Sec-Fetch-Dest": "iframe" },
    }),
    realmHeaders: { "Vary": "*" },
    loadDocument: () => new Response("application document"),
  });

  expect(response.headers.get("Vary")).toBe("*");
});
