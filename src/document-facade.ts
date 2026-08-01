import { translateShellSelector } from "./css.js";
import {
  createFacadeContext,
  HTML_NAMESPACE,
  type DocumentFacadeOptions,
  type NativeDocumentHandles,
} from "./facade/context.js";
import { installAttributeFacade } from "./facade/attributes.js";
import { installNodeFacade } from "./facade/nodes.js";
import { DOCUMENT_EVENT_HANDLER_NAMES, installEventFacade } from "./facade/events.js";
import { installStyleFacade } from "./facade/style.js";
import { createSelectionFacade } from "./selection-facade.js";

export type {
  DocumentFacadeOptions,
  NativeDocumentHandles,
} from "./facade/context.js";

export interface DocumentFacade {
  native: NativeDocumentHandles;
  getSelection(): Selection;
  markVirtualTree(node: Node): void;
  rebaseURLs(): void;
  synchronizeURLAttribute(
    element: Element,
    attributeName: string,
    namespaceURI: string | null,
  ): void;
  synchronizeStyleAttribute(element: Element): void;
  eventForListener(event: Event, currentTarget: EventTarget): Event;
  suppressEventDefault(event: Event): void;
  wasEventDefaultPrevented(event: Event): boolean;
  setReadyState(state: DocumentReadyState): void;
  dispatchDocumentEvent(type: string, options?: EventInit): boolean;
  dispose(): void;
}

function translateSelector(selector: string): string {
  try {
    return translateShellSelector(selector);
  } catch {
    return selector;
  }
}

function staticCollection<T extends Element>(elements: T[]): HTMLCollectionOf<T> {
  const collection = elements as unknown as HTMLCollectionOf<T> & {
    item(index: number): T | null;
    namedItem(name: string): T | null;
  };
  Object.defineProperties(collection, {
    item: {
      value(index: number) {
        return elements[index] ?? null;
      },
    },
    namedItem: {
      value(name: string) {
        return (
          elements.find(
            (element) => element.id === name || element.getAttribute("name") === name,
          ) ?? null
        );
      },
    },
  });
  return collection;
}

function staticNodeList<T extends Node>(nodes: T[]): NodeListOf<T> {
  const list = nodes as unknown as NodeListOf<T> & { item(index: number): T | null };
  Object.defineProperty(list, "item", {
    value(index: number) {
      return nodes[index] ?? null;
    },
  });
  return list;
}

interface LiveIndexedCollection<T extends object> {
  readonly length: number;
  item(index: number): T | null;
  readonly [index: number]: T;
}

function propertyIndex(property: PropertyKey): number | null {
  if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) {
    return null;
  }
  const index = Number(property);
  return Number.isSafeInteger(index) ? index : null;
}

function liveIndexedCollection<T extends object>(
  prototype: object,
  currentValues: () => T[],
  currentNamedValue?: (name: string) => T | null,
): LiveIndexedCollection<T> {
  const target = Object.create(prototype) as object;
  const itemAt = (index: number): T | null => currentValues()[index] ?? null;
  const namedItem = (name: string): T | null => currentNamedValue?.(String(name)) ?? null;
  const iterator = (): ArrayIterator<T> => currentValues()[Symbol.iterator]();

  const proxy = new Proxy(target, {
    get(proxyTarget, property, receiver) {
      if (property === "length") {
        return currentValues().length;
      }
      if (property === "item") {
        return itemAt;
      }
      if (property === "namedItem" && currentNamedValue !== undefined) {
        return namedItem;
      }
      if (property === Symbol.iterator) {
        return iterator;
      }

      const index = propertyIndex(property);
      if (index !== null) {
        return currentValues()[index];
      }
      if (Reflect.has(proxyTarget, property)) {
        // Prototype iteration helpers brand-check their receiver, which the
        // proxy fails; reimplement them over the live values instead.
        switch (property) {
          case "forEach":
            return (
              callback: (value: T, index: number, list: unknown) => void,
              thisArg?: unknown,
            ) => {
              currentValues().forEach((value, valueIndex) =>
                callback.call(thisArg, value, valueIndex, proxy),
              );
            };
          case "entries":
            return () => currentValues().entries();
          case "keys":
            return () => currentValues().keys();
          case "values":
            return () => currentValues().values();
        }
        return Reflect.get(proxyTarget, property, receiver);
      }
      if (typeof property === "string" && currentNamedValue !== undefined) {
        return currentNamedValue(property) ?? undefined;
      }
      return undefined;
    },
    has(proxyTarget, property) {
      const index = propertyIndex(property);
      if (index !== null) {
        return index < currentValues().length;
      }
      if (typeof property === "string" && currentNamedValue !== undefined) {
        const namedValue = currentNamedValue(property);
        if (namedValue !== null) {
          return true;
        }
      }
      return Reflect.has(proxyTarget, property);
    },
    ownKeys(proxyTarget) {
      return [
        ...currentValues().map((_value, index) => String(index)),
        ...Reflect.ownKeys(proxyTarget),
      ];
    },
    getOwnPropertyDescriptor(proxyTarget, property) {
      const index = propertyIndex(property);
      const value = index === null ? undefined : currentValues()[index];
      if (value !== undefined) {
        return {
          configurable: true,
          enumerable: true,
          value,
          writable: false,
        };
      }
      return Reflect.getOwnPropertyDescriptor(proxyTarget, property);
    },
  });
  return proxy as LiveIndexedCollection<T>;
}

export function installDocumentFacade(options: DocumentFacadeOptions): DocumentFacade {
  const context = createFacadeContext(options);
  const {
    window,
    document,
    hostDocument,
    privateHead,
    elementPrototype,
    nativeCreateElement,
    nativeCreateElementNS,
    nativeCreateTextNode,
    nativeCreateComment,
    nativeCreateDocumentFragment,
    nativeImportNode,
    nativeCreateAttribute,
    nativeCreateAttributeNS,
    nativeAppendChild,
    nativeDispatchEvent,
    nativeGetAttribute,
    nativeHasAttribute,
    nativeSetAttribute,
    nativeMatches,
    nativeClosest,
    nativeQuerySelector,
    nativeQuerySelectorAll,
    nativeGetElementsByTagName,
    nativeGetElementsByTagNameNS,
    nativeCurrentScript,
    isInVirtualDocumentTree,
    subtreeHasBaseElement,
    virtualNodes,
    createdScripts,
    logicalEventTargets,
    patch,
    toHostViewportPoint,
  } = context;
  let readyState: DocumentReadyState = "loading";

  const style = installStyleFacade(context);
  const {
    refreshInlineStyleSheet,
    synchronizeStyleAttribute,
    installPatches: installStylePatches,
  } = style;

  const events = installEventFacade(context);
  const {
    eventForListener,
    ensureRootEventRelay,
    documentListeners,
    suppressEventDefault,
    wasEventDefaultPrevented,
    installHandlerProperties: installEventHandlerProperties,
    installRelays: installEventRelays,
    installPatches: installEventPatches,
    dispose: disposeEventFacade,
  } = events;

  const attributes = installAttributeFacade(context, style, events);
  const {
    rebaseElementURLs,
    synchronizeURLAttribute,
    installPatches: installAttributePatches,
  } = attributes;

  const nodes = installNodeFacade(context, style, events, attributes);
  const {
    markVirtualNode,
    virtualDoctype,
    virtualCreateElement,
    prepareInsertion,
    insertedNodes,
    finishInsertion,
    finishVirtualClone,
    installMutationPatches,
    installNodePatches,
    dispose: disposeNodeFacade,
  } = nodes;

  installEventHandlerProperties();

  installMutationPatches();

  installEventRelays();

  installEventPatches();

  installAttributePatches();
  installStylePatches();
  installNodePatches();
  patch(elementPrototype, "matches", {
    writable: true,
    value(this: Element, selectors: string): boolean {
      if (!isInVirtualDocumentTree(this)) {
        return nativeMatches.call(this, selectors);
      }
      return (
        nativeMatches.call(this, selectors) ||
        nativeMatches.call(this, translateSelector(selectors))
      );
    },
  });
  patch(elementPrototype, "closest", {
    writable: true,
    value(this: Element, selectors: string): Element | null {
      if (!isInVirtualDocumentTree(this)) {
        return nativeClosest.call(this, selectors);
      }
      const translated = translateSelector(selectors);
      let candidate: Element | null = this;
      while (candidate !== null) {
        if (
          nativeMatches.call(candidate, selectors) ||
          nativeMatches.call(candidate, translated)
        ) {
          return candidate;
        }
        candidate = candidate.parentElement;
      }
      return null;
    },
  });

  const sortElementsInDocumentOrder = (elements: Element[]): Element[] =>
    elements.sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left.compareDocumentPosition(right) & window.Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    });

  const querySelectorAllWithShell = (root: Element, selectors: string): Element[] => {
    const translated = translateSelector(selectors);
    const matches = Array.from(nativeQuerySelectorAll.call(root, selectors));
    if (translated === selectors) {
      return matches;
    }
    const seen = new Set(matches);
    for (const match of Array.from(nativeQuerySelectorAll.call(root, translated))) {
      if (!seen.has(match)) {
        seen.add(match);
        matches.push(match);
      }
    }
    return sortElementsInDocumentOrder(matches);
  };
  patch(elementPrototype, "querySelector", {
    writable: true,
    value(this: Element, selectors: string): Element | null {
      return isInVirtualDocumentTree(this)
        ? (querySelectorAllWithShell(this, selectors)[0] ?? null)
        : nativeQuerySelector.call(this, selectors);
    },
  });
  patch(elementPrototype, "querySelectorAll", {
    writable: true,
    value(this: Element, selectors: string): NodeListOf<Element> {
      return isInVirtualDocumentTree(this)
        ? staticNodeList(querySelectorAllWithShell(this, selectors))
        : nativeQuerySelectorAll.call(this, selectors);
    },
  });

  const querySelector = (selectors: string): Element | null => {
    const translated = translateSelector(selectors);
    if (
      nativeMatches.call(options.html, selectors) ||
      nativeMatches.call(options.html, translated)
    ) {
      return options.html;
    }
    return querySelectorAllWithShell(options.html, selectors)[0] ?? null;
  };
  const querySelectorAll = (selectors: string): NodeListOf<Element> => {
    const translated = translateSelector(selectors);
    const matches = querySelectorAllWithShell(options.html, selectors);
    if (
      nativeMatches.call(options.html, selectors) ||
      nativeMatches.call(options.html, translated)
    ) {
      matches.unshift(options.html);
    }
    return staticNodeList(matches);
  };
  const createLiveHTMLCollection = <T extends Element>(
    currentElements: () => T[],
  ): HTMLCollectionOf<T> =>
    liveIndexedCollection(window.HTMLCollection.prototype, currentElements, (name) => {
      if (name === "") {
        return null;
      }
      return (
        currentElements().find(
          (element) =>
            nativeGetAttribute.call(element, "id") === name ||
            nativeGetAttribute.call(element, "name") === name,
        ) ?? null
      );
    }) as unknown as HTMLCollectionOf<T>;
  const tagCollections = new Map<string, HTMLCollectionOf<Element>>();
  const getElementsByTagName = (qualifiedName: string): HTMLCollectionOf<Element> => {
    const requestedName = String(qualifiedName);
    const existing = tagCollections.get(requestedName);
    if (existing !== undefined) {
      return existing;
    }

    // The native lookup lowercases HTML-namespace names itself while matching
    // foreign elements (SVG, MathML) case-sensitively; only the shell
    // translation below wants the lowercase form.
    const collectionName = requestedName.toLowerCase();
    const collection = createLiveHTMLCollection(() => {
      const translated = collectionName === "*" ? "*" : translateSelector(collectionName);
      const matches = Array.from(
        nativeGetElementsByTagName.call(options.html, requestedName),
      );
      if (translated !== collectionName) {
        const seen = new Set(matches);
        for (const match of Array.from(
          nativeGetElementsByTagName.call(options.html, translated),
        )) {
          if (!seen.has(match)) {
            matches.push(match);
          }
        }
      }
      sortElementsInDocumentOrder(matches);
      if (
        collectionName === "*" ||
        collectionName === "html" ||
        options.html.localName === collectionName
      ) {
        matches.unshift(options.html);
      }
      return matches;
    });
    tagCollections.set(requestedName, collection);
    return collection;
  };
  const namespaceTagCollections = new Map<string, HTMLCollectionOf<Element>>();
  const getElementsByTagNameNS = (
    namespaceURI: string | null,
    localName: string,
  ): HTMLCollectionOf<Element> => {
    const namespace = namespaceURI === null ? null : String(namespaceURI);
    const requestedName = String(localName);
    const collectionKey = `${namespace ?? "null"}\u0000${requestedName}`;
    const existing = namespaceTagCollections.get(collectionKey);
    if (existing !== undefined) {
      return existing;
    }

    const collection = createLiveHTMLCollection(() => {
      const matches = Array.from(
        nativeGetElementsByTagNameNS.call(options.html, namespace, requestedName),
      );
      const shellName =
        requestedName === "html"
          ? "v-html"
          : requestedName === "head"
            ? "v-head"
            : requestedName === "body"
              ? "v-body"
              : requestedName;
      if (
        (namespace === "*" || namespace === HTML_NAMESPACE) &&
        shellName !== requestedName
      ) {
        const seen = new Set(matches);
        for (const match of Array.from(
          nativeGetElementsByTagNameNS.call(options.html, HTML_NAMESPACE, shellName),
        )) {
          if (!seen.has(match)) {
            matches.push(match);
          }
        }
      }
      sortElementsInDocumentOrder(matches);
      if (
        (namespace === "*" || namespace === HTML_NAMESPACE) &&
        (requestedName === "*" || requestedName === "html")
      ) {
        matches.unshift(options.html);
      }
      return matches;
    });
    namespaceTagCollections.set(collectionKey, collection);
    return collection;
  };
  const classCollections = new Map<string, HTMLCollectionOf<Element>>();
  const getElementsByClassName = (names: string): HTMLCollectionOf<Element> => {
    const classNames = String(names);
    const existing = classCollections.get(classNames);
    if (existing !== undefined) {
      return existing;
    }

    const collection = createLiveHTMLCollection(() => {
      const matches = Array.from(options.html.getElementsByClassName(classNames));
      const requiredClasses = classNames
        .split(/[\t\n\f\r ]+/)
        .filter((className) => className !== "");
      if (
        requiredClasses.length > 0 &&
        requiredClasses.every((className) => options.html.classList.contains(className))
      ) {
        matches.unshift(options.html);
      }
      return matches;
    });
    classCollections.set(classNames, collection);
    return collection;
  };
  const styleSheetCollection = liveIndexedCollection(
    window.StyleSheetList.prototype,
    () =>
      Array.from(nativeQuerySelectorAll.call(options.html, "style"))
        .map((style) => (style as HTMLStyleElement).sheet)
        .filter((sheet): sheet is CSSStyleSheet => sheet !== null),
  ) as unknown as StyleSheetList;
  const formCollection = createLiveHTMLCollection(
    () =>
      Array.from(nativeQuerySelectorAll.call(options.html, "form")) as HTMLFormElement[],
  );
  const imageCollection = createLiveHTMLCollection(
    () =>
      Array.from(nativeQuerySelectorAll.call(options.html, "img")) as HTMLImageElement[],
  );
  const scriptCollection = createLiveHTMLCollection(
    () =>
      Array.from(
        nativeQuerySelectorAll.call(options.html, "script"),
      ) as HTMLScriptElement[],
  );
  const linkCollection = createLiveHTMLCollection(
    () =>
      Array.from(
        nativeQuerySelectorAll.call(options.html, "a[href], area[href]"),
      ) as Array<HTMLAnchorElement | HTMLAreaElement>,
  );
  const anchorCollection = createLiveHTMLCollection(
    () =>
      Array.from(
        nativeQuerySelectorAll.call(options.html, "a[name]"),
      ) as HTMLAnchorElement[],
  );
  const embedCollection = createLiveHTMLCollection(
    () =>
      Array.from(
        nativeQuerySelectorAll.call(options.html, "embed"),
      ) as HTMLEmbedElement[],
  );
  const namedNodeLists = new Map<string, NodeListOf<HTMLElement>>();
  const getElementsByName = (name: string): NodeListOf<HTMLElement> => {
    const requestedName = String(name);
    const existing = namedNodeLists.get(requestedName);
    if (existing !== undefined) {
      return existing;
    }
    const selector = `[name="${window.CSS.escape(requestedName)}"]`;
    const list = liveIndexedCollection(
      window.NodeList.prototype,
      () =>
        Array.from(nativeQuerySelectorAll.call(options.html, selector)) as HTMLElement[],
    ) as unknown as NodeListOf<HTMLElement>;
    namedNodeLists.set(requestedName, list);
    return list;
  };
  const createVirtualRange = (): Range => {
    const range = hostDocument.createRange();
    const nativeInsertNode = range.insertNode.bind(range);
    const nativeSurroundContents = range.surroundContents.bind(range);
    Object.defineProperties(range, {
      insertNode: {
        configurable: true,
        value(node: Node) {
          prepareInsertion(node);
          const nodes = insertedNodes(node);
          const baseElementChanged = nodes.some(subtreeHasBaseElement);
          nativeInsertNode(node);
          if (range.startContainer.isConnected) {
            finishInsertion(nodes, baseElementChanged);
          }
        },
      },
      surroundContents: {
        configurable: true,
        value(node: Node) {
          prepareInsertion(node);
          const nodes = insertedNodes(node);
          const baseElementChanged = nodes.some(subtreeHasBaseElement);
          nativeSurroundContents(node);
          if (range.startContainer.isConnected) {
            finishInsertion(nodes, baseElementChanged);
          }
        },
      },
    });
    return range;
  };
  let disposed = false;
  let selectionChangeTimer: number | undefined;
  const dispatchSelectionChange = (): void => {
    if (disposed || selectionChangeTimer !== undefined) {
      return;
    }
    selectionChangeTimer = window.setTimeout(() => {
      selectionChangeTimer = undefined;
      if (disposed) {
        return;
      }
      const event = new window.Event("selectionchange");
      logicalEventTargets.set(event, document);
      nativeDispatchEvent.call(document, event);
    }, 0);
  };
  const selectionFacade = createSelectionFacade({
    window,
    hostDocument,
    root: options.html,
    onSelectionChange: dispatchSelectionChange,
  });
  const selection = selectionFacade.selection;
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

  return {
    native: {
      privateHead,
      createElement<K extends keyof HTMLElementTagNameMap>(name: K) {
        return nativeCreateElement.call(document, name) as HTMLElementTagNameMap[K];
      },
      appendChild<T extends Node>(parent: Node, child: T): T {
        return nativeAppendChild.call(parent, child) as T;
      },
      getAttribute(element: Element, name: string) {
        return nativeGetAttribute.call(element, name);
      },
      setAttribute(element: Element, name: string, value: string) {
        nativeSetAttribute.call(element, name, value);
      },
    },
    getSelection: () => selection,
    markVirtualTree: markVirtualNode,
    rebaseURLs() {
      for (const element of options.authoredURLAttributes.keys()) {
        if (virtualNodes.has(element)) {
          rebaseElementURLs(element);
        }
      }
      refreshInlineStyleSheet();
    },
    synchronizeURLAttribute,
    synchronizeStyleAttribute,
    eventForListener,
    suppressEventDefault,
    wasEventDefaultPrevented,
    setReadyState(state) {
      readyState = state;
      const event = new window.Event("readystatechange");
      logicalEventTargets.set(event, document);
      nativeDispatchEvent.call(document, event);
    },
    dispatchDocumentEvent(type, eventOptions = {}) {
      const event = new window.Event(type, eventOptions);
      logicalEventTargets.set(event, document);
      return nativeDispatchEvent.call(document, event);
    },
    dispose() {
      disposed = true;
      context.dispose();
      if (selectionChangeTimer !== undefined) {
        window.clearTimeout(selectionChangeTimer);
        selectionChangeTimer = undefined;
      }
      selectionFacade.dispose();
      disposeEventFacade();
      context.restorePatches();
      disposeNodeFacade();
    },
  };
}
