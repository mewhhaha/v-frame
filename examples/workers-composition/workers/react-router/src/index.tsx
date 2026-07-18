import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";

import vFrameInlineScript from "../../host/generated/v-frame-inline.txt";
import {
  isWidgetRoute,
  ReleaseActivityWidget,
  type WidgetRoute,
  widgetStyle,
} from "./widget";

const clientModulePath = "/assets/react-router-widget-client.js";
const contentType = "text/html; charset=utf-8";
const embeddedVFrameScript = vFrameInlineScript.replace(/<\/script/gi, "<\\/script");

interface RenderContext {
  basename: string;
  route: WidgetRoute;
  routingFrameId: string;
  virtualPath: string;
}

function normalizedBasePath(value: string | null): string {
  if (value === null || !value.startsWith("/")) {
    return "/";
  }
  const normalized = value.replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

function requestedRoute(value: string | null): WidgetRoute {
  return value !== null && isWidgetRoute(value) ? value : "/activity";
}

function requestedFrameId(value: string | null): string {
  return value === null ? "react-router-widget" : value;
}

function virtualPath(basename: string, route: WidgetRoute): string {
  return basename === "/" ? route : `${basename}${route}`;
}

function renderContext(basename: string, route: WidgetRoute, routingFrameId: string): RenderContext {
  return { basename, route, routingFrameId, virtualPath: virtualPath(basename, route) };
}

function renderWidget(context: RenderContext): string {
  return renderToString(
    <div
      id="react-router-widget-root"
      data-router-basename={context.basename}
      data-routing-frame-id={context.routingFrameId}
    >
      <StaticRouter basename={context.basename} location={context.virtualPath}>
        <ReleaseActivityWidget routingFrameId={context.routingFrameId} />
      </StaticRouter>
    </div>,
  );
}

function clientModuleURL(basename: string): string {
  return basename === "/" ? clientModulePath : `${basename}${clientModulePath}`;
}

function materializedDocument(markup: string, moduleURL: string): string {
  return `<v-html lang="en"><v-head><style>v-html, v-body { display: block; } v-head { display: none; } ${widgetStyle}</style></v-head><v-body>${markup}<script type="application/vnd.v-frame" data-v-frame-script data-v-frame-type="module" src="${moduleURL}"></script></v-body></v-html>`;
}

function networkDocument(markup: string, moduleURL: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${widgetStyle}</style></head><body>${markup}<script>${embeddedVFrameScript}</script><script type="module" src="${moduleURL}"></script></body></html>`;
}

function documentResponse(context: RenderContext): Response {
  return new Response(networkDocument(renderWidget(context), clientModuleURL(context.basename)), {
    headers: { "Content-Type": contentType },
  });
}

function previewResponse(context: RenderContext): Response {
  return new Response(materializedDocument(renderWidget(context), clientModuleURL(context.basename)), {
    headers: { "Content-Type": contentType },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith("/widgets/qwik/")) {
      const mountedPath = url.pathname.slice("/widgets/qwik".length);
      const componentPath = mountedPath === "/inventory" || mountedPath === "/catalog"
        ? `/document?route=${encodeURIComponent(mountedPath)}&base=/widgets/qwik/build/`
        : mountedPath + url.search;
      return env.QWIK_WIDGET.fetch(new Request(`https://qwik-widget.internal${componentPath}`, {
        headers: { Accept: "text/html" },
      }));
    }
    let context: RenderContext;
    let endpoint: "/document" | "/preview";
    if (isWidgetRoute(url.pathname)) {
      context = renderContext("/", url.pathname, "react-router-widget");
      endpoint = "/document";
    } else if (url.pathname === "/document" || url.pathname === "/preview") {
      context = renderContext(
        normalizedBasePath(url.searchParams.get("base")),
        requestedRoute(url.searchParams.get("route")),
        requestedFrameId(url.searchParams.get("frameId")),
      );
      endpoint = url.pathname;
    } else {
      return new Response("React Router widget not found", { status: 404 });
    }

    const response = endpoint === "/document"
      ? documentResponse(context)
      : previewResponse(context);
    if (context.route !== "/activity") {
      return response;
    }

    const nestedPreviewResponse = await env.QWIK_WIDGET.fetch(new Request(
      "https://qwik-widget.internal/preview?route=%2Finventory&base=%2Fwidgets%2Fqwik%2Fbuild%2F",
      { headers: { Accept: "text/html" } },
    ));
    if (!nestedPreviewResponse.ok) {
      console.error(JSON.stringify({
        message: "Nested SSR widget composition failed",
        status: nestedPreviewResponse.status,
        widget: "qwik",
      }));
      return new Response(
        `Nested SSR widget qwik returned status ${nestedPreviewResponse.status}`,
        { status: 502 },
      );
    }

    const nestedPreview = await nestedPreviewResponse.text();
    return new HTMLRewriter()
      .on("v-frame.nested-workspace-widget", {
        element(element) {
          element.setAttribute("adopt", "");
          element.setInnerContent(
            `<template shadowrootmode="open" shadowrootserializable>${nestedPreview}</template>`,
            { html: true },
          );
        },
      })
      .transform(response);
  },
} satisfies ExportedHandler<Env>;
