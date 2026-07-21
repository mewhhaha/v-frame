import { startTransition, useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "v-frame/register";

import { ReleaseActivityWidget } from "./widget";

function HydratedWidget() {
  useEffect(() => {
    document.documentElement.dataset.reactHydrated = "true";
  }, []);

  return <ReleaseActivityWidget routingFrameId="react-router" />;
}

const root = document.getElementById("react-router-root");
if (root === null) {
  throw new Error("React Router document is missing #react-router-root");
}

startTransition(() => {
  hydrateRoot(
    root,
    <BrowserRouter basename="/widgets/react-router">
      <HydratedWidget />
    </BrowserRouter>,
    {
      onRecoverableError(error, errorDetails) {
        document.documentElement.dataset.reactHydrationError = "true";
        console.error("React Router recovered from a hydration error", {
          error,
          componentStack: errorDetails.componentStack,
        });
      },
    },
  );
});
