import { translateShellSelector } from "./css.js";
import {
  createFacadeContext,
  HTML_NAMESPACE,
  SVG_NAMESPACE,
  type DocumentFacadeOptions,
  type NativeDocumentHandles,
} from "./facade/context.js";
import { installAttributeFacade } from "./facade/attributes.js";
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
    nodePrototype,
    characterDataPrototype,
    elementPrototype,
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
    nativeTextContent,
    nativeNodeValue,
    nativeCharacterData,
    nativeAppendData,
    nativeDeleteData,
    nativeInsertData,
    nativeReplaceData,
    nativeDispatchEvent,
    nativeGetAttribute,
    nativeHasAttribute,
    nativeSetAttribute,
    nativeSetAttributeNS,
    nativeRemoveAttribute,
    nativeMatches,
    nativeClosest,
    nativeQuerySelector,
    nativeQuerySelectorAll,
    nativeGetElementsByTagName,
    nativeGetElementsByTagNameNS,
    nativeAttachShadow,
    nativeInnerHTML,
    nativeOuterHTML,
    nativeElementRemove,
    nativeScriptAsync,
    nativeScriptText,
    nativeScriptType,
    nativeCurrentScript,
    NativeMutationObserver,
    isElementNode,
    isDocumentFragmentNode,
    isHTMLTemplateElement,
    isHTMLStyleElement,
    isHTMLLinkElement,
    isHTMLScriptElement,
    virtualGetRootNode,
    isInVirtualDocumentTree,
    subtreeHasBaseElement,
    virtualNodes,
    createdScripts,
    protectedScriptAttributes,
    eventAttributeValues,
    cssomMutatedStyleElements,
    authoredLinkRelValues,
    logicalEventTargets,
    patch,
    getVirtualBoundingClientRect,
    getVirtualClientRects,
    toHostViewportPoint,
  } = context;
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
  const dynamicScriptExecution = new WeakMap<HTMLScriptElement, "async" | "ordered">();
  const executedScripts = new WeakSet<HTMLScriptElement>();
  const nodeFacadeDescriptors = new Map<
    Node,
    Map<PropertyKey, PropertyDescriptor | undefined>
  >();
  let readyState: DocumentReadyState = "loading";

  const style = installStyleFacade(context);
  const {
    refreshInlineStyleSheet,
    removeStyleSelector,
    ensureStyleSelector,
    setLogicalStyleAttribute,
    styleFacade,
    synchronizePhysicalLinkRel,
    setLogicalLinkRel,
    linkRelListFacade,
    rememberAuthoredStyleAttribute,
    rememberAuthoredLinkRel,
    synchronizeStyleAttribute,
    installPatches: installStylePatches,
  } = style;

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

  const events = installEventFacade(context);
  const {
    eventAttributeName,
    eventForListener,
    compileEventAttribute,
    ensureRootEventRelay,
    documentListeners,
    suppressEventDefault,
    wasEventDefaultPrevented,
    installHandlerProperties: installEventHandlerProperties,
    installRelays: installEventRelays,
    installPatches: installEventPatches,
    dispose: disposeEventFacade,
  } = events;

  const {
    markURLProperties,
    markSVGURLProperty,
    rememberAuthoredURLAttributes,
    rebaseElementURLs,
    getVirtualAttribute,
    getVirtualAttributeNS,
    hasVirtualAttribute,
    hasVirtualAttributeNS,
    getVirtualAttributeNames,
    setVirtualAttribute,
    removeVirtualAttribute,
    toggleVirtualAttribute,
    setVirtualAttributeNS,
    removeVirtualAttributeNS,
    synchronizeURLAttribute,
    installPatches: installAttributePatches,
  } = installAttributeFacade(context, style, events);
  const defineNodeFacade = (node: Node, descriptors: PropertyDescriptorMap): void => {
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
  const virtualDoctype =
    document.doctype ?? document.implementation.createDocumentType("html", "", "");
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

  installEventHandlerProperties();

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
    const template = nativeCreateElement.call(
      document,
      "template",
    ) as HTMLTemplateElement;
    nativeInnerHTML.set?.call(template, options.createHTML(markup));
    const fragment = template.content;
    const parsedElements = Array.from(fragment.querySelectorAll("*")).reverse();
    for (const parsedElement of parsedElements) {
      const customizedName = parsedElement.getAttribute("is");
      const customName =
        customizedName !== null && window.customElements.get(customizedName) !== undefined
          ? customizedName
          : parsedElement.localName;
      if (window.customElements.get(customName) === undefined) {
        continue;
      }
      const creationOptions =
        customName === customizedName ? { is: customName } : undefined;
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

  context.executeConnectedScript = (script: HTMLScriptElement): void => {
    if (
      !script.isConnected ||
      !createdScripts.has(script) ||
      executedScripts.has(script) ||
      !scriptCanExecute(script)
    ) {
      return;
    }
    executedScripts.add(script);
    options.onDynamicScript(script, dynamicScriptExecution.get(script) ?? "async");
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

  const finishInsertion = (nodes: readonly Node[], baseElementChanged: boolean): void => {
    if (baseElementChanged) {
      options.onBaseElementChange();
    }
    for (const node of nodes) {
      for (const element of collectElements(node)) {
        if (isHTMLScriptElement(element)) {
          context.executeConnectedScript(element);
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

  const insert = <T extends Node>(parent: Node, node: T, operation: () => T): T => {
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
        context.executeConnectedScript(parent);
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
        authoredLinkRelValues.set(clone, authoredLinkRelValues.get(source) ?? null);
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
          context.executeConnectedScript(this);
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

  const appendValues = (
    parent: Node,
    values: Array<Node | string>,
    prepend: boolean,
  ): void => {
    const nodes = values.map((value) =>
      typeof value === "string" ? (document.createTextNode(value) as Node) : value,
    );
    const reference = prepend ? parent.firstChild : null;
    const parentStyle =
      isElementNode(parent) && isHTMLStyleElement(parent) ? parent : null;
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
        const baseElementChanged =
          this.isConnected && Array.from(this.childNodes).some(subtreeHasBaseElement);
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
    const parentStyle =
      isElementNode(parent) && isHTMLStyleElement(parent) ? parent : null;
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
    const parentStyle =
      isElementNode(parent) && isHTMLStyleElement(parent) ? parent : null;
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
          throw new window.DOMException(
            `Invalid insertion position ${position}`,
            "SyntaxError",
          );
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
          throw new window.DOMException(
            `Invalid insertion position ${position}`,
            "SyntaxError",
          );
      }
    },
  });

  patch(elementPrototype, "innerHTML", {
    get:
      nativeInnerHTML.get ??
      function getInnerHTML(this: Element) {
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

  installEventRelays();

  installEventPatches();

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
          value: (qualifiedName: string) =>
            removeVirtualAttribute(element, qualifiedName),
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

  installAttributePatches();
  installStylePatches();
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
          context.executeConnectedScript(this);
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
        if (virtualNodes.has(this) && this instanceof window.HTMLScriptElement) {
          context.executeConnectedScript(this);
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
      const observedTarget =
        target === document && observerOptions?.subtree === true ? options.html : target;
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
