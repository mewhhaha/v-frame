import { AngularAppEngine, createRequestHandler } from "@angular/ssr";

const angularApp = new AngularAppEngine({
  allowedHosts: ["127.0.0.1", "localhost", "angular-widget.internal"],
});

interface AngularWorkerEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export const requestHandler = createRequestHandler(async (request) => {
  const response = await angularApp.handle(request);
  if (response === null) {
    return new Response("Angular widget not found", { status: 404 });
  }

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
});

export default {
  async fetch(
    request: Request,
    environment: AngularWorkerEnvironment,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/widgets/angular/")) {
      const assetURL = new URL(request.url);
      assetURL.pathname = url.pathname.slice("/widgets/angular".length);
      const assetResponse = await environment.ASSETS.fetch(
        new Request(assetURL, request),
      );
      if (assetResponse.status !== 404) return assetResponse;
    }

    const renderedResponse = await requestHandler(request);
    return renderedResponse ?? new Response("Angular widget not found", { status: 404 });
  },
};
