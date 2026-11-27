// The document facade is one closure by design: every part of it shares the
// same window, document and options, and the parts reference each other in both
// directions. This module is that shared closure made explicit — the captured
// native handles, the predicates and geometry every part needs, the state more
// than one module reads, and the patch bookkeeping that dispose() unwinds.

import { EnumerableWeakSet, type EnumerableWeakMap } from "../enumerable-weak.js";
import type { VFrameWindow } from "../types.js";
import type { LinkedStyle } from "../linked-styles.js";
import { liveIndexedCollection } from "./indexed-collection.js";

import { HTML_NAMESPACE } from "../asset-urls.js";
export { HTML_NAMESPACE, SVG_NAMESPACE } from "../asset-urls.js";

export interface SubtreeScan {
  styles: HTMLStyleElement[];
  links: HTMLLinkElement[];
  scripts: HTMLScriptElement[];
  hasBase: boolean;
  hasTarget: boolean;
}

export interface DocumentFacadeOptions {
  host: HTMLElement;
  shadowRoot: ShadowRoot;
  scroll: Pick<HTMLElement, "scrollLeft" | "scrollTop" | "scrollTo" | "scrollBy">;
  window: VFrameWindow;
  document: Document;
  html: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  // Weak on purpose: both admit every element carrying the feature, and a guest
  // that churns such elements must not grow. See src/enumerable-weak.ts.
  authoredURLAttributes: EnumerableWeakMap<Element, Map<string, string>>;
  authoredStyleAttributes: EnumerableWeakMap<Element, string>;
  inlineStyleSelectorAttribute: string;
  inlineStyleSheet: HTMLStyleElement;
  linkedStyles: WeakMap<HTMLLinkElement, LinkedStyle>;
  constructedSheetBaseURLs?: WeakMap<CSSStyleSheet, string>;
  initialFlags?: number;
  initialStyles?: readonly HTMLStyleElement[];
  initialScripts?: readonly HTMLScriptElement[];
  initialLinks?: readonly HTMLLinkElement[];
  lazyAttributes?: boolean;
  lazyEvents?: boolean;
  createHTML(source: string): string;
  createGuestHTML(value: unknown, legacyNull?: boolean): string;
  createScript(source: string): string;
  createGuestScript(value: unknown): unknown;
  updateTopLayerViewport(x: number | null, y?: number): void;
  getNonce(): string;
  getBaseURL(): string;
  getCurrentURL(): string;
  getCurrentScript(): HTMLScriptElement | null;
  onBaseElementChange(): void;
  onEventHandlerError(error: unknown): void;
  onDynamicScript(script: HTMLScriptElement, execution: "async" | "ordered"): void;
  onStyleElementChange(style: HTMLStyleElement): void;
  onStyleSheetAccess?(style: HTMLStyleElement): void;
  onLinkElementChange(link: HTMLLinkElement, authoredRel: string | null): void;
  onConnectedNodes(
    nodes: readonly Node[],
    scan?: SubtreeScan,
    alreadyFlushed?: boolean,
  ): void;
  onDisconnectedNodes(nodes: readonly Node[]): void;
  flushSettledMove?(nodes?: readonly Node[]): boolean;
  settledSubtreeHas?(node: Node, baseOnly: boolean): boolean | undefined;
  onShadowRoot?(root: ShadowRoot): void;
}

export interface PatchRegistry {
  patch(
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor,
    knownOriginal?: PropertyDescriptor,
  ): void;
  restorePatches(): void;
}

function adoptNativeShape(
  replacement: unknown,
  original: unknown,
  name: string,
  length?: number,
): void {
  if (typeof replacement !== "function") {
    return;
  }
  const fnName = replacement.name;
  if (fnName !== "" && fnName !== "value" && fnName !== "get" && fnName !== "set") {
    return;
  }
  if (fnName !== name) {
    Object.defineProperty(replacement, "name", { value: name, configurable: true });
  }
  if (typeof original === "function") {
    const targetLength = length ?? original.length;
    if (replacement.length !== targetLength) {
      Object.defineProperty(replacement, "length", {
        value: targetLength,
        configurable: true,
      });
    }
  }
}

export function createPatchRegistry(): PatchRegistry {
  const patchedDescriptors: Array<{
    target: object;
    key: PropertyKey;
    descriptor: PropertyDescriptor | undefined;
  }> = [];

  return {
    patch(
      target: object,
      key: PropertyKey,
      descriptor: PropertyDescriptor,
      knownOriginal?: PropertyDescriptor,
    ): void {
      const original =
        arguments.length >= 4
          ? knownOriginal
          : Object.getOwnPropertyDescriptor(target, key);
      patchedDescriptors.push({ target, key, descriptor: original });
      if (original !== undefined && typeof key === "string") {
        adoptNativeShape(descriptor.value, original.value, key);
        adoptNativeShape(descriptor.get, original.get, `get ${key}`, 0);
        adoptNativeShape(descriptor.set, original.set, `set ${key}`, 1);
      }
      Object.defineProperty(target, key, { configurable: true, ...descriptor });
    },
    restorePatches(): void {
      let patched = patchedDescriptors.pop();
      while (patched !== undefined) {
        if (patched.descriptor === undefined) {
          delete (patched.target as Record<PropertyKey, unknown>)[patched.key];
        } else {
          Object.defineProperty(patched.target, patched.key, patched.descriptor);
        }
        patched = patchedDescriptors.pop();
      }
    },
  };
}

export interface NativeDocumentHandles {
  privateHead: HTMLHeadElement;
  createElement<K extends keyof HTMLElementTagNameMap>(name: K): HTMLElementTagNameMap[K];
  appendChild<T extends Node>(parent: Node, child: T): T;
  getAttribute(element: Element, name: string): string | null;
  setAttribute(element: Element, name: string, value: string): void;
}

// The context type is inferred rather than declared: the native handles carry
// the exact `this`-bound signatures of the realm prototypes they came from, and
// restating fifty of them by hand would only be a second place to get wrong.
export type FacadeContext = ReturnType<typeof createFacadeContext>;

export function createFacadeContext(options: DocumentFacadeOptions) {
  const window = options.window;
  const document = options.document;
  const hostDocument = options.host.ownerDocument;
  const privateHead = document.head;
  const privateBody = document.body;
  const documentPrototype = window.Document.prototype;
  const nodePrototype = window.Node.prototype;
  const characterDataPrototype = window.CharacterData.prototype;
  const elementPrototype = window.Element.prototype;
  const eventTargetPrototype = window.EventTarget.prototype;
  const documentFragmentPrototype = window.DocumentFragment.prototype;
  const nativeCreateElement = documentPrototype.createElement;
  const nativeCreateElementNS = documentPrototype.createElementNS;
  const nativeCreateTextNode = documentPrototype.createTextNode;
  const nativeCreateComment = documentPrototype.createComment;
  const nativeCreateDocumentFragment = documentPrototype.createDocumentFragment;
  const nativeImportNode = documentPrototype.importNode;
  const nativeCreateAttribute = documentPrototype.createAttribute;
  const nativeCreateAttributeNS = documentPrototype.createAttributeNS;
  const nativeAppendChild = nodePrototype.appendChild;
  const nativeInsertBefore = nodePrototype.insertBefore;
  const nativeReplaceChild = nodePrototype.replaceChild;
  const nativeRemoveChild = nodePrototype.removeChild;
  const nativeCloneNode = nodePrototype.cloneNode;
  const nativeContains = nodePrototype.contains;
  const nativeGetRootNode = nodePrototype.getRootNode;
  const nativeFirstChild = Object.getOwnPropertyDescriptor(
    nodePrototype,
    "firstChild",
  )?.get;
  const nativeLocalName = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "localName",
  )?.get;
  const nativeNamespaceURI = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "namespaceURI",
  )?.get;
  const nativeOwnerDocument = Object.getOwnPropertyDescriptor(
    nodePrototype,
    "ownerDocument",
  );
  const nativeBaseURI = Object.getOwnPropertyDescriptor(nodePrototype, "baseURI");
  const nativeTextContent = Object.getOwnPropertyDescriptor(nodePrototype, "textContent");
  const nativeNodeValue = Object.getOwnPropertyDescriptor(nodePrototype, "nodeValue");
  const nativeCharacterData = Object.getOwnPropertyDescriptor(
    characterDataPrototype,
    "data",
  );
  const nativeAppendData = characterDataPrototype.appendData;
  const nativeDeleteData = characterDataPrototype.deleteData;
  const nativeInsertData = characterDataPrototype.insertData;
  const nativeReplaceData = characterDataPrototype.replaceData;
  const nativeAddEventListener = eventTargetPrototype.addEventListener;
  const nativeRemoveEventListener = eventTargetPrototype.removeEventListener;
  const nativeDispatchEvent = eventTargetPrototype.dispatchEvent;
  const nativeGetAttribute = elementPrototype.getAttribute;
  const nativeGetAttributeNS = elementPrototype.getAttributeNS;
  const nativeGetAttributeNode = elementPrototype.getAttributeNode;
  const nativeGetAttributeNodeNS = elementPrototype.getAttributeNodeNS;
  const nativeAttributes = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "attributes",
  );
  const nativeGetAttributeNames = elementPrototype.getAttributeNames;
  const nativeHasAttributes = elementPrototype.hasAttributes;
  const nativeHasAttribute = elementPrototype.hasAttribute;
  const nativeHasAttributeNS = elementPrototype.hasAttributeNS;
  const nativeSetAttribute = elementPrototype.setAttribute;
  const nativeSetAttributeNS = elementPrototype.setAttributeNS;
  const nativeSetAttributeNode = elementPrototype.setAttributeNode;
  const nativeSetAttributeNodeNS = elementPrototype.setAttributeNodeNS;
  const nativeRemoveAttribute = elementPrototype.removeAttribute;
  const nativeRemoveAttributeNS = elementPrototype.removeAttributeNS;
  const nativeRemoveAttributeNode = elementPrototype.removeAttributeNode;
  const nativeToggleAttribute = elementPrototype.toggleAttribute;
  const nativeElementReplaceChildren = elementPrototype.replaceChildren;
  const nativeCreateHTMLDocument = window.DOMImplementation.prototype.createHTMLDocument;
  const nativeImplementation = document.implementation;
  let inertDocument: Document | undefined;
  const getInertDocument = (): Document =>
    (inertDocument ??= nativeCreateHTMLDocument.call(nativeImplementation, ""));
  const nativeMatches = elementPrototype.matches;
  const nativeClosest = elementPrototype.closest;
  const nativeQuerySelector = elementPrototype.querySelector;
  const nativeQuerySelectorAll = elementPrototype.querySelectorAll;
  const nativeFragmentQuerySelector = documentFragmentPrototype.querySelector;
  const nativeFragmentQuerySelectorAll = documentFragmentPrototype.querySelectorAll;
  const nativeShadowGetElementById =
    options.host.ownerDocument.defaultView?.ShadowRoot?.prototype.getElementById;
  let literalShellElementsPresent = false;
  const hasLiteralShellElements = (): boolean => literalShellElementsPresent;
  const noteLiteralShellElement = (): void => {
    literalShellElementsPresent = true;
  };
  const nativeGetElementsByTagName = elementPrototype.getElementsByTagName;
  const nativeGetElementsByTagNameNS = elementPrototype.getElementsByTagNameNS;
  const nativeAttachShadow = elementPrototype.attachShadow;
  const nativeGetBoundingClientRect = elementPrototype.getBoundingClientRect;
  const nativeGetClientRects = elementPrototype.getClientRects;
  const nativeInnerHTML = Object.getOwnPropertyDescriptor(elementPrototype, "innerHTML");
  const nativeOuterHTML = Object.getOwnPropertyDescriptor(elementPrototype, "outerHTML");
  const nativeElementRemove = elementPrototype.remove;
  const nativeHTMLElementStyle = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "style",
  );
  const nativeSVGElementStyle = Object.getOwnPropertyDescriptor(
    window.SVGElement.prototype,
    "style",
  );
  const nativeScriptAsync = Object.getOwnPropertyDescriptor(
    window.HTMLScriptElement.prototype,
    "async",
  );
  const nativeScriptText = Object.getOwnPropertyDescriptor(
    window.HTMLScriptElement.prototype,
    "text",
  );
  const nativeScriptType = Object.getOwnPropertyDescriptor(
    window.HTMLScriptElement.prototype,
    "type",
  );
  const nativeLinkRel = Object.getOwnPropertyDescriptor(
    window.HTMLLinkElement.prototype,
    "rel",
  );
  const nativeLinkRelList = Object.getOwnPropertyDescriptor(
    window.HTMLLinkElement.prototype,
    "relList",
  );
  const nativeCurrentScript = Object.getOwnPropertyDescriptor(
    documentPrototype,
    "currentScript",
  )?.get;
  const NativeMutationObserver = window.MutationObserver;
  const isElementNode = (node: Node): node is Element => node.nodeType === 1;
  const isDocumentFragmentNode = (node: Node): node is DocumentFragment =>
    node.nodeType === 11;
  const isHTMLElementNamed = (element: Element, localName: string): boolean =>
    element.localName === localName && element.namespaceURI === HTML_NAMESPACE;
  const isHTMLTemplateElement = (element: Element): element is HTMLTemplateElement =>
    isHTMLElementNamed(element, "template");
  const isHTMLStyleElement = (element: Element): element is HTMLStyleElement =>
    isHTMLElementNamed(element, "style");
  const isHTMLLinkElement = (element: Element): element is HTMLLinkElement =>
    isHTMLElementNamed(element, "link");
  const isHTMLScriptElement = (element: Element): element is HTMLScriptElement =>
    isHTMLElementNamed(element, "script");
  const reachesVirtualDocument = (root: Node): boolean => {
    let currentRoot = root;
    while (isDocumentFragmentNode(currentRoot) && "host" in currentRoot) {
      if (currentRoot === options.shadowRoot) {
        return true;
      }
      currentRoot = nativeGetRootNode.call((currentRoot as ShadowRoot).host);
    }
    return currentRoot === options.shadowRoot;
  };
  const virtualGetRootNode = (node: Node, init?: GetRootNodeOptions): Node => {
    const root = nativeGetRootNode.call(node);
    if (root === options.shadowRoot) {
      return document;
    }
    if (init?.composed !== true || !reachesVirtualDocument(root)) {
      return nativeGetRootNode.call(node, init);
    }
    return document;
  };
  const isInVirtualDocumentTree = (node: Node): boolean =>
    node.parentNode !== null
      ? nativeGetRootNode.call(node) === options.shadowRoot
      : node === options.shadowRoot;
  const virtualNodes = new WeakSet<Node>();
  const trustedStyleNodes = new WeakSet<Node>();
  const trustedEventAttributes = new WeakMap<Element, Set<string>>();
  const trustEventAttribute = (element: Element, name: string): void => {
    let trusted = trustedEventAttributes.get(element);
    if (trusted === undefined) {
      trusted = new Set();
      trustedEventAttributes.set(element, trusted);
    }
    trusted.add(name);
  };
  const untrustEventAttribute = (element: Element, name: string): void => {
    trustedEventAttributes.get(element)?.delete(name);
  };
  const isTrustedEventAttribute = (element: Element, name: string): boolean =>
    trustedEventAttributes.get(element)?.has(name) === true;
  const createdScripts = new WeakSet<HTMLScriptElement>();
  const protectedScriptAttributes = new WeakMap<
    HTMLScriptElement,
    Map<"src" | "type", string>
  >();
  const eventAttributeValues = new WeakMap<Element, Map<string, string>>();
  const cssomMutatedStyleElements = new WeakSet<Element>();
  const authoredLinkRelValues = new WeakMap<HTMLLinkElement, string | null>();
  const logicalEventTargets = new WeakMap<Event, EventTarget>();
  const { patch, restorePatches } = createPatchRegistry();

  const isBaseElement = (element: Element): boolean =>
    isHTMLElementNamed(element, "base");
  const subtreeHasBaseElement = (node: Node): boolean => {
    if (isElementNode(node)) {
      return (
        isBaseElement(node) ||
        (node.firstElementChild !== null &&
          nativeQuerySelector.call(node, "base") !== null)
      );
    }
    if (isDocumentFragmentNode(node)) {
      return (
        node.firstElementChild !== null &&
        nativeFragmentQuerySelector.call(node, "base") !== null
      );
    }
    return false;
  };
  const connectedBaseElementChanged = (element: Element): void => {
    if (isBaseElement(element) && isInVirtualDocumentTree(element)) {
      options.onBaseElementChange();
    }
  };

  if (
    privateHead === null ||
    privateBody === null ||
    nativeInnerHTML?.set === undefined
  ) {
    throw new Error(
      "The about:blank execution document has no usable head, body, or HTML parser",
    );
  }

  const viewportOrigin = (): { x: number; y: number } => {
    const hostRect = options.host.getBoundingClientRect();
    return {
      x: hostRect.left + options.host.clientLeft,
      y: hostRect.top + options.host.clientTop,
    };
  };
  const toVirtualDOMRect = (rect: DOMRectReadOnly): DOMRect => {
    const origin = viewportOrigin();
    return new window.DOMRect(
      rect.x - origin.x,
      rect.y - origin.y,
      rect.width,
      rect.height,
    );
  };
  const getVirtualBoundingClientRect = (element: Element): DOMRect =>
    toVirtualDOMRect(nativeGetBoundingClientRect.call(element));
  const getVirtualClientRects = (element: Element): DOMRectList => {
    const rects = Array.from(nativeGetClientRects.call(element), (rect) =>
      toVirtualDOMRect(rect),
    );
    return liveIndexedCollection(
      window.DOMRectList.prototype,
      () => rects,
    ) as unknown as DOMRectList;
  };
  const toHostViewportPoint = (x: number, y: number): { x: number; y: number } => {
    const origin = viewportOrigin();
    return { x: x + origin.x, y: y + origin.y };
  };

  const hostWindow = hostDocument.defaultView;
  const openPopovers = new Set<EventTarget>();
  let activeTopLayerTracking: AbortController | null = null;
  let hostResizeObserver: ResizeObserver | null = null;
  const refreshTopLayerViewportStyle = (): void => {
    const origin = viewportOrigin();
    // Promotion changes the CSS viewport to the host page; translate it back
    // to the child viewport while preserving the browser's top-layer clipping escape.
    options.updateTopLayerViewport(origin.x, origin.y);
  };
  const stopTopLayerTracking = (): void => {
    activeTopLayerTracking?.abort();
    activeTopLayerTracking = null;
    hostResizeObserver?.disconnect();
    hostResizeObserver = null;
    options.updateTopLayerViewport(null);
  };
  const startTopLayerTracking = (): void => {
    if (activeTopLayerTracking === null) {
      activeTopLayerTracking = new AbortController();
      const { signal } = activeTopLayerTracking;
      hostWindow?.addEventListener("resize", refreshTopLayerViewportStyle, { signal });
      hostWindow?.addEventListener("scroll", refreshTopLayerViewportStyle, {
        capture: true,
        signal,
      });
      if (typeof hostWindow?.ResizeObserver === "function") {
        hostResizeObserver = new hostWindow.ResizeObserver(refreshTopLayerViewportStyle);
        hostResizeObserver.observe(options.host);
      }
    }
    refreshTopLayerViewportStyle();
  };
  const pruneOpenPopovers = (): void => {
    for (const target of openPopovers) {
      if (
        !(target instanceof hostWindow!.Element) &&
        !(target instanceof window.Element)
      ) {
        openPopovers.delete(target);
        continue;
      }
      const element = target as Element;
      if (!element.isConnected || !element.matches(":popover-open")) {
        openPopovers.delete(target);
      }
    }
    if (openPopovers.size === 0) {
      stopTopLayerTracking();
    }
  };
  const handleBeforeToggle: EventListener = (event) => {
    const toggle = event as Event & { newState?: string };
    if (toggle.newState === "open" && event.target !== null) {
      openPopovers.add(event.target);
      startTopLayerTracking();
      // If a listener canceled beforetoggle, the popover never opens.
      queueMicrotask(pruneOpenPopovers);
    }
  };
  const handleToggle: EventListener = (event) => {
    const toggle = event as Event & { newState?: string };
    if (toggle.newState === "closed" && event.target !== null) {
      openPopovers.delete(event.target);
      pruneOpenPopovers();
    }
  };
  const topLayerListenerLifetime = new AbortController();
  options.html.addEventListener("beforetoggle", handleBeforeToggle, {
    capture: true,
    signal: topLayerListenerLifetime.signal,
  });
  options.html.addEventListener("toggle", handleToggle, {
    capture: true,
    signal: topLayerListenerLifetime.signal,
  });

  return {
    options,
    window,
    document,
    hostDocument,
    privateHead,
    nodePrototype,
    characterDataPrototype,
    elementPrototype,
    eventTargetPrototype,
    documentFragmentPrototype,
    nativeCreateElement,
    nativeCreateElementNS,
    nativeCreateTextNode,
    nativeCreateComment,
    nativeCreateDocumentFragment,
    nativeImportNode,
    nativeCreateAttribute,
    nativeCreateAttributeNS,
    nativeAppendChild,
    nativeInsertBefore,
    nativeReplaceChild,
    nativeRemoveChild,
    nativeCloneNode,
    nativeContains,
    nativeGetRootNode,
    nativeFirstChild,
    nativeLocalName,
    nativeNamespaceURI,
    nativeOwnerDocument,
    nativeBaseURI,
    nativeTextContent,
    nativeNodeValue,
    nativeCharacterData,
    nativeAppendData,
    nativeDeleteData,
    nativeInsertData,
    nativeReplaceData,
    nativeAddEventListener,
    nativeRemoveEventListener,
    nativeDispatchEvent,
    nativeGetAttribute,
    nativeGetAttributeNS,
    nativeGetAttributeNode,
    nativeGetAttributeNodeNS,
    nativeAttributes,
    nativeGetAttributeNames,
    nativeHasAttributes,
    nativeHasAttribute,
    nativeHasAttributeNS,
    nativeSetAttribute,
    nativeSetAttributeNS,
    nativeSetAttributeNode,
    nativeSetAttributeNodeNS,
    nativeRemoveAttribute,
    nativeRemoveAttributeNS,
    nativeRemoveAttributeNode,
    nativeToggleAttribute,
    nativeElementReplaceChildren,
    getInertDocument,
    nativeMatches,
    nativeClosest,
    nativeQuerySelector,
    nativeQuerySelectorAll,
    nativeFragmentQuerySelector,
    nativeFragmentQuerySelectorAll,
    nativeShadowGetElementById,
    hasLiteralShellElements,
    noteLiteralShellElement,
    nativeGetElementsByTagName,
    nativeGetElementsByTagNameNS,
    nativeAttachShadow,
    nativeGetBoundingClientRect,
    nativeGetClientRects,
    nativeInnerHTML,
    nativeOuterHTML,
    nativeElementRemove,
    nativeHTMLElementStyle,
    nativeSVGElementStyle,
    nativeScriptAsync,
    nativeScriptText,
    nativeScriptType,
    nativeLinkRel,
    nativeLinkRelList,
    nativeCurrentScript,
    NativeMutationObserver,
    isElementNode,
    isDocumentFragmentNode,
    isHTMLElementNamed,
    isHTMLTemplateElement,
    isHTMLStyleElement,
    isHTMLLinkElement,
    isHTMLScriptElement,
    reachesVirtualDocument,
    virtualGetRootNode,
    isInVirtualDocumentTree,
    isBaseElement,
    subtreeHasBaseElement,
    connectedBaseElementChanged,
    guestShadowRoots: new EnumerableWeakSet<ShadowRoot>(),
    virtualNodes,
    trustedStyleNodes,
    trustedEventAttributes,
    trustEventAttribute,
    untrustEventAttribute,
    isTrustedEventAttribute,
    createdScripts,
    protectedScriptAttributes,
    eventAttributeValues,
    cssomMutatedStyleElements,
    authoredLinkRelValues,
    logicalEventTargets,
    patch,
    restorePatches,
    getVirtualBoundingClientRect,
    getVirtualClientRects,
    toHostViewportPoint,
    dispose(): void {
      topLayerListenerLifetime.abort();
      openPopovers.clear();
      stopTopLayerTracking();
    },
  };
}
