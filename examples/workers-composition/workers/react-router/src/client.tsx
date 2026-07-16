import { useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { ReleaseActivityWidget } from "./widget";

interface WidgetRoot {
  dataset: Record<string, string | undefined>;
}

const browserDocument = globalThis as typeof globalThis & {
  document?: {
    documentElement: WidgetRoot;
    getElementById(id: string): WidgetRoot | null;
  };
};
const container = browserDocument.document?.getElementById("react-router-widget-root") ?? null;
if (container === null) {
  throw new Error("React Router widget root #react-router-widget-root is missing");
}

const basename = container.dataset.routerBasename;
const routingFrameId = container.dataset.routingFrameId;
if (basename === undefined || routingFrameId === undefined) {
  throw new Error("React Router widget root is missing routing configuration");
}
const configuredBasename = basename;
const configuredRoutingFrameId = routingFrameId;

function setHydrationFlag(name: "reactHydrated" | "reactHydrationError"): void {
  const html = browserDocument.document?.documentElement;
  if (html !== undefined) {
    html.dataset[name] = "true";
  }
}

let resolveHydrationCommit: () => void;
const hydrationCommitted = new Promise<void>((resolve) => {
  resolveHydrationCommit = resolve;
});

function HydrationCommit() {
  useEffect(() => {
    resolveHydrationCommit();
  }, []);

  return <ReleaseActivityWidget routingFrameId={configuredRoutingFrameId} />;
}

hydrateRoot(
  container as Parameters<typeof hydrateRoot>[0],
  <BrowserRouter basename={configuredBasename}>
    <HydrationCommit />
  </BrowserRouter>,
  {
    onRecoverableError(error, errorDetails) {
      setHydrationFlag("reactHydrationError");
      console.error("React Router widget recovered from a hydration error", {
        error,
        componentStack: errorDetails.componentStack,
      });
    },
  },
);

await hydrationCommitted;
setHydrationFlag("reactHydrated");
