import { composeFrames } from "@mewhhaha/v-frame/server";
import { createRequestHandler } from "react-router";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

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

    const fetchGuest = (guest: Request) => {
      if (new URL(guest.url).pathname.startsWith("/widgets/qwik/"))
        return env.QWIK_WIDGET.fetch(
          new Request(guest.url, {
            headers: { Accept: guest.headers.get("Accept") ?? "*/*" },
            redirect: "manual",
            signal: guest.signal,
          }),
        );
      return new Response("Unknown guest mount", { status: 404 });
    };
    if (url.pathname.startsWith("/widgets/qwik/")) return fetchGuest(request);
    return composeFrames(await requestHandler(request), { request, fetchGuest });
  },
} satisfies ExportedHandler<Env>;
