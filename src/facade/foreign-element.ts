// An element that does not inherit from this realm's Element.prototype (Gecko
// binds some host-document elements to the host realm) never reaches the
// facade's prototype patches, so the patched behavior is defined on the
// instance instead: geometry, attribute access with its authored values, the
// style facade and the link and script properties the facade owns.

import type { AttributeFacade } from "./attributes.js";
import { type FacadeContext, HTML_NAMESPACE, SVG_NAMESPACE } from "./context.js";
import type { StyleFacade } from "./style.js";
import { toDOMString, toLegacyNullToEmptyString } from "./webidl.js";

const method = (value: unknown): PropertyDescriptor => ({
  configurable: true,
  writable: true,
  value,
});

export function createForeignElementFacade(
  context: FacadeContext,
  style: StyleFacade,
  attributes: AttributeFacade,
): (element: Element) => void {
  const {
    window,
    nativeAttributes,
    isHTMLLinkElement,
    isHTMLScriptElement,
    protectedScriptAttributes,
    authoredLinkRelValues,
    getVirtualBoundingClientRect,
    getVirtualClientRects,
  } = context;
  const { setLogicalStyleAttribute, styleFacade, setLogicalLinkRel, linkRelListFacade } =
    style;
  const {
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

  return (element) => {
    const namespaceURI = element.namespaceURI;
    const foreignLink = isHTMLLinkElement(element) ? element : null;
    if (element instanceof window.Element) {
      return;
    }
    try {
      const descriptors: PropertyDescriptorMap = {
        getBoundingClientRect: method(() => getVirtualBoundingClientRect(element)),
        getClientRects: method(() => getVirtualClientRects(element)),
        getAttribute: method((qualifiedName: string) =>
          getVirtualAttribute(element, qualifiedName),
        ),
        getAttributeNS: method((namespaceURI: string | null, localName: string) =>
          getVirtualAttributeNS(element, namespaceURI, localName),
        ),
        hasAttribute: method((qualifiedName: string) =>
          hasVirtualAttribute(element, qualifiedName),
        ),
        hasAttributeNS: method((namespaceURI: string | null, localName: string) =>
          hasVirtualAttributeNS(element, namespaceURI, localName),
        ),
        getAttributeNames: method(() => getVirtualAttributeNames(element)),
        // A foreign element resolves these on the host realm's prototype, where
        // the facade's patches are not, so the Attr nodes it hands out would
        // never reach marking.
        getAttributeNode: method((qualifiedName: string) =>
          getVirtualAttributeNode(element, qualifiedName),
        ),
        getAttributeNodeNS: method((namespaceURI: string | null, localName: string) =>
          getVirtualAttributeNodeNS(element, namespaceURI, localName),
        ),
        setAttribute: method((qualifiedName: string, value: string) =>
          setVirtualAttribute(element, qualifiedName, value),
        ),
        removeAttribute: method((qualifiedName: string) =>
          removeVirtualAttribute(element, qualifiedName),
        ),
        removeAttributeNS: method((namespaceURI: string | null, localName: string) =>
          removeVirtualAttributeNS(element, namespaceURI, localName),
        ),
        toggleAttribute: method((qualifiedName: string, force?: boolean) =>
          toggleVirtualAttribute(element, qualifiedName, force),
        ),
        setAttributeNS: method(
          (namespace: string | null, qualifiedName: string, value: string) =>
            setVirtualAttributeNS(element, namespace, qualifiedName, value),
        ),
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
          set: (value: string) =>
            setLogicalStyleAttribute(element, toLegacyNullToEmptyString(value), true),
        };
      }
      if (foreignLink !== null) {
        descriptors.rel = {
          configurable: true,
          get: () => authoredLinkRelValues.get(foreignLink) ?? "",
          set: (value: string) =>
            setLogicalLinkRel(foreignLink, toDOMString(value), false),
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
          set: (value: string) =>
            setVirtualAttribute(element, "type", toDOMString(value)),
        };
      }
      Object.defineProperties(element, descriptors);
    } catch {
      // The node remains physically inert even if its foreign wrapper rejects expandos.
    }
  };
}
