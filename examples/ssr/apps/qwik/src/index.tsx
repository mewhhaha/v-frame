/** @jsxImportSource @builder.io/qwik */
import { renderToStream } from "@builder.io/qwik/server";
import { manifest } from "./manifest.generated.js";
import {
  isWidgetRoute,
  type WikipediaArticleKey,
  type WidgetRoute,
  widgetStyle,
  WorkspaceWidget,
} from "./widget";

type WidgetEndpoint = WidgetRoute | "/document";

function isWidgetEndpoint(pathname: string): pathname is WidgetEndpoint {
  return isWidgetRoute(pathname) || pathname === "/document";
}

function widgetBuildBase(url: URL): string {
  const requestedBase = url.searchParams.get("base");
  if (requestedBase === "/build/" || requestedBase === "/widgets/qwik/build/") {
    return requestedBase;
  }
  return "/build/";
}

function requestedRoute(url: URL, pathname: WidgetEndpoint): WidgetRoute {
  if (isWidgetRoute(pathname)) {
    return pathname;
  }
  const route = url.searchParams.get("route");
  return route !== null && isWidgetRoute(route) ? route : "/inventory";
}

function requestedSurface(url: URL): "definition" | "page" | "profile" {
  const surface = url.searchParams.get("surface");
  if (surface === "definition" || surface === "profile") return surface;
  return "page";
}

function requestedArticle(url: URL): WikipediaArticleKey {
  const article = url.searchParams.get("article");
  if (article === "brief" || article === "research") return article;
  return "migration";
}

async function renderWidget(url: URL, pathname: WidgetEndpoint): Promise<string> {
  const chunks: string[] = [];
  await renderToStream(
    <WorkspaceWidget
      articleKey={requestedArticle(url)}
      initialRoute={requestedRoute(url, pathname)}
      surface={requestedSurface(url)}
    />,
    {
      base: widgetBuildBase(url),
      containerTagName: "div",
      manifest,
      preloader: false,
      qwikLoader: "module",
      snapshot: true,
      stream: {
        write(chunk) {
          chunks.push(chunk);
        },
      },
      streaming: { inOrder: { strategy: "disabled" } },
    },
  );
  return chunks.join("");
}

function networkDocument(markup: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${widgetStyle}</style></head><body>${markup}</body></html>`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("method not allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const url = new URL(request.url);
    const { pathname } = url;
    if (!isWidgetEndpoint(pathname)) {
      return new Response("Qwik widget not found", { status: 404 });
    }

    const markup = await renderWidget(url, pathname);
    return new Response(networkDocument(markup), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  },
} satisfies ExportedHandler;
