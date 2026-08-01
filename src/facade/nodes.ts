// Guest nodes are created in the realm so they keep the prototypes this facade
// patches, then inserted into the host shadow tree so they render in host
// layout. Marking is what makes that lie hold: every node that crosses into the
// virtual tree gets ownerDocument, baseURI and getRootNode of its own, has its
// authored attributes remembered, and has its scripts and inline handlers
// defused. Insertion, cloning and markup parsing all funnel back through it.

import { type FacadeContext, HTML_NAMESPACE, SVG_NAMESPACE } from "./context.js";
import type { AttributeFacade } from "./attributes.js";
import type { EventFacade } from "./events.js";
import type { StyleFacade } from "./style.js";

export interface NodeFacade {
  markVirtualNode(node: Node): void;
  virtualDoctype: DocumentType;
  virtualCreateElement<K extends keyof HTMLElementTagNameMap>(
    name: K,
    creationOptions?: ElementCreationOptions,
  ): HTMLElementTagNameMap[K];
  prepareInsertion(node: Node): void;
  insertedNodes(node: Node): Node[];
  finishInsertion(nodes: readonly Node[], baseElementChanged: boolean): void;
  finishVirtualClone<T extends Node>(source: Node, clone: T): T;
  installMutationPatches(): void;
  installNodePatches(): void;
  dispose(): void;
}

export function installNodeFacade(
  context: FacadeContext,
  style: StyleFacade,
  events: EventFacade,
  attributes: AttributeFacade,
): NodeFacade {
  const options = context.options;
  const {
    window,
    document,
    hostDocument,
    nodePrototype,
    characterDataPrototype,
    elementPrototype,
    documentFragmentPrototype,
    nativeCreateElement,
    nativeAppendChild,
    nativeInsertBefore,
    nativeReplaceChild,
    nativeRemoveChild,
    nativeCloneNode,
    nativeImportNode,
    nativeGetRootNode,
    nativeTextContent,
    nativeNodeValue,
    nativeCharacterData,
    nativeAppendData,
    nativeDeleteData,
    nativeInsertData,
    nativeReplaceData,
    nativeGetAttribute,
    nativeSetAttribute,
    nativeSetAttributeNS,
    nativeRemoveAttribute,
    nativeAttachShadow,
    nativeInnerHTML,
    nativeOuterHTML,
    nativeElementRemove,
    nativeScriptAsync,
    nativeScriptText,
    nativeScriptType,
    NativeMutationObserver,
    isElementNode,
    isDocumentFragmentNode,
    isHTMLTemplateElement,
    isHTMLStyleElement,
    isHTMLLinkElement,
    isHTMLScriptElement,
    isInVirtualDocumentTree,
    virtualGetRootNode,
    subtreeHasBaseElement,
    virtualNodes,
    createdScripts,
    protectedScriptAttributes,
    eventAttributeValues,
    cssomMutatedStyleElements,
    authoredLinkRelValues,
    patch,
    getVirtualBoundingClientRect,
    getVirtualClientRects,
  } = context;
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
  } = style;
  const { eventAttributeName, compileEventAttribute } = events;
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
  } = attributes;

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

  const installMutationPatches = (): void => {
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
  };

  const installNodePatches = (): void => {
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
          target === document && observerOptions?.subtree === true
            ? options.html
            : target;
        super.observe(observedTarget, observerOptions);
      }
    }
    patch(window, "MutationObserver", {
      writable: true,
      value: VFrameMutationObserver,
    });
  };

  const dispose = (): void => {
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

  installScrollFacade(options.html);
  installScrollFacade(options.body);

  return {
    markVirtualNode,
    virtualDoctype,
    virtualCreateElement,
    prepareInsertion,
    insertedNodes,
    finishInsertion,
    finishVirtualClone,
    installMutationPatches,
    installNodePatches,
    dispose,
  };
}
