import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToReadableStream } from "react-dom/server.edge";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        console.error("React Router streaming render failed", error);
      },
    },
  );
  await body.allReady;
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
