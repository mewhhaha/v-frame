// The document the guest sees is the realm's own Document object with every
// tree-shaped property answered from the shell instead: documentElement, head
// and body are the shell elements, the child list is the doctype plus the
// shell, listeners are relayed from the shell root, and the APIs that would
// need a real parsed document — write(), open(), adoptedStyleSheets, direct
// child mutation — throw rather than lie.

import {
  staticCollection,
  staticNodeList,
  type CollectionFacade,
} from "./collections.js";
import type { FacadeContext } from "./context.js";
import { DOCUMENT_EVENT_HANDLER_NAMES, type EventFacade } from "./events.js";
import type { NodeFacade } from "./nodes.js";
import type { SelectionFacadeInstallation } from "./selection.js";

export interface DocumentProperties {
  setReadyState(state: DocumentReadyState): void;
  dispatchDocumentEvent(type: string, eventOptions?: EventInit): boolean;
}

export function installDocumentProperties(
  context: FacadeContext,
  events: EventFacade,
  nodes: NodeFacade,
  collections: CollectionFacade,
  selectionFacade: SelectionFacadeInstallation,
): DocumentProperties {
  const options = context.options;
  const {
    window,
    document,
    hostDocument,
    nativeCreateElementNS,
    nativeCreateTextNode,
    nativeCreateComment,
    nativeCreateDocumentFragment,
    nativeImportNode,
    nativeCreateAttribute,
    nativeCreateAttributeNS,
    nativeDispatchEvent,
    nativeHasAttribute,
    nativeQuerySelector,
    nativeCurrentScript,
    virtualNodes,
    createdScripts,
    logicalEventTargets,
    toHostViewportPoint,
  } = context;
  const { documentListeners, ensureRootEventRelay } = events;
  const { markVirtualNode, virtualDoctype, virtualCreateElement, finishVirtualClone } =
    nodes;
  const {
    querySelector,
    querySelectorAll,
    getElementsByTagName,
    getElementsByTagNameNS,
    getElementsByClassName,
    getElementsByName,
    styleSheetCollection,
    formCollection,
    imageCollection,
    scriptCollection,
    linkCollection,
    anchorCollection,
    embedCollection,
  } = collections;
  const { selection, createVirtualRange } = selectionFacade;
  let readyState: DocumentReadyState = "loading";

  const documentChildNodes = staticNodeList([virtualDoctype, options.html]);
  const documentChildren = staticCollection([options.html]);

  Object.defineProperties(document, {
    doctype: { configurable: true, get: () => virtualDoctype },
    documentElement: { configurable: true, get: () => options.html },
    head: { configurable: true, get: () => options.head },
    body: { configurable: true, get: () => options.body },
    scrollingElement: { configurable: true, get: () => options.html },
    activeElement: {
      configurable: true,
      get: () => options.shadowRoot.activeElement ?? options.body,
    },
    currentScript: {
      configurable: true,
      get: () =>
        options.getCurrentScript() ?? nativeCurrentScript?.call(document) ?? null,
    },
    readyState: { configurable: true, get: () => readyState },
    URL: { configurable: true, get: options.getCurrentURL },
    documentURI: { configurable: true, get: options.getCurrentURL },
    baseURI: { configurable: true, get: options.getBaseURL },
    hidden: { configurable: true, get: () => false },
    visibilityState: { configurable: true, get: () => "visible" },
    styleSheets: { configurable: true, get: () => styleSheetCollection },
    adoptedStyleSheets: {
      configurable: true,
      get: unsupportedAdoptedStyleSheets,
      set: unsupportedAdoptedStyleSheets,
    },
    fonts: { configurable: true, get: () => hostDocument.fonts },
    forms: {
      configurable: true,
      get: () => formCollection,
    },
    images: {
      configurable: true,
      get: () => imageCollection,
    },
    scripts: {
      configurable: true,
      get: () => scriptCollection,
    },
    links: {
      configurable: true,
      get: () => linkCollection,
    },
    anchors: {
      configurable: true,
      get: () => anchorCollection,
    },
    embeds: {
      configurable: true,
      get: () => embedCollection,
    },
    plugins: {
      configurable: true,
      get: () => embedCollection,
    },
    title: {
      configurable: true,
      get: () => options.head.querySelector("title")?.textContent ?? "",
      set(value: string) {
        let title = options.head.querySelector("title");
        if (title === null) {
          title = document.createElement("title");
          options.head.append(title);
        }
        title.textContent = String(value);
      },
    },
    childNodes: {
      configurable: true,
      get: () => documentChildNodes,
    },
    children: {
      configurable: true,
      get: () => documentChildren,
    },
    firstChild: { configurable: true, get: () => virtualDoctype },
    lastChild: { configurable: true, get: () => options.html },
    firstElementChild: { configurable: true, get: () => options.html },
    lastElementChild: { configurable: true, get: () => options.html },
    childElementCount: { configurable: true, get: () => 1 },
    addEventListener: {
      configurable: true,
      writable: true,
      value(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        listenerOptions?: boolean | AddEventListenerOptions,
      ) {
        ensureRootEventRelay(type);
        documentListeners.add(type, listener, listenerOptions);
      },
    },
    removeEventListener: {
      configurable: true,
      writable: true,
      value(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        listenerOptions?: boolean | EventListenerOptions,
      ) {
        documentListeners.remove(type, listener, listenerOptions);
      },
    },
    dispatchEvent: {
      configurable: true,
      writable: true,
      value(event: Event) {
        logicalEventTargets.set(event, document);
        return nativeDispatchEvent.call(document, event);
      },
    },
    querySelector: { configurable: true, writable: true, value: querySelector },
    querySelectorAll: { configurable: true, writable: true, value: querySelectorAll },
    getElementById: {
      configurable: true,
      writable: true,
      value(id: string) {
        const identifier = String(id);
        // An empty id attribute means the element has no ID.
        if (identifier === "") {
          return null;
        }
        if (
          options.html.id === identifier &&
          nativeHasAttribute.call(options.html, "id")
        ) {
          return options.html;
        }
        return nativeQuerySelector.call(
          options.html,
          `[id="${window.CSS.escape(identifier)}"]`,
        );
      },
    },
    getElementsByTagName: {
      configurable: true,
      writable: true,
      value: getElementsByTagName,
    },
    getElementsByTagNameNS: {
      configurable: true,
      writable: true,
      value: getElementsByTagNameNS,
    },
    getElementsByClassName: {
      configurable: true,
      writable: true,
      value: getElementsByClassName,
    },
    getElementsByName: {
      configurable: true,
      writable: true,
      value: getElementsByName,
    },
    contains: {
      configurable: true,
      writable: true,
      value(node: Node | null) {
        return (
          node === document ||
          node === virtualDoctype ||
          node === options.html ||
          options.html.contains(node)
        );
      },
    },
    createElement: {
      configurable: true,
      writable: true,
      value: virtualCreateElement,
    },
    createElementNS: {
      configurable: true,
      writable: true,
      value(
        namespace: string | null,
        qualifiedName: string,
        creationOptions?: string | ElementCreationOptions,
      ) {
        const element = nativeCreateElementNS.call(
          document,
          namespace,
          qualifiedName,
          creationOptions,
        );
        hostDocument.adoptNode(element);
        markVirtualNode(element);
        if (element instanceof window.HTMLScriptElement) {
          createdScripts.add(element);
        }
        return element;
      },
    },
    createTextNode: {
      configurable: true,
      writable: true,
      value(data: string) {
        const node = nativeCreateTextNode.call(document, data);
        hostDocument.adoptNode(node);
        markVirtualNode(node);
        return node;
      },
    },
    createComment: {
      configurable: true,
      writable: true,
      value(data: string) {
        const node = nativeCreateComment.call(document, data);
        hostDocument.adoptNode(node);
        markVirtualNode(node);
        return node;
      },
    },
    createDocumentFragment: {
      configurable: true,
      writable: true,
      value() {
        const fragment = nativeCreateDocumentFragment.call(document);
        hostDocument.adoptNode(fragment);
        markVirtualNode(fragment);
        return fragment;
      },
    },
    importNode: {
      configurable: true,
      writable: true,
      value(node: Node, deep = false) {
        const imported = nativeImportNode.call(document, node, deep);
        hostDocument.adoptNode(imported);
        if (virtualNodes.has(node)) {
          return finishVirtualClone(node, imported);
        }
        markVirtualNode(imported);
        return imported;
      },
    },
    adoptNode: {
      configurable: true,
      writable: true,
      value<T extends Node>(node: T): T {
        const adopted = hostDocument.adoptNode(node);
        markVirtualNode(adopted);
        return adopted;
      },
    },
    createAttribute: {
      configurable: true,
      writable: true,
      value(name: string) {
        const attribute = nativeCreateAttribute.call(document, name);
        markVirtualNode(attribute);
        return attribute;
      },
    },
    createAttributeNS: {
      configurable: true,
      writable: true,
      value(namespace: string | null, qualifiedName: string) {
        const attribute = nativeCreateAttributeNS.call(
          document,
          namespace,
          qualifiedName,
        );
        markVirtualNode(attribute);
        return attribute;
      },
    },
    createRange: {
      configurable: true,
      writable: true,
      value: createVirtualRange,
    },
    createTreeWalker: {
      configurable: true,
      writable: true,
      value(root: Node, whatToShow?: number, filter?: NodeFilter | null) {
        return hostDocument.createTreeWalker(
          root === document ? options.html : root,
          whatToShow,
          filter,
        );
      },
    },
    createNodeIterator: {
      configurable: true,
      writable: true,
      value(root: Node, whatToShow?: number, filter?: NodeFilter | null) {
        return hostDocument.createNodeIterator(
          root === document ? options.html : root,
          whatToShow,
          filter,
        );
      },
    },
    getSelection: {
      configurable: true,
      writable: true,
      value: () => selection,
    },
    hasFocus: {
      configurable: true,
      writable: true,
      value() {
        return hostDocument.hasFocus() && options.shadowRoot.activeElement !== null;
      },
    },
    elementFromPoint: {
      configurable: true,
      writable: true,
      value(x: number, y: number) {
        const point = toHostViewportPoint(x, y);
        return options.shadowRoot.elementFromPoint?.(point.x, point.y) ?? null;
      },
    },
    elementsFromPoint: {
      configurable: true,
      writable: true,
      value(x: number, y: number) {
        const point = toHostViewportPoint(x, y);
        return options.shadowRoot.elementsFromPoint?.(point.x, point.y) ?? [];
      },
    },
    appendChild: {
      configurable: true,
      writable: true,
      value: unsupportedDirectDocumentMutation,
    },
    insertBefore: {
      configurable: true,
      writable: true,
      value: unsupportedDirectDocumentMutation,
    },
    replaceChild: {
      configurable: true,
      writable: true,
      value: unsupportedDirectDocumentMutation,
    },
    removeChild: {
      configurable: true,
      writable: true,
      value: unsupportedDirectDocumentMutation,
    },
    append: {
      configurable: true,
      writable: true,
      value: unsupportedDirectDocumentMutation,
    },
    prepend: {
      configurable: true,
      writable: true,
      value: unsupportedDirectDocumentMutation,
    },
    replaceChildren: {
      configurable: true,
      writable: true,
      value: unsupportedDirectDocumentMutation,
    },
    open: { configurable: true, writable: true, value: unsupportedDocumentWriting },
    close: { configurable: true, writable: true, value: unsupportedDocumentWriting },
    write: { configurable: true, writable: true, value: unsupportedDocumentWriting },
    writeln: { configurable: true, writable: true, value: unsupportedDocumentWriting },
  });

  function unsupportedDocumentWriting(): never {
    throw new window.DOMException(
      "document.open(), document.close(), and document.write() are unsupported inside v-frame",
      "NotSupportedError",
    );
  }

  function unsupportedDirectDocumentMutation(): never {
    throw new window.DOMException(
      "Direct child mutation of the virtual document is unsupported inside v-frame",
      "NotSupportedError",
    );
  }

  function unsupportedAdoptedStyleSheets(): never {
    throw new window.DOMException(
      "document.adoptedStyleSheets is unsupported inside v-frame",
      "NotSupportedError",
    );
  }

  const handlerValues = new Map<
    string,
    { listener: EventListener; wrapper: EventListener }
  >();
  for (const eventName of DOCUMENT_EVENT_HANDLER_NAMES) {
    Object.defineProperty(document, `on${eventName}`, {
      configurable: true,
      get: () => handlerValues.get(eventName)?.listener ?? null,
      set(value: EventListener | null) {
        const previous = handlerValues.get(eventName);
        if (previous !== undefined) {
          documentListeners.remove(eventName, previous.wrapper);
          handlerValues.delete(eventName);
        }
        const listener = typeof value === "function" ? value : null;
        if (listener === null) {
          return;
        }
        const wrapper: EventListener = (event) => {
          const result = (listener as (this: Document, event: Event) => unknown).call(
            document,
            event,
          );
          if (result === false) {
            event.preventDefault();
          }
        };
        handlerValues.set(eventName, { listener, wrapper });
        ensureRootEventRelay(eventName);
        documentListeners.add(eventName, wrapper);
      },
    });
  }

  const setReadyState = (state: DocumentReadyState): void => {
    readyState = state;
    const event = new window.Event("readystatechange");
    logicalEventTargets.set(event, document);
    nativeDispatchEvent.call(document, event);
  };

  const dispatchDocumentEvent = (type: string, eventOptions: EventInit = {}): boolean => {
    const event = new window.Event(type, eventOptions);
    logicalEventTargets.set(event, document);
    return nativeDispatchEvent.call(document, event);
  };

  return {
    setReadyState,
    dispatchDocumentEvent,
  };
}
