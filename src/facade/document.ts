// The document the guest sees is the realm's own Document object with every
// tree-shaped property answered from the shell instead: documentElement, head
// and body are the shell elements, the child list is the doctype plus the
// shell, listeners are relayed from the shell root, constructed sheets adopted
// onto document.adoptedStyleSheets are mirrored through the CSS rewriter into
// the render shadow root, and the APIs that would need a real parsed document —
// write(), open(), direct child mutation — throw rather than lie.

import { rewriteConstructedStylesheet } from "../css.js";
import type { CollectionFacade } from "./collections.js";
import { type FacadeContext, HTML_NAMESPACE } from "./context.js";
import { cachedDocumentEventHandlerNames, type EventFacade } from "./events.js";
import type { NodeCloning } from "./clone.js";
import type { NodeMarking } from "./marking.js";
import type { SelectionFacadeInstallation } from "./selection.js";
import { toDOMString } from "./webidl.js";

export interface DocumentProperties {
  setReadyState(state: DocumentReadyState): void;
  dispatchDocumentEvent(type: string, eventOptions?: EventInit): boolean;
  dispose(): void;
}

function releasableDescriptor(descriptor: PropertyDescriptor) {
  let getter = descriptor.get;
  let setter = descriptor.set;
  let value =
    typeof descriptor.value === "function"
      ? (descriptor.value as (...args: unknown[]) => unknown)
      : undefined;
  let method: ((...args: unknown[]) => unknown) | undefined;
  if (value !== undefined) {
    const arity = value.length;
    if (arity === 0) {
      method = {
        value(this: unknown) {
          if (value === undefined) return undefined;
          return arguments.length === 0
            ? value.call(this)
            : Reflect.apply(value, this, arguments);
        },
      }.value;
    } else if (arity === 1) {
      method = {
        value(this: unknown, a: unknown) {
          if (value === undefined) return undefined;
          return arguments.length === 1
            ? value.call(this, a)
            : Reflect.apply(value, this, arguments);
        },
      }.value;
    } else if (arity === 2) {
      method = {
        value(this: unknown, a: unknown, b: unknown) {
          if (value === undefined) return undefined;
          return arguments.length === 2
            ? value.call(this, a, b)
            : Reflect.apply(value, this, arguments);
        },
      }.value;
    } else if (arity === 3) {
      method = {
        value(this: unknown, a: unknown, b: unknown, c: unknown) {
          if (value === undefined) return undefined;
          return arguments.length === 3
            ? value.call(this, a, b, c)
            : Reflect.apply(value, this, arguments);
        },
      }.value;
    } else {
      method = {
        value(this: unknown, ...args: unknown[]) {
          return value?.apply(this, args);
        },
      }.value;
    }
    if (method.name !== value.name) {
      Object.defineProperty(method, "name", { value: value.name, configurable: true });
    }
    if (method.length !== arity) {
      Object.defineProperty(method, "length", { value: arity, configurable: true });
    }
  }
  return {
    descriptor: {
      ...descriptor,
      ...(getter
        ? {
            get(this: unknown) {
              return getter?.call(this);
            },
          }
        : {}),
      ...(setter
        ? {
            set(this: unknown, value: unknown) {
              setter?.call(this, value);
            },
          }
        : {}),
      ...(method ? { value: method } : {}),
    },
    release() {
      getter = undefined;
      setter = undefined;
      value = undefined;
    },
  };
}

export function installDocumentProperties(
  context: FacadeContext,
  events: EventFacade,
  marking: NodeMarking,
  cloning: NodeCloning,
  collections: CollectionFacade,
  selectionFacade: SelectionFacadeInstallation,
): DocumentProperties {
  const options = context.options;
  const {
    window,
    document,
    hostDocument,
    nativeCreateElement,
    nativeSetAttribute,
    nativeCreateElementNS,
    nativeCreateTextNode,
    nativeCreateComment,
    nativeCreateDocumentFragment,
    nativeImportNode,
    nativeCreateAttribute,
    nativeCreateAttributeNS,
    nativeDispatchEvent,
    nativeContains,
    nativeHasAttribute,
    nativeQuerySelector,
    nativeQuerySelectorAll,
    nativeShadowGetElementById,
    noteLiteralShellElement,
    nativeCurrentScript,
    virtualNodes,
    trustedStyleNodes,
    isHTMLStyleElement,
    logicalEventTargets,
    toHostViewportPoint,
  } = context;
  const { documentListeners, ensureRootEventRelay, listenerEventSource } = events;
  const { markVirtualNode, adoptAndMark, adoptCreatedElement, virtualDoctype } = marking;
  const { finishVirtualClone } = cloning;
  const {
    staticCollection,
    staticNodeList,
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
  const guestElement = (element: Element | null): Element | null =>
    options.html.contains(element) ? element : null;
  const activeElement = () => guestElement(options.shadowRoot.activeElement);
  // The first HTML title in the document, wherever it sits, not only in head.
  const documentTitleElement = (): Element | null => {
    const first = nativeQuerySelector.call(options.html, "title");
    if (first === null) return null;
    if (first.namespaceURI === HTML_NAMESPACE) return first;
    for (const candidate of nativeQuerySelectorAll.call(options.html, "title")) {
      if (candidate.namespaceURI === HTML_NAMESPACE) return candidate;
    }
    return null;
  };
  const releases: Array<() => void> = [];
  const patchDocument = (name: string, descriptor: PropertyDescriptor) => {
    if (descriptor.get || descriptor.set || typeof descriptor.value === "function") {
      // Engines can cache a Document's customized shape after restoration.
      // Cached functions must not retain the disposed guest tree.
      const releasable = releasableDescriptor(descriptor);
      releases.push(releasable.release);
      context.patch(document, name, releasable.descriptor);
    } else context.patch(document, name, descriptor);
  };

  const hostWindow = hostDocument.defaultView;
  const HostCSSStyleSheet = hostWindow?.CSSStyleSheet;
  const guestAdoptedSheets: CSSStyleSheet[] = [];
  let appliedAdoptedMirrors: CSSStyleSheet[] = [];
  const adoptedMirrors = new WeakMap<CSSStyleSheet, CSSStyleSheet>();
  const adoptedMirrorRestores: Array<() => void> = [];

  const serializeConstructedSheet = (sheet: CSSStyleSheet): string => {
    let text = "";
    const rules = sheet.cssRules;
    for (let index = 0; index < rules.length; index += 1) {
      text += `${rules[index]!.cssText}\n`;
    }
    return text;
  };

  const syncConstructedMirror = (sheet: CSSStyleSheet, mirror: CSSStyleSheet): void => {
    const baseURL = options.constructedSheetBaseURLs?.get(sheet) ?? options.getBaseURL();
    mirror.disabled = sheet.disabled;
    const mediaText = sheet.media.mediaText;
    if (mirror.media.mediaText !== mediaText) {
      mirror.media.mediaText = mediaText;
    }
    const cssText = serializeConstructedSheet(sheet);
    const rewritten =
      cssText === "" ? "" : rewriteConstructedStylesheet(cssText, baseURL);
    mirror.replaceSync(rewritten);
  };

  const hookConstructedSheet = (sheet: CSSStyleSheet, mirror: CSSStyleSheet): void => {
    const restoreProperty = (
      property: PropertyKey,
      previous: PropertyDescriptor | undefined,
    ) => {
      adoptedMirrorRestores.push(() => {
        if (previous === undefined) {
          delete (sheet as unknown as Record<PropertyKey, unknown>)[property];
        } else {
          Object.defineProperty(sheet, property, previous);
        }
      });
    };
    const syncLater = () => {
      try {
        syncConstructedMirror(sheet, mirror);
      } catch {
        // Malformed rules are already rejected by the native sheet call.
      }
    };
    for (const methodName of [
      "replaceSync",
      "insertRule",
      "deleteRule",
      "addRule",
    ] as const) {
      const sheetRecord = sheet as unknown as Record<
        string,
        ((...args: unknown[]) => unknown) | undefined
      >;
      const nativeMethod = sheetRecord[methodName];
      if (typeof nativeMethod !== "function") continue;
      const previous = Object.getOwnPropertyDescriptor(sheet, methodName);
      Object.defineProperty(sheet, methodName, {
        configurable: true,
        writable: true,
        value(...args: unknown[]) {
          const result = Reflect.apply(nativeMethod, sheet, args);
          syncLater();
          return result;
        },
      });
      restoreProperty(methodName, previous);
    }
    const nativeReplace = sheet.replace;
    if (typeof nativeReplace === "function") {
      const previous = Object.getOwnPropertyDescriptor(sheet, "replace");
      Object.defineProperty(sheet, "replace", {
        configurable: true,
        writable: true,
        value(text: string) {
          return nativeReplace.call(sheet, text).then((resolved) => {
            syncLater();
            return resolved;
          });
        },
      });
      restoreProperty("replace", previous);
    }
    const disabledDescriptor =
      Object.getOwnPropertyDescriptor(sheet, "disabled") ??
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sheet), "disabled") ??
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(Object.getPrototypeOf(sheet)),
        "disabled",
      );
    if (disabledDescriptor?.get && disabledDescriptor.set) {
      const previous = Object.getOwnPropertyDescriptor(sheet, "disabled");
      Object.defineProperty(sheet, "disabled", {
        configurable: true,
        get: () => disabledDescriptor.get!.call(sheet),
        set(value: boolean) {
          disabledDescriptor.set!.call(sheet, value);
          mirror.disabled = sheet.disabled;
        },
      });
      restoreProperty("disabled", previous);
    }
  };

  const ensureAdoptedMirror = (sheet: CSSStyleSheet): CSSStyleSheet => {
    let mirror = adoptedMirrors.get(sheet);
    if (mirror !== undefined) {
      syncConstructedMirror(sheet, mirror);
      return mirror;
    }
    if (typeof HostCSSStyleSheet !== "function") {
      throw new window.DOMException(
        "Constructable stylesheets are unavailable",
        "NotSupportedError",
      );
    }
    const baseURL = options.constructedSheetBaseURLs?.get(sheet) ?? options.getBaseURL();
    mirror = new HostCSSStyleSheet({
      baseURL,
      media: sheet.media.mediaText,
      disabled: sheet.disabled,
    });
    adoptedMirrors.set(sheet, mirror);
    syncConstructedMirror(sheet, mirror);
    hookConstructedSheet(sheet, mirror);
    return mirror;
  };

  const validateConstructedSheet = (value: unknown): CSSStyleSheet => {
    const isSheet =
      (typeof HostCSSStyleSheet === "function" && value instanceof HostCSSStyleSheet) ||
      value instanceof window.CSSStyleSheet;
    if (!isSheet) {
      throw new window.TypeError(
        "Failed to set adoptedStyleSheets: value is not a CSSStyleSheet",
      );
    }
    const sheet = value as CSSStyleSheet;
    if (sheet.ownerNode !== null) {
      throw new window.DOMException(
        "Failed to set adoptedStyleSheets: stylesheet was not constructed",
        "NotAllowedError",
      );
    }
    return sheet;
  };

  const syncAdoptedStyleSheets = (): void => {
    const previous = new Set(appliedAdoptedMirrors);
    const nextMirrors = guestAdoptedSheets.map((sheet) => ensureAdoptedMirror(sheet));
    const preserved = options.shadowRoot.adoptedStyleSheets.filter(
      (candidate) => !previous.has(candidate),
    );
    options.shadowRoot.adoptedStyleSheets = [...preserved, ...nextMirrors];
    appliedAdoptedMirrors = nextMirrors;
  };

  let batchingAdoptedMutation = false;
  const MUTATING_ARRAY_METHODS = new Set<PropertyKey>([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
    "reverse",
    "sort",
    "fill",
    "copyWithin",
  ]);
  const adoptedStyleSheetsProxy = new Proxy(guestAdoptedSheets, {
    get(target, property, receiver) {
      if (MUTATING_ARRAY_METHODS.has(property)) {
        const method = Reflect.get(target, property, target) as (
          ...args: unknown[]
        ) => unknown;
        return (...args: unknown[]) => {
          batchingAdoptedMutation = true;
          try {
            return Reflect.apply(method, receiver, args);
          } finally {
            batchingAdoptedMutation = false;
            syncAdoptedStyleSheets();
          }
        };
      }
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) {
        value = validateConstructedSheet(value);
      }
      const updated = Reflect.set(target, property, value, receiver);
      if (updated && !batchingAdoptedMutation) {
        syncAdoptedStyleSheets();
      }
      return updated;
    },
    deleteProperty(target, property) {
      const deleted = Reflect.deleteProperty(target, property);
      if (deleted && !batchingAdoptedMutation) {
        syncAdoptedStyleSheets();
      }
      return deleted;
    },
  });

  const documentProperties: PropertyDescriptorMap = {
    doctype: { configurable: true, get: () => virtualDoctype },
    documentElement: { configurable: true, get: () => options.html },
    head: { configurable: true, get: () => options.head },
    body: { configurable: true, get: () => options.body },
    scrollingElement: { configurable: true, get: () => options.html },
    activeElement: {
      configurable: true,
      get: () => activeElement() ?? options.body,
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
    hidden: { configurable: true, get: () => hostDocument.hidden },
    visibilityState: { configurable: true, get: () => hostDocument.visibilityState },
    styleSheets: { configurable: true, get: () => styleSheetCollection },
    adoptedStyleSheets: {
      configurable: true,
      get: () => adoptedStyleSheetsProxy,
      set(value: Iterable<CSSStyleSheet>) {
        if (
          value === null ||
          value === undefined ||
          typeof (value as Iterable<unknown>)[Symbol.iterator] !== "function"
        ) {
          throw new window.TypeError(
            "Failed to set the 'adoptedStyleSheets' property on 'Document': the value is not iterable",
          );
        }
        const validated: CSSStyleSheet[] = [];
        for (const item of value) {
          validated.push(validateConstructedSheet(item));
        }
        guestAdoptedSheets.length = 0;
        guestAdoptedSheets.push(...validated);
        syncAdoptedStyleSheets();
      },
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
      get() {
        const title = documentTitleElement();
        if (title === null) return "";
        let text = "";
        for (const child of Array.from(title.childNodes)) {
          if (child.nodeType === 3) text += child.nodeValue;
        }
        // Strip and collapse ASCII whitespace.
        return text.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
      },
      set(value: string) {
        const text = toDOMString(value);
        let title = documentTitleElement();
        if (title === null) {
          title = document.createElement("title");
          options.head.append(title);
        }
        title.textContent = text;
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
        type = `${type}`;
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
        // Native dispatch rejects a non-event, or one already being dispatched,
        // and the logical target must not be rewritten by a rejected call: for
        // an event still in flight that would change where it appears to be.
        if (typeof event !== "object" || event === null) {
          return nativeDispatchEvent.call(document, event);
        }
        // Listeners hold a proxy, which the browser will not dispatch.
        const source = listenerEventSource(event);
        const previousTarget = logicalEventTargets.get(source);
        logicalEventTargets.set(source, document);
        try {
          return nativeDispatchEvent.call(document, source);
        } catch (error) {
          if (previousTarget === undefined) {
            logicalEventTargets.delete(source);
          } else {
            logicalEventTargets.set(source, previousTarget);
          }
          throw error;
        }
      },
    },
    querySelector: { configurable: true, writable: true, value: querySelector },
    querySelectorAll: { configurable: true, writable: true, value: querySelectorAll },
    getElementById: {
      configurable: true,
      writable: true,
      value(id: string) {
        const identifier = typeof id === "string" ? id : toDOMString(id);
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
        if (
          nativeShadowGetElementById !== undefined &&
          options.html.parentNode === options.shadowRoot
        ) {
          const found = nativeShadowGetElementById.call(options.shadowRoot, identifier);
          if (found === null) {
            return null;
          }
          if (nativeContains.call(options.html, found)) {
            return found;
          }
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
      value<K extends keyof HTMLElementTagNameMap>(
        name: K,
        creationOptions?: ElementCreationOptions,
      ): HTMLElementTagNameMap[K] {
        // Convert before creating: the name is read again below, and a value that
        // cannot become a string has to fail before an element exists.
        const localName = typeof name === "string" ? name : toDOMString(name);
        if (localName.length === 4) {
          const lower = localName.toLowerCase();
          if (lower === "body" || lower === "head" || lower === "html") {
            noteLiteralShellElement();
          }
        }
        const element = adoptCreatedElement(
          nativeCreateElement.call(
            document,
            localName,
            creationOptions,
          ) as HTMLElementTagNameMap[K],
          creationOptions === undefined && !localName.includes("-"),
        );
        if (
          localName === "style" ||
          (localName.length === 5 && localName.toLowerCase() === "style")
        ) {
          trustedStyleNodes.add(element);
          const nonce = options.getNonce();
          if (nonce !== "") {
            nativeSetAttribute.call(element, "nonce", nonce);
          }
        }
        return element;
      },
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
        const tag = element.localName;
        if (tag.length === 4 && (tag === "body" || tag === "head" || tag === "html")) {
          noteLiteralShellElement();
        }
        const adopted = adoptCreatedElement(element);
        if (isHTMLStyleElement(adopted)) {
          trustedStyleNodes.add(adopted);
          const nonce = options.getNonce();
          if (nonce !== "") {
            nativeSetAttribute.call(adopted, "nonce", nonce);
          }
        }
        return adopted;
      },
    },
    createTextNode: {
      configurable: true,
      writable: true,
      value(data: string) {
        return adoptAndMark(nativeCreateTextNode.call(document, data));
      },
    },
    createComment: {
      configurable: true,
      writable: true,
      value(data: string) {
        return adoptAndMark(nativeCreateComment.call(document, data));
      },
    },
    createDocumentFragment: {
      configurable: true,
      writable: true,
      value() {
        return adoptAndMark(nativeCreateDocumentFragment.call(document));
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
        return adoptAndMark(node);
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
        return hostDocument.hasFocus() && activeElement() !== null;
      },
    },
    elementFromPoint: {
      configurable: true,
      writable: true,
      value(x: number, y: number) {
        const point = toHostViewportPoint(x, y);
        return guestElement(
          options.shadowRoot.elementFromPoint?.(point.x, point.y) ?? null,
        );
      },
    },
    elementsFromPoint: {
      configurable: true,
      writable: true,
      value(x: number, y: number) {
        const point = toHostViewportPoint(x, y);
        return (options.shadowRoot.elementsFromPoint?.(point.x, point.y) ?? []).filter(
          (element) => options.html.contains(element),
        );
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
  };
  for (const [name, descriptor] of Object.entries(documentProperties)) {
    patchDocument(name, descriptor);
  }

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

  // One wrapper per type reads the handler's current value at dispatch, so
  // assigning a new function keeps the handler's place in the listener order;
  // only null removes it, and setting it again registers at the end.
  const handlerValues = new Map<
    string,
    { listener: EventListener; wrapper: EventListener }
  >();
  for (const eventName of cachedDocumentEventHandlerNames(
    window,
    hostWindow!,
    context.eventTargetPrototype,
  )) {
    patchDocument(`on${eventName}`, {
      configurable: true,
      get: () => handlerValues.get(eventName)?.listener ?? null,
      set(value: EventListener | null) {
        const listener = typeof value === "function" ? value : null;
        const previous = handlerValues.get(eventName);
        if (listener === null) {
          if (previous !== undefined) {
            documentListeners.remove(eventName, previous.wrapper);
            handlerValues.delete(eventName);
          }
          return;
        }
        if (previous !== undefined) {
          previous.listener = listener;
          return;
        }
        const entry = {
          listener,
          wrapper: ((event: Event) => {
            const result = (
              entry.listener as (this: Document, event: Event) => unknown
            ).call(document, event);
            if (result === false) {
              event.preventDefault();
            }
          }) as EventListener,
        };
        handlerValues.set(eventName, entry);
        ensureRootEventRelay(eventName);
        documentListeners.add(eventName, entry.wrapper);
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

  const visibilityController = new AbortController();
  hostDocument.addEventListener(
    "visibilitychange",
    () => {
      dispatchDocumentEvent("visibilitychange");
    },
    { signal: visibilityController.signal },
  );

  return {
    setReadyState,
    dispatchDocumentEvent,
    dispose() {
      visibilityController.abort();
      if (appliedAdoptedMirrors.length > 0) {
        const owned = new Set(appliedAdoptedMirrors);
        options.shadowRoot.adoptedStyleSheets =
          options.shadowRoot.adoptedStyleSheets.filter(
            (candidate) => !owned.has(candidate),
          );
        appliedAdoptedMirrors = [];
      }
      guestAdoptedSheets.length = 0;
      for (const restore of adoptedMirrorRestores.splice(0).reverse()) restore();
      for (const release of releases.splice(0)) release();
      handlerValues.clear();
    },
  };
}
