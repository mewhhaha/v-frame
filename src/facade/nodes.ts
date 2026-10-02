// Guest nodes are created in the realm so they keep the prototypes this facade
// patches, then inserted into the host shadow tree so they render in host
// layout. Marking is what makes that lie hold: every node that crosses into the
// virtual tree joins the virtual-node set that the realm's ownerDocument,
// baseURI and getRootNode accessors answer from, has its authored attributes
// remembered, and has its scripts and inline handlers defused. Insertion,
// cloning and markup parsing all funnel back through it.

import { EnumerableWeakMap } from "../enumerable-weak.js";
import { scriptCategory } from "../script-type.js";
import type { AttributeFacade } from "./attributes.js";
import { type FacadeContext, HTML_NAMESPACE, SVG_NAMESPACE } from "./context.js";
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
    nativeOwnerDocument,
    nativeBaseURI,
    nativeTextContent,
    nativeNodeValue,
    nativeCharacterData,
    nativeAppendData,
    nativeDeleteData,
    nativeInsertData,
    nativeReplaceData,
    nativeGetAttribute,
    nativeAttributes,
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
    updateInlineStyle,
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
    getVirtualAttributeNode,
    getVirtualAttributeNodeNS,
    markAttributeNodes,
    setVirtualAttribute,
    removeVirtualAttribute,
    toggleVirtualAttribute,
    setVirtualAttributeNS,
    removeVirtualAttributeNS,
  } = attributes;

  // Narrowed once here rather than through an optional chain inside the patched
  // getters, which sit on the hottest read path the facade has. If a realm keeps
  // either accessor somewhere Node.prototype cannot answer for, marking falls
  // back to per-node accessors rather than silently reporting the host document.
  const nativeOwnerDocumentGetter = nativeOwnerDocument?.get;
  const nativeBaseURIGetter = nativeBaseURI?.get;
  const nodeIdentityIsPrototypeWide =
    nativeOwnerDocumentGetter !== undefined && nativeBaseURIGetter !== undefined;

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
  // dispose() has to hand every node it touched back the descriptors it
  // overwrote, which is why the previous ones are remembered at all. Holding the
  // nodes themselves to do it would make the facade a leak: a guest that churns
  // rows would retain every row it ever rendered for the lifetime of the frame.
  // A node nothing else can reach can no longer observe whether its descriptors
  // came back, so the record holds its nodes weakly and dispose() restores the
  // survivors.
  const nodeFacadeDescriptors = new EnumerableWeakMap<
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

  // ownerDocument, baseURI and getRootNode are answered by accessors on the
  // realm's Node.prototype, gated on the virtual-node set. A node that does not
  // inherit from those prototypes never reaches them and still needs its own —
  // Gecko binds a ShadowRoot to its node document's global, so the shadow roots
  // a guest attaches after adoption come from the host realm rather than this one.
  const installForeignNodeFacade = (node: Node): void => {
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
  };

  // An attribute node has no children and no attributes of its own, so joining
  // the virtual-node set is the whole of marking one. Attribute writes sit on
  // the insertion path, so this skips the recursive descent markVirtualNode
  // would otherwise run for a node that can never have descendants.
  const markVirtualAttribute = (attribute: Attr): void => {
    if (virtualNodes.has(attribute)) {
      return;
    }
    virtualNodes.add(attribute);
    if (!nodeIdentityIsPrototypeWide || !(attribute instanceof window.Node)) {
      installForeignNodeFacade(attribute);
    }
  };
  context.markVirtualAttribute = markVirtualAttribute;

  const markVirtualSubtree = (node: Node): void => {
    const newlyVirtual = !virtualNodes.has(node);
    if (newlyVirtual) {
      virtualNodes.add(node);
      if (!nodeIdentityIsPrototypeWide || !(node instanceof window.Node)) {
        installForeignNodeFacade(node);
      }
    }

    if (isElementNode(node)) {
      for (const attribute of Array.from(node.attributes)) {
        markVirtualAttribute(attribute);
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
      markVirtualSubtree(child);
    }

    if (isElementNode(node) && isHTMLTemplateElement(node)) {
      markVirtualSubtree(node.content);
    }
  };

  // Everything marking does is a statement about the node itself, never about
  // where it hangs: the virtual-node set the realm's identity accessors read,
  // the authored attribute records, the defused scripts and inline handlers.
  // Re-parenting changes none of those answers, and the base URL — the one
  // input that is not per-node — is rebased across the whole tree by
  // rebaseURLs() when it changes. So a subtree that is already marked and still
  // inside the virtual tree costs nothing to move.
  //
  // The gate is connectedness rather than an "already walked" flag because the
  // realm's mutation observer watches the shell subtree and hands every node
  // added under it back to marking on its own. Nothing watches a detached
  // subtree, so anything the guest put inside one since the last walk — a text
  // node from the textContent setter, the result of a DOM API the facade does
  // not intercept — is only found by walking it again.
  const markVirtualNode = (node: Node): void => {
    if (virtualNodes.has(node) && isInVirtualDocumentTree(node)) {
      return;
    }
    markVirtualSubtree(node);
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

  // Parse in an inert document, but use the destination's context: a template
  // alone loses table insertion modes, foreign namespaces and raw-text parsing.
  const fragmentDocument = new window.DOMParser().parseFromString(
    options.createHTML("<!doctype html><html><body></body></html>"),
    "text/html",
  );
  const parseFragment = (
    markup: string,
    destination: Element | null,
  ): DocumentFragment => {
    const shellName =
      destination === options.html
        ? "html"
        : destination === options.head
          ? "head"
          : destination === options.body
            ? "body"
            : null;
    const parserContext =
      destination === null || shellName !== null
        ? fragmentDocument.createElement(shellName ?? "body")
        : (nativeImportNode.call(fragmentDocument, destination, false) as Element);
    nativeInnerHTML.set?.call(parserContext, options.createHTML(markup));
    const fragment = fragmentDocument.createDocumentFragment();
    const parsedRoot = isHTMLTemplateElement(parserContext)
      ? parserContext.content
      : parserContext;
    while (parsedRoot.firstChild !== null) {
      nativeAppendChild.call(fragment, parsedRoot.firstChild);
    }
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
    if (scriptCategory(script) === "inert") {
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
    for (const element of collectElements(clone)) {
      updateInlineStyle(element);
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
        // A foreign element resolves these on the host realm's prototype, where
        // the facade's patches are not, so the Attr nodes it hands out would
        // never reach marking.
        getAttributeNode: {
          configurable: true,
          writable: true,
          value: (qualifiedName: string) =>
            getVirtualAttributeNode(element, qualifiedName),
        },
        getAttributeNodeNS: {
          configurable: true,
          writable: true,
          value: (namespaceURI: string | null, localName: string) =>
            getVirtualAttributeNodeNS(element, namespaceURI, localName),
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
      const nativeAttributesGetter = nativeAttributes?.get;
      if (nativeAttributesGetter !== undefined) {
        descriptors.attributes = {
          configurable: true,
          get: () =>
            markAttributeNodes(
              element,
              nativeAttributesGetter.call(element) as NamedNodeMap,
            ),
        };
      }
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
        options.onDisconnectedNodes([child]);
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
        options.onDisconnectedNodes([child]);
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
        const virtual = virtualNodes.has(this);
        const baseElementChanged =
          isInVirtualDocumentTree(this) && subtreeHasBaseElement(this);
        nativeElementRemove.call(this);
        if (virtual) {
          options.onDisconnectedNodes([this]);
        }
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
    // The other two thirds of the lie about where a guest node lives. These were
    // own accessors installed by markVirtualNode on every node and every
    // attribute node, which cost a hidden-class transition each on the hot DOM
    // path; asking the virtual-node set from one prototype accessor answers the
    // same question without touching the node.
    if (nativeOwnerDocumentGetter !== undefined) {
      patch(nodePrototype, "ownerDocument", {
        get(this: Node): Document | null {
          return virtualNodes.has(this)
            ? document
            : (nativeOwnerDocumentGetter.call(this) as Document | null);
        },
      });
    }
    if (nativeBaseURIGetter !== undefined) {
      patch(nodePrototype, "baseURI", {
        get(this: Node): string {
          return virtualNodes.has(this)
            ? options.getBaseURL()
            : (nativeBaseURIGetter.call(this) as string);
        },
      });
    }
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
            const child = this.firstChild;
            nativeRemoveChild.call(this, child);
            if (virtualNodes.has(this)) {
              options.onDisconnectedNodes([child]);
            }
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
        const insertionPosition = position.toLowerCase() as InsertPosition;
        const outside =
          insertionPosition === "beforebegin" || insertionPosition === "afterend";
        if (
          outside &&
          (this.parentNode === null ||
            this.parentNode.nodeType === window.Node.DOCUMENT_NODE)
        ) {
          throw new window.DOMException(
            "The element has no insertion parent",
            "NoModificationAllowedError",
          );
        }
        const destination = outside ? this.parentElement : this;
        const fragment = parseFragment(
          text,
          destination === options.html ? null : destination,
        );
        switch (insertionPosition) {
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
        const fragment = parseFragment(String(markup), this);
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
          if (parent.nodeType === window.Node.DOCUMENT_NODE) {
            throw new window.DOMException(
              "Cannot replace the document element",
              "NoModificationAllowedError",
            );
          }
          parent.insertBefore(parseFragment(String(markup), this.parentElement), this);
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
          const removedNodes = virtualNodes.has(this) ? Array.from(this.childNodes) : [];
          const baseElementChanged =
            isInVirtualDocumentTree(this) && subtreeHasBaseElement(this);
          nativeTextContent.set?.call(this, value);
          if (removedNodes.length > 0) {
            options.onDisconnectedNodes(removedNodes);
          }
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
    // A node the guest still holds outlives the facade, and clearing drops its
    // finalization registration with it — for a large guest that would otherwise
    // be one dead cell per marked node, held for as long as the host keeps the
    // disposed element around.
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
