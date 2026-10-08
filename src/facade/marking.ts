// Guest nodes are created in the realm so they keep the prototypes this facade
// patches, then inserted into the host shadow tree so they render in host
// layout. Marking is what makes that lie hold: every node that crosses into the
// virtual tree joins the virtual-node set that the realm's ownerDocument,
// baseURI and getRootNode accessors answer from, has its authored attributes
// remembered, and has its scripts and inline handlers defused. Insertion,
// cloning and markup parsing all funnel back through it.

import { EnumerableWeakMap } from "../enumerable-weak.js";
import type { AttributeFacade } from "./attributes.js";
import type { FacadeContext } from "./context.js";
import type { EventFacade } from "./events.js";
import type { StyleFacade } from "./style.js";

export interface NodeMarking {
  markVirtualNode(node: Node): void;
  markVirtualAttribute(attribute: Attr): void;
  /** Adopts a node the realm just created into the shell's document and marks it. */
  adoptAndMark<T extends Node>(node: T): T;
  /** adoptAndMark for an element, which also records scripts as guest-created. */
  adoptCreatedElement<T extends Element>(element: T): T;
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
    isElementNode,
    isHTMLTemplateElement,
    isHTMLLinkElement,
    isHTMLScriptElement,
    isInVirtualDocumentTree,
    virtualGetRootNode,
    virtualNodes,
    createdScripts,
    protectedScriptAttributes,
    eventAttributeValues,
    patch,
  } = context;
  const { rememberAuthoredStyleAttribute, rememberAuthoredLinkRel } = style;
  const { eventAttributeName, compileEventAttribute } = events;
  const {
    markURLProperties,
    markSVGURLProperty,
    rememberAuthoredURLAttributes,
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
        foreignElementFacade(node);
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
        defineNodeFacade(element, { [name]: descriptor });
      } catch {
        continue;
      }
    }
  };

  const adoptAndMark = <T extends Node>(node: T): T => {
    hostDocument.adoptNode(node);
    markVirtualNode(node);
    return node;
  };

  const adoptCreatedElement = <T extends Element>(element: T): T => {
    adoptAndMark(element);
    if (element instanceof window.HTMLScriptElement) {
      createdScripts.add(element);
    }
    return element;
  };

  const virtualDoctype =
    document.doctype ?? document.implementation.createDocumentType("html", "", "");

  const markShell = (): void => {
    markVirtualNode(options.html);
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

  return {
    markVirtualNode,
    markVirtualAttribute,
    adoptAndMark,
    adoptCreatedElement,
    virtualDoctype,
    markShell,
    installIdentityPatches,
    dispose,
  };
}
