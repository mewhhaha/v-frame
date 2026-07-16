/** @jsxImportSource @builder.io/qwik */
import { renderToStream } from "@builder.io/qwik/server";
import { manifest } from "@qwik-client-manifest";
import {
  isWidgetRoute,
  type WidgetRoute,
  widgetStyle,
  WorkspaceWidget,
} from "./widget";

type WidgetEndpoint = WidgetRoute | "/preview" | "/document";

function isWidgetEndpoint(pathname: string): pathname is WidgetEndpoint {
  return isWidgetRoute(pathname) || pathname === "/preview" || pathname === "/document";
}

function widgetBuildBase(url: URL, pathname: WidgetEndpoint): string {
  const requestedBase = url.searchParams.get("base");
  if (requestedBase === "/build/" || requestedBase === "/widgets/qwik/build/") {
    return requestedBase;
  }
  return pathname === "/preview" ? "/widgets/qwik/build/" : "/build/";
}

function requestedRoute(url: URL, pathname: WidgetEndpoint): WidgetRoute {
  if (isWidgetRoute(pathname)) {
    return pathname;
  }
  const route = url.searchParams.get("route");
  return route !== null && isWidgetRoute(route) ? route : "/inventory";
}

async function renderWidget(url: URL, pathname: WidgetEndpoint): Promise<string> {
  const chunks: string[] = [];
  await renderToStream(<WorkspaceWidget initialRoute={requestedRoute(url, pathname)} />, {
    base: widgetBuildBase(url, pathname),
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
  });
  return chunks.join("");
}

function inertScripts(markup: string): string {
  return markup.replace(/<script\b([^>]*)>/gi, (_match, attributes: string) => {
    const typeMatch = /\stype=("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attributes);
    const type = typeMatch?.[1].replace(/^['"]|['"]$/g, "");
    const remainingAttributes = attributes
      .replace(/\sdata-v-frame-(?:script|type)(?:=("[^"]*"|'[^']*'|[^\s>]+))?/gi, "")
      .replace(/\stype=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    const authoredType = type === undefined ? "" : ` data-v-frame-type="${type}"`;
    return `<script type="application/vnd.v-frame" data-v-frame-script${authoredType}${remainingAttributes}>`;
  });
}

function materializedDocument(markup: string): string {
  return `<v-html lang="en"><v-head><style>v-html, v-body { display: block; } v-head { display: none; } ${widgetStyle}</style></v-head><v-body>${inertScripts(markup)}</v-body></v-html>`;
}

function networkDocument(markup: string): string {
  return `<!doctype html><html lang="en"><head><style>${widgetStyle}</style></head><body>${markup}</body></html>`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
    }

    const url = new URL(request.url);
    const { pathname } = url;
    if (!isWidgetEndpoint(pathname)) {
      return new Response("Qwik widget not found", { status: 404 });
    }

    const markup = await renderWidget(url, pathname);
    return new Response(
      pathname === "/preview" ? materializedDocument(markup) : networkDocument(markup),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
} satisfies ExportedHandler;
