import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

function qwikRequest(request: Request, env: Env): Promise<Response> | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/widgets/qwik/")) return null;

  const mountedPath = url.pathname.slice("/widgets/qwik".length);
  let componentPath = mountedPath + url.search;
  if (mountedPath === "/inventory" || mountedPath === "/catalog") {
    const componentParameters = new URLSearchParams({
      route: mountedPath,
      base: "/widgets/qwik/build/",
    });
    if (url.searchParams.get("surface") === "definition") {
      componentParameters.set("surface", "definition");
      const article = url.searchParams.get("article");
      if (article !== null) componentParameters.set("article", article);
    }
    componentPath = `/document?${componentParameters}`;
  }

  return env.QWIK_WIDGET.fetch(
    new Request(`https://qwik-widget.internal${componentPath}`, {
      headers: { Accept: "text/html" },
    }),
  );
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/widgets/react-router/assets/")) {
      const assetURL = new URL(request.url);
      assetURL.pathname = url.pathname.slice("/widgets/react-router".length);
      return env.ASSETS.fetch(new Request(assetURL, request));
    }

    return qwikRequest(request, env) ?? requestHandler(request);
  },
} satisfies ExportedHandler<Env>;
