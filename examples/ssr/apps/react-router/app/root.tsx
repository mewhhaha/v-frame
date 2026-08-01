import type { ReactNode } from "react";
import { isRouteErrorResponse, Meta, Outlet, Scripts } from "react-router";

import type { Route } from "./+types/root";
import { widgetStyle } from "./widget";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <style>{widgetStyle}</style>
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <div id="react-router-root">
      <Outlet />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "The React Router application could not render this route.";

  return (
    <main className="activity-widget">
      <p>{message}</p>
    </main>
  );
}
