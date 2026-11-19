import type { VFrameWindow } from "../types.js";

export function renderedBy(
  guestRoot: Element,
  target: Node,
  hostWindow: VFrameWindow,
): boolean {
  const { contains, getRootNode } = hostWindow.Node.prototype;
  let node = target;
  while (!contains.call(guestRoot, node)) {
    const root = getRootNode.call(node);
    if (!("host" in root)) return false;
    node = (root as ShadowRoot).host;
  }
  return true;
}

const PART_SELECTOR = "[part], [exportparts]";
const RENDER_HOST = "data-v-frame-render-root";
const STAGED = "data-v-frame-staged";
const RENDER_HOST_CSS = `
  :host > div[${RENDER_HOST}] { display:contents!important; }
  :host > div[${RENDER_HOST}][${STAGED}] {
    display:block!important;
    position:absolute!important;
    inset:0!important;
    overflow:clip!important;
    visibility:hidden!important;
    opacity:0!important;
    pointer-events:none!important;
  }
`;

/** Keeps the incoming native tree connected without sharing the visible guest's tree scope. */
export function createStagedRoot(frameRoot: ShadowRoot) {
  const document = Object.getOwnPropertyDescriptor(
    Node.prototype,
    "ownerDocument",
  )!.get!.call(frameRoot) as Document;
  const window = document.defaultView!;
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  const frame = frameRoot.host;
  const left = frame.scrollLeft;
  const top = frame.scrollTop;
  const sheet = new window.CSSStyleSheet();
  sheet.replaceSync(`:host { overflow-anchor:none!important } ${RENDER_HOST_CSS}`);
  frameRoot.adoptedStyleSheets = [...frameRoot.adoptedStyleSheets, sheet];
  host.inert = true;
  host.setAttribute(RENDER_HOST, "");
  host.setAttribute(STAGED, "");
  frameRoot.append(host);
  frame.scrollTo({ left, top, behavior: "instant" });

  const { matches, querySelector, querySelectorAll, getAttribute } =
    window.Element.prototype;
  const queryAll = window.DocumentFragment.prototype.querySelectorAll;
  const names = new Set<string>();
  const recordNames = (element: Element): void => {
    const parts = getAttribute.call(element, "part");
    if (parts) {
      for (const name of parts.split(/\s+/)) {
        if (name) names.add(name);
      }
    }
    const exports = getAttribute.call(element, "exportparts");
    if (exports) {
      for (const mapping of exports.split(",")) {
        const name = mapping.split(":").at(-1)?.trim();
        if (name) names.add(name);
      }
    }
  };
  const forwardParts = (): void => {
    const value = [...names].join(",");
    if (value) {
      if (host.getAttribute("exportparts") !== value)
        host.setAttribute("exportparts", value);
    } else host.removeAttribute("exportparts");
  };
  const refreshParts = (): void => {
    names.clear();
    for (const element of queryAll.call(root, PART_SELECTOR)) recordNames(element);
    forwardParts();
  };
  const recordConnected = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    recordNames(element);
    if (element.firstElementChild === null) return;
    for (const candidate of querySelectorAll.call(element, PART_SELECTOR)) {
      recordNames(candidate);
    }
  };
  const hasPart = (node: Node): boolean => {
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    return (
      matches.call(element, PART_SELECTOR) ||
      querySelector.call(element, PART_SELECTOR) !== null
    );
  };
  const observer = new window.MutationObserver((records) => {
    const before = names.size;
    for (const record of records) {
      if (
        record.type === "attributes" ||
        (record.removedNodes.length > 0 && Array.from(record.removedNodes).some(hasPart))
      ) {
        refreshParts();
        return;
      }
      for (const node of record.addedNodes) recordConnected(node);
    }
    if (before !== names.size) forwardParts();
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["part", "exportparts"],
  });

  return {
    root,
    refreshParts,
    partsConnected(nodes: readonly Node[]) {
      const before = names.size;
      for (const node of nodes) recordConnected(node);
      if (before !== names.size) forwardParts();
    },
    reveal() {
      host.inert = false;
      host.removeAttribute(STAGED);
      sheet.replaceSync(RENDER_HOST_CSS);
      refreshParts();
    },
    dispose() {
      observer.disconnect();
      host.remove();
      frameRoot.adoptedStyleSheets = frameRoot.adoptedStyleSheets.filter(
        (candidate) => candidate !== sheet,
      );
    },
  };
}
