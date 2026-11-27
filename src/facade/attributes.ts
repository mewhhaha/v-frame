// Every URL the guest authors is relative to the guest's own URL, not to the
// host document the nodes physically live in. The authored value is therefore
// kept aside and the physical attribute carries the absolutized form, which
// means getAttribute, setAttribute, the reflected IDL properties and the SVG
// href animated string all have to answer from the authored side. The same
// indirection hides the style, rel and inert-script attributes the facade owns.

import {
  canHaveURLAttributes,
  isSrcsetAttribute,
  isURLAttribute,
  rewriteAssetAttribute,
  XLINK_NAMESPACE,
} from "../asset-urls.js";
import { type FacadeContext, HTML_NAMESPACE, SVG_NAMESPACE } from "./context.js";
import type { EventFacade } from "./events.js";
import type { ScriptExecution } from "./script-execution.js";
import type { StyleFacade } from "./style.js";
import { toDOMString, toNullableDOMString, toUSVString } from "./webidl.js";
import { FRAGMENT_TARGET_ATTRIBUTE } from "../wire-format.js";

const POTENTIAL_URL_ATTRIBUTE_NAMES = new Set([
  "href",
  "src",
  "srcset",
  "imagesrcset",
  "action",
  "formaction",
  "poster",
  "cite",
  "data",
  "xlink:href",
]);

const URL_PROPERTY_NAMES = [
  "href",
  "src",
  "action",
  "formAction",
  "poster",
  "cite",
  "data",
] as const;

const REFLECTED_URL_GROUPS: ReadonlyArray<
  readonly [propertyName: string, stems: readonly string[]]
> = [
  ["href", ["Anchor", "Area", "Base", "Link"]],
  ["src", ["Image", "Script", "IFrame", "Media", "Source", "Track", "Embed", "Input"]],
  ["action", ["Form"]],
  ["formAction", ["Button", "Input"]],
  ["poster", ["Video"]],
  ["cite", ["Quote", "Mod"]],
  ["data", ["Object"]],
  ["srcset", ["Image", "Source"]],
];

export interface AttributeFacade {
  urlPropertiesPrototypeWide: boolean;
  urlAttributeKey(
    element: Element,
    attributeName: string,
    namespaceURI: string | null,
  ): string | null;
  markURLProperties(element: Element): void;
  markSVGURLProperty(element: Element): void;
  rememberAuthoredURLAttributes(element: Element): void;
  rememberPhysicalURLAttribute(
    element: Element,
    attributeName: string,
    value: string | null,
  ): void;
  syncInitialPhysicalURLs(element: Element): void;
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
  /** Marking is built from this facade, so it hands its marker back afterwards. */
  setAttributeMarker(mark: (attribute: Attr) => void): void;
  installPatches(): void;
}

export function installAttributeFacade(
  context: FacadeContext,
  style: StyleFacade,
  events: EventFacade,
  scripts: ScriptExecution,
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
    nativeRemoveAttributeNode,
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
  let markVirtualAttribute: ((attribute: Attr) => void) | undefined;
  const markAttributeNode = (element: Element, attribute: Attr | null): Attr | null => {
    if (attribute !== null && virtualNodes.has(element)) {
      // Marking exists before any guest code can write an attribute.
      markVirtualAttribute!(attribute);
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
  const lazyAttributes = options.lazyAttributes === true;
  const observedAttributeElements = new WeakSet<Element>();
  const nativeAttrOwnerElement = Object.getOwnPropertyDescriptor(
    window.Attr.prototype,
    "ownerElement",
  )?.get;
  const hostAttrCtor = context.hostDocument.defaultView?.Attr;
  const markAttributeNodes = (
    element: Element,
    attributeNodes: NamedNodeMap,
  ): NamedNodeMap => {
    if (virtualNodes.has(element)) {
      if (lazyAttributes) {
        observedAttributeElements.add(element);
      }
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
    markAttributeNode(
      element,
      nativeGetAttributeNode.call(element, toDOMString(qualifiedName)),
    );
  const getVirtualAttributeNodeNS = (
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): Attr | null =>
    markAttributeNode(
      element,
      nativeGetAttributeNodeNS.call(
        element,
        toNullableDOMString(namespaceURI),
        toDOMString(localName),
      ),
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
  // What the physical attribute carries for an authored URL. Whether and how it
  // is rewritten is the asset policy's decision; a value it leaves alone (blank,
  // `javascript:`, already absolute) is physically what the guest authored. A
  // <base> resolves against the document's own URL, since it is what sets the
  // base everything else resolves against.
  const physicalURLValue = (
    element: Element,
    attributeName: string,
    authoredValue: string,
  ): string => {
    const baseURL = isBaseElement(element)
      ? options.getCurrentURL()
      : options.getBaseURL();
    const [name, namespaceURI] =
      attributeName === "xlink:href"
        ? (["href", XLINK_NAMESPACE] as const)
        : ([attributeName, null] as const);
    return (
      rewriteAssetAttribute(element, name, namespaceURI, authoredValue, baseURL) ??
      authoredValue
    );
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
    const shouldMark = !lazyAttributes || observedAttributeElements.has(element);
    if (attributeName === "xlink:href") {
      nativeSetAttributeNS.call(element, XLINK_NAMESPACE, attributeName, value);
      if (shouldMark) {
        getVirtualAttributeNodeNS(element, XLINK_NAMESPACE, "href");
      }
    } else {
      nativeSetAttribute.call(element, attributeName, value);
      if (shouldMark) {
        getVirtualAttributeNode(element, attributeName);
      }
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

  const readVirtualURLProperty = (
    element: Element,
    propertyName: (typeof URL_PROPERTY_NAMES)[number],
    attributeName: string,
  ): string => {
    const value = options.authoredURLAttributes.get(element)?.get(attributeName);
    if (value === undefined) {
      if (propertyName === "action" || propertyName === "formAction") {
        return options.getCurrentURL();
      }
      return "";
    }

    if (value === "" && (propertyName === "action" || propertyName === "formAction")) {
      return options.getCurrentURL();
    }

    const baseURL = isBaseElement(element)
      ? options.getCurrentURL()
      : options.getBaseURL();
    return window.URL.parse(value, baseURL)?.href ?? value;
  };

  const realmGlobals = window as unknown as Record<
    string,
    { prototype?: object } | undefined
  >;
  const reflectedURLPatches: Array<
    readonly [
      prototype: object,
      propertyName: string,
      attributeName: string,
      nativeGet: () => unknown,
      nativeSet: (value: unknown) => void,
    ]
  > = [];
  let urlPropertiesPrototypeWide = true;
  for (const [propertyName, stems] of REFLECTED_URL_GROUPS) {
    const attributeName = propertyName === "formAction" ? "formaction" : propertyName;
    for (const stem of stems) {
      const prototype = realmGlobals[`HTML${stem}Element`]?.prototype;
      const descriptor = prototype
        ? Object.getOwnPropertyDescriptor(prototype, propertyName)
        : undefined;
      if (prototype === undefined || !descriptor?.get || !descriptor?.set) {
        urlPropertiesPrototypeWide = false;
        continue;
      }
      reflectedURLPatches.push([
        prototype,
        propertyName,
        attributeName,
        descriptor.get,
        descriptor.set,
      ]);
    }
  }

  const markURLProperties = (element: Element) => {
    if (
      element.namespaceURI !== HTML_NAMESPACE ||
      (urlPropertiesPrototypeWide && element instanceof window.Element)
    ) {
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
          get: () => readVirtualURLProperty(element, propertyName, attributeName),
          set(value: string) {
            setVirtualAttribute(element, attributeName, toUSVString(value));
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
          set: (value: string) => element.setAttribute("srcset", toDOMString(value)),
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
          set: (value: string) =>
            setVirtualAttribute(element, "href", toUSVString(value)),
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
    if (!canHaveURLAttributes(element)) {
      return;
    }
    const attributes = element.attributes;
    let authoredAttributes = options.authoredURLAttributes.get(element);
    for (let index = 0; index < attributes.length; index += 1) {
      const attribute = attributes[index]!;
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

  const syncInitialPhysicalURLs = (element: Element): void => {
    const authoredAttributes = options.authoredURLAttributes.get(element);
    if (authoredAttributes === undefined) {
      return;
    }
    for (const attributeName of authoredAttributes.keys()) {
      if (
        isHTMLScriptElement(element) &&
        protectedScriptAttributes.has(element) &&
        attributeName === "src"
      ) {
        continue;
      }
      rememberPhysicalURLAttribute(
        element,
        attributeName,
        physicalURLAttributeValue(element, attributeName),
      );
    }
  };

  const rebaseElementURLs = (element: Element): void => {
    const authoredAttributes = options.authoredURLAttributes.get(element);
    if (authoredAttributes === undefined) {
      return;
    }

    for (const [attributeName, authoredValue] of authoredAttributes) {
      const value = physicalURLValue(element, attributeName, authoredValue);
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

  // The attributes the guest sees differently from the DOM: the physical
  // attribute is rewritten, defused or hidden, so each of them is answered from
  // the facade's own record. One entry per kind, each owning every operation on
  // it, and one precedence — the order of the table — for deciding who owns a
  // name. Getting, setting, removing and listing used to each carry their own
  // chain of these checks in a different order.
  //
  // Only one thing ever depends on that order: a protected script's `src` is
  // both a script attribute and a URL attribute, and the script entry owns it
  // by coming first (its record holds the value the inert script will run, the
  // URL record holds what the guest authored; the script entry keeps both in
  // step). Every other name matches at most one entry.
  interface ManagedAttribute {
    // `name` is already normalized for the element's namespace. A read and a
    // write can disagree on who owns a name, which is why `access` is passed.
    matches(element: Element, name: string, access: "read" | "write"): boolean;
    // The authored value; null when the guest has none. undefined means the
    // facade holds nothing for this name and the physical attribute answers.
    get(element: Element, name: string): string | null | undefined;
    set(element: Element, name: string, value: string): void;
    remove(element: Element, name: string): void;
    // Brings the physical attribute names in line with the authored ones.
    names?(element: Element, names: string[]): void;
  }

  const isProtectedScript = (element: Element): element is HTMLScriptElement =>
    isHTMLScriptElement(element) && protectedScriptAttributes.has(element);
  const authoredURLKey = (
    element: Element,
    name: string,
    access: "read" | "write",
  ): string | null =>
    // Only a read recognizes the legacy `xlink:href` spelling, and only once an
    // authored value is on record for it: a write by that name is the native
    // attribute with a colon in its name.
    access === "read" &&
    element.namespaceURI === SVG_NAMESPACE &&
    name.toLowerCase() === "xlink:href" &&
    options.authoredURLAttributes.get(element)?.has("xlink:href") === true
      ? "xlink:href"
      : urlAttributeKey(element, name, null);

  const removeAuthoredURLAttribute = (element: Element, attributeName: string): void => {
    options.authoredURLAttributes.get(element)?.delete(attributeName);
    removePhysicalURLAttribute(element, attributeName);
    if (isHTMLLinkElement(element) && attributeName === "href") {
      synchronizePhysicalLinkRel(element, false);
      options.onLinkElementChange(element, authoredLinkRelValues.get(element) ?? null);
    }
  };

  const managedAttributes: readonly ManagedAttribute[] = [
    // The facade's own bookkeeping attributes. The fragment target marker is
    // hidden from reads but writable: the realm writes it natively to select an
    // element, and a guest copying it onto another is no different.
    {
      matches: (element, name, access) =>
        virtualNodes.has(element) &&
        (name === options.inlineStyleSelectorAttribute ||
          (access === "read" && name === FRAGMENT_TARGET_ATTRIBUTE)),
      get: () => null,
      set: () => undefined,
      remove: () => undefined,
    },
    // The inert script's `src` and `type`, held aside so nothing runs by itself.
    {
      matches: (element, name) =>
        isProtectedScript(element) && (name === "src" || name === "type"),
      get(element, name) {
        const authored = options.authoredURLAttributes.get(element);
        if (name === "src" && authored?.has("src") === true) {
          return authored.get("src") ?? null;
        }
        return (
          protectedScriptAttributes
            .get(element as HTMLScriptElement)
            ?.get(name as "src" | "type") ?? null
        );
      },
      set(element, name, value) {
        if (name === "src") {
          setVirtualURLAttribute(element, "src", value);
        } else {
          protectedScriptAttributes.get(element as HTMLScriptElement)?.set("type", value);
        }
      },
      remove(element, name) {
        protectedScriptAttributes
          .get(element as HTMLScriptElement)
          ?.delete(name as "src" | "type");
        if (name === "src") {
          options.authoredURLAttributes.get(element)?.delete("src");
        }
      },
      names(element, names) {
        if (!isHTMLScriptElement(element)) {
          return;
        }
        const scriptAttributes = protectedScriptAttributes.get(element);
        for (const attributeName of ["src", "type"] as const) {
          const index = names.indexOf(attributeName);
          if (!scriptAttributes?.has(attributeName) && index !== -1) {
            names.splice(index, 1);
          } else if (scriptAttributes?.has(attributeName) && index === -1) {
            names.push(attributeName);
          }
        }
      },
    },
    // Inline event handlers, compiled in the realm instead of left on the element.
    {
      matches: (element, name) =>
        virtualNodes.has(element) && eventAttributeName(element, name) !== null,
      get: (element, name) =>
        eventAttributeValues.get(element)?.get(eventAttributeName(element, name)!) ??
        null,
      set(element, name, value) {
        const eventName = eventAttributeName(element, name)!;
        let attributes = eventAttributeValues.get(element);
        if (attributes === undefined) {
          attributes = new Map();
          eventAttributeValues.set(element, attributes);
        }
        attributes.set(eventName, value);
        compileEventAttribute(element, eventName, value);
      },
      remove(element, name) {
        const eventName = eventAttributeName(element, name)!;
        eventAttributeValues.get(element)?.delete(eventName);
        setElementHandler(element, eventName.slice(2), null);
      },
      names(element, names) {
        for (const attributeName of eventAttributeValues.get(element)?.keys() ?? []) {
          if (!names.includes(attributeName)) {
            names.push(attributeName);
          }
        }
      },
    },
    {
      matches: (element, name) => virtualNodes.has(element) && name === "style",
      get: (element) => options.authoredStyleAttributes.get(element) ?? null,
      set: (element, _name, value) => setLogicalStyleAttribute(element, value, false),
      remove: (element) => removeLogicalStyleAttribute(element),
      names(element, names) {
        if (options.authoredStyleAttributes.has(element) && !names.includes("style")) {
          names.push("style");
        }
      },
    },
    {
      matches: (element, name) =>
        virtualNodes.has(element) && isHTMLLinkElement(element) && name === "rel",
      get: (element) => authoredLinkRelValues.get(element as HTMLLinkElement) ?? null,
      set: (element, _name, value) =>
        setLogicalLinkRel(element as HTMLLinkElement, value, false),
      remove: (element) => removeLogicalLinkRel(element as HTMLLinkElement),
      names(element, names) {
        if (
          isHTMLLinkElement(element) &&
          (authoredLinkRelValues.get(element) ?? null) !== null &&
          !names.includes("rel")
        ) {
          names.push("rel");
        }
      },
    },
    // URL attributes: the physical value is absolutized, the authored one is
    // what the guest reads back.
    {
      matches: (element, name, access) =>
        virtualNodes.has(element) && authoredURLKey(element, name, access) !== null,
      get(element, name) {
        const attributeName = authoredURLKey(element, name, "read")!;
        const authored = options.authoredURLAttributes.get(element);
        return authored?.has(attributeName) === true
          ? (authored.get(attributeName) ?? null)
          : undefined;
      },
      set: (element, name, value) =>
        setVirtualURLAttribute(element, authoredURLKey(element, name, "write")!, value),
      remove(element, name) {
        removeAuthoredURLAttribute(element, authoredURLKey(element, name, "write")!);
        connectedBaseElementChanged(element);
      },
    },
  ];

  const inlineStyleSelectorAttrLen = options.inlineStyleSelectorAttribute.length;
  const fragmentTargetAttrLen = FRAGMENT_TARGET_ATTRIBUTE.length;
  // Fast-reject ordinary unmanaged attribute names (class, id, data-*, aria-*,
  // role, title, name, value, etc.) using length and first character alone,
  // before touching virtualNodes, namespaceURI, toLowerCase(), or Set lookups.
  const couldBeManagedAttributeName = (name: string): boolean => {
    const len = name.length;
    if (len < 3) return false;
    const c0 = name.charCodeAt(0) | 32;
    if (c0 === 111 /* 'o' */) {
      return (name.charCodeAt(1) | 32) === 110; /* 'n' */
    }
    switch (len) {
      case 3:
        return c0 === 114 /* 'r' rel */ || c0 === 115; /* 's' src */
      case 4:
        return (
          c0 === 104 /* 'h' href */ ||
          c0 === 99 /* 'c' cite */ ||
          c0 === 100 /* 'd' data */ ||
          c0 === 116 /* 't' type */
        );
      case 5:
        return c0 === 115; /* 's' style */
      case 6:
        return (
          c0 === 97 /* 'a' action */ ||
          c0 === 112 /* 'p' poster */ ||
          c0 === 115 /* 's' srcset */
        );
      case 10:
        return c0 === 102 /* 'f' formaction */ || c0 === 120; /* 'x' xlink:href */
      case 11:
        return c0 === 105; /* 'i' imagesrcset */
      default:
        return (
          c0 === 100 /* 'd' */ &&
          (len === fragmentTargetAttrLen || len === inlineStyleSelectorAttrLen)
        );
    }
  };

  const managedAttributeFor = (
    element: Element,
    name: string,
    access: "read" | "write",
    isHTML: boolean,
  ): ManagedAttribute | undefined => {
    const c0 = name.charCodeAt(0);
    const c1 = name.charCodeAt(1);
    // Fast-reject ordinary unmanaged attributes (class, id, data-*, aria-*, title, etc.)
    // by name before consulting URL element capability or walking the matcher table.
    const couldBeURL = isHTML
      ? POTENTIAL_URL_ATTRIBUTE_NAMES.has(name)
      : element.namespaceURI === SVG_NAMESPACE &&
        (name === "href" ||
          (name.length === 4 && name.toLowerCase() === "href") ||
          (name.length === 10 && name.toLowerCase() === "xlink:href"));
    if (
      !couldBeURL &&
      name !== "style" &&
      name !== "rel" &&
      name !== "type" &&
      name !== options.inlineStyleSelectorAttribute &&
      name !== FRAGMENT_TARGET_ATTRIBUTE &&
      !(name.length > 2 && (c0 === 111 || c0 === 79) && (c1 === 110 || c1 === 78))
    ) {
      return undefined;
    }
    return managedAttributes.find((managed) => managed.matches(element, name, access));
  };

  // The authored value of an attribute the facade manages, null when it has
  // none, undefined when the name is not managed and the physical attribute is
  // the answer.
  const logicalAttribute = (
    element: Element,
    qualifiedName: string,
  ): string | null | undefined => {
    if (!virtualNodes.has(element)) {
      return undefined;
    }
    const isHTML = element.namespaceURI === HTML_NAMESPACE;
    const name = isHTML ? qualifiedName.toLowerCase() : qualifiedName;
    return managedAttributeFor(element, name, "read", isHTML)?.get(element, name);
  };

  function getVirtualAttribute(element: Element, qualifiedName: string): string | null {
    const attrName =
      typeof qualifiedName === "string" ? qualifiedName : toDOMString(qualifiedName);
    if (!couldBeManagedAttributeName(attrName)) {
      return nativeGetAttribute.call(element, attrName);
    }
    const logical = logicalAttribute(element, attrName);
    return logical === undefined ? nativeGetAttribute.call(element, attrName) : logical;
  }

  const logicalAttributeNS = (
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): string | null | undefined => {
    // With no namespace, the lookup covers the same managed attributes as
    // getAttribute. localName stays case-sensitive, so only the canonical
    // lowercase spelling can name a managed attribute.
    if (
      (namespaceURI === null || namespaceURI === "") &&
      localName === localName.toLowerCase()
    ) {
      const logical = logicalAttribute(element, localName);
      if (logical !== undefined) {
        return logical;
      }
    }
    if (virtualNodes.has(element)) {
      const attributeName = urlAttributeKey(element, localName, namespaceURI);
      const authoredAttributes = options.authoredURLAttributes.get(element);
      if (attributeName !== null && authoredAttributes?.has(attributeName) === true) {
        return authoredAttributes.get(attributeName) ?? null;
      }
    }
    return undefined;
  };

  function getVirtualAttributeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): string | null {
    namespaceURI = toNullableDOMString(namespaceURI);
    localName = toDOMString(localName);
    const logical = logicalAttributeNS(element, namespaceURI, localName);
    return logical === undefined
      ? nativeGetAttributeNS.call(element, namespaceURI, localName)
      : logical;
  }

  function hasVirtualAttribute(element: Element, qualifiedName: string): boolean {
    const attrName =
      typeof qualifiedName === "string" ? qualifiedName : toDOMString(qualifiedName);
    if (!couldBeManagedAttributeName(attrName)) {
      return nativeHasAttribute.call(element, attrName);
    }
    const logical = logicalAttribute(element, attrName);
    return logical === undefined
      ? nativeHasAttribute.call(element, attrName)
      : logical !== null;
  }

  function hasVirtualAttributeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): boolean {
    namespaceURI = toNullableDOMString(namespaceURI);
    localName = toDOMString(localName);
    const logical = logicalAttributeNS(element, namespaceURI, localName);
    return logical === undefined
      ? nativeHasAttributeNS.call(element, namespaceURI, localName)
      : logical !== null;
  }

  function getVirtualAttributeNames(element: Element): string[] {
    const names = nativeGetAttributeNames
      .call(element)
      .filter((name) => logicalAttribute(element, name) !== null);
    // The order of the table is the order the authored-only names come after the
    // physical ones.
    for (const managed of managedAttributes) {
      managed.names?.(element, names);
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

    const physicalValue = physicalURLValue(element, attributeName, value);

    if (
      isHTMLScriptElement(element) &&
      protectedScriptAttributes.has(element) &&
      attributeName === "src"
    ) {
      protectedScriptAttributes.get(element)?.set("src", physicalValue);
      scripts.executeConnectedScript(element);
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
    const attrName =
      typeof qualifiedName === "string" ? qualifiedName : toDOMString(qualifiedName);
    const nextValue = typeof value === "string" ? value : toDOMString(value);
    if (!couldBeManagedAttributeName(attrName)) {
      nativeSetAttribute.call(element, attrName, nextValue);
      if (
        (!lazyAttributes || observedAttributeElements.has(element)) &&
        virtualNodes.has(element)
      ) {
        const attribute = nativeGetAttributeNode.call(element, attrName);
        if (attribute !== null) {
          markVirtualAttribute!(attribute);
        }
      }
      return;
    }
    const virtual = virtualNodes.has(element);
    if (virtual) {
      const isHTML = element.namespaceURI === HTML_NAMESPACE;
      const name = isHTML ? attrName.toLowerCase() : attrName;
      const managed = managedAttributeFor(element, name, "write", isHTML);
      if (managed !== undefined) {
        managed.set(element, name, nextValue);
        return;
      }
    }
    nativeSetAttribute.call(element, attrName, nextValue);
    if (virtual && (!lazyAttributes || observedAttributeElements.has(element))) {
      const attribute = nativeGetAttributeNode.call(element, attrName);
      if (attribute !== null) {
        markVirtualAttribute!(attribute);
      }
    }
  }

  function removeVirtualAttribute(element: Element, qualifiedName: string): void {
    const attrName =
      typeof qualifiedName === "string" ? qualifiedName : toDOMString(qualifiedName);
    if (!couldBeManagedAttributeName(attrName)) {
      nativeRemoveAttribute.call(element, attrName);
      return;
    }
    if (virtualNodes.has(element)) {
      const isHTML = element.namespaceURI === HTML_NAMESPACE;
      const name = isHTML ? attrName.toLowerCase() : attrName;
      const managed = managedAttributeFor(element, name, "write", isHTML);
      if (managed !== undefined) {
        managed.remove(element, name);
        return;
      }
    }
    nativeRemoveAttribute.call(element, attrName);
  }

  let nameProbeElement: Element | undefined;
  const nameProbe = (): Element =>
    (nameProbeElement ??= context.nativeCreateElement.call(document, "span"));

  function toggleVirtualAttribute(
    element: Element,
    qualifiedName: string,
    force?: boolean,
  ): boolean {
    qualifiedName = toDOMString(qualifiedName);
    // `optional boolean force`: only undefined means "not given"; null is false.
    const forced = force === undefined ? undefined : Boolean(force);
    if (!virtualNodes.has(element)) {
      return nativeToggleAttribute.call(element, qualifiedName, forced);
    }
    // Removal never reaches a native call that validates the name, but the
    // method throws InvalidCharacterError for a bad name whatever force says.
    nativeToggleAttribute.call(nameProbe(), qualifiedName, false);
    const present = hasVirtualAttribute(element, qualifiedName);
    const nextPresent = forced ?? !present;
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
    // The empty string is the null namespace, as for every namespace argument.
    namespace = toNullableDOMString(namespace);
    if (namespace === "") {
      namespace = null;
    }
    qualifiedName = toDOMString(qualifiedName);
    const authoredValue = toDOMString(value);
    // Without a namespace and prefix the call names the same attribute
    // setAttribute would, minus its lowercasing, so only the lowercase spelling
    // can be one of the attributes the facade manages. A prefix with no
    // namespace is the native NamespaceError, which setAttribute would swallow.
    if (
      virtualNodes.has(element) &&
      namespace === null &&
      !qualifiedName.includes(":") &&
      qualifiedName === qualifiedName.toLowerCase()
    ) {
      setVirtualAttribute(element, qualifiedName, authoredValue);
      return;
    }
    const localName = qualifiedName.includes(":")
      ? qualifiedName.slice(qualifiedName.indexOf(":") + 1)
      : qualifiedName;
    const attributeName = urlAttributeKey(element, localName, namespace);
    if (virtualNodes.has(element) && attributeName !== null && namespace !== null) {
      setVirtualURLAttribute(element, attributeName, authoredValue);
      return;
    }
    nativeSetAttributeNS.call(element, namespace, qualifiedName, authoredValue);
    if (
      virtualNodes.has(element) &&
      (!lazyAttributes || observedAttributeElements.has(element))
    ) {
      getVirtualAttributeNodeNS(element, namespace, localName);
    }
  }

  function removeVirtualAttributeNS(
    element: Element,
    namespaceURI: string | null,
    localName: string,
  ): void {
    namespaceURI = toNullableDOMString(namespaceURI);
    localName = toDOMString(localName);
    if (namespaceURI === "") {
      namespaceURI = null;
    }
    if (
      virtualNodes.has(element) &&
      namespaceURI === null &&
      localName === localName.toLowerCase()
    ) {
      removeVirtualAttribute(element, localName);
      return;
    }
    const attributeName = urlAttributeKey(element, localName, namespaceURI);
    if (virtualNodes.has(element) && attributeName !== null && namespaceURI !== null) {
      removeAuthoredURLAttribute(element, attributeName);
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
    for (const [name, fn] of [
      ["getAttribute", getVirtualAttribute],
      ["getAttributeNS", getVirtualAttributeNS],
      ["hasAttribute", hasVirtualAttribute],
      ["hasAttributeNS", hasVirtualAttributeNS],
      ["getAttributeNames", getVirtualAttributeNames],
      ["getAttributeNode", getVirtualAttributeNode],
      ["getAttributeNodeNS", getVirtualAttributeNodeNS],
      ["setAttribute", setVirtualAttribute],
      ["removeAttribute", removeVirtualAttribute],
      ["removeAttributeNS", removeVirtualAttributeNS],
      ["toggleAttribute", toggleVirtualAttribute],
      ["setAttributeNS", setVirtualAttributeNS],
    ] as ReadonlyArray<
      readonly [string, (el: Element, a: never, b: never, c: never) => unknown]
    >) {
      patch(elementPrototype, name, {
        writable: true,
        value(this: Element, a: never, b: never, c: never) {
          return fn(this, a, b, c);
        },
      });
    }
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
    patch(elementPrototype, "removeAttributeNode", {
      writable: true,
      value(this: Element, attr: Attr): Attr {
        const candidate: unknown = attr;
        if (
          virtualNodes.has(this) &&
          (candidate instanceof window.Attr ||
            (hostAttrCtor !== undefined && candidate instanceof hostAttrCtor)) &&
          nativeAttrOwnerElement?.call(attr) === this
        ) {
          markVirtualAttribute!(attr);
        }
        return nativeRemoveAttributeNode.call(this, attr);
      },
    });
    const isVirtualAttr = (attr: Attr): boolean => {
      if (virtualNodes.has(attr)) {
        return true;
      }
      const owner = nativeAttrOwnerElement?.call(attr) as Element | null | undefined;
      return owner != null && virtualNodes.has(owner);
    };
    patch(window.Attr.prototype, "ownerDocument", {
      get(this: Attr): Document | null {
        if (isVirtualAttr(this)) {
          return document;
        }
        return nativeOwnerDocument?.get?.call(this) ?? null;
      },
    });
    if (context.nativeBaseURI?.get !== undefined) {
      const nativeBaseURIGetter = context.nativeBaseURI.get;
      patch(window.Attr.prototype, "baseURI", {
        get(this: Attr): string {
          if (isVirtualAttr(this)) {
            return options.getBaseURL();
          }
          return nativeBaseURIGetter.call(this) as string;
        },
      });
    }
    patch(window.Attr.prototype, "getRootNode", {
      writable: true,
      value(this: Attr, init?: GetRootNodeOptions): Node {
        if (isVirtualAttr(this)) {
          return context.virtualGetRootNode(this, init);
        }
        return context.nativeGetRootNode.call(this, init);
      },
    });
    for (const [
      prototype,
      propertyName,
      attributeName,
      nativeGet,
      nativeSet,
    ] of reflectedURLPatches) {
      const isSrcset = propertyName === "srcset";
      patch(prototype, propertyName, {
        get(this: Element): string {
          if (!virtualNodes.has(this)) return nativeGet.call(this) as string;
          return isSrcset
            ? (options.authoredURLAttributes.get(this)?.get("srcset") ?? "")
            : readVirtualURLProperty(
                this,
                propertyName as (typeof URL_PROPERTY_NAMES)[number],
                attributeName,
              );
        },
        set(this: Element, value: string) {
          if (virtualNodes.has(this)) {
            setVirtualAttribute(
              this,
              attributeName,
              isSrcset ? toDOMString(value) : toUSVString(value),
            );
            return;
          }
          nativeSet.call(this, value);
        },
      });
    }
  };

  return {
    urlPropertiesPrototypeWide,
    urlAttributeKey,
    markURLProperties,
    markSVGURLProperty,
    rememberAuthoredURLAttributes,
    rememberPhysicalURLAttribute,
    syncInitialPhysicalURLs,
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
    setAttributeMarker(mark) {
      markVirtualAttribute = mark;
    },
    installPatches,
  };
}
