import * as cssTree from "css-tree";
import type { DeclarationList } from "css-tree";
import { rewriteStyleAttribute, translateShellSelector } from "./css.js";
import {
  absolutizeSrcset,
  isSrcsetAttribute,
  isURLAttribute,
  XLINK_NAMESPACE,
} from "./markup.js";
import { createSelectionFacade } from "./selection-facade.js";
import type { VFrameWindow } from "./types.js";

const DOCUMENT_EVENT_HANDLER_NAMES = [
  "click",
  "dblclick",
  "input",
  "change",
  "submit",
  "keydown",
  "keyup",
  "keypress",
  "pointerdown",
  "pointerup",
  "pointermove",
  "mousedown",
  "mouseup",
  "mousemove",
  "touchstart",
  "touchend",
  "wheel",
  "focus",
  "blur",
  "focusin",
  "focusout",
  "selectionchange",
  "readystatechange",
] as const;

const URL_PROPERTY_NAMES = [
  "href",
  "src",
  "action",
  "formAction",
  "poster",
  "cite",
  "data",
] as const;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const INLINE_STYLE_SELECTOR_ID_COUNT = 32;

function stylePropertyKey(property: string): string {
  return property.startsWith("--") ? property : property.toLowerCase();
}

function stylePropertyNameFromIDL(property: string): string {
  if (property === "cssFloat") {
    return "float";
  }
  const cssName = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return cssName.startsWith("webkit-") ? `-${cssName}` : cssName;
}

function authoredStylePropertyValues(source: string): Map<string, string> {
  const properties = new Map<string, string>();
  try {
    const declarations = cssTree.parse(source, {
      context: "declarationList",
      parseCustomProperty: true,
    });
    cssTree.walk(declarations, {
      visit: "Declaration",
      enter(declaration) {
        const value = cssTree.generate(declaration.value);
        if (!/url\s*\(/i.test(value)) {
          return;
        }
        properties.set(
          stylePropertyKey(declaration.property),
          value,
        );
      },
    });
  } catch {
    // The native declaration remains the source of truth for malformed CSS.
  }
  return properties;
}

function normalizeAuthoredStyleAttribute(source: string): string {
  const declarations = cssTree.parse(source, {
    context: "declarationList",
    parseCustomProperty: true,
  });
  return cssTree.generate(declarations);
}

function updateAuthoredStyleProperty(
  source: string,
  property: string,
  value: string,
  priority: string,
): string {
  const declarations = cssTree.parse(source, {
    context: "declarationList",
    parseCustomProperty: true,
  }) as DeclarationList;
  declarations.children.forEach((declaration, item, list) => {
    if (
      declaration.type === "Declaration" &&
      stylePropertyKey(declaration.property) === stylePropertyKey(property)
    ) {
      list.remove(item);
    }
  });
  if (value !== "") {
    const addition = cssTree.parse(
      `${property}:${value}${priority === "" ? "" : `!${priority}`}`,
      {
        context: "declarationList",
        parseCustomProperty: true,
      },
    ) as DeclarationList;
    const declaration = addition.children.first;
    if (declaration !== null) {
      declarations.children.appendData(declaration);
    }
  }
  return cssTree.generate(declarations);
}

interface ListenerRecord {
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
  signal?: AbortSignal;
  abort?: () => void;
  wrapper: EventListener;
}

type AddNativeEventListener = (
  type: string,
  listener: EventListener,
  options?: boolean | AddEventListenerOptions,
) => void;

type RemoveNativeEventListener = (
  type: string,
  listener: EventListener,
  options?: boolean | EventListenerOptions,
) => void;

type EventForListener = (
  event: Event,
  currentTarget: EventTarget,
  eventPhase?: number,
) => Event;

class ListenerBridge {
  readonly #listenerThis: EventTarget;
  readonly #eventForListener: EventForListener;
  readonly #addToTarget: AddNativeEventListener;
  readonly #removeFromTarget: RemoveNativeEventListener;
  readonly #records: ListenerRecord[] = [];

  constructor(
    listenerThis: EventTarget,
    eventForListener: EventForListener,
    addToTarget: AddNativeEventListener,
    removeFromTarget: RemoveNativeEventListener,
  ) {
    this.#listenerThis = listenerThis;
    this.#eventForListener = eventForListener;
    this.#addToTarget = addToTarget;
    this.#removeFromTarget = removeFromTarget;
  }

  #removeRecord(record: ListenerRecord): void {
    const index = this.#records.indexOf(record);
    if (index !== -1) {
      this.#records.splice(index, 1);
    }
    this.#removeFromTarget(record.type, record.wrapper, record.capture);
    if (record.signal !== undefined && record.abort !== undefined) {
      record.signal.removeEventListener("abort", record.abort);
    }
  }

  add(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener === null) {
      return;
    }
    if (typeof options !== "boolean" && options?.signal?.aborted === true) {
      return;
    }

    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    if (
      this.#records.some(
        (record) =>
          record.type === type && record.listener === listener && record.capture === capture,
      )
    ) {
      return;
    }

    const record: ListenerRecord = {
      type,
      listener,
      capture,
      wrapper: () => undefined,
    };
    record.wrapper = (event) => {
      try {
        const eventPhase = event.currentTarget === this.#listenerThis
          ? undefined
          : capture
            ? 1
            : 3;
        const listenerEvent = this.#eventForListener(
          event,
          this.#listenerThis,
          eventPhase,
        );
        if (typeof listener === "function") {
          listener.call(this.#listenerThis, listenerEvent);
        } else {
          listener.handleEvent(listenerEvent);
        }
      } finally {
        if (typeof options !== "boolean" && options?.once === true) {
          this.#removeRecord(record);
        }
      }
    };
    this.#records.push(record);
    this.#addToTarget(type, record.wrapper, options);
    if (typeof options !== "boolean" && options?.signal !== undefined) {
      record.signal = options.signal;
      record.abort = () => this.#removeRecord(record);
      options.signal.addEventListener("abort", record.abort, { once: true });
    }
  }

  invoke(
    event: Event,
    capture: boolean,
    shouldContinue: () => boolean,
  ): void {
    for (const record of [...this.#records]) {
      // A listener removed by an earlier listener in this dispatch is skipped,
      // matching the DOM inner-invoke algorithm.
      if (!this.#records.includes(record)) {
        continue;
      }
      if (record.type === event.type && record.capture === capture) {
        record.wrapper(event);
        if (!shouldContinue()) {
          return;
        }
      }
    }
  }

  remove(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (listener === null) {
      return;
    }

    const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
    const index = this.#records.findIndex(
      (record) =>
        record.type === type && record.listener === listener && record.capture === capture,
    );
    const record = this.#records[index];
    if (record === undefined) {
      return;
    }

    this.#removeRecord(record);
  }

  dispose(): void {
    for (const record of [...this.#records]) {
      this.#removeRecord(record);
    }
  }
}

export interface DocumentFacadeOptions {
  host: HTMLElement;
  shadowRoot: ShadowRoot;
  window: VFrameWindow;
  document: Document;
  html: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  authoredURLAttributes: Map<Element, Map<string, string>>;
  authoredStyleAttributes: Map<Element, string>;
  inlineStyleSelectorAttribute: string;
  inlineStyleSheet: HTMLStyleElement;
  createHTML(source: string): string;
  createScript(source: string): string;
  updateTopLayerViewport(x: number, y: number): void;
  getNonce(): string;
  getBaseURL(): string;
  getCurrentURL(): string;
  getCurrentScript(): HTMLScriptElement | null;
  onBaseElementChange(): void;
  onEventHandlerError(error: unknown): void;
  onDynamicScript(
    script: HTMLScriptElement,
    execution: "async" | "ordered",
  ): void;
  onStyleElementChange(style: HTMLStyleElement): void;
  onLinkElementChange(link: HTMLLinkElement, authoredRel: string | null): void;
  onConnectedNodes(nodes: readonly Node[]): void;
}

export interface NativeDocumentHandles {
  privateHead: HTMLHeadElement;
  createElement<K extends keyof HTMLElementTagNameMap>(name: K): HTMLElementTagNameMap[K];
  appendChild<T extends Node>(parent: Node, child: T): T;
  getAttribute(element: Element, name: string): string | null;
  setAttribute(element: Element, name: string, value: string): void;
}

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
        return elements.find((element) => element.id === name || element.getAttribute("name") === name) ?? null;
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
  const nativeOwnerDocument = Object.getOwnPropertyDescriptor(nodePrototype, "ownerDocument");
  const nativeTextContent = Object.getOwnPropertyDescriptor(nodePrototype, "textContent");
  const nativeNodeValue = Object.getOwnPropertyDescriptor(nodePrototype, "nodeValue");
  const nativeCharacterData = Object.getOwnPropertyDescriptor(characterDataPrototype, "data");
  const nativeAppendData = characterDataPrototype.appendData;
  const nativeDeleteData = characterDataPrototype.deleteData;
  const nativeInsertData = characterDataPrototype.insertData;
  const nativeReplaceData = characterDataPrototype.replaceData;
  const nativeAddEventListener = eventTargetPrototype.addEventListener;
  const nativeRemoveEventListener = eventTargetPrototype.removeEventListener;
  const nativeDispatchEvent = eventTargetPrototype.dispatchEvent;
  const nativeGetAttribute = elementPrototype.getAttribute;
  const nativeGetAttributeNS = elementPrototype.getAttributeNS;
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
  const styleMutationBatches = new WeakSet<HTMLStyleElement>();
  const styleElementForMutation = (node: Node): HTMLStyleElement | null => {
    if (isElementNode(node) && isHTMLStyleElement(node)) {
      return isInVirtualDocumentTree(node) ? node : null;
    }
    const parent = node.parentNode;
    return parent !== null &&
      isElementNode(parent) &&
      isHTMLStyleElement(parent) &&
      isInVirtualDocumentTree(parent)
      ? parent
      : null;
  };
  const styleElementChanged = (node: Node): void => {
    const style = styleElementForMutation(node);
    if (style !== null && !styleMutationBatches.has(style)) {
      options.onStyleElementChange(style);
    }
  };
  const virtualNodes = new WeakSet<Node>();
  const createdScripts = new WeakSet<HTMLScriptElement>();
  const protectedScriptAttributes = new WeakMap<
    HTMLScriptElement,
    Map<"src" | "type", string>
  >();
  const eventAttributeValues = new WeakMap<Element, Map<string, string>>();
  const physicalURLAttributeValues = new WeakMap<
    Element,
    Map<string, string | null>
  >();
  const physicalStyleAttributeValues = new WeakMap<Element, string | null>();
  const styleSelectorValues = new WeakMap<Element, string>();
  const styleDeclarations = new WeakMap<Element, CSSStyleDeclaration>();
  const styleFacades = new WeakMap<Element, CSSStyleDeclaration>();
  const cssomMutatedStyleElements = new WeakSet<Element>();
  const authoredLinkRelValues = new WeakMap<HTMLLinkElement, string | null>();
  const linkRelLists = new WeakMap<HTMLLinkElement, DOMTokenList>();
  const nativeLinkRelLists = new WeakMap<HTMLLinkElement, DOMTokenList>();
  const elementHandlerValues = new WeakMap<
    Element,
    Map<string, EventListener | null>
  >();
  const elementHandlerWrappers = new WeakMap<Element, Map<string, EventListener>>();
  const virtualListenerRecords = new WeakMap<EventTarget, ListenerRecord[]>();
  const elementHandlerTargets = new Set<Element>();
  const virtualListenerTargets = new Set<EventTarget>();
  const mirroredEvents = new WeakMap<Event, Event>();
  const mirroredEventSources = new WeakMap<Event, Event>();
  const listenerEventSources = new WeakMap<Event, Event>();
  const listenerEvents = new WeakMap<Event, Event>();
  const logicalCurrentTargets = new WeakMap<Event, EventTarget>();
  const logicalEventPhases = new WeakMap<Event, number>();
  const logicalEventTargets = new WeakMap<Event, EventTarget>();
  const immediatePropagationStopped = new WeakSet<Event>();
  const virtualPropagationStopped = new WeakSet<Event>();
  const boundaryPropagationStopped = new WeakSet<Event>();
  const hostDefaultsSuppressed = new WeakSet<Event>();
  const virtualDefaultsPrevented = new WeakSet<Event>();
  const dynamicScriptExecution = new WeakMap<
    HTMLScriptElement,
    "async" | "ordered"
  >();
  const executedScripts = new WeakSet<HTMLScriptElement>();
  const nodeFacadeDescriptors = new Map<
    Node,
    Map<PropertyKey, PropertyDescriptor | undefined>
  >();
  let executeConnectedScript = (_script: HTMLScriptElement): void => undefined;
  const patchedDescriptors: Array<{
    target: object;
    key: PropertyKey;
    descriptor: PropertyDescriptor | undefined;
  }> = [];
  let readyState: DocumentReadyState = "loading";
  let eventHandlerSequence = 0;

  const isBaseElement = (element: Element): boolean =>
    isHTMLElementNamed(element, "base");
  const subtreeHasBaseElement = (node: Node): boolean => {
    if (isElementNode(node) && isBaseElement(node)) {
      return true;
    }
    return "querySelector" in node &&
      (node as ParentNode).querySelector("base") !== null;
  };
  const connectedBaseElementChanged = (element: Element): void => {
    if (isBaseElement(element) && isInVirtualDocumentTree(element)) {
      options.onBaseElementChange();
    }
  };
  const urlAttributeKey = (
    element: Element,
    attributeName: string,
    namespaceURI: string | null,
  ): string | null => {
    if (
      !isURLAttribute(element, attributeName, namespaceURI) &&
      !isSrcsetAttribute(element, attributeName, namespaceURI)
    ) {
      return null;
    }
    if (namespaceURI === XLINK_NAMESPACE) {
      return "xlink:href";
    }
    return attributeName.toLowerCase();
  };
  const physicalURLAttributeValue = (
    element: Element,
    attributeName: string,
  ): string | null => attributeName === "xlink:href"
    ? nativeGetAttributeNS.call(element, XLINK_NAMESPACE, "href")
    : nativeGetAttribute.call(element, attributeName);
  const rememberPhysicalURLAttribute = (
    element: Element,
    attributeName: string,
    value: string | null,
  ): void => {
    let physicalAttributes = physicalURLAttributeValues.get(element);
    if (physicalAttributes === undefined) {
      physicalAttributes = new Map();
      physicalURLAttributeValues.set(element, physicalAttributes);
    }
    physicalAttributes.set(attributeName, value);
  };
  const setPhysicalURLAttribute = (
    element: Element,
    attributeName: string,
    value: string,
  ): void => {
    if (attributeName === "xlink:href") {
      nativeSetAttributeNS.call(element, XLINK_NAMESPACE, attributeName, value);
    } else {
      nativeSetAttribute.call(element, attributeName, value);
    }
    rememberPhysicalURLAttribute(element, attributeName, value);
  };
  const removePhysicalURLAttribute = (
    element: Element,
    attributeName: string,
  ): void => {
    if (attributeName === "xlink:href") {
      nativeRemoveAttributeNS.call(element, XLINK_NAMESPACE, "href");
    } else {
      nativeRemoveAttribute.call(element, attributeName);
    }
    rememberPhysicalURLAttribute(element, attributeName, null);
  };

  if (privateHead === null || privateBody === null || nativeInnerHTML?.set === undefined) {
    throw new Error("The about:blank execution document has no usable head, body, or HTML parser");
  }

  const patch = (target: object, key: PropertyKey, descriptor: PropertyDescriptor) => {
    patchedDescriptors.push({
      target,
      key,
      descriptor: Object.getOwnPropertyDescriptor(target, key),
    });
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
  };

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
    const rects = Array.from(
      nativeGetClientRects.call(element),
      (rect) => toVirtualDOMRect(rect),
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

  const styleDeclarationDocument = new window.DOMParser().parseFromString(
    options.createHTML("<!doctype html><html><body></body></html>"),
    "text/html",
  );

  const usedStyleSelectorValues = new Set<string>();
  let nextStyleSelectorValue = 0;
  for (const element of options.authoredStyleAttributes.keys()) {
    const selectorValue = nativeGetAttribute.call(
      element,
      options.inlineStyleSelectorAttribute,
    );
    if (selectorValue === null || usedStyleSelectorValues.has(selectorValue)) {
      continue;
    }
    styleSelectorValues.set(element, selectorValue);
    usedStyleSelectorValues.add(selectorValue);
    if (/^\d+$/.test(selectorValue)) {
      nextStyleSelectorValue = Math.max(nextStyleSelectorValue, Number(selectorValue) + 1);
    }
  }

  const nativeStyleDeclaration = (element: Element): CSSStyleDeclaration => {
    const existing = styleDeclarations.get(element);
    if (existing !== undefined) {
      return existing;
    }

    const scratch = nativeCreateElement.call(styleDeclarationDocument, "span") as HTMLElement;
    const declaration = nativeHTMLElementStyle?.get?.call(scratch) as
      | CSSStyleDeclaration
      | undefined;
    if (declaration === undefined) {
      throw new Error("The execution realm has no usable CSSStyleDeclaration implementation");
    }
    const authoredStyle = options.authoredStyleAttributes.get(element) ?? "";
    declaration.cssText = authoredStyle;
    styleDeclarations.set(element, declaration);
    return declaration;
  };

  const removeStyleSelector = (element: Element): void => {
    nativeRemoveAttribute.call(element, options.inlineStyleSelectorAttribute);
  };

  const ensureStyleSelector = (element: Element): string => {
    const existing = styleSelectorValues.get(element);
    if (existing !== undefined) {
      nativeSetAttribute.call(element, options.inlineStyleSelectorAttribute, existing);
      return existing;
    }

    let selectorValue: string;
    do {
      selectorValue = String(nextStyleSelectorValue);
      nextStyleSelectorValue += 1;
    } while (usedStyleSelectorValues.has(selectorValue));
    usedStyleSelectorValues.add(selectorValue);
    styleSelectorValues.set(element, selectorValue);
    nativeSetAttribute.call(element, options.inlineStyleSelectorAttribute, selectorValue);
    return selectorValue;
  };

  const inlineStyleSpecificity = `:not(${Array.from(
    { length: INLINE_STYLE_SELECTOR_ID_COUNT },
    (_value, index) => `#v-frame-inline-style-${index}`,
  ).join("")})`;
  const refreshInlineStyleSheet = (): void => {
    const rules: string[] = [];
    for (const [element, cssText] of options.authoredStyleAttributes) {
      if (cssText === "") {
        removeStyleSelector(element);
        continue;
      }

      let rewritten: string;
      try {
        rewritten = rewriteStyleAttribute(cssText, options.getBaseURL());
      } catch {
        removeStyleSelector(element);
        continue;
      }
      if (rewritten === "") {
        removeStyleSelector(element);
        continue;
      }

      const selectorValue = window.CSS.escape(ensureStyleSelector(element));
      rules.push(
        `[${options.inlineStyleSelectorAttribute}="${selectorValue}"]${inlineStyleSpecificity}{${rewritten}}`,
      );
    }
    const nonce = options.getNonce();
    if (nonce === "") {
      nativeRemoveAttribute.call(options.inlineStyleSheet, "nonce");
    } else {
      nativeSetAttribute.call(options.inlineStyleSheet, "nonce", nonce);
    }
    options.inlineStyleSheet.textContent = rules.join("\n");
  };

  const setLogicalStyleAttribute = (
    element: Element,
    value: string,
    normalize: boolean,
  ): void => {
    const declaration = nativeStyleDeclaration(element);
    declaration.cssText = value;
    let logicalValue = value;
    if (normalize) {
      try {
        logicalValue = normalizeAuthoredStyleAttribute(value);
      } catch {
        logicalValue = declaration.cssText;
      }
      cssomMutatedStyleElements.add(element);
    } else {
      cssomMutatedStyleElements.delete(element);
    }
    options.authoredStyleAttributes.set(element, logicalValue);
    nativeRemoveAttribute.call(element, "style");
    physicalStyleAttributeValues.set(element, null);
    refreshInlineStyleSheet();
  };

  const removeLogicalStyleAttribute = (element: Element): void => {
    options.authoredStyleAttributes.delete(element);
    const declaration = styleDeclarations.get(element);
    if (declaration !== undefined) {
      declaration.cssText = "";
    }
    cssomMutatedStyleElements.delete(element);
    nativeRemoveAttribute.call(element, "style");
    physicalStyleAttributeValues.set(element, null);
    removeStyleSelector(element);
    refreshInlineStyleSheet();
  };

  const probeStyleDeclaration = (): CSSStyleDeclaration | undefined => {
    const scratch = nativeCreateElement.call(
      styleDeclarationDocument,
      "span",
    ) as HTMLElement;
    return nativeHTMLElementStyle?.get?.call(scratch) as
      | CSSStyleDeclaration
      | undefined;
  };

  const styleFacade = (element: Element): CSSStyleDeclaration => {
    const existing = styleFacades.get(element);
    if (existing !== undefined) {
      return existing;
    }

    const declaration = nativeStyleDeclaration(element);
    const boundMethods = new Map<PropertyKey, unknown>();
    const synchronizeDeclaration = (logicalValue: string): void => {
      options.authoredStyleAttributes.set(element, logicalValue);
      cssomMutatedStyleElements.add(element);
      nativeRemoveAttribute.call(element, "style");
      physicalStyleAttributeValues.set(element, null);
      refreshInlineStyleSheet();
    };
    const setProperty = (
      property: string,
      value: string | null,
      priority?: string,
    ): void => {
      const propertyName = String(property);
      const nextValue = String(value);
      const requestedPriority = priority === undefined ? "" : String(priority);
      if (
        requestedPriority !== "" &&
        requestedPriority.toLowerCase() !== "important"
      ) {
        declaration.setProperty(propertyName, nextValue, requestedPriority);
        return;
      }
      if (priority === undefined) {
        declaration.setProperty(propertyName, nextValue);
      } else {
        declaration.setProperty(propertyName, nextValue, requestedPriority);
      }
      if (nextValue !== "") {
        const probe = probeStyleDeclaration();
        if (probe !== undefined) {
          probe.setProperty(propertyName, nextValue);
          // Native setProperty ignores values its parser rejects; the authored
          // style must stay untouched too.
          if (probe.getPropertyValue(propertyName) === "") {
            return;
          }
        }
      }
      const propertyNames = Array.from(
        { length: declaration.length },
        (_value, index) => declaration.item(index),
      );
      // item() enumerates longhands only, so an applied shorthand is detected
      // through its serialized value instead.
      const canonicalProperty = propertyNames.find(
        (candidate) => stylePropertyKey(candidate) === stylePropertyKey(propertyName),
      ) ?? (
        declaration.getPropertyValue(propertyName) === ""
          ? undefined
          : propertyName.toLowerCase()
      );
      let logicalValue: string;
      try {
        logicalValue = updateAuthoredStyleProperty(
          options.authoredStyleAttributes.get(element) ?? "",
          canonicalProperty ?? propertyName,
          canonicalProperty === undefined ? "" : nextValue,
          canonicalProperty === undefined
            ? ""
            : declaration.getPropertyPriority(canonicalProperty),
        );
      } catch {
        logicalValue = declaration.cssText;
      }
      synchronizeDeclaration(logicalValue);
    };
    const removeProperty = (property: string): string => {
      const propertyName = String(property);
      const previous = declaration.removeProperty(propertyName);
      let logicalValue: string;
      try {
        logicalValue = updateAuthoredStyleProperty(
          options.authoredStyleAttributes.get(element) ?? "",
          propertyName,
          "",
          "",
        );
      } catch {
        logicalValue = declaration.cssText;
      }
      synchronizeDeclaration(logicalValue);
      return previous;
    };
    const getPropertyValue = (property: string): string => {
      const propertyName = String(property);
      if (declaration.getPropertyValue(propertyName) === "") {
        return "";
      }
      return authoredStylePropertyValues(
        options.authoredStyleAttributes.get(element) ?? "",
      ).get(stylePropertyKey(propertyName)) ??
        declaration.getPropertyValue(propertyName);
    };
    boundMethods.set("setProperty", setProperty);
    boundMethods.set("removeProperty", removeProperty);
    boundMethods.set("getPropertyValue", getPropertyValue);

    const facade = new Proxy(declaration, {
      get(target, property) {
        if (property === "cssText") {
          return cssomMutatedStyleElements.has(element)
            ? (options.authoredStyleAttributes.get(element) ?? "")
            : target.cssText;
        }
        const bound = boundMethods.get(property);
        if (bound !== undefined) {
          return bound;
        }
        const value = Reflect.get(target, property, target);
        if (typeof property === "string" && typeof value === "string") {
          const authoredValue = authoredStylePropertyValues(
            options.authoredStyleAttributes.get(element) ?? "",
          ).get(stylePropertyNameFromIDL(property));
          if (authoredValue !== undefined) {
            return authoredValue;
          }
        }
        if (typeof value !== "function") {
          return value;
        }
        const method = value.bind(target);
        boundMethods.set(property, method);
        return method;
      },
      set(target, property, value) {
        if (property === "cssText") {
          setLogicalStyleAttribute(element, String(value), true);
          return true;
        }
        const previousProperties = new Set(
          Array.from(
            { length: target.length },
            (_value, index) => stylePropertyKey(target.item(index)),
          ),
        );
        let logicalValue = options.authoredStyleAttributes.get(element) ?? "";
        const updated = Reflect.set(target, property, value, target);
        if (updated) {
          const currentProperties = new Set(
            Array.from(
              { length: target.length },
              (_value, index) => stylePropertyKey(target.item(index)),
            ),
          );
          for (const previousProperty of previousProperties) {
            if (currentProperties.has(previousProperty)) {
              continue;
            }
            try {
              logicalValue = updateAuthoredStyleProperty(
                logicalValue,
                previousProperty,
                "",
                "",
              );
            } catch {
              logicalValue = target.cssText;
            }
          }
          if (typeof property === "string" && String(value) === "") {
            // Clearing a shorthand IDL attribute must also drop an authored
            // shorthand declaration, which the vanished-longhand pass misses.
            try {
              logicalValue = updateAuthoredStyleProperty(
                logicalValue,
                stylePropertyNameFromIDL(property),
                "",
                "",
              );
            } catch {
              logicalValue = target.cssText;
            }
          }
          if (typeof property === "string" && String(value) !== "") {
            const probe = probeStyleDeclaration();
            if (probe !== undefined && Reflect.set(probe, property, value, probe)) {
              const probeProperties = Array.from(
                { length: probe.length },
                (_probeValue, index) => probe.item(index),
              );
              const applied = probeProperties.length > 0 &&
                probeProperties.every((name) =>
                  currentProperties.has(stylePropertyKey(name)),
                );
              if (applied) {
                // A shorthand IDL attribute must be written back as the
                // shorthand itself, not as its first longhand.
                const assignedProperty = stylePropertyNameFromIDL(property);
                const canonicalProperty =
                  probe.getPropertyValue(assignedProperty) === ""
                    ? probe.item(0)
                    : assignedProperty;
                try {
                  logicalValue = updateAuthoredStyleProperty(
                    logicalValue,
                    canonicalProperty,
                    String(value),
                    target.getPropertyPriority(canonicalProperty),
                  );
                } catch {
                  logicalValue = target.cssText;
                }
              }
            }
          }
          synchronizeDeclaration(logicalValue);
        }
        return updated;
      },
    });
    styleFacades.set(element, facade);
    return facade;
  };

  const linkRelIncludesStylesheet = (value: string | null): boolean =>
    value !== null && value
      .split(/[\t\n\f\r ]+/)
      .some((token) => token.toLowerCase() === "stylesheet");

  const synchronizePhysicalLinkRel = (
    link: HTMLLinkElement,
    hrefPresent = nativeHasAttribute.call(link, "href"),
  ): void => {
    const authoredRel = authoredLinkRelValues.get(link) ?? null;
    if (hrefPresent && linkRelIncludesStylesheet(authoredRel)) {
      nativeSetAttribute.call(link, "rel", "v-frame-stylesheet");
      return;
    }
    if (authoredRel === null) {
      nativeRemoveAttribute.call(link, "rel");
    } else {
      nativeSetAttribute.call(link, "rel", authoredRel);
    }
  };

  const setLogicalLinkRel = (
    link: HTMLLinkElement,
    value: string,
    normalize: boolean,
  ): void => {
    let authoredRel = String(value);
    const relList = nativeLinkRelLists.get(link);
    if (relList !== undefined) {
      relList.value = authoredRel;
      if (normalize) {
        authoredRel = relList.value;
      }
    }
    authoredLinkRelValues.set(link, authoredRel);
    synchronizePhysicalLinkRel(link);
    options.onLinkElementChange(link, authoredRel);
  };

  const removeLogicalLinkRel = (link: HTMLLinkElement): void => {
    authoredLinkRelValues.set(link, null);
    const relList = nativeLinkRelLists.get(link);
    if (relList !== undefined) {
      relList.value = "";
    }
    synchronizePhysicalLinkRel(link);
    options.onLinkElementChange(link, null);
  };

  const linkRelListFacade = (link: HTMLLinkElement): DOMTokenList => {
    const existing = linkRelLists.get(link);
    if (existing !== undefined) {
      return existing;
    }

    const scratch = nativeCreateElement.call(document, "link") as HTMLLinkElement;
    const relList = nativeLinkRelList?.get?.call(scratch) as DOMTokenList | undefined;
    if (relList === undefined) {
      throw new Error("The execution realm has no usable DOMTokenList implementation");
    }
    relList.value = authoredLinkRelValues.get(link) ?? "";
    nativeLinkRelLists.set(link, relList);
    const boundMethods = new Map<PropertyKey, unknown>();
    const synchronize = (): void => setLogicalLinkRel(link, relList.value, true);
    for (const methodName of ["add", "remove", "toggle", "replace"] as const) {
      const nativeMethod = relList[methodName];
      boundMethods.set(methodName, (...args: unknown[]) => {
        const result = Reflect.apply(nativeMethod, relList, args);
        synchronize();
        return result;
      });
    }
    const facade = new Proxy(relList, {
      get(target, property) {
        const bound = boundMethods.get(property);
        if (bound !== undefined) {
          return bound;
        }
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        const method = value.bind(target);
        boundMethods.set(property, method);
        return method;
      },
      set(target, property, value) {
        const updated = Reflect.set(target, property, value, target);
        if (updated) {
          synchronize();
        }
        return updated;
      },
    });
    linkRelLists.set(link, facade);
    return facade;
  };

  refreshInlineStyleSheet();
  options.shadowRoot.append(options.inlineStyleSheet);

  const protectScript = (script: HTMLScriptElement): void => {
    if (protectedScriptAttributes.has(script)) {
      return;
    }

    const attributes = new Map<"src" | "type", string>();
    const source = nativeGetAttribute.call(script, "src");
    const type = nativeGetAttribute.call(script, "type");
    if (source !== null) {
      attributes.set("src", source);
    }
    if (type !== null) {
      attributes.set("type", type);
    }
    protectedScriptAttributes.set(script, attributes);
    nativeRemoveAttribute.call(script, "src");
    nativeSetAttribute.call(script, "type", "application/x-v-frame-inert");
  };

  const eventAttributeName = (
    element: Element,
    attributeName: string,
  ): string | null => {
    const normalizedName = attributeName.toLowerCase();
    if (!/^on[a-z]/.test(normalizedName)) {
      return null;
    }
    // Browsers compile only the fixed set of event-handler content attributes;
    // the element interface's handler properties mirror that set, so names like
    // "once" or "onboarding-step" stay plain attributes. The prototype chain is
    // consulted directly to ignore expando properties.
    return normalizedName in Object.getPrototypeOf(element)
      ? normalizedName
      : null;
  };

  const listenerEventSource = (event: Event): Event =>
    listenerEventSources.get(event) ?? mirroredEventSources.get(event) ?? event;

  const createMirroredEvent = (source: Event): Event => {
    const existing = mirroredEvents.get(source);
    if (existing !== undefined) {
      return existing;
    }

    const hostWindow = hostDocument.defaultView;
    const eventInit = new Proxy(Object.create(null) as EventInit, {
      get(_target, property) {
        if (property === "view") {
          return window;
        }
        return Reflect.get(source, property, source);
      },
    });
    let mirrored: Event;
    try {
      if (
        hostWindow !== null &&
        typeof hostWindow.PointerEvent === "function" &&
        source instanceof hostWindow.PointerEvent &&
        typeof window.PointerEvent === "function"
      ) {
        mirrored = new window.PointerEvent(source.type, eventInit as PointerEventInit);
      } else if (
        hostWindow !== null &&
        source instanceof hostWindow.WheelEvent
      ) {
        mirrored = new window.WheelEvent(source.type, eventInit as WheelEventInit);
      } else if (
        hostWindow !== null &&
        typeof hostWindow.DragEvent === "function" &&
        source instanceof hostWindow.DragEvent &&
        typeof window.DragEvent === "function"
      ) {
        mirrored = new window.DragEvent(source.type, eventInit as DragEventInit);
      } else if (
        hostWindow !== null &&
        source instanceof hostWindow.MouseEvent
      ) {
        mirrored = new window.MouseEvent(source.type, eventInit as MouseEventInit);
      } else if (
        hostWindow !== null &&
        source instanceof hostWindow.KeyboardEvent
      ) {
        mirrored = new window.KeyboardEvent(source.type, eventInit as KeyboardEventInit);
      } else if (
        hostWindow !== null &&
        typeof hostWindow.InputEvent === "function" &&
        source instanceof hostWindow.InputEvent &&
        typeof window.InputEvent === "function"
      ) {
        mirrored = new window.InputEvent(source.type, eventInit as InputEventInit);
      } else if (
        hostWindow !== null &&
        typeof hostWindow.SubmitEvent === "function" &&
        source instanceof hostWindow.SubmitEvent &&
        typeof window.SubmitEvent === "function"
      ) {
        mirrored = new window.SubmitEvent(source.type, eventInit as SubmitEventInit);
      } else if (
        hostWindow !== null &&
        source instanceof hostWindow.FocusEvent
      ) {
        mirrored = new window.FocusEvent(source.type, eventInit as FocusEventInit);
      } else if (
        hostWindow !== null &&
        source instanceof hostWindow.CustomEvent
      ) {
        mirrored = new window.CustomEvent(source.type, eventInit as CustomEventInit);
      } else {
        mirrored = new window.Event(source.type, eventInit);
      }
    } catch {
      mirrored = new window.Event(source.type, {
        bubbles: source.bubbles,
        cancelable: source.cancelable,
        composed: source.composed,
      });
    }
    mirroredEvents.set(source, mirrored);
    mirroredEventSources.set(mirrored, source);
    return mirrored;
  };

  const logicalComposedPath = (source: Event): EventTarget[] => {
    const path = source.composedPath();
    const rootIndex = path.indexOf(options.html);
    if (rootIndex === -1) {
      return path;
    }
    return [...path.slice(0, rootIndex + 1), document, window];
  };

  const eventForListener = (
    event: Event,
    currentTarget: EventTarget,
    eventPhase?: number,
  ): Event => {
    const source = listenerEventSource(event);
    logicalCurrentTargets.set(source, currentTarget);
    if (eventPhase === undefined) {
      logicalEventPhases.delete(source);
    } else {
      logicalEventPhases.set(source, eventPhase);
    }
    const existing = listenerEvents.get(source);
    if (existing !== undefined) {
      return existing;
    }
    const mirrored = event instanceof window.Event ? event : createMirroredEvent(source);
    const listenerEvent = new Proxy(mirrored, {
      get(target, property) {
        switch (property) {
          case "target":
          case "srcElement":
            return logicalEventTargets.get(source) ?? source.target;
          case "currentTarget":
            return source.currentTarget === null
              ? null
              : (logicalCurrentTargets.get(source) ?? source.currentTarget);
          case "eventPhase":
            return source.currentTarget === null
              ? 0
              : (logicalEventPhases.get(source) ?? source.eventPhase);
          case "view":
            return window;
          case "defaultPrevented":
            return virtualDefaultsPrevented.has(source) || target.defaultPrevented ||
              (source.defaultPrevented && !hostDefaultsSuppressed.has(source));
          case "cancelBubble":
            return boundaryPropagationStopped.has(source) &&
                !virtualPropagationStopped.has(source)
              ? false
              : source.cancelBubble;
          case "returnValue":
            return !virtualDefaultsPrevented.has(source);
          case "isTrusted":
            // The mirrored event is synthetic; trust belongs to the source.
            return source.isTrusted;
          case "composedPath":
            return () => logicalComposedPath(source);
          case "preventDefault":
            return () => {
              // preventDefault is a spec no-op on non-cancelable events.
              if (source.cancelable) {
                virtualDefaultsPrevented.add(source);
              }
              source.preventDefault();
              target.preventDefault();
            };
          case "stopPropagation":
            return () => {
              virtualPropagationStopped.add(source);
              source.stopPropagation();
              target.stopPropagation();
            };
          case "stopImmediatePropagation":
            return () => {
              virtualPropagationStopped.add(source);
              immediatePropagationStopped.add(source);
              source.stopImmediatePropagation();
              target.stopImmediatePropagation();
            };
          default: {
            if (!(property in target) && property in source) {
              const sourceValue = Reflect.get(source, property, source);
              return typeof sourceValue === "function"
                ? sourceValue.bind(source)
                : sourceValue;
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        }
      },
      set(target, property, value) {
        if (property === "cancelBubble") {
          if (Boolean(value)) {
            virtualPropagationStopped.add(source);
          }
          source.cancelBubble = Boolean(value);
          target.cancelBubble = Boolean(value);
          return true;
        }
        if (property === "returnValue") {
          if (!value && source.cancelable) {
            virtualDefaultsPrevented.add(source);
            source.preventDefault();
            target.preventDefault();
          }
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
    listenerEventSources.set(listenerEvent, source);
    listenerEvents.set(source, listenerEvent);
    return listenerEvent;
  };

  const documentListeners = new ListenerBridge(
    document,
    eventForListener,
    (type, listener, listenerOptions) => {
      nativeAddEventListener.call(document, type, listener, listenerOptions);
    },
    (type, listener, listenerOptions) => {
      nativeRemoveEventListener.call(document, type, listener, listenerOptions);
    },
  );

  const removeElementHandler = (element: Element, eventName: string): void => {
    const wrapper = elementHandlerWrappers.get(element)?.get(eventName);
    if (wrapper !== undefined) {
      const target = element === options.body && eventName === "load"
        ? window
        : element;
      nativeRemoveEventListener.call(target, eventName, wrapper);
      elementHandlerWrappers.get(element)?.delete(eventName);
      if (elementHandlerWrappers.get(element)?.size === 0) {
        elementHandlerTargets.delete(element);
      }
    }
  };

  const setElementHandler = (
    element: Element,
    eventName: string,
    listener: EventListener | null,
  ): void => {
    removeElementHandler(element, eventName);
    let handlers = elementHandlerValues.get(element);
    if (handlers === undefined) {
      handlers = new Map();
      elementHandlerValues.set(element, handlers);
    }
    handlers.set(eventName, listener);
    if (listener === null) {
      return;
    }

    const wrapper: EventListener = (event) => {
      const listenerEvent = eventForListener(event, element);
      try {
        const result = (listener as (this: Element, event: Event) => unknown).call(
          element,
          listenerEvent,
        );
        if (result === false) {
          listenerEvent.preventDefault();
        }
      } catch (error) {
        options.onEventHandlerError(error);
      }
    };
    let wrappers = elementHandlerWrappers.get(element);
    if (wrappers === undefined) {
      wrappers = new Map();
      elementHandlerWrappers.set(element, wrappers);
    }
    wrappers.set(eventName, wrapper);
    elementHandlerTargets.add(element);
    const target = element === options.body && eventName === "load"
      ? window
      : element;
    nativeAddEventListener.call(target, eventName, wrapper);
  };

  const compileEventAttribute = (
    element: Element,
    attributeName: string,
    source: string,
  ): void => {
    const eventName = attributeName.slice(2);
    const completionName = `__vFrameEventHandler${eventHandlerSequence += 1}`;
    let listener: EventListener | null = null;
    let compilationError: unknown;
    const errorListener: EventListener = (event) => {
      const errorEvent = event as ErrorEvent;
      compilationError = errorEvent.error ?? new Error(errorEvent.message);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    Object.defineProperty(window, completionName, {
      configurable: true,
      value(compiledListener: EventListener) {
        listener = compiledListener;
      },
    });
    nativeAddEventListener.call(window, "error", errorListener);

    const companion = nativeCreateElement.call(document, "script") as HTMLScriptElement;
    const nonce = options.getNonce();
    if (nonce !== "") {
      companion.nonce = nonce;
    }
    companion.text = options.createScript(
      `globalThis[${JSON.stringify(completionName)}](function(event) {\n${source}\n});`,
    );
    try {
      nativeAppendChild.call(privateHead, companion);
    } catch (error) {
      compilationError = error;
    } finally {
      nativeRemoveEventListener.call(window, "error", errorListener);
      delete (window as unknown as Record<string, unknown>)[completionName];
      companion.remove();
    }

    if (listener === null) {
      setElementHandler(element, eventName, null);
      options.onEventHandlerError(
        compilationError ?? new Error(`Event handler ${attributeName} could not be compiled`),
      );
      return;
    }
    setElementHandler(element, eventName, listener);
  };

  const markURLProperties = (element: Element) => {
    if (element.namespaceURI !== HTML_NAMESPACE) {
      return;
    }

    for (const propertyName of URL_PROPERTY_NAMES) {
      const attributeName = propertyName === "formAction" ? "formaction" : propertyName;
      if (!isURLAttribute(element, attributeName) || !(propertyName in element)) {
        continue;
      }

      try {
        Object.defineProperty(element, propertyName, {
          configurable: true,
          get() {
            const value = options.authoredURLAttributes.get(element)?.get(attributeName);
            if (value === undefined) {
              if (propertyName === "action" || propertyName === "formAction") {
                return options.getCurrentURL();
              }
              return "";
            }

            if (
              value === "" &&
              (propertyName === "action" || propertyName === "formAction")
            ) {
              return options.getCurrentURL();
            }

            const baseURL = isBaseElement(element)
              ? options.getCurrentURL()
              : options.getBaseURL();
            return window.URL.parse(value, baseURL)?.href ?? value;
          },
          set(value: string) {
            setVirtualAttribute(element, attributeName, String(value));
          },
        });
      } catch {
        continue;
      }
    }

    if ("srcset" in element) {
      try {
        Object.defineProperty(element, "srcset", {
          configurable: true,
          get: () => options.authoredURLAttributes.get(element)?.get("srcset") ?? "",
          set: (value: string) => element.setAttribute("srcset", String(value)),
        });
      } catch {
        // Some browser-owned element instances reject expandos for reflected attributes.
      }
    }
  };

  const markSVGURLProperty = (element: Element): void => {
    if (
      element.namespaceURI !== SVG_NAMESPACE ||
      !isURLAttribute(element, "href") ||
      !("href" in element)
    ) {
      return;
    }

    const animatedHref = (element as Element & { href: SVGAnimatedString }).href;
    if (typeof animatedHref !== "object" || animatedHref === null) {
      return;
    }

    const authoredHref = (): string => {
      const authoredAttributes = options.authoredURLAttributes.get(element);
      return authoredAttributes?.get("href") ??
        authoredAttributes?.get("xlink:href") ??
        "";
    };
    try {
      Object.defineProperties(animatedHref, {
        baseVal: {
          configurable: true,
          get: authoredHref,
          set: (value: string) => setVirtualAttribute(element, "href", String(value)),
        },
        animVal: {
          configurable: true,
          get: authoredHref,
        },
      });
      Object.defineProperty(element, "href", {
        configurable: true,
        get: () => animatedHref,
      });
    } catch {
      // The native SVGAnimatedString remains intact if a browser rejects instance facades.
    }
  };

  const rememberAuthoredURLAttributes = (element: Element): void => {
    let authoredAttributes = options.authoredURLAttributes.get(element);
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = urlAttributeKey(
        element,
        attribute.localName,
        attribute.namespaceURI,
      );
      if (attributeName === null) {
        continue;
      }
      if (authoredAttributes === undefined) {
        authoredAttributes = new Map();
        options.authoredURLAttributes.set(element, authoredAttributes);
      }
      if (!authoredAttributes.has(attributeName)) {
        authoredAttributes.set(attributeName, attribute.value);
      }
      rememberPhysicalURLAttribute(element, attributeName, attribute.value);
    }
  };

  const rememberAuthoredStyleAttribute = (element: Element): void => {
    if (!styleSelectorValues.has(element)) {
      removeStyleSelector(element);
    }

    const authoredStyle = nativeGetAttribute.call(element, "style");
    if (authoredStyle !== null && !options.authoredStyleAttributes.has(element)) {
      options.authoredStyleAttributes.set(element, authoredStyle);
      nativeStyleDeclaration(element).cssText = authoredStyle;
    }
    if (authoredStyle !== null) {
      nativeRemoveAttribute.call(element, "style");
    }
    physicalStyleAttributeValues.set(element, null);
    if (authoredStyle !== null) {
      refreshInlineStyleSheet();
    }
  };

  const rememberAuthoredLinkRel = (link: HTMLLinkElement): void => {
    const authoredRel = authoredLinkRelValues.has(link)
      ? (authoredLinkRelValues.get(link) ?? null)
      : nativeGetAttribute.call(link, "rel");
    authoredLinkRelValues.set(link, authoredRel);
    synchronizePhysicalLinkRel(link);
    options.onLinkElementChange(link, authoredRel);
  };

  const rebaseElementURLs = (element: Element): void => {
    const authoredAttributes = options.authoredURLAttributes.get(element);
    if (authoredAttributes === undefined) {
      return;
    }

    for (const [attributeName, authoredValue] of authoredAttributes) {
      let value = attributeName === "srcset"
        ? absolutizeSrcset(authoredValue, options.getBaseURL())
        : authoredValue;
      const baseURL = isBaseElement(element)
        ? options.getCurrentURL()
        : options.getBaseURL();
      if (
        attributeName !== "srcset" &&
        value.trim() !== "" &&
        !value.trim().toLowerCase().startsWith("javascript:")
      ) {
        value = window.URL.parse(value, baseURL)?.href ?? value;
      }
      if (isHTMLScriptElement(element) && protectedScriptAttributes.has(element) && attributeName === "src") {
        protectedScriptAttributes.get(element)?.set("src", value);
      } else {
        setPhysicalURLAttribute(element, attributeName, value);
      }
    }
  };

  const defineNodeFacade = (
    node: Node,
    descriptors: PropertyDescriptorMap,
  ): void => {
    let previousDescriptors = nodeFacadeDescriptors.get(node);
    if (previousDescriptors === undefined) {
      previousDescriptors = new Map();
      nodeFacadeDescriptors.set(node, previousDescriptors);
    }
    for (const property of Reflect.ownKeys(descriptors)) {
      if (!previousDescriptors.has(property)) {
        previousDescriptors.set(
          property,
          Object.getOwnPropertyDescriptor(node, property),
        );
      }
    }
    Object.defineProperties(node, descriptors);
  };

  const markVirtualNode = (node: Node): void => {
    const newlyVirtual = !virtualNodes.has(node);
    if (newlyVirtual) {
      virtualNodes.add(node);
      try {
        defineNodeFacade(node, {
          ownerDocument: {
            configurable: true,
            get: () => document,
          },
          baseURI: {
            configurable: true,
            get: options.getBaseURL,
          },
          getRootNode: {
            configurable: true,
            writable: true,
            value(init?: GetRootNodeOptions) {
              return virtualGetRootNode(node, init);
            },
          },
        });
      } catch {
        // DOM internals still use the adopted host document; the facade remains usable without expandos.
      }
    }

    if (isElementNode(node)) {
      for (const attribute of Array.from(node.attributes)) {
        markVirtualNode(attribute);
      }
      rememberAuthoredURLAttributes(node);
      if (newlyVirtual) {
        rememberAuthoredStyleAttribute(node);
        if (isHTMLLinkElement(node)) {
          rememberAuthoredLinkRel(node);
        }
      }
      if (newlyVirtual && isHTMLScriptElement(node)) {
        protectScript(node);
      }
      if (newlyVirtual) {
        installForeignElementFacade(node);
        for (const attribute of Array.from(node.attributes)) {
          const attributeName = eventAttributeName(node, attribute.name);
          if (attributeName === null) {
            continue;
          }
          let attributes = eventAttributeValues.get(node);
          if (attributes === undefined) {
            attributes = new Map();
            eventAttributeValues.set(node, attributes);
          }
          attributes.set(attributeName, attribute.value);
          nativeRemoveAttribute.call(node, attribute.name);
          compileEventAttribute(node, attributeName, attribute.value);
        }
        markURLProperties(node);
        markSVGURLProperty(node);
      }
      rebaseElementURLs(node);
    }

    for (const child of Array.from(node.childNodes)) {
      markVirtualNode(child);
    }

    if (isElementNode(node) && isHTMLTemplateElement(node)) {
      markVirtualNode(node.content);
    }
  };

  markVirtualNode(options.html);
  const virtualDoctype = document.doctype ??
    document.implementation.createDocumentType("html", "", "");
  markVirtualNode(virtualDoctype);
  try {
    defineNodeFacade(virtualDoctype, {
      parentNode: { configurable: true, get: () => document },
      parentElement: { configurable: true, get: () => null },
      previousSibling: { configurable: true, get: () => null },
      nextSibling: { configurable: true, get: () => options.html },
    });
    defineNodeFacade(options.html, {
      parentNode: { configurable: true, get: () => document },
      parentElement: { configurable: true, get: () => null },
      previousSibling: { configurable: true, get: () => virtualDoctype },
      nextSibling: { configurable: true, get: () => null },
      previousElementSibling: { configurable: true, get: () => null },
      nextElementSibling: { configurable: true, get: () => null },
    });
  } catch {
    // The shell remains reachable from document.documentElement even if parent identity cannot be shadowed.
  }

  const patchedEventHandlerProperties = new WeakMap<object, Set<string>>();
  for (const startingPrototype of [
    window.HTMLElement.prototype,
    window.SVGElement.prototype,
  ]) {
    let prototype: object | null = startingPrototype;
    while (prototype !== null && prototype !== eventTargetPrototype) {
      for (const propertyName of Object.getOwnPropertyNames(prototype)) {
        if (!propertyName.startsWith("on")) {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
        if (descriptor?.get === undefined || descriptor.set === undefined) {
          continue;
        }
        let names = patchedEventHandlerProperties.get(prototype);
        if (names === undefined) {
          names = new Set();
          patchedEventHandlerProperties.set(prototype, names);
        }
        if (names.has(propertyName)) {
          continue;
        }
        names.add(propertyName);
        const eventName = propertyName.slice(2);
        patch(prototype, propertyName, {
          get(this: Element) {
            if (!virtualNodes.has(this)) {
              return descriptor.get?.call(this) ?? null;
            }
            return elementHandlerValues.get(this)?.get(eventName) ?? null;
          },
          set(this: Element, value: EventListener | null) {
            if (!virtualNodes.has(this)) {
              descriptor.set?.call(this, value);
              return;
            }
            setElementHandler(
              this,
              eventName,
              typeof value === "function" ? value : null,
            );
          },
        });
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  }

  const installScrollFacade = (element: HTMLElement) => {
    const scrollProperties: Record<string, () => number> = {
      scrollTop: () => options.host.scrollTop,
      scrollLeft: () => options.host.scrollLeft,
      scrollHeight: () => options.host.scrollHeight,
      scrollWidth: () => options.host.scrollWidth,
      clientHeight: () => options.host.clientHeight,
      clientWidth: () => options.host.clientWidth,
    };

    for (const [name, getter] of Object.entries(scrollProperties)) {
      try {
        const descriptor: PropertyDescriptor = {
          configurable: true,
          get: getter,
        };
        if (name === "scrollTop") {
          descriptor.set = (value: number) => {
            options.host.scrollTop = value;
          };
        } else if (name === "scrollLeft") {
          descriptor.set = (value: number) => {
            options.host.scrollLeft = value;
          };
        }
        Object.defineProperty(element, name, descriptor);
      } catch {
        continue;
      }
    }
  };
  installScrollFacade(options.html);
  installScrollFacade(options.body);

  const virtualCreateElement = <K extends keyof HTMLElementTagNameMap>(
    name: K,
    creationOptions?: ElementCreationOptions,
  ): HTMLElementTagNameMap[K] => {
    const element = nativeCreateElement.call(
      document,
      name,
      creationOptions,
    ) as HTMLElementTagNameMap[K];
    hostDocument.adoptNode(element);
    markVirtualNode(element);
    if (name.toLowerCase() === "style" && options.getNonce() !== "") {
      nativeSetAttribute.call(element, "nonce", options.getNonce());
    }
    if (element instanceof window.HTMLScriptElement) {
      createdScripts.add(element);
    }
    return element;
  };

  const parseFragment = (markup: string): DocumentFragment => {
    const template = nativeCreateElement.call(document, "template") as HTMLTemplateElement;
    nativeInnerHTML.set?.call(template, options.createHTML(markup));
    const fragment = template.content;
    const parsedElements = Array.from(fragment.querySelectorAll("*")).reverse();
    for (const parsedElement of parsedElements) {
      const customizedName = parsedElement.getAttribute("is");
      const customName = customizedName !== null &&
          window.customElements.get(customizedName) !== undefined
        ? customizedName
        : parsedElement.localName;
      if (window.customElements.get(customName) === undefined) {
        continue;
      }
      const creationOptions = customName === customizedName
        ? { is: customName }
        : undefined;
      const customElement = nativeCreateElement.call(
        document,
        parsedElement.localName,
        creationOptions,
      );
      for (const attribute of Array.from(parsedElement.attributes)) {
        nativeSetAttributeNS.call(
          customElement,
          attribute.namespaceURI,
          attribute.name,
          attribute.value,
        );
      }
      while (parsedElement.firstChild !== null) {
        nativeAppendChild.call(customElement, parsedElement.firstChild);
      }
      nativeReplaceChild.call(parsedElement.parentNode, customElement, parsedElement);
    }
    hostDocument.adoptNode(fragment);
    markVirtualNode(fragment);
    return fragment;
  };

  const collectElements = (node: Node): Element[] => {
    const elements: Element[] = [];
    if (isElementNode(node)) {
      elements.push(node, ...Array.from(node.querySelectorAll("*")));
    } else if (isDocumentFragmentNode(node)) {
      elements.push(...Array.from(node.querySelectorAll("*")));
    }
    return elements;
  };

  const scriptCanExecute = (script: HTMLScriptElement): boolean => {
    const type = script.getAttribute("type")?.trim().toLowerCase() ?? "";
    if (
      type !== "" &&
      type !== "module" &&
      type !== "importmap" &&
      type !== "text/javascript" &&
      type !== "application/javascript" &&
      type !== "application/x-ecmascript" &&
      type !== "application/x-javascript" &&
      type !== "text/ecmascript" &&
      type !== "application/ecmascript" &&
      type !== "text/javascript1.0" &&
      type !== "text/javascript1.1" &&
      type !== "text/javascript1.2" &&
      type !== "text/javascript1.3" &&
      type !== "text/javascript1.4" &&
      type !== "text/javascript1.5" &&
      type !== "text/jscript" &&
      type !== "text/livescript" &&
      type !== "text/x-ecmascript" &&
      type !== "text/x-javascript"
    ) {
      return false;
    }
    const source = script.getAttribute("src");
    return source !== null || script.text !== "";
  };

  executeConnectedScript = (script: HTMLScriptElement): void => {
    if (
      !script.isConnected ||
      !createdScripts.has(script) ||
      executedScripts.has(script) ||
      !scriptCanExecute(script)
    ) {
      return;
    }
    executedScripts.add(script);
    options.onDynamicScript(
      script,
      dynamicScriptExecution.get(script) ?? "async",
    );
  };

  const prepareInsertion = (node: Node): void => {
    markVirtualNode(node);

    for (const element of collectElements(node)) {
      if (isHTMLStyleElement(element)) {
        const nonce = options.getNonce();
        if (nonce !== "") {
          element.nonce = nonce;
        }
      }
    }
  };

  const insertedNodes = (node: Node): Node[] =>
    isDocumentFragmentNode(node) ? Array.from(node.childNodes) : [node];

  const finishInsertion = (
    nodes: readonly Node[],
    baseElementChanged: boolean,
  ): void => {
    if (baseElementChanged) {
      options.onBaseElementChange();
    }
    for (const node of nodes) {
      for (const element of collectElements(node)) {
        if (isHTMLScriptElement(element)) {
          executeConnectedScript(element);
        }
      }
    }
    const observableNodes = nodes.filter((node) => {
      const parent = node.parentNode;
      return !(
        parent !== null &&
        isElementNode(parent) &&
        isHTMLStyleElement(parent) &&
        styleMutationBatches.has(parent)
      );
    });
    if (observableNodes.length > 0) {
      options.onConnectedNodes(observableNodes);
    }
  };

  const insert = <T extends Node>(
    parent: Node,
    node: T,
    operation: () => T,
  ): T => {
    if (!virtualNodes.has(parent)) {
      return operation();
    }

    prepareInsertion(node);
    const nodes = insertedNodes(node);
    const baseElementChanged = nodes.some(subtreeHasBaseElement);
    const result = operation();
    if (parent.isConnected) {
      finishInsertion(nodes, baseElementChanged);
      if (parent instanceof window.HTMLScriptElement) {
        executeConnectedScript(parent);
      }
    }
    return result;
  };

  const copyVirtualMetadata = (source: Node, clone: Node): void => {
    if (isElementNode(source) && isElementNode(clone)) {
      const authoredAttributes = options.authoredURLAttributes.get(source);
      if (authoredAttributes !== undefined) {
        options.authoredURLAttributes.set(clone, new Map(authoredAttributes));
      }
      const authoredStyle = options.authoredStyleAttributes.get(source);
      if (authoredStyle !== undefined) {
        options.authoredStyleAttributes.set(clone, authoredStyle);
        if (cssomMutatedStyleElements.has(source)) {
          cssomMutatedStyleElements.add(clone);
        }
        removeStyleSelector(clone);
        ensureStyleSelector(clone);
      }
      if (isHTMLLinkElement(source) && isHTMLLinkElement(clone)) {
        authoredLinkRelValues.set(
          clone,
          authoredLinkRelValues.get(source) ?? null,
        );
        synchronizePhysicalLinkRel(clone);
      }
      const eventAttributes = eventAttributeValues.get(source);
      if (eventAttributes !== undefined) {
        eventAttributeValues.set(clone, new Map(eventAttributes));
      }
      if (isHTMLScriptElement(source) && isHTMLScriptElement(clone)) {
        const scriptAttributes = protectedScriptAttributes.get(source);
        if (scriptAttributes !== undefined) {
          protectedScriptAttributes.set(clone, new Map(scriptAttributes));
        }
        if (createdScripts.has(source) && !executedScripts.has(source)) {
          createdScripts.add(clone);
          const execution = dynamicScriptExecution.get(source);
          if (execution !== undefined) {
            dynamicScriptExecution.set(clone, execution);
          }
        }
      }
    }

    const sourceChildren = Array.from(source.childNodes);
    const cloneChildren = Array.from(clone.childNodes);
    for (let index = 0; index < sourceChildren.length; index += 1) {
      const sourceChild = sourceChildren[index];
      const cloneChild = cloneChildren[index];
      if (sourceChild !== undefined && cloneChild !== undefined) {
        copyVirtualMetadata(sourceChild, cloneChild);
      }
    }
    if (
      isElementNode(source) &&
      isElementNode(clone) &&
      isHTMLTemplateElement(source) &&
      isHTMLTemplateElement(clone)
    ) {
      copyVirtualMetadata(source.content, clone.content);
    }
  };

  const finishVirtualClone = <T extends Node>(source: Node, clone: T): T => {
    copyVirtualMetadata(source, clone);
    markVirtualNode(clone);
    refreshInlineStyleSheet();
    for (const element of collectElements(clone)) {
      const eventAttributes = eventAttributeValues.get(element);
      if (eventAttributes === undefined) {
        continue;
      }
      for (const [attributeName, value] of eventAttributes) {
        compileEventAttribute(element, attributeName, value);
      }
    }
    return clone;
  };

  patch(nodePrototype, "appendChild", {
    writable: true,
    value<T extends Node>(this: Node, node: T): T {
      return insert(this, node, () => nativeAppendChild.call(this, node) as T);
    },
  });
  patch(nodePrototype, "insertBefore", {
    writable: true,
    value<T extends Node>(this: Node, node: T, child: Node | null): T {
      return insert(this, node, () => nativeInsertBefore.call(this, node, child) as T);
    },
  });
  patch(nodePrototype, "replaceChild", {
    writable: true,
    value<T extends Node>(this: Node, node: Node, child: T): T {
      if (!virtualNodes.has(this)) {
        return nativeReplaceChild.call(this, node, child) as T;
      }
      prepareInsertion(node);
      const nodes = insertedNodes(node);
      const baseElementChanged =
        subtreeHasBaseElement(child) || nodes.some(subtreeHasBaseElement);
      const result = nativeReplaceChild.call(this, node, child) as T;
      if (this.isConnected) {
        finishInsertion(nodes, baseElementChanged);
        if (this instanceof window.HTMLScriptElement) {
          executeConnectedScript(this);
        }
      }
      return result;
    },
  });
  patch(nodePrototype, "removeChild", {
    writable: true,
    value<T extends Node>(this: Node, child: T): T {
      if (!virtualNodes.has(this)) {
        return nativeRemoveChild.call(this, child) as T;
      }
      const baseElementChanged = this.isConnected && subtreeHasBaseElement(child);
      const result = nativeRemoveChild.call(this, child) as T;
      styleElementChanged(this);
      if (baseElementChanged) {
        options.onBaseElementChange();
      }
      return result;
    },
  });
  patch(elementPrototype, "remove", {
    writable: true,
    value(this: Element): void {
      const baseElementChanged =
        isInVirtualDocumentTree(this) && subtreeHasBaseElement(this);
      nativeElementRemove.call(this);
      if (baseElementChanged) {
        options.onBaseElementChange();
      }
    },
  });
  patch(nodePrototype, "getRootNode", {
    writable: true,
    value(this: Node, init?: GetRootNodeOptions): Node {
      return virtualNodes.has(this)
        ? virtualGetRootNode(this, init)
        : nativeGetRootNode.call(this, init);
    },
  });
  patch(nodePrototype, "cloneNode", {
    writable: true,
    value(this: Node, deep = false): Node {
      if (!virtualNodes.has(this)) {
        return nativeCloneNode.call(this, deep);
      }
      const clone = nativeImportNode.call(document, this, deep);
      hostDocument.adoptNode(clone);
      return finishVirtualClone(this, clone);
    },
  });

  const appendValues = (parent: Node, values: Array<Node | string>, prepend: boolean): void => {
    const nodes = values.map((value) =>
      typeof value === "string"
        ? (document.createTextNode(value) as Node)
        : value,
    );
    const reference = prepend ? parent.firstChild : null;
    const parentStyle = isElementNode(parent) && isHTMLStyleElement(parent)
      ? parent
      : null;
    const ownsStyleBatch = parentStyle !== null && !styleMutationBatches.has(parentStyle);
    if (ownsStyleBatch) {
      styleMutationBatches.add(parentStyle);
    }
    try {
      for (const node of nodes) {
        parent.insertBefore(node, reference);
      }
    } finally {
      if (ownsStyleBatch) {
        styleMutationBatches.delete(parentStyle);
        styleElementChanged(parentStyle);
      }
    }
  };

  for (const prototype of [elementPrototype, documentFragmentPrototype]) {
    patch(prototype, "append", {
      writable: true,
      value(this: Node, ...values: Array<Node | string>) {
        appendValues(this, values, false);
      },
    });
    patch(prototype, "prepend", {
      writable: true,
      value(this: Node, ...values: Array<Node | string>) {
        appendValues(this, values, true);
      },
    });
    patch(prototype, "replaceChildren", {
      writable: true,
      value(this: Node, ...values: Array<Node | string>) {
        const baseElementChanged = this.isConnected && Array.from(this.childNodes)
          .some(subtreeHasBaseElement);
        while (this.firstChild !== null) {
          nativeRemoveChild.call(this, this.firstChild);
        }
        appendValues(this, values, false);
        if (values.length === 0) {
          styleElementChanged(this);
        }
        if (baseElementChanged) {
          options.onBaseElementChange();
        }
      },
    });
  }

  const performStyleMutationBatch = (parent: Node, mutation: () => void): void => {
    const parentStyle = isElementNode(parent) && isHTMLStyleElement(parent)
      ? parent
      : null;
    if (parentStyle === null || styleMutationBatches.has(parentStyle)) {
      mutation();
      return;
    }

    styleMutationBatches.add(parentStyle);
    try {
      mutation();
    } finally {
      styleMutationBatches.delete(parentStyle);
      styleElementChanged(parentStyle);
    }
  };

  patch(elementPrototype, "before", {
    writable: true,
    value(this: Element, ...values: Array<Node | string>) {
      const parent = this.parentNode;
      if (parent !== null) {
        appendValuesBefore(parent, values, this);
      }
    },
  });
  patch(elementPrototype, "after", {
    writable: true,
    value(this: Element, ...values: Array<Node | string>) {
      const parent = this.parentNode;
      if (parent !== null) {
        appendValuesBefore(parent, values, this.nextSibling);
      }
    },
  });
  patch(elementPrototype, "replaceWith", {
    writable: true,
    value(this: Element, ...values: Array<Node | string>) {
      const parent = this.parentNode;
      if (parent === null) {
        return;
      }
      performStyleMutationBatch(parent, () => {
        appendValuesBefore(parent, values, this);
        parent.removeChild(this);
      });
    },
  });

  for (const prototype of [
    window.CharacterData.prototype,
    window.DocumentType.prototype,
  ]) {
    patch(prototype, "before", {
      writable: true,
      value(this: Node, ...values: Array<Node | string>) {
        if (this.parentNode !== null) {
          appendValuesBefore(this.parentNode, values, this);
        }
      },
    });
    patch(prototype, "after", {
      writable: true,
      value(this: Node, ...values: Array<Node | string>) {
        if (this.parentNode !== null) {
          appendValuesBefore(this.parentNode, values, this.nextSibling);
        }
      },
    });
    patch(prototype, "replaceWith", {
      writable: true,
      value(this: Node, ...values: Array<Node | string>) {
        if (this.parentNode === null) {
          return;
        }
        const parent = this.parentNode;
        performStyleMutationBatch(parent, () => {
          appendValuesBefore(parent, values, this);
          parent.removeChild(this);
        });
      },
    });
  }

  function appendValuesBefore(
    parent: Node,
    values: Array<Node | string>,
    reference: Node | null,
  ): void {
    const parentStyle = isElementNode(parent) && isHTMLStyleElement(parent)
      ? parent
      : null;
    const ownsStyleBatch = parentStyle !== null && !styleMutationBatches.has(parentStyle);
    if (ownsStyleBatch) {
      styleMutationBatches.add(parentStyle);
    }
    try {
      for (const value of values) {
        const node = typeof value === "string" ? document.createTextNode(value) : value;
        parent.insertBefore(node, reference);
      }
    } finally {
      if (ownsStyleBatch) {
        styleMutationBatches.delete(parentStyle);
        styleElementChanged(parentStyle);
      }
    }
  }

  patch(elementPrototype, "insertAdjacentHTML", {
    writable: true,
    value(this: Element, position: InsertPosition, text: string) {
      const fragment = parseFragment(text);
      switch (position.toLowerCase() as InsertPosition) {
        case "beforebegin":
          this.parentNode?.insertBefore(fragment, this);
          return;
        case "afterbegin":
          this.insertBefore(fragment, this.firstChild);
          return;
        case "beforeend":
          this.appendChild(fragment);
          return;
        case "afterend":
          this.parentNode?.insertBefore(fragment, this.nextSibling);
          return;
        default:
          throw new window.DOMException(`Invalid insertion position ${position}`, "SyntaxError");
      }
    },
  });

  patch(elementPrototype, "insertAdjacentElement", {
    writable: true,
    value(this: Element, position: InsertPosition, element: Element): Element | null {
      switch (position.toLowerCase() as InsertPosition) {
        case "beforebegin":
          if (this.parentNode === null) {
            return null;
          }
          this.parentNode.insertBefore(element, this);
          return element;
        case "afterbegin":
          this.insertBefore(element, this.firstChild);
          return element;
        case "beforeend":
          this.appendChild(element);
          return element;
        case "afterend":
          if (this.parentNode === null) {
            return null;
          }
          this.parentNode.insertBefore(element, this.nextSibling);
          return element;
        default:
          throw new window.DOMException(`Invalid insertion position ${position}`, "SyntaxError");
      }
    },
  });

  patch(elementPrototype, "innerHTML", {
    get: nativeInnerHTML.get ?? function getInnerHTML(this: Element) {
      return "";
    },
    set(this: Element, markup: string) {
      if (!virtualNodes.has(this)) {
        nativeInnerHTML.set?.call(this, options.createHTML(String(markup)));
        return;
      }
      if (isHTMLTemplateElement(this)) {
        nativeInnerHTML.set?.call(this, options.createHTML(String(markup)));
        markVirtualNode(this.content);
        return;
      }
      const fragment = parseFragment(String(markup));
      this.replaceChildren(fragment);
    },
  });

  if (nativeOuterHTML?.get !== undefined && nativeOuterHTML.set !== undefined) {
    patch(elementPrototype, "outerHTML", {
      get: nativeOuterHTML.get,
      set(this: Element, markup: string) {
        if (!virtualNodes.has(this)) {
          nativeOuterHTML.set?.call(this, options.createHTML(String(markup)));
          return;
        }
        if (this.parentNode === null) {
          return;
        }
        const parent = this.parentNode;
        parent.insertBefore(parseFragment(String(markup)), this);
        parent.removeChild(this);
      },
    });
  }

  interface RootEventRelay {
    capture: EventListener;
    bubble: EventListener;
  }
  const rootEventRelays = new Map<string, RootEventRelay>();
  const boundaryEventRelays = new Map<string, EventListener>();

  const ensureBoundaryEventRelay = (type: string): void => {
    if (boundaryEventRelays.has(type)) {
      return;
    }
    const relay: EventListener = (event) => {
      if (event.composedPath().includes(options.html)) {
        boundaryPropagationStopped.add(listenerEventSource(event));
        event.stopPropagation();
      }
    };
    boundaryEventRelays.set(type, relay);
    options.shadowRoot.addEventListener(type, relay);
  };

  for (const eventType of [
    ...DOCUMENT_EVENT_HANDLER_NAMES,
    "auxclick",
    "beforeinput",
    "contextmenu",
    "dragstart",
    "dragend",
    "drop",
  ]) {
    ensureBoundaryEventRelay(eventType);
  }

  const listenerCanContinue = (event: Event): boolean =>
    !immediatePropagationStopped.has(listenerEventSource(event));

  const invokeRootListeners = (event: Event, capture: boolean): void => {
    for (const record of [...(virtualListenerRecords.get(options.html) ?? [])]) {
      // A listener removed by an earlier listener in this dispatch is skipped,
      // matching the DOM inner-invoke algorithm.
      if (virtualListenerRecords.get(options.html)?.includes(record) !== true) {
        continue;
      }
      if (record.type !== event.type || record.capture !== capture) {
        continue;
      }
      record.wrapper(event);
      if (!listenerCanContinue(event)) {
        return;
      }
    }
  };

  const ensureRootEventRelay = (type: string): void => {
    if (rootEventRelays.has(type)) {
      return;
    }
    const capture: EventListener = (event) => {
      immediatePropagationStopped.delete(listenerEventSource(event));
      documentListeners.invoke(event, true, () => listenerCanContinue(event));
      if (event.cancelBubble || !listenerCanContinue(event)) {
        return;
      }
      invokeRootListeners(event, true);
    };
    const bubble: EventListener = (event) => {
      invokeRootListeners(event, false);
      if (
        !event.bubbles ||
        event.cancelBubble ||
        !listenerCanContinue(event)
      ) {
        return;
      }
      documentListeners.invoke(event, false, () => listenerCanContinue(event));
    };
    rootEventRelays.set(type, { capture, bubble });
    nativeAddEventListener.call(options.html, type, capture, true);
    nativeAddEventListener.call(options.html, type, bubble, false);
  };

  const removeVirtualListenerRecord = (
    target: EventTarget,
    record: ListenerRecord,
  ): void => {
    const records = virtualListenerRecords.get(target);
    const index = records?.indexOf(record) ?? -1;
    if (index !== -1) {
      records?.splice(index, 1);
    }
    nativeRemoveEventListener.call(target, record.type, record.wrapper, record.capture);
    if (record.signal !== undefined && record.abort !== undefined) {
      record.signal.removeEventListener("abort", record.abort);
    }
    if (records?.length === 0) {
      virtualListenerTargets.delete(target);
    }
  };

  patch(eventTargetPrototype, "addEventListener", {
    writable: true,
    value(
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      listenerOptions?: boolean | AddEventListenerOptions,
    ): void {
      if (!virtualNodes.has(this as Node)) {
        nativeAddEventListener.call(this, type, listener, listenerOptions);
        return;
      }
      if (listener === null) {
        return;
      }
      if (
        typeof listenerOptions !== "boolean" &&
        listenerOptions?.signal?.aborted === true
      ) {
        return;
      }

      const capture = typeof listenerOptions === "boolean"
        ? listenerOptions
        : (listenerOptions?.capture ?? false);
      let records = virtualListenerRecords.get(this);
      if (records === undefined) {
        records = [];
        virtualListenerRecords.set(this, records);
      }
      if (
        records.some(
          (record) =>
            record.type === type &&
            record.listener === listener &&
            record.capture === capture,
        )
      ) {
        return;
      }

      const record: ListenerRecord = {
        type,
        listener,
        capture,
        wrapper: () => undefined,
      };
      virtualListenerTargets.add(this);
      if (this === options.html) {
        ensureRootEventRelay(type);
      }
      record.wrapper = (event) => {
        try {
          const listenerEvent = eventForListener(event, this);
          if (typeof listener === "function") {
            listener.call(this, listenerEvent);
          } else {
            listener.handleEvent(listenerEvent);
          }
        } finally {
          if (
            typeof listenerOptions !== "boolean" &&
            listenerOptions?.once === true
          ) {
            removeVirtualListenerRecord(this, record);
          }
        }
      };
      records.push(record);
      if (this !== options.html) {
        nativeAddEventListener.call(this, type, record.wrapper, listenerOptions);
      }
      if (
        typeof listenerOptions !== "boolean" &&
        listenerOptions?.signal !== undefined
      ) {
        record.signal = listenerOptions.signal;
        record.abort = () => removeVirtualListenerRecord(this, record);
        listenerOptions.signal.addEventListener("abort", record.abort, { once: true });
      }
    },
  });
  patch(eventTargetPrototype, "removeEventListener", {
    writable: true,
    value(
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      listenerOptions?: boolean | EventListenerOptions,
    ): void {
      if (!virtualNodes.has(this as Node)) {
        nativeRemoveEventListener.call(this, type, listener, listenerOptions);
        return;
      }
      if (listener === null) {
        return;
      }
      const capture = typeof listenerOptions === "boolean"
        ? listenerOptions
        : (listenerOptions?.capture ?? false);
      const record = virtualListenerRecords.get(this)?.find(
        (candidate) =>
          candidate.type === type &&
          candidate.listener === listener &&
          candidate.capture === capture,
      );
      if (record !== undefined) {
        removeVirtualListenerRecord(this, record);
      }
    },
  });
  patch(eventTargetPrototype, "dispatchEvent", {
    writable: true,
    value(this: EventTarget, event: Event): boolean {
      if (virtualNodes.has(this as Node)) {
        ensureBoundaryEventRelay(event.type);
        logicalEventTargets.delete(listenerEventSource(event));
      }
      return nativeDispatchEvent.call(this, event);
    },
  });

  function logicalAttribute(
    element: Element,
    attributeName: string,
  ): { managed: boolean; value: string | null } {
    const normalizedAttributeName = element.namespaceURI === HTML_NAMESPACE
      ? attributeName.toLowerCase()
      : attributeName;
    if (virtualNodes.has(element)) {
      if (normalizedAttributeName === options.inlineStyleSelectorAttribute) {
        return { managed: true, value: null };
      }
      if (normalizedAttributeName === "style") {
        return {
          managed: true,
          value: options.authoredStyleAttributes.get(element) ?? null,
        };
      }
      if (isHTMLLinkElement(element) && normalizedAttributeName === "rel") {
        return {
          managed: true,
          value: authoredLinkRelValues.get(element) ?? null,
        };
      }
      const authoredAttributes = options.authoredURLAttributes.get(element);
      const urlAttributeName =
        element.namespaceURI === SVG_NAMESPACE &&
        normalizedAttributeName.toLowerCase() === "xlink:href" &&
        authoredAttributes?.has("xlink:href") === true
          ? "xlink:href"
          : urlAttributeKey(element, normalizedAttributeName, null);
      if (
        urlAttributeName !== null &&
        authoredAttributes?.has(urlAttributeName) === true
      ) {
        return {
          managed: true,
          value: authoredAttributes.get(urlAttributeName) ?? null,
        };
      }
    }
    if (isHTMLScriptElement(element)) {
      const scriptAttributes = protectedScriptAttributes.get(element);
      if (
        scriptAttributes !== undefined &&
        (normalizedAttributeName === "src" || normalizedAttributeName === "type")
      ) {
        return {
          managed: true,
          value: scriptAttributes.get(normalizedAttributeName) ?? null,
        };
      }
    }
    const eventName = eventAttributeName(element, normalizedAttributeName);
    if (eventName !== null && virtualNodes.has(element)) {
      return {
        managed: true,
        value: eventAttributeValues.get(element)?.get(eventName) ?? null,
      };
    }
    return { managed: false, value: null };
  }

  function getVirtualAttribute(element: Element, qualifiedName: string): string | null {
    const logical = logicalAttribute(element, qualifiedName);
    return logical.managed
      ? logical.value
      : nativeGetAttribute.call(element, qualifiedName);
  }

  function getVirtualAttributeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): string | null {
    // With no namespace, the lookup covers the same managed attributes as
    // getAttribute. localName stays case-sensitive, so only the canonical
    // lowercase spelling can name a managed attribute.
    if (
      (namespaceURI === null || namespaceURI === "") &&
      localName === localName.toLowerCase()
    ) {
      const logical = logicalAttribute(element, localName);
      if (logical.managed) {
        return logical.value;
      }
    }
    if (virtualNodes.has(element)) {
      const attributeName = urlAttributeKey(element, localName, namespaceURI);
      const authoredAttributes = options.authoredURLAttributes.get(element);
      if (attributeName !== null && authoredAttributes?.has(attributeName) === true) {
        return authoredAttributes.get(attributeName) ?? null;
      }
    }
    return nativeGetAttributeNS.call(element, namespaceURI, localName);
  }

  function hasVirtualAttribute(element: Element, qualifiedName: string): boolean {
    const logical = logicalAttribute(element, qualifiedName);
    return logical.managed
      ? logical.value !== null
      : nativeHasAttribute.call(element, qualifiedName);
  }

  function hasVirtualAttributeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): boolean {
    // Mirrors getVirtualAttributeNS: null-namespace lookups resolve the same
    // managed attributes as hasAttribute.
    if (
      (namespaceURI === null || namespaceURI === "") &&
      localName === localName.toLowerCase()
    ) {
      const logical = logicalAttribute(element, localName);
      if (logical.managed) {
        return logical.value !== null;
      }
    }
    if (virtualNodes.has(element)) {
      const attributeName = urlAttributeKey(element, localName, namespaceURI);
      const authoredAttributes = options.authoredURLAttributes.get(element);
      if (attributeName !== null && authoredAttributes?.has(attributeName) === true) {
        return true;
      }
    }
    return nativeHasAttributeNS.call(element, namespaceURI, localName);
  }

  function getVirtualAttributeNames(element: Element): string[] {
    const names = nativeGetAttributeNames.call(element).filter((name) => {
      const logical = logicalAttribute(element, name);
      return !logical.managed || logical.value !== null;
    });
    if (isHTMLScriptElement(element)) {
      const scriptAttributes = protectedScriptAttributes.get(element);
      for (const attributeName of ["src", "type"] as const) {
        const index = names.indexOf(attributeName);
        if (!scriptAttributes?.has(attributeName) && index !== -1) {
          names.splice(index, 1);
        } else if (scriptAttributes?.has(attributeName) && index === -1) {
          names.push(attributeName);
        }
      }
    }
    for (const attributeName of eventAttributeValues.get(element)?.keys() ?? []) {
      if (!names.includes(attributeName)) {
        names.push(attributeName);
      }
    }
    if (options.authoredStyleAttributes.has(element) && !names.includes("style")) {
      names.push("style");
    }
    if (
      isHTMLLinkElement(element) &&
      authoredLinkRelValues.get(element) !== null &&
      !names.includes("rel")
    ) {
      names.push("rel");
    }
    return names;
  }

  function setVirtualURLAttribute(
    element: Element,
    attributeName: string,
    value: string,
  ): void {
    let authoredAttributes = options.authoredURLAttributes.get(element);
    if (authoredAttributes === undefined) {
      authoredAttributes = new Map();
      options.authoredURLAttributes.set(element, authoredAttributes);
    }
    authoredAttributes.set(attributeName, value);

    if (isHTMLLinkElement(element) && attributeName === "href") {
      synchronizePhysicalLinkRel(element, true);
    }

    let physicalValue = attributeName === "srcset"
      ? absolutizeSrcset(value, options.getBaseURL())
      : value;
    const baseURL = isBaseElement(element)
      ? options.getCurrentURL()
      : options.getBaseURL();
    if (
      attributeName !== "srcset" &&
      physicalValue.trim() !== "" &&
      !physicalValue.trim().toLowerCase().startsWith("javascript:")
    ) {
      physicalValue = window.URL.parse(physicalValue, baseURL)?.href ?? physicalValue;
    }

    if (
      isHTMLScriptElement(element) &&
      protectedScriptAttributes.has(element) &&
      attributeName === "src"
    ) {
      protectedScriptAttributes.get(element)?.set("src", physicalValue);
      executeConnectedScript(element);
    } else {
      setPhysicalURLAttribute(element, attributeName, physicalValue);
    }
    if (isHTMLLinkElement(element) && attributeName === "href") {
      options.onLinkElementChange(
        element,
        authoredLinkRelValues.get(element) ?? null,
      );
    }
    connectedBaseElementChanged(element);
  }

  function setVirtualAttribute(
    element: Element,
    qualifiedName: string,
    value: string,
  ): void {
    let nextValue = String(value);
    const attributeName = qualifiedName.toLowerCase();
    const normalizedAttributeName = element.namespaceURI === HTML_NAMESPACE
      ? attributeName
      : qualifiedName;
    if (
      virtualNodes.has(element) &&
      normalizedAttributeName === options.inlineStyleSelectorAttribute
    ) {
      return;
    }
    if (virtualNodes.has(element) && normalizedAttributeName === "style") {
      setLogicalStyleAttribute(element, nextValue, false);
      return;
    }
    if (
      virtualNodes.has(element) &&
      isHTMLLinkElement(element) &&
      normalizedAttributeName === "rel"
    ) {
      setLogicalLinkRel(element, nextValue, false);
      return;
    }
    const inlineEventAttribute = eventAttributeName(element, attributeName);
    if (virtualNodes.has(element) && inlineEventAttribute !== null) {
      let attributes = eventAttributeValues.get(element);
      if (attributes === undefined) {
        attributes = new Map();
        eventAttributeValues.set(element, attributes);
      }
      attributes.set(inlineEventAttribute, nextValue);
      compileEventAttribute(element, inlineEventAttribute, nextValue);
      return;
    }
    if (
      isHTMLScriptElement(element) &&
      protectedScriptAttributes.has(element) &&
      attributeName === "type"
    ) {
      protectedScriptAttributes.get(element)?.set("type", nextValue);
      return;
    }
    const urlAttributeName = urlAttributeKey(element, attributeName, null);
    if (virtualNodes.has(element) && urlAttributeName !== null) {
      setVirtualURLAttribute(element, urlAttributeName, nextValue);
      return;
    }
    if (
      isHTMLScriptElement(element) &&
      protectedScriptAttributes.has(element) &&
      attributeName === "src"
    ) {
      protectedScriptAttributes.get(element)?.set("src", nextValue);
      executeConnectedScript(element);
      return;
    }
    nativeSetAttribute.call(element, qualifiedName, nextValue);
  }

  function removeVirtualAttribute(element: Element, qualifiedName: string): void {
    const attributeName = qualifiedName.toLowerCase();
    const normalizedAttributeName = element.namespaceURI === HTML_NAMESPACE
      ? attributeName
      : qualifiedName;
    if (
      virtualNodes.has(element) &&
      normalizedAttributeName === options.inlineStyleSelectorAttribute
    ) {
      return;
    }
    if (virtualNodes.has(element) && normalizedAttributeName === "style") {
      removeLogicalStyleAttribute(element);
      return;
    }
    if (
      virtualNodes.has(element) &&
      isHTMLLinkElement(element) &&
      normalizedAttributeName === "rel"
    ) {
      removeLogicalLinkRel(element);
      return;
    }
    const inlineEventAttribute = eventAttributeName(element, attributeName);
    if (virtualNodes.has(element) && inlineEventAttribute !== null) {
      eventAttributeValues.get(element)?.delete(inlineEventAttribute);
      setElementHandler(element, inlineEventAttribute.slice(2), null);
      return;
    }
    if (
      isHTMLScriptElement(element) &&
      protectedScriptAttributes.has(element) &&
      (attributeName === "src" || attributeName === "type")
    ) {
      protectedScriptAttributes.get(element)?.delete(attributeName);
      if (attributeName === "src") {
        options.authoredURLAttributes.get(element)?.delete("src");
      }
      return;
    }
    const urlAttributeName = urlAttributeKey(element, attributeName, null);
    if (virtualNodes.has(element) && urlAttributeName !== null) {
      options.authoredURLAttributes.get(element)?.delete(urlAttributeName);
      removePhysicalURLAttribute(element, urlAttributeName);
      if (isHTMLLinkElement(element) && urlAttributeName === "href") {
        synchronizePhysicalLinkRel(element, false);
        options.onLinkElementChange(
          element,
          authoredLinkRelValues.get(element) ?? null,
        );
      }
      connectedBaseElementChanged(element);
      return;
    }
    nativeRemoveAttribute.call(element, qualifiedName);
  }

  function toggleVirtualAttribute(
    element: Element,
    qualifiedName: string,
    force?: boolean,
  ): boolean {
    if (!virtualNodes.has(element)) {
      return nativeToggleAttribute.call(element, qualifiedName, force);
    }
    const present = hasVirtualAttribute(element, qualifiedName);
    const nextPresent = force ?? !present;
    if (nextPresent) {
      if (!present) {
        setVirtualAttribute(element, qualifiedName, "");
      }
      return true;
    }
    removeVirtualAttribute(element, qualifiedName);
    return false;
  }

  function setVirtualAttributeNS(
    element: Element,
    namespace: string | null,
    qualifiedName: string,
    value: string,
  ): void {
    if (virtualNodes.has(element) && namespace === null) {
      setVirtualAttribute(element, qualifiedName, value);
      return;
    }
    const localName = qualifiedName.includes(":")
      ? qualifiedName.slice(qualifiedName.indexOf(":") + 1)
      : qualifiedName;
    const attributeName = urlAttributeKey(element, localName, namespace);
    if (virtualNodes.has(element) && attributeName !== null) {
      setVirtualURLAttribute(element, attributeName, String(value));
      return;
    }
    nativeSetAttributeNS.call(element, namespace, qualifiedName, value);
  }

  function removeVirtualAttributeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): void {
    if (virtualNodes.has(element) && namespaceURI === null) {
      removeVirtualAttribute(element, localName);
      return;
    }
    const attributeName = urlAttributeKey(element, localName, namespaceURI);
    if (virtualNodes.has(element) && attributeName !== null) {
      options.authoredURLAttributes.get(element)?.delete(attributeName);
      removePhysicalURLAttribute(element, attributeName);
      if (isHTMLLinkElement(element) && attributeName === "href") {
        synchronizePhysicalLinkRel(element, false);
        options.onLinkElementChange(
          element,
          authoredLinkRelValues.get(element) ?? null,
        );
      }
      return;
    }
    nativeRemoveAttributeNS.call(element, namespaceURI, localName);
  }

  function synchronizeURLAttribute(
    element: Element,
    attributeName: string,
    namespaceURI: string | null,
  ): void {
    if (!virtualNodes.has(element)) {
      return;
    }

    const urlAttributeName = urlAttributeKey(element, attributeName, namespaceURI);
    if (urlAttributeName === null) {
      return;
    }

    const physicalValue = physicalURLAttributeValue(element, urlAttributeName);
    const expectedValue = physicalURLAttributeValues.get(element)?.get(urlAttributeName);
    if (expectedValue === physicalValue) {
      return;
    }

    let authoredAttributes = options.authoredURLAttributes.get(element);
    if (physicalValue === null) {
      authoredAttributes?.delete(urlAttributeName);
    } else {
      if (authoredAttributes === undefined) {
        authoredAttributes = new Map();
        options.authoredURLAttributes.set(element, authoredAttributes);
      }
      authoredAttributes.set(urlAttributeName, physicalValue);
    }
    rememberPhysicalURLAttribute(element, urlAttributeName, physicalValue);

    if (isHTMLLinkElement(element) && urlAttributeName === "href") {
      synchronizePhysicalLinkRel(element, physicalValue !== null);
      options.onLinkElementChange(
        element,
        authoredLinkRelValues.get(element) ?? null,
      );
    }

    if (isBaseElement(element)) {
      connectedBaseElementChanged(element);
      return;
    }
    rebaseElementURLs(element);
  }

  function synchronizeStyleAttribute(element: Element): void {
    if (!virtualNodes.has(element)) {
      return;
    }
    const physicalValue = nativeGetAttribute.call(element, "style");
    if (physicalStyleAttributeValues.get(element) === physicalValue) {
      return;
    }
    if (physicalValue === null) {
      physicalStyleAttributeValues.set(element, null);
      return;
    }

    nativeStyleDeclaration(element).cssText = physicalValue;
    options.authoredStyleAttributes.set(element, physicalValue);
    cssomMutatedStyleElements.delete(element);
    nativeRemoveAttribute.call(element, "style");
    physicalStyleAttributeValues.set(element, null);
    refreshInlineStyleSheet();
  }

  function installForeignElementFacade(element: Element): void {
    const namespaceURI = element.namespaceURI;
    const foreignLink = isHTMLLinkElement(element) ? element : null;
    if (element instanceof window.Element) {
      return;
    }
    try {
      const descriptors: PropertyDescriptorMap = {
        getBoundingClientRect: {
          configurable: true,
          writable: true,
          value: () => getVirtualBoundingClientRect(element),
        },
        getClientRects: {
          configurable: true,
          writable: true,
          value: () => getVirtualClientRects(element),
        },
        getAttribute: {
          configurable: true,
          writable: true,
          value: (qualifiedName: string) => getVirtualAttribute(element, qualifiedName),
        },
        getAttributeNS: {
          configurable: true,
          writable: true,
          value: (namespaceURI: string | null, localName: string) =>
            getVirtualAttributeNS(element, namespaceURI, localName),
        },
        hasAttribute: {
          configurable: true,
          writable: true,
          value: (qualifiedName: string) => hasVirtualAttribute(element, qualifiedName),
        },
        hasAttributeNS: {
          configurable: true,
          writable: true,
          value: (namespaceURI: string | null, localName: string) =>
            hasVirtualAttributeNS(element, namespaceURI, localName),
        },
        getAttributeNames: {
          configurable: true,
          writable: true,
          value: () => getVirtualAttributeNames(element),
        },
        setAttribute: {
          configurable: true,
          writable: true,
          value: (qualifiedName: string, value: string) =>
            setVirtualAttribute(element, qualifiedName, value),
        },
        removeAttribute: {
          configurable: true,
          writable: true,
          value: (qualifiedName: string) => removeVirtualAttribute(element, qualifiedName),
        },
        removeAttributeNS: {
          configurable: true,
          writable: true,
          value: (namespaceURI: string | null, localName: string) =>
            removeVirtualAttributeNS(element, namespaceURI, localName),
        },
        toggleAttribute: {
          configurable: true,
          writable: true,
          value: (qualifiedName: string, force?: boolean) =>
            toggleVirtualAttribute(element, qualifiedName, force),
        },
        setAttributeNS: {
          configurable: true,
          writable: true,
          value: (namespace: string | null, qualifiedName: string, value: string) =>
            setVirtualAttributeNS(element, namespace, qualifiedName, value),
        },
      };
      if (namespaceURI === HTML_NAMESPACE || namespaceURI === SVG_NAMESPACE) {
        descriptors.style = {
          configurable: true,
          get: () => styleFacade(element),
          set: (value: string) => setLogicalStyleAttribute(element, String(value), true),
        };
      }
      if (foreignLink !== null) {
        descriptors.rel = {
          configurable: true,
          get: () => authoredLinkRelValues.get(foreignLink) ?? "",
          set: (value: string) => setLogicalLinkRel(foreignLink, String(value), false),
        };
        descriptors.relList = {
          configurable: true,
          get: () => linkRelListFacade(foreignLink),
        };
      }
      if (isHTMLScriptElement(element)) {
        descriptors.type = {
          configurable: true,
          get: () => protectedScriptAttributes.get(element)?.get("type") ?? "",
          set: (value: string) => setVirtualAttribute(element, "type", String(value)),
        };
      }
      Object.defineProperties(element, descriptors);
    } catch {
      // The node remains physically inert even if its foreign wrapper rejects expandos.
    }
  }

  patch(elementPrototype, "getAttribute", {
    writable: true,
    value(this: Element, qualifiedName: string): string | null {
      return getVirtualAttribute(this, qualifiedName);
    },
  });
  patch(elementPrototype, "getBoundingClientRect", {
    writable: true,
    value(this: Element): DOMRect {
      return virtualNodes.has(this)
        ? getVirtualBoundingClientRect(this)
        : nativeGetBoundingClientRect.call(this);
    },
  });
  patch(elementPrototype, "getClientRects", {
    writable: true,
    value(this: Element): DOMRectList {
      return virtualNodes.has(this)
        ? getVirtualClientRects(this)
        : nativeGetClientRects.call(this);
    },
  });
  patch(elementPrototype, "getAttributeNS", {
    writable: true,
    value(this: Element, namespaceURI: string | null, localName: string): string | null {
      return getVirtualAttributeNS(this, namespaceURI, localName);
    },
  });
  patch(elementPrototype, "hasAttribute", {
    writable: true,
    value(this: Element, qualifiedName: string): boolean {
      return hasVirtualAttribute(this, qualifiedName);
    },
  });
  patch(elementPrototype, "hasAttributeNS", {
    writable: true,
    value(this: Element, namespaceURI: string | null, localName: string): boolean {
      return hasVirtualAttributeNS(this, namespaceURI, localName);
    },
  });
  patch(elementPrototype, "getAttributeNames", {
    writable: true,
    value(this: Element): string[] {
      return getVirtualAttributeNames(this);
    },
  });

  patch(elementPrototype, "setAttribute", {
    writable: true,
    value(this: Element, qualifiedName: string, value: string) {
      setVirtualAttribute(this, qualifiedName, value);
    },
  });
  patch(elementPrototype, "removeAttribute", {
    writable: true,
    value(this: Element, qualifiedName: string): void {
      removeVirtualAttribute(this, qualifiedName);
    },
  });
  patch(elementPrototype, "removeAttributeNS", {
    writable: true,
    value(this: Element, namespaceURI: string | null, localName: string): void {
      removeVirtualAttributeNS(this, namespaceURI, localName);
    },
  });
  patch(elementPrototype, "toggleAttribute", {
    writable: true,
    value(this: Element, qualifiedName: string, force?: boolean): boolean {
      return toggleVirtualAttribute(this, qualifiedName, force);
    },
  });
  patch(elementPrototype, "setAttributeNS", {
    writable: true,
    value(this: Element, namespace: string | null, qualifiedName: string, value: string) {
      setVirtualAttributeNS(this, namespace, qualifiedName, value);
    },
  });
  const patchStyleProperty = (
    prototype: object,
    nativeStyle: PropertyDescriptor | undefined,
  ): void => {
    if (nativeStyle?.get === undefined) {
      return;
    }
    patch(prototype, "style", {
      get(this: Element): CSSStyleDeclaration {
        return virtualNodes.has(this)
          ? styleFacade(this)
          : nativeStyle.get?.call(this);
      },
      set(this: Element, value: string) {
        if (virtualNodes.has(this)) {
          setLogicalStyleAttribute(this, String(value), true);
          return;
        }
        nativeStyle.set?.call(this, value);
      },
    });
  };
  patchStyleProperty(window.HTMLElement.prototype, nativeHTMLElementStyle);
  patchStyleProperty(window.SVGElement.prototype, nativeSVGElementStyle);
  if (nativeLinkRel?.get !== undefined && nativeLinkRel.set !== undefined) {
    patch(window.HTMLLinkElement.prototype, "rel", {
      get(this: HTMLLinkElement): string {
        return virtualNodes.has(this)
          ? (authoredLinkRelValues.get(this) ?? "")
          : (nativeLinkRel.get?.call(this) ?? "");
      },
      set(this: HTMLLinkElement, value: string) {
        if (virtualNodes.has(this)) {
          setLogicalLinkRel(this, String(value), false);
          return;
        }
        nativeLinkRel.set?.call(this, value);
      },
    });
  }
  if (nativeLinkRelList?.get !== undefined) {
    patch(window.HTMLLinkElement.prototype, "relList", {
      get(this: HTMLLinkElement): DOMTokenList {
        return virtualNodes.has(this)
          ? linkRelListFacade(this)
          : nativeLinkRelList.get?.call(this);
      },
    });
  }
  patch(window.Attr.prototype, "ownerDocument", {
    get(this: Attr): Document | null {
      if (virtualNodes.has(this) ||
          (this.ownerElement !== null && virtualNodes.has(this.ownerElement))) {
        return document;
      }
      return nativeOwnerDocument?.get?.call(this) ?? null;
    },
  });
  patch(elementPrototype, "attachShadow", {
    writable: true,
    value(this: Element, init: ShadowRootInit): ShadowRoot {
      const shadowRoot = nativeAttachShadow.call(this, init);
      if (virtualNodes.has(this)) {
        markVirtualNode(shadowRoot);
      }
      return shadowRoot;
    },
  });
  patch(elementPrototype, "matches", {
    writable: true,
    value(this: Element, selectors: string): boolean {
      if (!isInVirtualDocumentTree(this)) {
        return nativeMatches.call(this, selectors);
      }
      return nativeMatches.call(this, selectors) ||
        nativeMatches.call(this, translateSelector(selectors));
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

  const querySelectorAllWithShell = (
    root: Element,
    selectors: string,
  ): Element[] => {
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

  if (nativeScriptAsync?.get !== undefined && nativeScriptAsync.set !== undefined) {
    patch(window.HTMLScriptElement.prototype, "async", {
      get: nativeScriptAsync.get,
      set(this: HTMLScriptElement, value: boolean) {
        if (createdScripts.has(this)) {
          dynamicScriptExecution.set(this, value ? "async" : "ordered");
        }
        nativeScriptAsync.set?.call(this, value);
      },
    });
  }
  if (nativeScriptText?.get !== undefined && nativeScriptText.set !== undefined) {
    patch(window.HTMLScriptElement.prototype, "text", {
      get: nativeScriptText.get,
      set(this: HTMLScriptElement, value: string) {
        nativeScriptText.set?.call(this, value);
        if (virtualNodes.has(this)) {
          executeConnectedScript(this);
        }
      },
    });
  }
  if (nativeScriptType?.get !== undefined && nativeScriptType.set !== undefined) {
    patch(window.HTMLScriptElement.prototype, "type", {
      get(this: HTMLScriptElement) {
        if (!protectedScriptAttributes.has(this)) {
          return nativeScriptType.get?.call(this) ?? "";
        }
        return protectedScriptAttributes.get(this)?.get("type") ?? "";
      },
      set(this: HTMLScriptElement, value: string) {
        if (!protectedScriptAttributes.has(this)) {
          nativeScriptType.set?.call(this, value);
          return;
        }
        this.setAttribute("type", value);
      },
    });
  }
  if (nativeTextContent?.get !== undefined && nativeTextContent.set !== undefined) {
    patch(nodePrototype, "textContent", {
      get: nativeTextContent.get,
      set(this: Node, value: string | null) {
        const baseElementChanged =
          isInVirtualDocumentTree(this) && subtreeHasBaseElement(this);
        nativeTextContent.set?.call(this, value);
        styleElementChanged(this);
        if (baseElementChanged) {
          options.onBaseElementChange();
        }
        if (
          virtualNodes.has(this) &&
          this instanceof window.HTMLScriptElement
        ) {
          executeConnectedScript(this);
        }
      },
    });
  }
  if (nativeNodeValue?.get !== undefined && nativeNodeValue.set !== undefined) {
    patch(nodePrototype, "nodeValue", {
      get: nativeNodeValue.get,
      set(this: Node, value: string | null) {
        nativeNodeValue.set?.call(this, value);
        styleElementChanged(this);
      },
    });
  }
  if (nativeCharacterData?.get !== undefined && nativeCharacterData.set !== undefined) {
    patch(characterDataPrototype, "data", {
      get: nativeCharacterData.get,
      set(this: CharacterData, value: string) {
        nativeCharacterData.set?.call(this, value);
        styleElementChanged(this);
      },
    });
  }
  for (const [methodName, nativeMethod] of [
    ["appendData", nativeAppendData],
    ["deleteData", nativeDeleteData],
    ["insertData", nativeInsertData],
    ["replaceData", nativeReplaceData],
  ] as const) {
    patch(characterDataPrototype, methodName, {
      writable: true,
      value(this: CharacterData, ...args: unknown[]) {
        const result = Reflect.apply(nativeMethod, this, args);
        styleElementChanged(this);
        return result;
      },
    });
  }

  class VFrameMutationObserver extends NativeMutationObserver {
    observe(target: Node, observerOptions?: MutationObserverInit): void {
      const observedTarget = target === document && observerOptions?.subtree === true
        ? options.html
        : target;
      super.observe(observedTarget, observerOptions);
    }
  }
  patch(window, "MutationObserver", {
    writable: true,
    value: VFrameMutationObserver,
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
    liveIndexedCollection(
      window.HTMLCollection.prototype,
      currentElements,
      (name) => {
        if (name === "") {
          return null;
        }
        return currentElements().find(
          (element) =>
            nativeGetAttribute.call(element, "id") === name ||
            nativeGetAttribute.call(element, "name") === name,
        ) ?? null;
      },
    ) as unknown as HTMLCollectionOf<T>;
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
      const translated = collectionName === "*"
        ? "*"
        : translateSelector(collectionName);
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
      const shellName = requestedName === "html"
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
    () => Array.from(nativeQuerySelectorAll.call(options.html, "style"))
      .map((style) => (style as HTMLStyleElement).sheet)
      .filter((sheet): sheet is CSSStyleSheet => sheet !== null),
  ) as unknown as StyleSheetList;
  const formCollection = createLiveHTMLCollection(() =>
    Array.from(nativeQuerySelectorAll.call(options.html, "form")) as HTMLFormElement[]
  );
  const imageCollection = createLiveHTMLCollection(() =>
    Array.from(nativeQuerySelectorAll.call(options.html, "img")) as HTMLImageElement[]
  );
  const scriptCollection = createLiveHTMLCollection(() =>
    Array.from(nativeQuerySelectorAll.call(options.html, "script")) as HTMLScriptElement[]
  );
  const linkCollection = createLiveHTMLCollection(() =>
    Array.from(nativeQuerySelectorAll.call(options.html, "a[href], area[href]")) as Array<
      HTMLAnchorElement | HTMLAreaElement
    >
  );
  const anchorCollection = createLiveHTMLCollection(() =>
    Array.from(nativeQuerySelectorAll.call(options.html, "a[name]")) as HTMLAnchorElement[]
  );
  const embedCollection = createLiveHTMLCollection(() =>
    Array.from(nativeQuerySelectorAll.call(options.html, "embed")) as HTMLEmbedElement[]
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
      () => Array.from(nativeQuerySelectorAll.call(options.html, selector)) as HTMLElement[],
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
      get: () => options.getCurrentScript() ?? nativeCurrentScript?.call(document) ?? null,
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
      value: documentListeners.remove.bind(documentListeners),
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
        return node === document || node === virtualDoctype ||
          node === options.html || options.html.contains(node);
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
      value(namespace: string | null, qualifiedName: string, creationOptions?: string | ElementCreationOptions) {
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
        const attribute = nativeCreateAttributeNS.call(document, namespace, qualifiedName);
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
          const result = (
            listener as (this: Document, event: Event) => unknown
          ).call(document, event);
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
    suppressEventDefault(event) {
      const source = listenerEventSource(event);
      hostDefaultsSuppressed.add(source);
      source.preventDefault();
    },
    wasEventDefaultPrevented(event) {
      const source = listenerEventSource(event);
      return virtualDefaultsPrevented.has(source) ||
        (source.defaultPrevented && !hostDefaultsSuppressed.has(source));
    },
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
      topLayerListenerLifetime.abort();
      if (selectionChangeTimer !== undefined) {
        window.clearTimeout(selectionChangeTimer);
        selectionChangeTimer = undefined;
      }
      selectionFacade.dispose();
      documentListeners.dispose();
      for (const [type, relay] of rootEventRelays) {
        nativeRemoveEventListener.call(options.html, type, relay.capture, true);
        nativeRemoveEventListener.call(options.html, type, relay.bubble, false);
      }
      rootEventRelays.clear();
      for (const [type, relay] of boundaryEventRelays) {
        options.shadowRoot.removeEventListener(type, relay);
      }
      boundaryEventRelays.clear();
      for (const target of [...virtualListenerTargets]) {
        for (const record of [...(virtualListenerRecords.get(target) ?? [])]) {
          removeVirtualListenerRecord(target, record);
        }
      }
      for (const element of [...elementHandlerTargets]) {
        for (const eventName of [...(elementHandlerWrappers.get(element)?.keys() ?? [])]) {
          removeElementHandler(element, eventName);
        }
      }
      for (const patched of patchedDescriptors.reverse()) {
        if (patched.descriptor === undefined) {
          delete (patched.target as Record<PropertyKey, unknown>)[patched.key];
        } else {
          Object.defineProperty(patched.target, patched.key, patched.descriptor);
        }
      }
      for (const [node, descriptors] of nodeFacadeDescriptors) {
        for (const [property, descriptor] of descriptors) {
          if (descriptor === undefined) {
            delete (node as unknown as Record<PropertyKey, unknown>)[property];
          } else {
            Object.defineProperty(node, property, descriptor);
          }
        }
      }
      nodeFacadeDescriptors.clear();
    },
  };
}
