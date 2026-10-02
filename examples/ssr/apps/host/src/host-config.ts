export const hostSections = {
  migration: {
    path: "/",
    kicker: "Thread",
    title: "Platform migration",
    description:
      "Plan a reversible rollout and keep the implementation decisions in one place.",
  },
  research: {
    path: "/research",
    kicker: "Thread",
    title: "Customer research",
    description: "Turn interview evidence into themes and a focused next decision.",
  },
  brief: {
    path: "/brief",
    kicker: "Thread",
    title: "Weekly brief",
    description:
      "Shape this week’s progress, risks, and decisions into a concise update.",
  },
  plugins: {
    path: "/plugins",
    kicker: "Workspace",
    title: "Plugins",
    description: "Connect focused capabilities to Relay conversations.",
  },
  usage: {
    path: "/usage",
    kicker: "Workspace",
    title: "Usage",
    description: "Review message volume, context consumption, and plan limits.",
  },
  angular: {
    path: "/angular",
    kicker: "Workspace",
    title: "Delivery readiness",
    description:
      "Track launch reviews in an Angular app with its own server and client build.",
  },
  solid: {
    path: "/solid",
    kicker: "Workspace",
    title: "Signal review",
    description:
      "Review live signals in a SolidStart app with independently hydrated state.",
  },
} as const;

export type HostSectionKey = keyof typeof hostSections;
export type PageFrameId = "angular" | "qwik" | "react-router" | "solid";

export const hostSectionRoutes = {
  migration: { "react-router": "/activity", qwik: "/inventory" },
  research: { "react-router": "/research", qwik: "/inventory" },
  brief: { "react-router": "/brief", qwik: "/inventory" },
  plugins: { "react-router": "/plugins" },
  usage: { qwik: "/catalog" },
  angular: { angular: "/dashboard" },
  solid: { solid: "/signals" },
} as const;

export const pageFramePresentation: Record<
  PageFrameId,
  { className: string; surfaceId: string }
> = {
  angular: { className: "widget-angular", surfaceId: "angular-surface" },
  qwik: { className: "widget-qwik", surfaceId: "qwik-surface" },
  "react-router": { className: "widget-react", surfaceId: "react-surface" },
  solid: { className: "widget-solid", surfaceId: "solid-surface" },
};

export function pageFrameLabel(
  frameId: PageFrameId,
  hostSection: HostSectionKey,
): string {
  if (frameId === "angular") return "Angular delivery frontend";
  if (frameId === "solid") return "Solid signal frontend";
  if (frameId === "react-router") {
    return hostSection === "plugins"
      ? "React plugins frontend"
      : "React transcript frontend";
  }
  return hostSection === "usage" ? "Qwik usage frontend" : "Qwik composer frontend";
}

export function pageFrameSource(frameId: PageFrameId, route: string): string {
  return `/widgets/${frameId}${route}`;
}

export type FrameRoutes = Partial<Record<PageFrameId, string>>;

export interface HostPageConfig {
  initialRoutes: FrameRoutes;
}
