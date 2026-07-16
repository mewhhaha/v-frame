import { useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";

import { useWidgetRouteAdapter } from "./routing";

export const widgetRoutes = ["/activity", "/history"] as const;

export type WidgetRoute = typeof widgetRoutes[number];

export function isWidgetRoute(value: string): value is WidgetRoute {
  return (widgetRoutes as readonly string[]).includes(value);
}

function Navigation() {
  return (
    <nav aria-label="Release activity navigation" className="widget-navigation">
      <Link to="/activity">Activity</Link>
      <Link to="/history">History</Link>
    </nav>
  );
}

function ActivityPage() {
  const [updatesAcknowledged, setUpdatesAcknowledged] = useState(false);

  return (
    <section aria-labelledby="activity-title">
      <span className="widget-kicker">React Router SSR Worker</span>
      <h2 id="activity-title">Release activity</h2>
      <p className="widget-copy">The widget owns this state after hydration.</p>
      <ol className="activity-list">
        <li><strong>Design tokens</strong><span>Published 12 minutes ago</span></li>
        <li><strong>Checkout shell</strong><span>Promoted to production</span></li>
        <li><strong>Search widget</strong><span>Preview is ready</span></li>
      </ol>
      <button type="button" onClick={() => setUpdatesAcknowledged(true)}>
        Acknowledge updates
      </button>
      <output aria-live="polite">
        {updatesAcknowledged ? "All caught up" : "3 updates waiting"}
      </output>
    </section>
  );
}

function HistoryPage() {
  return (
    <section aria-labelledby="history-title">
      <span className="widget-kicker">React Router SSR Worker</span>
      <h2 id="history-title">Release history</h2>
      <p className="widget-copy">Recent releases remain available inside this isolated router.</p>
      <ol className="history-list">
        <li><time dateTime="2026-07-13">Yesterday</time><span>Search widget preview created</span></li>
        <li><time dateTime="2026-07-10">Jul 10</time><span>Checkout shell promoted</span></li>
        <li><time dateTime="2026-07-02">Jul 2</time><span>Design tokens published</span></li>
      </ol>
    </section>
  );
}

function CurrentRoute() {
  const location = useLocation();
  return <p className="current-route">Current route: <code>{location.pathname}</code></p>;
}

export interface ReleaseActivityWidgetProps {
  routingFrameId: string;
}

export function ReleaseActivityWidget({ routingFrameId }: ReleaseActivityWidgetProps) {
  useWidgetRouteAdapter(routingFrameId);

  return (
    <main className="activity-widget">
      <Navigation />
      <CurrentRoute />
      <Routes>
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="*" element={<Navigate replace to="/activity" />} />
      </Routes>
    </main>
  );
}

export const widgetStyle = `
  .activity-widget { height: 100%; padding: 1.4rem; border-radius: 1rem; background: #172554; color: #eff6ff; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .widget-navigation { display: flex; gap: 0.45rem; margin-bottom: 1.3rem; }
  .widget-navigation a { padding: 0.45rem 0.65rem; border: 1px solid #4f70a7; border-radius: 999px; color: #dbeafe; font-size: 0.8rem; font-weight: 700; text-decoration: none; }
  .widget-navigation a[aria-current="page"] { border-color: #93c5fd; background: #eff6ff; color: #172554; }
  .widget-kicker { color: #93c5fd; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; }
  .activity-widget h2 { margin: 0.45rem 0 0; font-size: 1.55rem; }
  .widget-copy, .current-route { margin: 0.35rem 0 1.2rem; color: #bfdbfe; }
  .current-route { margin: -0.8rem 0 1.2rem; font-size: 0.78rem; }
  .widget-copy code, .current-route code { color: #fff; }
  .activity-list, .history-list { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
  .activity-list li, .history-list li { display: flex; justify-content: space-between; gap: 1rem; padding-bottom: 0.7rem; border-bottom: 1px solid #334e83; }
  .activity-list span, .history-list span, .history-list time { color: #bfdbfe; font-size: 0.82rem; text-align: right; }
  .history-list time { min-width: 4.5rem; text-align: left; }
  .activity-widget button { margin-top: 1.2rem; padding: 0.65rem 0.9rem; border: 0; border-radius: 0.65rem; background: #60a5fa; color: #10204c; font: inherit; font-weight: 800; cursor: pointer; }
  .activity-widget output { display: block; margin-top: 0.65rem; color: #bfdbfe; font-size: 0.82rem; }
`;
