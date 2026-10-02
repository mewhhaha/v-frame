import "@mewhhaha/v-frame/register";
import { VFrameElement } from "@mewhhaha/v-frame";
import {
  hostSections as hostSectionDefinitions,
  hostSectionRoutes,
  pageFramePresentation as framePresentations,
  pageFrameLabel,
  type FrameRoutes,
  type HostPageConfig,
  type HostSectionKey,
  type PageFrameId,
} from "./host-config.js";

const configElement = document.querySelector("#host-config");
if (configElement === null) throw new Error("Missing SSR host configuration");
const { initialRoutes } = JSON.parse(configElement.textContent ?? "") as HostPageConfig;
let frameRoutes: FrameRoutes = { ...initialRoutes };
const allowedRoutes = Object.fromEntries(
  Object.keys(framePresentations).map((frameId) => [
    frameId,
    new Set(
      Object.values(hostSectionRoutes).flatMap((routes) => {
        const route = (routes as FrameRoutes)[frameId as PageFrameId];
        return route === undefined ? [] : [route];
      }),
    ),
  ]),
) as Record<PageFrameId, Set<string>>;
const isFrameId = (value: string | undefined): value is PageFrameId =>
  value !== undefined && Object.hasOwn(framePresentations, value);
const sectionKeys = Object.keys(hostSectionDefinitions) as HostSectionKey[];

interface PendingNavigation {
  composition: HTMLDivElement;
  destination: string;
  expectedFrames: number;
  loadedFrames: Set<PageFrameId>;
  mode: "push" | "replace" | "traverse";
  routes: FrameRoutes;
  sectionKey: HostSectionKey;
}

const hostSidebar = document.querySelector("#host-sidebar");
const sidebarToggle = document.querySelector("#sidebar-toggle");
const compositionToggle = document.querySelector("#composition-toggle");
const compositionToggleLabel = document.querySelector("#composition-toggle-label");
const compositionStorageKey = "v-frame:composition-visible";
const hostWorkspace = document.querySelector("#host-workspace");
const hostSectionKicker = document.querySelector("#host-section-kicker");
const hostSectionTitle = document.querySelector<HTMLElement>("#host-section-title");
const hostSectionDescription = document.querySelector("#host-section-description");
const routeOutput = document.querySelector("#host-route");
let pendingNavigation: PendingNavigation | null = null;

sidebarToggle?.addEventListener("click", () => {
  const sidebarClosed = !document.documentElement.hasAttribute("data-sidebar-closed");
  document.documentElement.toggleAttribute("data-sidebar-closed", sidebarClosed);
  sidebarToggle.setAttribute("aria-expanded", String(!sidebarClosed));
  sidebarToggle.textContent = sidebarClosed ? "Show sidebar" : "Hide sidebar";
  hostSidebar?.toggleAttribute("inert", sidebarClosed);
  if (sidebarClosed) {
    hostSidebar?.setAttribute("aria-hidden", "true");
  } else {
    hostSidebar?.removeAttribute("aria-hidden");
  }
});

const updateNestedCompositionSurface = (visible: boolean) => {
  const reactFrame = document.querySelector('v-frame[data-frame-id="react-router"]');
  const reactWidget = reactFrame?.shadowRoot?.querySelector(".activity-widget");
  reactWidget?.toggleAttribute("data-composition-visible", visible);
};

const showComposition = (visible: boolean) => {
  document.documentElement.toggleAttribute("data-composition-visible", visible);
  compositionToggle?.setAttribute("aria-pressed", String(visible));
  if (compositionToggleLabel !== null) {
    compositionToggleLabel.textContent = visible ? "Hide frontends" : "Show frontends";
  }
  updateNestedCompositionSurface(visible);
  try {
    sessionStorage.setItem(compositionStorageKey, String(visible));
  } catch (error) {
    console.warn("Could not persist the composition preference", error);
  }
};
let compositionVisible = false;
try {
  compositionVisible = sessionStorage.getItem(compositionStorageKey) === "true";
} catch (error) {
  console.warn("Could not restore the composition preference", error);
}
showComposition(compositionVisible);
compositionToggle?.addEventListener("click", () => {
  showComposition(!document.documentElement.hasAttribute("data-composition-visible"));
});

const frameMountPath = (frameId: PageFrameId) => "/widgets/" + frameId;

// The route a frontend is currently showing, read straight off the element and
// expressed in the shell's vocabulary.
const frameRoute = (frame: VFrameElement) => {
  const frameId = frame.dataset.frameId;
  const currentURL = frame.currentURL;
  if (!isFrameId(frameId) || currentURL === null) return null;
  const mountPath = frameMountPath(frameId);
  const pathname = new URL(currentURL).pathname;
  if (!pathname.startsWith(mountPath)) return null;
  const route = pathname.slice(mountPath.length);
  return allowedRoutes[frameId].has(route) ? route : null;
};

// The route table that owns a frame: a staged frame answers to the destination
// composition, everything else to the page the shell is showing.
const routesFor = (frame: VFrameElement): FrameRoutes | null => {
  const stagedComposition = frame.closest(".navigation-stage");
  if (stagedComposition === null) return frameRoutes;
  return pendingNavigation?.composition === stagedComposition
    ? pendingNavigation.routes
    : null;
};
const expectedRoute = (frame: VFrameElement) => {
  const frameId = frame.dataset.frameId;
  return isFrameId(frameId) ? (routesFor(frame)?.[frameId] ?? null) : null;
};

// The shell owns the route every frontend shows. One that booted or drifted
// elsewhere is moved with a same-document navigation, not a document reload.
const alignFrameRoute = (frame: VFrameElement, route: string) => {
  const frameId = frame.dataset.frameId;
  if (!isFrameId(frameId)) return;
  if (frameRoute(frame) === route) {
    frame.setAttribute("data-routing-ready", "");
    return;
  }
  frame.removeAttribute("data-routing-ready");
  frame.navigate(frameMountPath(frameId) + route, { replace: true }).catch((error) => {
    console.warn("Could not move the frontend onto the shell route", error);
  });
};

const sectionOwning = (frameId: PageFrameId, route: string) => {
  const currentSection = sectionKeys.find(
    (sectionKey) => hostSectionDefinitions[sectionKey].path === location.pathname,
  );
  const matchingSections = sectionKeys.filter(
    (sectionKey) => (hostSectionRoutes[sectionKey] as FrameRoutes)[frameId] === route,
  );
  return currentSection !== undefined && matchingSections.includes(currentSection)
    ? currentSection
    : matchingSections[0];
};

const cancelPendingNavigation = () => {
  if (pendingNavigation === null) return;
  pendingNavigation.composition.remove();
  pendingNavigation = null;
};

const beginHostSectionTransition = (
  sectionKey: HostSectionKey,
  mode: PendingNavigation["mode"],
) => {
  const section = hostSectionDefinitions[sectionKey];
  const sectionRoutes = hostSectionRoutes[sectionKey];
  if (hostWorkspace === null) return;
  if (pendingNavigation?.sectionKey === sectionKey) return;

  cancelPendingNavigation();
  const threadSection =
    sectionKey === "migration" || sectionKey === "research" || sectionKey === "brief";
  const composition = document.createElement("div");
  composition.className = threadSection
    ? "page-composition navigation-stage"
    : "page-composition widget-grid-single widget-grid-" +
      sectionKey +
      " navigation-stage";
  composition.dataset.hostComposition = "";
  composition.setAttribute("aria-hidden", "true");
  composition.setAttribute("inert", "");

  for (const [frameId, route] of Object.entries(sectionRoutes) as [
    PageFrameId,
    string,
  ][]) {
    const presentation = framePresentations[frameId];
    const label = pageFrameLabel(frameId, sectionKey);
    const surface = document.createElement("div");
    surface.className = "widget-surface " + presentation.className;
    surface.dataset.compositionLabel = label;
    surface.dataset.surfaceId = presentation.surfaceId;

    const frame = document.createElement("v-frame") as VFrameElement;
    frame.dataset.frameId = frameId;
    frame.dataset.pendingFrame = "";
    frame.setAttribute("src", frameMountPath(frameId) + route);
    frame.setAttribute("aria-label", label);
    surface.append(frame);
    composition.append(surface);
  }

  const destination = new URL(location.href);
  destination.pathname = section.path;
  destination.hash = "";
  for (const frameId of Object.keys(allowedRoutes)) {
    destination.searchParams.delete(frameId);
  }
  pendingNavigation = {
    composition,
    destination: destination.pathname + destination.search,
    expectedFrames: Object.keys(sectionRoutes).length,
    loadedFrames: new Set(),
    mode,
    routes: sectionRoutes,
    sectionKey,
  };
  document.querySelector(".mobile-navigation")?.removeAttribute("open");
  hostWorkspace.append(composition);
};

const commitPendingNavigation = () => {
  const completedNavigation = pendingNavigation;
  if (completedNavigation === null) return;
  pendingNavigation = null;

  const outgoingComposition = document.querySelector(
    "[data-host-composition]:not(.navigation-stage)",
  );
  completedNavigation.composition.classList.remove("navigation-stage");
  completedNavigation.composition.removeAttribute("aria-hidden");
  completedNavigation.composition.removeAttribute("inert");
  completedNavigation.composition.id = "host-composition";
  for (const surface of completedNavigation.composition.querySelectorAll<HTMLElement>(
    "[data-surface-id]",
  )) {
    surface.id = surface.dataset.surfaceId ?? "";
    delete surface.dataset.surfaceId;
  }
  for (const frame of completedNavigation.composition.querySelectorAll<VFrameElement>(
    "v-frame[data-frame-id]",
  )) {
    frame.id = frame.dataset.frameId + "-frontend";
    delete frame.dataset.pendingFrame;
  }
  outgoingComposition?.remove();

  const section = hostSectionDefinitions[completedNavigation.sectionKey];
  document.title = section.title + " · Relay";
  if (hostSectionKicker !== null) hostSectionKicker.textContent = section.kicker;
  if (hostSectionTitle !== null) hostSectionTitle.textContent = section.title;
  if (hostSectionDescription !== null) {
    hostSectionDescription.textContent = section.description;
  }
  for (const link of document.querySelectorAll(".host-link[data-host-section]")) {
    const active =
      link.getAttribute("data-host-section") === completedNavigation.sectionKey;
    link.classList.toggle("host-link-active", active);
    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }

  frameRoutes = { ...completedNavigation.routes };
  if (routeOutput !== null) {
    routeOutput.textContent = Object.entries(frameRoutes)
      .map(([frameId, route]) => frameId + " " + route)
      .join("; ");
  }
  if (completedNavigation.mode === "push") {
    history.pushState(null, "", completedNavigation.destination);
  } else if (completedNavigation.mode === "replace") {
    history.replaceState(null, "", completedNavigation.destination);
  }

  showComposition(document.documentElement.hasAttribute("data-composition-visible"));
  hostSectionTitle?.focus();
};

document.addEventListener("v-frame-load", (event) => {
  if (!(event.target instanceof VFrameElement)) return;
  const route = expectedRoute(event.target);
  if (route !== null) alignFrameRoute(event.target, route);

  const stagedComposition = event.target.closest(".navigation-stage");
  if (
    stagedComposition !== null &&
    pendingNavigation?.composition === stagedComposition
  ) {
    const frameId = event.target.dataset.frameId;
    if (!isFrameId(frameId)) return;
    pendingNavigation.loadedFrames.add(frameId);
    if (pendingNavigation.loadedFrames.size === pendingNavigation.expectedFrames) {
      commitPendingNavigation();
    }
    return;
  }
  if (event.target.matches('v-frame[data-frame-id="react-router"]')) {
    updateNestedCompositionSurface(
      document.documentElement.hasAttribute("data-composition-visible"),
    );
  }
});

document.addEventListener("v-frame-error", (event) => {
  if (
    !(event.target instanceof VFrameElement) ||
    pendingNavigation === null ||
    !pendingNavigation.composition.contains(event.target)
  )
    return;

  const failedNavigation = pendingNavigation;
  cancelPendingNavigation();
  if (failedNavigation.mode === "push") {
    location.assign(failedNavigation.destination);
  } else {
    location.replace(failedNavigation.destination);
  }
});

document.addEventListener("click", (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const link =
    event.target instanceof Element ? event.target.closest("a[data-host-section]") : null;
  if (!(link instanceof HTMLAnchorElement) || link.origin !== location.origin) return;

  const sectionKey = link.dataset.hostSection;
  if (sectionKey === undefined || !Object.hasOwn(hostSectionDefinitions, sectionKey))
    return;
  const key = sectionKey as HostSectionKey;
  const section = hostSectionDefinitions[key];
  event.preventDefault();
  if (location.pathname === section.path) {
    cancelPendingNavigation();
    document.querySelector(".mobile-navigation")?.removeAttribute("open");
    return;
  }
  beginHostSectionTransition(key, "push");
});

// A frontend that routes itself is the other half of shell routing: the shell
// follows it into whichever section owns the route it moved to.
document.addEventListener("v-frame-navigated", (event) => {
  if (!(event.target instanceof VFrameElement)) return;
  const frame = event.target;
  const frameId = frame.dataset.frameId;
  if (!isFrameId(frameId)) return;
  const expected = expectedRoute(frame);
  const route = frameRoute(frame);
  if (expected === null || route === null) return;
  if (route === expected) {
    frame.setAttribute("data-routing-ready", "");
    return;
  }

  const sectionKey =
    frame.closest(".navigation-stage") === null
      ? sectionOwning(frameId, route)
      : undefined;
  if (sectionKey === undefined) {
    alignFrameRoute(frame, expected);
    return;
  }
  beginHostSectionTransition(sectionKey, "push");
});

addEventListener("popstate", () => {
  const sectionKey = sectionKeys.find(
    (candidate) => hostSectionDefinitions[candidate].path === location.pathname,
  );
  if (sectionKey === undefined) return;
  beginHostSectionTransition(sectionKey, "traverse");
});
addEventListener("pagehide", cancelPendingNavigation, { once: true });
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
