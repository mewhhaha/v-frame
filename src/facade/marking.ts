// Guest nodes are created in the realm so they keep the prototypes this facade
// patches, then inserted into the host shadow tree so they render in host
// layout. Marking is what makes that lie hold: every node that crosses into the
// virtual tree joins the virtual-node set that the realm's ownerDocument,
// baseURI and getRootNode accessors answer from, has its authored attributes
// remembered, and has its scripts and inline handlers defused. Insertion,
// cloning and markup parsing all funnel back through it.

import { canHaveURLAttributes, HTML_NAMESPACE } from "../asset-urls.js";
import { EnumerableWeakMap, EnumerableWeakSet } from "../enumerable-weak.js";
import {
  MARKUP_FLAG_INLINE_EVENTS,
  MARKUP_FLAG_LINKS,
  MARKUP_FLAG_SVG,
  MARKUP_FLAG_TEMPLATES,
} from "../markup.js";
import { FRAGMENT_TARGET_ATTRIBUTE } from "../wire-format.js";
import type { AttributeFacade } from "./attributes.js";
import type { FacadeContext, SubtreeScan } from "./context.js";
import type { EventFacade } from "./events.js";
import type { StyleFacade } from "./style.js";

export interface NodeMarking {
  markVirtualNode(node: Node, scan?: SubtreeScan): boolean;
  markVirtualSubtree(node: Node, scan?: SubtreeScan): void;
  markVirtualAttribute(attribute: Attr): void;
  /** Adopts a node the realm just created into the shell's document and marks it. */
  adoptAndMark<T extends Node>(node: T): T;
  /** adoptAndMark for an element, which also records scripts as guest-created. */
  adoptCreatedElement<T extends Element>(element: T, isPlainBuiltinHTML?: boolean): T;
  /** Marks a detached multi-node element as eligible for a clean-subtree watch on re-attach. */
  noteDetachedCandidate(element: Element): void;
  /** Arms a clean-subtree observer after a full walk found zero special elements. */
  armDetachedWatchIfCandidate(element: Element): void;
  /** Checks a clean-subtree watch; returns true only when zero mutations occurred since the last walk. */
  consumeDetachedWatch(node: Node, keepAlive: boolean): boolean;
  /** Marks that a template or guest shadow root exists, invalidating detached watches. */
  noteOpaqueSubtree(): void;
  virtualDoctype: DocumentType;
  /** Marks the shell and gives it the parentage the guest's document implies. */
  markShell(): void;
  /** Answers ownerDocument, baseURI and getRootNode from the virtual-node set. */
  installIdentityPatches(): void;
  dispose(): void;
}

export function installNodeMarking(
  context: FacadeContext,
  style: StyleFacade,
  events: EventFacade,
  attributes: AttributeFacade,
  foreignElementFacade: (element: Element) => void,
): NodeMarking {
  const options = context.options;
  const {
    window,
    document,
    hostDocument,
    nodePrototype,
    nativeGetRootNode,
    nativeOwnerDocument,
    nativeBaseURI,
    nativeGetAttribute,
    nativeSetAttribute,
    nativeRemoveAttribute,
    nativeAttributes,
    nativeHasAttributes,
    nativeHasAttribute,
    nativeQuerySelector,
    nativeQuerySelectorAll,
    NativeMutationObserver,
    isHTMLTemplateElement,
    isHTMLStyleElement,
    isHTMLLinkElement,
    isHTMLScriptElement,
    isBaseElement,
    isInVirtualDocumentTree,
    virtualGetRootNode,
    virtualNodes,
    fragmentNodes,
    createdScripts,
    protectedScriptAttributes,
    eventAttributeValues,
    patch,
  } = context;
  const nativeAttributesGetter = nativeAttributes?.get;
  const onShadowRoot = options.onShadowRoot;
  const initialFlags = options.initialFlags ?? 0xff;
  const hasInitialInlineEvents = (initialFlags & MARKUP_FLAG_INLINE_EVENTS) !== 0;
  const lazyAttributes = options.lazyAttributes === true;
  let realmMayHaveTemplates = (initialFlags & MARKUP_FLAG_TEMPLATES) !== 0;
  let realmHasShadowRoots = false;
  let opaqueGeneration = 0;
  const { rememberAuthoredStyleAttribute, rememberAuthoredLinkRel } = style;
  const { eventAttributeName, compileEventAttribute } = events;
  const {
    urlPropertiesPrototypeWide,
    urlAttributeKey,
    markURLProperties,
    markSVGURLProperty,
    rememberPhysicalURLAttribute,
    syncInitialPhysicalURLs,
    rebaseElementURLs,
  } = attributes;

  // Narrowed once here rather than through an optional chain inside the patched
  // getters, which sit on the hottest read path the facade has. If a realm keeps
  // either accessor somewhere Node.prototype cannot answer for, marking falls
  // back to per-node accessors rather than silently reporting the host document.
  const nativeOwnerDocumentGetter = nativeOwnerDocument?.get;
  const nativeBaseURIGetter = nativeBaseURI?.get;
  const nodeIdentityIsPrototypeWide =
    nativeOwnerDocumentGetter !== undefined && nativeBaseURIGetter !== undefined;

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
  // Compact record for foreign nodes (especially Gecko's host-realm Attr and
  // Text wrappers) whose ownerDocument/baseURI/getRootNode had no prior own
  // descriptors: avoids allocating a Map, Reflect.ownKeys, and per-node closures.
  const compactForeignNodes = new EnumerableWeakSet<Node>();
  const foreignNodeDescriptors: PropertyDescriptorMap = {
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
      value(this: Node, init?: GetRootNodeOptions) {
        return virtualGetRootNode(this, init);
      },
    },
  };

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
      if (compactForeignNodes.has(node)) {
        compactForeignNodes.delete(node);
        previousDescriptors.set("ownerDocument", undefined);
        previousDescriptors.set("baseURI", undefined);
        previousDescriptors.set("getRootNode", undefined);
      }
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
  // Gecko binds a ShadowRoot, Attr, or dynamic Text node to its node document's
  // global, so those come from the host realm rather than this one.
  const installForeignNodeFacade = (node: Node): void => {
    try {
      if (
        !nodeFacadeDescriptors.has(node) &&
        !Object.hasOwn(node, "ownerDocument") &&
        !Object.hasOwn(node, "baseURI") &&
        !Object.hasOwn(node, "getRootNode")
      ) {
        compactForeignNodes.add(node);
        Object.defineProperties(node, foreignNodeDescriptors);
        return;
      }
      defineNodeFacade(node, foreignNodeDescriptors);
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
  const installInlineEventAttributes = (
    element: Element,
    eventAttrs: Array<[string, string, string]>,
  ): void => {
    let attributes = eventAttributeValues.get(element);
    if (attributes === undefined) {
      attributes = new Map();
      eventAttributeValues.set(element, attributes);
    }
    for (const [rawName, attributeName, value] of eventAttrs) {
      attributes.set(attributeName, value);
      nativeRemoveAttribute.call(element, rawName);
      compileEventAttribute(element, attributeName, value, !fragmentNodes.has(element));
    }
  };
  const collectInlineEventAttr = (
    element: Element,
    attribute: Attr,
    attrName: string,
    out: Array<[string, string, string]> | undefined,
  ): Array<[string, string, string]> | undefined => {
    if (attrName.length > 2) {
      const first = attrName.charCodeAt(0);
      const second = attrName.charCodeAt(1);
      if ((first === 111 || first === 79) && (second === 110 || second === 78)) {
        const eventName = eventAttributeName(element, attrName);
        if (eventName !== null) {
          (out ??= []).push([attrName, eventName, attribute.value]);
        }
      }
    }
    return out;
  };
  const markVirtualSubtree = (node: Node, scan?: SubtreeScan): void => {
    const nodeType = node.nodeType;
    const newlyVirtual = !virtualNodes.has(node);
    if (newlyVirtual) {
      virtualNodes.add(node);
      if (!nodeIdentityIsPrototypeWide || !(node instanceof window.Node)) {
        installForeignNodeFacade(node);
      }
      if (onShadowRoot !== undefined) {
        if (nodeType === 11 && "host" in node) {
          realmHasShadowRoots = true;
          opaqueGeneration += 1;
          onShadowRoot(node as ShadowRoot);
        } else if (nodeType === 1 && (node as Element).shadowRoot) {
          realmHasShadowRoots = true;
          opaqueGeneration += 1;
          onShadowRoot((node as Element).shadowRoot!);
        }
      }
    }

    if (nodeType === 1) {
      const element = node as Element;
      const hasURLCapability = canHaveURLAttributes(element);
      let eventAttrs: Array<[string, string, string]> | undefined;
      let attrCount = 0;
      if (nativeHasAttributes.call(element)) {
        if (!newlyVirtual && !hasURLCapability) {
          if (
            scan !== undefined &&
            nativeHasAttribute.call(element, FRAGMENT_TARGET_ATTRIBUTE)
          ) {
            scan.hasTarget = true;
          }
          if (!lazyAttributes) {
            const attrs =
              nativeAttributesGetter !== undefined
                ? (nativeAttributesGetter.call(element) as NamedNodeMap)
                : element.attributes;
            attrCount = attrs.length;
            for (let index = 0; index < attrCount; index += 1) {
              markVirtualAttribute(attrs[index]!);
            }
          }
        } else {
          const attrs =
            nativeAttributesGetter !== undefined
              ? (nativeAttributesGetter.call(element) as NamedNodeMap)
              : element.attributes;
          attrCount = attrs.length;
          let authoredURLs = hasURLCapability
            ? options.authoredURLAttributes.get(element)
            : undefined;
          for (let index = 0; index < attrCount; index += 1) {
            const attribute = attrs[index]!;
            if (!lazyAttributes) {
              markVirtualAttribute(attribute);
            }
            const attrName = attribute.name;
            if (scan !== undefined && attrName === FRAGMENT_TARGET_ATTRIBUTE) {
              scan.hasTarget = true;
            }
            if (hasURLCapability) {
              const urlKey = urlAttributeKey(
                element,
                attribute.localName,
                attribute.namespaceURI,
              );
              if (urlKey !== null) {
                if (authoredURLs === undefined) {
                  authoredURLs = new Map();
                  options.authoredURLAttributes.set(element, authoredURLs);
                }
                if (!authoredURLs.has(urlKey)) {
                  authoredURLs.set(urlKey, attribute.value);
                }
                rememberPhysicalURLAttribute(element, urlKey, attribute.value);
              }
            }
            if (newlyVirtual) {
              eventAttrs = collectInlineEventAttr(
                element,
                attribute,
                attrName,
                eventAttrs,
              );
            }
          }
        }
      }
      if (newlyVirtual) {
        if (attrCount > 0) {
          rememberAuthoredStyleAttribute(element);
        }
        if (isHTMLLinkElement(element)) {
          rememberAuthoredLinkRel(element);
        } else if (isHTMLScriptElement(element)) {
          protectScript(element);
        }
        foreignElementFacade(element);
        if (eventAttrs !== undefined) {
          installInlineEventAttributes(element, eventAttrs);
        }
        if (hasURLCapability) {
          markURLProperties(element);
          markSVGURLProperty(element);
        }
      }
      if (hasURLCapability && options.authoredURLAttributes.has(element)) {
        rebaseElementURLs(element);
      }
      if (scan !== undefined) {
        if (isHTMLStyleElement(element)) {
          scan.styles.push(element);
        } else if (isHTMLLinkElement(element)) {
          scan.links.push(element);
        } else if (isHTMLScriptElement(element)) {
          scan.scripts.push(element);
        } else if (isBaseElement(element)) {
          scan.hasBase = true;
        }
      }

      for (let child = element.firstChild; child !== null;) {
        const next = child.nextSibling;
        const childType = child.nodeType;
        if (childType === 1 || childType === 11) {
          markVirtualSubtree(child, scan);
        } else if (!virtualNodes.has(child)) {
          virtualNodes.add(child);
          if (!nodeIdentityIsPrototypeWide || !(child instanceof window.Node)) {
            installForeignNodeFacade(child);
          }
        }
        child = next;
      }

      if (isHTMLTemplateElement(element)) {
        realmMayHaveTemplates = true;
        opaqueGeneration += 1;
        markVirtualSubtree(element.content);
      }
      return;
    }

    if (nodeType === 11) {
      for (let child = node.firstChild; child !== null;) {
        const next = child.nextSibling;
        const childType = child.nodeType;
        if (childType === 1 || childType === 11) {
          markVirtualSubtree(child, scan);
        } else if (!virtualNodes.has(child)) {
          virtualNodes.add(child);
          if (!nodeIdentityIsPrototypeWide || !(child instanceof window.Node)) {
            installForeignNodeFacade(child);
          }
        }
        child = next;
      }
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
  const markVirtualNode = (node: Node, scan?: SubtreeScan): boolean => {
    if (virtualNodes.has(node) && isInVirtualDocumentTree(node)) {
      return false;
    }
    markVirtualSubtree(node, scan);
    return true;
  };

  const installScrollFacade = (element: HTMLElement) => {
    const scrollProperties: Record<string, () => number> = {
      scrollTop: () => options.scroll.scrollTop,
      scrollLeft: () => options.scroll.scrollLeft,
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
            options.scroll.scrollTop = value;
          };
        } else if (name === "scrollLeft") {
          descriptor.set = (value: number) => {
            options.scroll.scrollLeft = value;
          };
        }
        defineNodeFacade(element, { [name]: descriptor });
      } catch {
        continue;
      }
    }
    defineNodeFacade(element, {
      scroll: { value: options.scroll.scrollTo, writable: true, configurable: true },
      scrollTo: { value: options.scroll.scrollTo, writable: true, configurable: true },
      scrollBy: { value: options.scroll.scrollBy, writable: true, configurable: true },
    });
  };

  const adoptAndMark = <T extends Node>(node: T): T => {
    hostDocument.adoptNode(node);
    const type = node.nodeType;
    if (type === 3 || type === 8) {
      virtualNodes.add(node);
      if (!nodeIdentityIsPrototypeWide || !(node instanceof window.Node)) {
        installForeignNodeFacade(node);
      }
      return node;
    }
    markVirtualNode(node);
    return node;
  };

  interface DetachedWatch {
    observer: MutationObserver;
    nonce: string;
    baseURL: string;
    opaqueGen: number;
    dirty: boolean;
  }
  const DETACHED_WATCH_CAP = 16;
  const detachedCandidates = new WeakSet<Element>();
  const detachedWatches = new WeakMap<Element, DetachedWatch>();
  const activeDetachedObservers = new Set<MutationObserver>();
  const detachedWatchFinalizer = new FinalizationRegistry<MutationObserver>((obs) => {
    obs.disconnect();
    activeDetachedObservers.delete(obs);
  });

  const teardownDetachedWatch = (element: Element, watch: DetachedWatch): void => {
    detachedWatches.delete(element);
    watch.observer.disconnect();
    activeDetachedObservers.delete(watch.observer);
    detachedWatchFinalizer.unregister(element);
  };

  const noteDetachedCandidate = (element: Element): void => {
    if (realmHasShadowRoots || detachedWatches.has(element)) {
      return;
    }
    detachedCandidates.add(element);
  };

  // Armed only immediately after a full markVirtualSubtree() confirmed every
  // node and attribute in `element` is marked and zero special elements exist.
  // Watching all childList and attribute mutations continuously means any edit
  // before or during a future detach invalidates the shortcut and falls back to
  // the full walk, while clean re-attaches skip walking in O(1).
  const armDetachedWatchIfCandidate = (element: Element): void => {
    if (!detachedCandidates.delete(element)) {
      return;
    }
    if (
      realmHasShadowRoots ||
      detachedWatches.has(element) ||
      activeDetachedObservers.size >= DETACHED_WATCH_CAP
    ) {
      return;
    }
    if (
      element.shadowRoot !== null ||
      (realmMayHaveTemplates &&
        (isHTMLTemplateElement(element) ||
          nativeQuerySelector.call(element, "template") !== null))
    ) {
      return;
    }
    const watch: DetachedWatch = {
      observer: null as unknown as MutationObserver,
      nonce: options.getNonce(),
      baseURL: options.getBaseURL(),
      opaqueGen: opaqueGeneration,
      dirty: false,
    };
    const observer = new NativeMutationObserver(() => {
      // Any idle mutation disconnects immediately so long-lived elements never
      // accumulate records or occupy a watch slot; re-attach takes the full walk.
      watch.dirty = true;
      observer.disconnect();
      activeDetachedObservers.delete(observer);
    });
    watch.observer = observer;
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    detachedWatches.set(element, watch);
    activeDetachedObservers.add(observer);
    detachedWatchFinalizer.register(element, observer, element);
  };

  const consumeDetachedWatch = (node: Node, keepAlive: boolean): boolean => {
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    const watch = detachedWatches.get(element);
    if (watch === undefined) return false;
    const records = watch.observer.takeRecords();
    if (
      watch.dirty ||
      records.length > 0 ||
      realmHasShadowRoots ||
      watch.nonce !== options.getNonce() ||
      watch.baseURL !== options.getBaseURL() ||
      watch.opaqueGen !== opaqueGeneration ||
      !virtualNodes.has(element)
    ) {
      teardownDetachedWatch(element, watch);
      return false;
    }
    if (!keepAlive) {
      teardownDetachedWatch(element, watch);
    }
    return true;
  };

  const adoptCreatedElement = <T extends Element>(
    element: T,
    isPlainBuiltinHTML = false,
  ): T => {
    hostDocument.adoptNode(element);
    if (isPlainBuiltinHTML && nodeIdentityIsPrototypeWide && urlPropertiesPrototypeWide) {
      virtualNodes.add(element);
      const localName = element.localName;
      if (localName === "script") {
        protectScript(element as unknown as HTMLScriptElement);
        createdScripts.add(element as unknown as HTMLScriptElement);
      } else if (localName === "link") {
        rememberAuthoredLinkRel(element as unknown as HTMLLinkElement);
      } else if (localName === "template") {
        realmMayHaveTemplates = true;
        opaqueGeneration += 1;
        markVirtualSubtree((element as unknown as HTMLTemplateElement).content);
      }
      return element;
    }
    if (
      nodeIdentityIsPrototypeWide &&
      element.namespaceURI === HTML_NAMESPACE &&
      !nativeHasAttributes.call(element) &&
      element.firstChild === null &&
      element.shadowRoot === null &&
      element instanceof window.Element
    ) {
      virtualNodes.add(element);
      const localName = element.localName;
      if (localName === "script") {
        protectScript(element as unknown as HTMLScriptElement);
        createdScripts.add(element as unknown as HTMLScriptElement);
      } else if (localName === "link") {
        rememberAuthoredLinkRel(element as unknown as HTMLLinkElement);
      } else if (localName === "template") {
        realmMayHaveTemplates = true;
        opaqueGeneration += 1;
        markVirtualSubtree((element as unknown as HTMLTemplateElement).content);
      }
      if (!urlPropertiesPrototypeWide && canHaveURLAttributes(element)) {
        markURLProperties(element);
      }
      return element;
    }
    markVirtualNode(element);
    if (element instanceof window.HTMLScriptElement) {
      createdScripts.add(element);
    }
    return element;
  };

  const virtualDoctype =
    document.doctype ?? document.implementation.createDocumentType("html", "", "");

  // markShell runs before Element.prototype.attributes is patched, so direct
  // element.attributes access is native and guarding with hasAttributes() avoids
  // allocating a NamedNodeMap wrapper for every attribute-less element.
  const markInitialOwnershipLazyAttrs = (element: Element): void => {
    virtualNodes.add(element);
    for (let child = element.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 1) {
        markInitialOwnershipLazyAttrs(child as Element);
      } else {
        virtualNodes.add(child);
      }
    }
  };

  const markInitialOwnershipFast = (element: Element): void => {
    virtualNodes.add(element);
    if (element.hasAttributes()) {
      const attrs = element.attributes;
      for (let index = 0, len = attrs.length; index < len; index += 1) {
        virtualNodes.add(attrs[index]!);
      }
    }
    for (let child = element.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 1) {
        markInitialOwnershipFast(child as Element);
      } else {
        virtualNodes.add(child);
      }
    }
  };

  const markInitialOwnershipWithEvents = (element: Element): void => {
    virtualNodes.add(element);
    if (element.hasAttributes()) {
      const attrs = element.attributes;
      let eventAttrs: Array<[string, string, string]> | undefined;
      for (let index = 0, len = attrs.length; index < len; index += 1) {
        const attribute = attrs[index]!;
        if (!lazyAttributes) {
          virtualNodes.add(attribute);
        }
        eventAttrs = collectInlineEventAttr(
          element,
          attribute,
          attribute.name,
          eventAttrs,
        );
      }
      if (eventAttrs !== undefined) {
        installInlineEventAttributes(element, eventAttrs);
      }
    }
    for (let child = element.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 1) {
        markInitialOwnershipWithEvents(child as Element);
      } else {
        virtualNodes.add(child);
      }
    }
  };

  const markShell = (): void => {
    const query = (selector: string) =>
      nativeQuerySelectorAll.call(options.html, selector);
    if (
      nodeIdentityIsPrototypeWide &&
      urlPropertiesPrototypeWide &&
      options.html instanceof window.Node
    ) {
      if (hasInitialInlineEvents) {
        markInitialOwnershipWithEvents(options.html);
      } else if (lazyAttributes) {
        markInitialOwnershipLazyAttrs(options.html);
      } else {
        markInitialOwnershipFast(options.html);
      }
      if (initialFlags & MARKUP_FLAG_TEMPLATES) {
        for (const template of query("template")) {
          if (isHTMLTemplateElement(template)) markVirtualSubtree(template.content);
        }
        if (onShadowRoot !== undefined) {
          for (const nested of query("v-frame")) {
            if (nested.shadowRoot !== null) {
              realmHasShadowRoots = true;
              opaqueGeneration += 1;
              onShadowRoot(nested.shadowRoot);
            }
          }
        }
      }
      for (const element of options.authoredStyleAttributes.keys()) {
        rememberAuthoredStyleAttribute(element);
      }
      if (initialFlags & MARKUP_FLAG_LINKS) {
        for (const link of options.initialLinks ?? query("link")) {
          if (isHTMLLinkElement(link)) rememberAuthoredLinkRel(link);
        }
      }
      for (const script of options.initialScripts ?? query("script")) {
        if (isHTMLScriptElement(script)) protectScript(script);
      }
      if (initialFlags & MARKUP_FLAG_SVG) {
        for (const svg of query("a,feImage,image,use")) markSVGURLProperty(svg);
      }
      for (const element of options.authoredURLAttributes.keys()) {
        syncInitialPhysicalURLs(element);
      }
    } else {
      markVirtualSubtree(options.html);
    }
    virtualNodes.add(virtualDoctype);
    if (!nodeIdentityIsPrototypeWide) installForeignNodeFacade(virtualDoctype);
    const ro = (value: Node | null): PropertyDescriptor => ({
      configurable: true,
      get: () => value,
    });
    const nullProp = ro(null);
    try {
      defineNodeFacade(virtualDoctype, {
        parentNode: ro(document),
        parentElement: nullProp,
        previousSibling: nullProp,
        nextSibling: ro(options.html),
      });
      defineNodeFacade(options.html, {
        parentNode: ro(document),
        parentElement: nullProp,
        previousSibling: ro(virtualDoctype),
        nextSibling: nullProp,
        previousElementSibling: nullProp,
        nextElementSibling: nullProp,
      });
    } catch {
      // The shell remains reachable from document.documentElement even if parent identity cannot be shadowed.
    }

    installScrollFacade(options.html);
  };

  const installIdentityPatches = (): void => {
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
  };

  const dispose = (): void => {
    for (const observer of activeDetachedObservers) {
      observer.disconnect();
    }
    activeDetachedObservers.clear();
    compactForeignNodes.drain((node) => {
      const record = node as unknown as Record<PropertyKey, unknown>;
      delete record.ownerDocument;
      delete record.baseURI;
      delete record.getRootNode;
    });
    nodeFacadeDescriptors.drain((node, descriptors) => {
      for (const [property, descriptor] of descriptors) {
        if (descriptor === undefined) {
          delete (node as unknown as Record<PropertyKey, unknown>)[property];
        } else {
          Object.defineProperty(node, property, descriptor);
        }
      }
    });
  };

  return {
    markVirtualNode,
    markVirtualSubtree,
    markVirtualAttribute,
    adoptAndMark,
    adoptCreatedElement,
    noteDetachedCandidate,
    armDetachedWatchIfCandidate,
    consumeDetachedWatch,
    noteOpaqueSubtree() {
      realmHasShadowRoots = true;
      opaqueGeneration += 1;
    },
    virtualDoctype,
    markShell,
    installIdentityPatches,
    dispose,
  };
}
