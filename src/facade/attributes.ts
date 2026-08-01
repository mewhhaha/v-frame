// Every URL the guest authors is relative to the guest's own URL, not to the
// host document the nodes physically live in. The authored value is therefore
// kept aside and the physical attribute carries the absolutized form, which
// means getAttribute, setAttribute, the reflected IDL properties and the SVG
// href animated string all have to answer from the authored side. The same
// indirection hides the style, rel and inert-script attributes the facade owns.

import {
  absolutizeSrcset,
  isSrcsetAttribute,
  isURLAttribute,
  XLINK_NAMESPACE,
} from "../markup.js";
import { type FacadeContext, HTML_NAMESPACE, SVG_NAMESPACE } from "./context.js";
import type { EventFacade } from "./events.js";
import type { StyleFacade } from "./style.js";

const URL_PROPERTY_NAMES = [
  "href",
  "src",
  "action",
  "formAction",
  "poster",
  "cite",
  "data",
] as const;

export interface AttributeFacade {
  urlAttributeKey(
    element: Element,
    attributeName: string,
    namespaceURI: string | null,
  ): string | null;
  markURLProperties(element: Element): void;
  markSVGURLProperty(element: Element): void;
  rememberAuthoredURLAttributes(element: Element): void;
  rebaseElementURLs(element: Element): void;
  getVirtualAttribute(element: Element, qualifiedName: string): string | null;
  getVirtualAttributeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): string | null;
  hasVirtualAttribute(element: Element, qualifiedName: string): boolean;
  hasVirtualAttributeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): boolean;
  getVirtualAttributeNames(element: Element): string[];
  getVirtualAttributeNode(element: Element, qualifiedName: string): Attr | null;
  getVirtualAttributeNodeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): Attr | null;
  markAttributeNodes(element: Element, attributeNodes: NamedNodeMap): NamedNodeMap;
  setVirtualAttribute(element: Element, qualifiedName: string, value: string): void;
  removeVirtualAttribute(element: Element, qualifiedName: string): void;
  toggleVirtualAttribute(
    element: Element,
    qualifiedName: string,
    force?: boolean,
  ): boolean;
  setVirtualAttributeNS(
    element: Element,
    namespace: string | null,
    qualifiedName: string,
    value: string,
  ): void;
  removeVirtualAttributeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): void;
  synchronizeURLAttribute(
    element: Element,
    attributeName: string,
    namespaceURI: string | null,
  ): void;
  installPatches(): void;
}

export function installAttributeFacade(
  context: FacadeContext,
  style: StyleFacade,
  events: EventFacade,
): AttributeFacade {
  const options = context.options;
  const {
    window,
    document,
    elementPrototype,
    nativeGetAttribute,
    nativeGetAttributeNS,
    nativeGetAttributeNode,
    nativeGetAttributeNodeNS,
    nativeAttributes,
    nativeGetAttributeNames,
    nativeHasAttribute,
    nativeHasAttributeNS,
    nativeSetAttribute,
    nativeSetAttributeNS,
    nativeRemoveAttribute,
    nativeRemoveAttributeNS,
    nativeToggleAttribute,
    nativeOwnerDocument,
    nativeGetBoundingClientRect,
    nativeGetClientRects,
    getVirtualBoundingClientRect,
    getVirtualClientRects,
    isHTMLLinkElement,
    isHTMLScriptElement,
    isBaseElement,
    connectedBaseElementChanged,
    virtualNodes,
    protectedScriptAttributes,
    eventAttributeValues,
    authoredLinkRelValues,
    patch,
  } = context;
  const {
    setLogicalStyleAttribute,
    removeLogicalStyleAttribute,
    synchronizePhysicalLinkRel,
    setLogicalLinkRel,
    removeLogicalLinkRel,
  } = style;
  const { eventAttributeName, compileEventAttribute, setElementHandler } = events;

  // Writing an attribute creates a fresh Attr node, and nothing re-marks a
  // subtree just because one of its attributes changed. An unmarked Attr
  // answers with native identity — baseURI from the host page on both engines,
  // and on Gecko ownerDocument from the host document, because Gecko binds the
  // Attr to the node document the element was adopted into. So every physical
  // write on a virtual element hands the node it produced back to marking.
  const markAttributeNode = (element: Element, attribute: Attr | null): Attr | null => {
    if (attribute !== null && virtualNodes.has(element)) {
      context.markVirtualAttribute(attribute);
    }
    return attribute;
  };

  // Marking on write only reaches writes that come through the facade. A
  // reflected IDL setter, classList, or the host page's own Element.prototype
  // used on a node it adopted all reach the attribute past every patch, and
  // marking the subtree again would not repair it either: a subtree that is
  // already virtual and still in the tree is deliberately not re-walked. So the
  // realm marks on the way out as well, wherever it hands an Attr node to
  // script — which is where the node's identity is observable in practice,
  // though not the only place it can be reached. See the exclusions below.
  //
  // The tradeoff: this is one WeakSet probe per Attr handed out, on a read path,
  // instead of widening the realm's mutation observer to every attribute name.
  // The observer sits on the hot mutation path and would have paid per write
  // rather than per read, and it delivers a microtask late, so an attribute read
  // back in the same task would still have answered wrong. What it does not
  // cover: an Attr reached through the host realm's own accessors; a
  // NamedNodeMap held across a write from outside the facade, since indexed
  // access on the map cannot be intercepted; and an Attr the guest builds with
  // createAttribute and attaches with setAttributeNode, which stays unmarked
  // until something hands it back out through a marked element. All three hand
  // out a node the realm never sees.
  const markAttributeNodes = (
    element: Element,
    attributeNodes: NamedNodeMap,
  ): NamedNodeMap => {
    if (virtualNodes.has(element)) {
      for (let index = 0; index < attributeNodes.length; index += 1) {
        markAttributeNode(element, attributeNodes.item(index));
      }
    }
    return attributeNodes;
  };
  const getVirtualAttributeNode = (
    element: Element,
    qualifiedName: string,
  ): Attr | null =>
    markAttributeNode(element, nativeGetAttributeNode.call(element, qualifiedName));
  const getVirtualAttributeNodeNS = (
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): Attr | null =>
    markAttributeNode(
      element,
      nativeGetAttributeNodeNS.call(element, namespaceURI, localName),
    );

  const physicalURLAttributeValues = new WeakMap<Element, Map<string, string | null>>();
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
  ): string | null =>
    attributeName === "xlink:href"
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
      getVirtualAttributeNodeNS(element, XLINK_NAMESPACE, "href");
    } else {
      nativeSetAttribute.call(element, attributeName, value);
      getVirtualAttributeNode(element, attributeName);
    }
    rememberPhysicalURLAttribute(element, attributeName, value);
  };
  const removePhysicalURLAttribute = (element: Element, attributeName: string): void => {
    if (attributeName === "xlink:href") {
      nativeRemoveAttributeNS.call(element, XLINK_NAMESPACE, "href");
    } else {
      nativeRemoveAttribute.call(element, attributeName);
    }
    rememberPhysicalURLAttribute(element, attributeName, null);
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
      return (
        authoredAttributes?.get("href") ?? authoredAttributes?.get("xlink:href") ?? ""
      );
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

  const rebaseElementURLs = (element: Element): void => {
    const authoredAttributes = options.authoredURLAttributes.get(element);
    if (authoredAttributes === undefined) {
      return;
    }

    for (const [attributeName, authoredValue] of authoredAttributes) {
      let value =
        attributeName === "srcset"
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
      if (
        isHTMLScriptElement(element) &&
        protectedScriptAttributes.has(element) &&
        attributeName === "src"
      ) {
        protectedScriptAttributes.get(element)?.set("src", value);
      } else {
        setPhysicalURLAttribute(element, attributeName, value);
      }
    }
  };

  function logicalAttribute(
    element: Element,
    attributeName: string,
  ): { managed: boolean; value: string | null } {
    const normalizedAttributeName =
      element.namespaceURI === HTML_NAMESPACE
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

    let physicalValue =
      attributeName === "srcset" ? absolutizeSrcset(value, options.getBaseURL()) : value;
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
      context.executeConnectedScript(element);
    } else {
      setPhysicalURLAttribute(element, attributeName, physicalValue);
    }
    if (isHTMLLinkElement(element) && attributeName === "href") {
      options.onLinkElementChange(element, authoredLinkRelValues.get(element) ?? null);
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
    const normalizedAttributeName =
      element.namespaceURI === HTML_NAMESPACE ? attributeName : qualifiedName;
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
      context.executeConnectedScript(element);
      return;
    }
    nativeSetAttribute.call(element, qualifiedName, nextValue);
    getVirtualAttributeNode(element, qualifiedName);
  }

  function removeVirtualAttribute(element: Element, qualifiedName: string): void {
    const attributeName = qualifiedName.toLowerCase();
    const normalizedAttributeName =
      element.namespaceURI === HTML_NAMESPACE ? attributeName : qualifiedName;
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
        options.onLinkElementChange(element, authoredLinkRelValues.get(element) ?? null);
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
    getVirtualAttributeNodeNS(element, namespace, localName);
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
        options.onLinkElementChange(element, authoredLinkRelValues.get(element) ?? null);
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
      options.onLinkElementChange(element, authoredLinkRelValues.get(element) ?? null);
    }

    if (isBaseElement(element)) {
      connectedBaseElementChanged(element);
      return;
    }
    rebaseElementURLs(element);
  }

  const installPatches = (): void => {
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
      value(
        this: Element,
        namespaceURI: string | null,
        localName: string,
      ): string | null {
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
    patch(elementPrototype, "getAttributeNode", {
      writable: true,
      value(this: Element, qualifiedName: string): Attr | null {
        return getVirtualAttributeNode(this, qualifiedName);
      },
    });
    patch(elementPrototype, "getAttributeNodeNS", {
      writable: true,
      value(this: Element, namespaceURI: string | null, localName: string): Attr | null {
        return getVirtualAttributeNodeNS(this, namespaceURI, localName);
      },
    });
    const nativeAttributesGetter = nativeAttributes?.get;
    if (nativeAttributesGetter !== undefined) {
      patch(elementPrototype, "attributes", {
        get(this: Element): NamedNodeMap {
          return markAttributeNodes(
            this,
            nativeAttributesGetter.call(this) as NamedNodeMap,
          );
        },
      });
    }

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
      value(
        this: Element,
        namespace: string | null,
        qualifiedName: string,
        value: string,
      ) {
        setVirtualAttributeNS(this, namespace, qualifiedName, value);
      },
    });
    patch(window.Attr.prototype, "ownerDocument", {
      get(this: Attr): Document | null {
        if (
          virtualNodes.has(this) ||
          (this.ownerElement !== null && virtualNodes.has(this.ownerElement))
        ) {
          return document;
        }
        return nativeOwnerDocument?.get?.call(this) ?? null;
      },
    });
  };

  return {
    urlAttributeKey,
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
    synchronizeURLAttribute,
    installPatches,
  };
}
