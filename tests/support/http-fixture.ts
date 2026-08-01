import { createReadStream, existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";

/** What a matched route writes back. */
export interface RouteResponse {
  /** Defaults to 200. */
  status?: number;
  /** Defaults to "text/html". */
  type?: string;
  body?: string | Buffer;
  /** Streams this file instead of `body`, replying 404 with `missing` when it is absent. */
  file?: string;
  missing?: string;
  /** Merged over the fixture-wide headers. */
  headers?: Record<string, string>;
  /** Milliseconds to hold the request before writing the response. */
  delay?: number;
}

/**
 * Returning undefined hands the response to the handler, which is how fixtures park a
 * request until a test releases it.
 */
export type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => RouteResponse | undefined | Promise<RouteResponse | undefined>;

/** A bare string is an HTML body served with a 200. */
export type Route = string | RouteResponse | RouteHandler;

export interface FixtureOptions<Recorded> {
  routes: Record<string, Route>;
  /** Serves paths the route table does not name; defaults to a 404. */
  fallback?: Route;
  /** Merged into every response — a fixture-wide CSP, typically. */
  headers?: Record<string, string>;
  /** Defaults to recording the pathname; returning undefined records nothing. */
  record?: (request: IncomingMessage) => Recorded | undefined;
}

export interface HTTPFixture<Recorded = string> {
  origin: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** The built bundle every fixture host page imports to define the element. */
export const bundleRoute: RouteResponse = {
  file: resolve(process.cwd(), "dist/index.js"),
  type: "text/javascript",
  missing: "Build output not found",
};

/** The side-effecting entry point, served alongside the bundle by the contract fixture. */
export const registerBundleRoute: RouteResponse = {
  file: resolve(process.cwd(), "dist/register.js"),
  type: "text/javascript",
  missing: "Register build output not found",
};

export function htmlDocument(body: string, head = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

export function requestPathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://fixture.test").pathname;
}

function writeRoute(
  response: ServerResponse,
  route: RouteResponse,
  fixtureHeaders: Record<string, string>,
) {
  const send = () => {
    const headers = {
      "cache-control": "no-store",
      "content-type": route.type ?? "text/html",
      ...fixtureHeaders,
      ...route.headers,
    };
    if (route.file === undefined) {
      response.writeHead(route.status ?? 200, headers);
      response.end(route.body ?? "");
      return;
    }
    if (!existsSync(route.file)) {
      response.writeHead(404, { ...headers, "content-type": "text/plain" });
      response.end(route.missing ?? `No build output at ${route.file}`);
      return;
    }
    response.writeHead(route.status ?? 200, headers);
    createReadStream(route.file).pipe(response);
  };
  if (route.delay === undefined) {
    send();
    return;
  }
  setTimeout(send, route.delay);
}

async function serveRoute(
  route: Route,
  request: IncomingMessage,
  response: ServerResponse,
  fixtureHeaders: Record<string, string>,
) {
  if (typeof route === "string") {
    writeRoute(response, { body: route }, fixtureHeaders);
    return;
  }
  if (typeof route !== "function") {
    writeRoute(response, route, fixtureHeaders);
    return;
  }
  const result = await route(request, response);
  if (result !== undefined) writeRoute(response, result, fixtureHeaders);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((error) => (error === undefined ? resolveClosed() : reject(error)));
  });
}

/**
 * Every spec's fixture is the same server with a different route table: an ephemeral
 * port on the loopback interface, a recorded request log, and no caching anywhere.
 */
export async function startHTTPFixture<Recorded = string>(
  options: FixtureOptions<Recorded>,
): Promise<HTTPFixture<Recorded>> {
  const requests: Recorded[] = [];
  const fixtureHeaders = options.headers ?? {};
  const routes = new Map(Object.entries(options.routes));
  const server = createServer((request, response) => {
    const path = requestPathname(request);
    const recorded =
      options.record === undefined
        ? (path as unknown as Recorded)
        : options.record(request);
    if (recorded !== undefined) requests.push(recorded);

    const route =
      routes.get(path) ??
      options.fallback ??
      ({ status: 404, type: "text/plain", body: `No fixture for ${path}` } as Route);
    void serveRoute(route, request, response, fixtureHeaders);
  });

  await new Promise<void>((resolveListening) =>
    server.listen(0, "127.0.0.1", resolveListening),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("The fixture server did not expose a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}
