// The document facade is one closure by design: every part of it shares the
// same window, document and options, and the parts reference each other in both
// directions. This module is that shared closure made explicit — the captured
// native handles, the predicates and geometry every part needs, the state more
// than one module reads, and the patch bookkeeping that dispose() unwinds.

import type { EnumerableWeakMap } from "../enumerable-weak.js";
import type { VFrameWindow } from "../types.js";
import type { LinkedStyle } from "../linked-styles.js";

export const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export interface DocumentFacadeOptions {
  host: HTMLElement;
  shadowRoot: ShadowRoot;
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
  createHTML(source: string): string;
  createScript(source: string): string;
  updateTopLayerViewport(x: number, y: number): void;
  getNonce(): string;
  getBaseURL(): string;
  getCurrentURL(): string;
  getCurrentScript(): HTMLScriptElement | null;
  onBaseElementChange(): void;
  onEventHandlerError(error: unknown): void;
  onDynamicScript(script: HTMLScriptElement, execution: "async" | "ordered"): void;
  onStyleElementChange(style: HTMLStyleElement): void;
  onLinkElementChange(link: HTMLLinkElement, authoredRel: string | null): void;
  onConnectedNodes(nodes: readonly Node[]): void;
  onDisconnectedNodes(nodes: readonly Node[]): void;
}

export interface PatchRegistry {
  patch(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void;
  restorePatches(): void;
}

/**
 * Remembers what the facade overwrote on the realm's prototypes so that
 * dispose() can put it back. Restoring drains the record newest-first: a key
 * patched more than once has to end up with the descriptor it had before the
 * first patch, and unwinding has to be idempotent, so a second run finds
 * nothing left rather than replaying the record in the wrong order.
 */
export function createPatchRegistry(): PatchRegistry {
  const patchedDescriptors: Array<{
    target: object;
    key: PropertyKey;
    descriptor: PropertyDescriptor | undefined;
  }> = [];

  return {
    patch(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void {
      patchedDescriptors.push({
        target,
        key,
        descriptor: Object.getOwnPropertyDescriptor(target, key),
      });
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

// Scripts created before nodes.ts installs the real execution hook stay inert,
// which is what the facade did before the hook was assigned.
function ignoreConnectedScript(_script: HTMLScriptElement): void {
  return undefined;
}

// Nothing writes an attribute through the facade before nodes.ts assigns the
// real marker: the Element patches that route here are installed after it.
function ignoreVirtualAttribute(_attribute: Attr): void {
  return undefined;
}

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
  const nativeGetRootNode = nodePrototype.getRootNode;
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
  const nativeHasAttribute = elementPrototype.hasAttribute;
  const nativeHasAttributeNS = elementPrototype.hasAttributeNS;
  const nativeSetAttribute = elementPrototype.setAttribute;
  const nativeSetAttributeNS = elementPrototype.setAttributeNS;
  const nativeRemoveAttribute = elementPrototype.removeAttribute;
  const nativeRemoveAttributeNS = elementPrototype.removeAttributeNS;
  const nativeToggleAttribute = elementPrototype.toggleAttribute;
  const nativeMatches = elementPrototype.matches;
  const nativeClosest = elementPrototype.closest;
  const nativeQuerySelector = elementPrototype.querySelector;
  const nativeQuerySelectorAll = elementPrototype.querySelectorAll;
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
    element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    element.localName === localName;
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
    nativeGetRootNode.call(node) === options.shadowRoot;
  const virtualNodes = new WeakSet<Node>();
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
    if (isElementNode(node) && isBaseElement(node)) {
      return true;
    }
    return "querySelector" in node && (node as ParentNode).querySelector("base") !== null;
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
    ) as DOMRect[] & { item(index: number): DOMRect | null };
    Object.defineProperty(rects, "item", {
      configurable: true,
      value: (index: number) => rects[index] ?? null,
    });
    return rects as unknown as DOMRectList;
  };
  const toHostViewportPoint = (x: number, y: number): { x: number; y: number } => {
    const origin = viewportOrigin();
    return { x: x + origin.x, y: y + origin.y };
  };

  const hostWindow = hostDocument.defaultView;
  let topLayerViewportActivated = false;
  const refreshTopLayerViewportStyle = (): void => {
    if (!topLayerViewportActivated) return;
    const origin = viewportOrigin();
    // Promotion changes the CSS viewport to the host page; translate it back
    // to the child viewport while preserving the browser's top-layer clipping escape.
    options.updateTopLayerViewport(origin.x, origin.y);
  };
  const refreshOpeningTopLayer: EventListener = (event) => {
    if ((event as Event & { newState?: string }).newState === "open") {
      topLayerViewportActivated = true;
      refreshTopLayerViewportStyle();
    }
  };
  const topLayerListenerLifetime = new AbortController();
  options.html.addEventListener("beforetoggle", refreshOpeningTopLayer, {
    capture: true,
    signal: topLayerListenerLifetime.signal,
  });
  hostWindow?.addEventListener("resize", refreshTopLayerViewportStyle, {
    signal: topLayerListenerLifetime.signal,
  });
  hostWindow?.addEventListener("scroll", refreshTopLayerViewportStyle, {
    capture: true,
    signal: topLayerListenerLifetime.signal,
  });

  return {
    options,
    window,
    document,
    hostDocument,
    privateHead,
    privateBody,
    documentPrototype,
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
    nativeGetRootNode,
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
    nativeHasAttribute,
    nativeHasAttributeNS,
    nativeSetAttribute,
    nativeSetAttributeNS,
    nativeRemoveAttribute,
    nativeRemoveAttributeNS,
    nativeToggleAttribute,
    nativeMatches,
    nativeClosest,
    nativeQuerySelector,
    nativeQuerySelectorAll,
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
    virtualNodes,
    createdScripts,
    protectedScriptAttributes,
    eventAttributeValues,
    cssomMutatedStyleElements,
    authoredLinkRelValues,
    logicalEventTargets,
    // Reassigned by nodes.ts once script execution is wired up; the attribute
    // facades reach dynamic scripts through this slot.
    executeConnectedScript: ignoreConnectedScript,
    // Reassigned by nodes.ts once marking exists; the attribute facade reaches
    // the Attr nodes its writes create through this slot.
    markVirtualAttribute: ignoreVirtualAttribute,
    patch,
    restorePatches,
    getVirtualBoundingClientRect,
    getVirtualClientRects,
    toHostViewportPoint,
    dispose(): void {
      topLayerListenerLifetime.abort();
    },
  };
}
