import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";

import {
  isWidgetRoute,
  ReleaseActivityWidget,
  type WidgetRoute,
  widgetStyle,
} from "./widget";

const clientModulePath = "/assets/react-router-widget-client.js";
const contentType = "text/html; charset=utf-8";

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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${widgetStyle}</style></head><body>${markup}<script type="module" src="${moduleURL}"></script></body></html>`;
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
  fetch(request: Request): Response {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
    }

    const url = new URL(request.url);
    if (isWidgetRoute(url.pathname)) {
      return documentResponse(renderContext("/", url.pathname, "react-router-widget"));
    }
    if (url.pathname === "/document" || url.pathname === "/preview") {
      const context = renderContext(
        normalizedBasePath(url.searchParams.get("base")),
        requestedRoute(url.searchParams.get("route")),
        requestedFrameId(url.searchParams.get("frameId")),
      );
      return url.pathname === "/document" ? documentResponse(context) : previewResponse(context);
    }
    return new Response("React Router widget not found", { status: 404 });
  },
} satisfies ExportedHandler;
