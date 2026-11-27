// Inline style attributes cannot survive in the shadow tree: a physical style
// attribute would be resolved against the host document's base URL, so the
// authored declarations live here instead and are re-emitted as one generated
// stylesheet keyed by a private selector attribute. The same indirection covers
// the CSSOM (element.style, cssText, setProperty) and the stylesheet link rel,
// which v-frame renames so the browser does not fetch the sheet itself.

import {
  extractAuthoredURLDeclarations,
  normalizeDeclarationList,
  rewriteStyleAttribute,
  updateDeclarationProperty,
} from "../css.js";
import { NEUTRALIZED_STYLESHEET_REL } from "../wire-format.js";
import type { FacadeContext } from "./context.js";
import { toDOMString, toLegacyNullToEmptyString } from "./webidl.js";

const INLINE_STYLE_SELECTOR_ID_COUNT = 32;
const STYLE_URL_PATTERN = /(?:url|image-set|src)\s*\(/i;
const SIMPLE_STYLE_SELECTOR_VALUE = /^[0-9A-Za-z_-]+$/;

function mayContainStyleURL(value: string): boolean {
  return value.includes("(") && STYLE_URL_PATTERN.test(value);
}

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

const NO_AUTHORED_VALUES: ReadonlyMap<string, string> = new Map();

/**
 * Every string-valued read of `el.style.x` needs the authored values, and
 * parsing the whole attribute for each one made reading a property cost as much
 * as a write. The values are a pure function of the attribute text, so they are
 * kept per element and drop out by themselves when the text changes.
 */
export function createAuthoredValueCache(
  extract: (
    source: string,
  ) => ReadonlyMap<string, string> = extractAuthoredURLDeclarations,
) {
  const cache = new WeakMap<
    object,
    { source: string; values: ReadonlyMap<string, string> }
  >();
  return (owner: object, source: string): ReadonlyMap<string, string> => {
    const cached = cache.get(owner);
    if (cached?.source === source) {
      return cached.values;
    }
    const values = source.includes("(") ? extract(source) : NO_AUTHORED_VALUES;
    cache.set(owner, { source, values });
    return values;
  };
}

function normalizeAuthoredStyleAttribute(source: string): string {
  return normalizeDeclarationList(source);
}

function updateAuthoredStyleProperty(
  source: string,
  property: string,
  value: string,
  priority: string,
): string {
  return updateDeclarationProperty(source, property, value, priority);
}

export interface StyleFacade {
  refreshInlineStyleSheet(): void;
  updateInlineStyle(element: Element): void;
  removeStyleSelector(element: Element): void;
  ensureStyleSelector(element: Element): string;
  setLogicalStyleAttribute(element: Element, value: string, normalize: boolean): void;
  removeLogicalStyleAttribute(element: Element): void;
  styleFacade(element: Element): CSSStyleDeclaration;
  synchronizePhysicalLinkRel(link: HTMLLinkElement, hrefPresent?: boolean): void;
  setLogicalLinkRel(link: HTMLLinkElement, value: string, normalize: boolean): void;
  removeLogicalLinkRel(link: HTMLLinkElement): void;
  linkRelListFacade(link: HTMLLinkElement): DOMTokenList;
  rememberAuthoredStyleAttribute(element: Element): void;
  rememberAuthoredLinkRel(link: HTMLLinkElement): void;
  synchronizeStyleAttribute(element: Element): void;
  installPatches(): void;
}

export function installStyleFacade(context: FacadeContext): StyleFacade {
  const options = context.options;
  const {
    window,
    document,
    nativeCreateElement,
    nativeGetAttribute,
    nativeHasAttribute,
    nativeSetAttribute,
    nativeRemoveAttribute,
    nativeHTMLElementStyle,
    nativeSVGElementStyle,
    nativeLinkRel,
    nativeLinkRelList,
    virtualNodes,
    cssomMutatedStyleElements,
    authoredLinkRelValues,
    patch,
  } = context;

  const physicalStyleAttributeValues = new WeakMap<Element, string | null>();
  const styleSelectorValues = new WeakMap<Element, string>();
  const attachedStyleSelectors = new WeakSet<Element>();
  const styleDeclarations = new WeakMap<Element, CSSStyleDeclaration>();
  const styleFacades = new WeakMap<Element, CSSStyleDeclaration>();
  const linkRelLists = new WeakMap<HTMLLinkElement, DOMTokenList>();
  const nativeLinkRelLists = new WeakMap<HTMLLinkElement, DOMTokenList>();
  const linkDisabledValues = new WeakMap<HTMLLinkElement, boolean>();
  const nativeLinkSheet = Object.getOwnPropertyDescriptor(
    window.HTMLLinkElement.prototype,
    "sheet",
  );
  const nativeStyleSheet = Object.getOwnPropertyDescriptor(
    window.HTMLStyleElement.prototype,
    "sheet",
  );
  const nativeLinkDisabled = Object.getOwnPropertyDescriptor(
    window.HTMLLinkElement.prototype,
    "disabled",
  );
  const nativeLinkMedia = Object.getOwnPropertyDescriptor(
    window.HTMLLinkElement.prototype,
    "media",
  );
  const nativeLinkTitle = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "title",
  );
  const { getInertDocument } = context;

  let nextStyleSelectorValue = 0;
  const initialStyleSelectorValues = new Set<string>();
  for (const element of options.authoredStyleAttributes.keys()) {
    const selectorValue = nativeGetAttribute.call(
      element,
      options.inlineStyleSelectorAttribute,
    );
    if (selectorValue === null || initialStyleSelectorValues.has(selectorValue)) {
      continue;
    }
    styleSelectorValues.set(element, selectorValue);
    attachedStyleSelectors.add(element);
    initialStyleSelectorValues.add(selectorValue);
    if (/^\d+$/.test(selectorValue)) {
      nextStyleSelectorValue = Math.max(
        nextStyleSelectorValue,
        Number(selectorValue) + 1,
      );
    }
  }

  const authoredValues = createAuthoredValueCache();

  const nativeStyleDeclaration = (element: Element): CSSStyleDeclaration => {
    const existing = styleDeclarations.get(element);
    if (existing !== undefined) {
      return existing;
    }

    const scratch = nativeCreateElement.call(getInertDocument(), "span") as HTMLElement;
    const declaration = nativeHTMLElementStyle?.get?.call(scratch) as
      | CSSStyleDeclaration
      | undefined;
    if (declaration === undefined) {
      throw new Error(
        "The execution realm has no usable CSSStyleDeclaration implementation",
      );
    }
    const authoredStyle = options.authoredStyleAttributes.get(element) ?? "";
    declaration.cssText = authoredStyle;
    styleDeclarations.set(element, declaration);
    return declaration;
  };

  const clearPhysicalStyleAttribute = (element: Element): void => {
    if (nativeHasAttribute.call(element, "style")) {
      nativeRemoveAttribute.call(element, "style");
      physicalStyleAttributeValues.set(element, null);
    } else if (physicalStyleAttributeValues.get(element) !== null) {
      physicalStyleAttributeValues.set(element, null);
    }
  };

  const removeStyleSelector = (element: Element): void => {
    if (
      attachedStyleSelectors.has(element) ||
      nativeHasAttribute.call(element, options.inlineStyleSelectorAttribute)
    ) {
      attachedStyleSelectors.delete(element);
      nativeRemoveAttribute.call(element, options.inlineStyleSelectorAttribute);
    }
  };

  const ensureStyleSelector = (element: Element): string => {
    const existing = styleSelectorValues.get(element);
    if (existing !== undefined) {
      if (!attachedStyleSelectors.has(element)) {
        nativeSetAttribute.call(element, options.inlineStyleSelectorAttribute, existing);
        attachedStyleSelectors.add(element);
      }
      return existing;
    }

    const selectorValue = String(nextStyleSelectorValue++);
    styleSelectorValues.set(element, selectorValue);
    nativeSetAttribute.call(element, options.inlineStyleSelectorAttribute, selectorValue);
    attachedStyleSelectors.add(element);
    return selectorValue;
  };

  const inlineStyleSpecificity = `:not(${Array.from(
    { length: INLINE_STYLE_SELECTOR_ID_COUNT },
    (_value, index) => `#v-frame-inline-style-${index}`,
  ).join("")})`;
  const inlineStyleRules = new WeakMap<Element, CSSStyleRule>();
  // CSS rules do not retain their matched elements. Batch retirements in a
  // microtask so mass GC sweeps the sheet once instead of quadratically.
  let pendingDeletedRules: Set<CSSStyleRule> | undefined;
  const flushDeletedInlineStyles = (): void => {
    const doomed = pendingDeletedRules;
    pendingDeletedRules = undefined;
    const sheet = options.inlineStyleSheet.sheet;
    if (doomed === undefined || sheet === null) {
      return;
    }
    for (let index = sheet.cssRules.length - 1; index >= 0; index -= 1) {
      const candidate = sheet.cssRules[index] as CSSStyleRule | undefined;
      if (candidate !== undefined && doomed.has(candidate)) {
        sheet.deleteRule(index);
      }
    }
  };
  const collectedInlineStyles = new FinalizationRegistry<CSSStyleRule>((rule) => {
    if (pendingDeletedRules === undefined) {
      pendingDeletedRules = new Set();
      queueMicrotask(flushDeletedInlineStyles);
    }
    pendingDeletedRules.add(rule);
  });
  let appliedInlineStyleNonce: string | undefined;
  const applyInlineStyleNonce = (): void => {
    const nonce = options.getNonce();
    if (nonce === appliedInlineStyleNonce) {
      return;
    }
    appliedInlineStyleNonce = nonce;
    if (nonce === "") {
      nativeRemoveAttribute.call(options.inlineStyleSheet, "nonce");
    } else {
      nativeSetAttribute.call(options.inlineStyleSheet, "nonce", nonce);
    }
  };
  const updateInlineStyle = (element: Element): void => {
    let rewritten = "";
    const cssText = options.authoredStyleAttributes.get(element) ?? "";
    if (cssText !== "" && !cssText.includes("(")) {
      // Rewriting only rebases url(), image-set() and src() arguments, and each
      // of those needs a parenthesis; the browser parses the rest itself.
      rewritten = cssText;
    } else if (cssText !== "") {
      try {
        rewritten = rewriteStyleAttribute(cssText, options.getBaseURL());
      } catch {
        // Invalid declarations have no rendered rule, just as on a native style.
      }
    }
    applyInlineStyleNonce();
    const sheet = options.inlineStyleSheet.sheet;
    let rule = inlineStyleRules.get(element);
    if (rewritten === "") {
      removeStyleSelector(element);
      if (rule !== undefined) {
        rule.style.cssText = "";
      }
      return;
    }
    const rawSelectorValue = ensureStyleSelector(element);
    if (sheet === null) {
      return; // A CSP-blocked sheet must stay blocked.
    }
    if (rule === undefined || rule.parentStyleSheet !== sheet) {
      const selectorValue = SIMPLE_STYLE_SELECTOR_VALUE.test(rawSelectorValue)
        ? rawSelectorValue
        : window.CSS.escape(rawSelectorValue);
      const selectorHeader = `[${options.inlineStyleSelectorAttribute}="${selectorValue}"]${inlineStyleSpecificity}`;
      let index: number;
      let parsedInInsert = false;
      if (!rewritten.includes("{") && !rewritten.includes("}")) {
        try {
          index = sheet.insertRule(
            `${selectorHeader}{${rewritten}}`,
            sheet.cssRules.length,
          );
          parsedInInsert = true;
        } catch {
          index = sheet.insertRule(`${selectorHeader}{}`, sheet.cssRules.length);
        }
      } else {
        index = sheet.insertRule(`${selectorHeader}{}`, sheet.cssRules.length);
      }
      rule = sheet.cssRules[index] as CSSStyleRule;
      inlineStyleRules.set(element, rule);
      collectedInlineStyles.unregister(element);
      collectedInlineStyles.register(element, rule, element);
      if (!parsedInInsert) {
        rule.style.cssText = rewritten;
      }
      return;
    }
    rule.style.cssText = rewritten;
  };
  const syncDirectRuleUpdate = (
    element: Element,
    logicalValue: string,
    applyToRule: (ruleStyle: CSSStyleDeclaration) => void,
  ): void => {
    options.authoredStyleAttributes.set(element, logicalValue);
    cssomMutatedStyleElements.add(element);
    clearPhysicalStyleAttribute(element);
    applyInlineStyleNonce();
    const sheet = options.inlineStyleSheet.sheet;
    const rule = inlineStyleRules.get(element);
    if (
      logicalValue !== "" &&
      sheet !== null &&
      rule !== undefined &&
      rule.parentStyleSheet === sheet
    ) {
      ensureStyleSelector(element);
      applyToRule(rule.style);
      return;
    }
    updateInlineStyle(element);
  };
  const refreshInlineStyleSheet = (): void => {
    for (const element of options.authoredStyleAttributes.keys()) {
      updateInlineStyle(element);
    }
  };

  const setLogicalStyleAttribute = (
    element: Element,
    value: string,
    normalize: boolean,
  ): void => {
    const existingDeclaration = styleDeclarations.get(element);
    let logicalValue = value;
    if (normalize) {
      const declaration = existingDeclaration ?? nativeStyleDeclaration(element);
      declaration.cssText = value;
      if (!mayContainStyleURL(value)) {
        logicalValue = declaration.cssText;
      } else {
        try {
          logicalValue = normalizeAuthoredStyleAttribute(value);
        } catch {
          logicalValue = declaration.cssText;
        }
      }
      cssomMutatedStyleElements.add(element);
    } else {
      if (existingDeclaration !== undefined) {
        existingDeclaration.cssText = value;
      }
      cssomMutatedStyleElements.delete(element);
    }
    options.authoredStyleAttributes.set(element, logicalValue);
    clearPhysicalStyleAttribute(element);
    updateInlineStyle(element);
  };

  const removeLogicalStyleAttribute = (element: Element): void => {
    options.authoredStyleAttributes.delete(element);
    const declaration = styleDeclarations.get(element);
    if (declaration !== undefined) {
      declaration.cssText = "";
    }
    cssomMutatedStyleElements.delete(element);
    clearPhysicalStyleAttribute(element);
    removeStyleSelector(element);
    updateInlineStyle(element);
  };

  // One scratch declaration serves every probe; each use finishes before the
  // next begins, so it only has to start empty.
  let probeDeclaration: CSSStyleDeclaration | undefined;
  const probeStyleDeclaration = (): CSSStyleDeclaration | undefined => {
    if (probeDeclaration === undefined) {
      const scratch = nativeCreateElement.call(getInertDocument(), "span") as HTMLElement;
      probeDeclaration = nativeHTMLElementStyle?.get?.call(scratch) as
        | CSSStyleDeclaration
        | undefined;
    }
    if (probeDeclaration !== undefined) {
      probeDeclaration.cssText = "";
    }
    return probeDeclaration;
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
      clearPhysicalStyleAttribute(element);
      updateInlineStyle(element);
    };
    const setProperty = (
      property: string,
      value: string | null,
      priority?: string,
    ): void => {
      const propertyName =
        typeof property === "string" ? property : toDOMString(property);
      const nextValue =
        typeof value === "string" ? value : toLegacyNullToEmptyString(value);
      const requestedPriority =
        priority === undefined
          ? ""
          : typeof priority === "string"
            ? priority
            : toLegacyNullToEmptyString(priority);
      if (requestedPriority !== "" && requestedPriority.toLowerCase() !== "important") {
        declaration.setProperty(propertyName, nextValue, requestedPriority);
        return;
      }
      if (priority === undefined) {
        declaration.setProperty(propertyName, nextValue);
      } else {
        declaration.setProperty(propertyName, nextValue, requestedPriority);
      }
      const previousAuthored = options.authoredStyleAttributes.get(element) ?? "";
      if (!mayContainStyleURL(previousAuthored) && !mayContainStyleURL(nextValue)) {
        syncDirectRuleUpdate(element, declaration.cssText, (ruleStyle) => {
          if (priority === undefined) {
            ruleStyle.setProperty(propertyName, nextValue);
          } else {
            ruleStyle.setProperty(propertyName, nextValue, requestedPriority);
          }
        });
        return;
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
      const propertyNames = Array.from({ length: declaration.length }, (_value, index) =>
        declaration.item(index),
      );
      // item() enumerates longhands only, so an applied shorthand is detected
      // through its serialized value instead.
      const canonicalProperty =
        propertyNames.find(
          (candidate) => stylePropertyKey(candidate) === stylePropertyKey(propertyName),
        ) ??
        (declaration.getPropertyValue(propertyName) === ""
          ? undefined
          : propertyName.toLowerCase());
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
      const propertyName =
        typeof property === "string" ? property : toDOMString(property);
      const previous = declaration.removeProperty(propertyName);
      const previousAuthored = options.authoredStyleAttributes.get(element) ?? "";
      if (!mayContainStyleURL(previousAuthored)) {
        syncDirectRuleUpdate(element, declaration.cssText, (ruleStyle) => {
          ruleStyle.removeProperty(propertyName);
        });
        return previous;
      }
      let logicalValue: string;
      try {
        logicalValue = updateAuthoredStyleProperty(
          previousAuthored,
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
      const propertyName = toDOMString(property);
      if (declaration.getPropertyValue(propertyName) === "") {
        return "";
      }
      return (
        authoredValues(element, options.authoredStyleAttributes.get(element) ?? "").get(
          stylePropertyKey(propertyName),
        ) ?? declaration.getPropertyValue(propertyName)
      );
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
          const authoredValue = authoredValues(
            element,
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
          setLogicalStyleAttribute(element, toLegacyNullToEmptyString(value), true);
          return true;
        }
        let logicalValue = options.authoredStyleAttributes.get(element) ?? "";
        // CSS properties are [LegacyNullToEmptyString]: null clears, not "null".
        const assigned =
          typeof value === "string" ? value : toLegacyNullToEmptyString(value);
        if (!mayContainStyleURL(logicalValue) && !mayContainStyleURL(assigned)) {
          const updated = Reflect.set(target, property, value, target);
          if (updated) {
            syncDirectRuleUpdate(element, target.cssText, (ruleStyle) => {
              Reflect.set(ruleStyle, property, value, ruleStyle);
            });
          }
          return updated;
        }
        const previousProperties = new Set(
          Array.from({ length: target.length }, (_value, index) =>
            stylePropertyKey(target.item(index)),
          ),
        );
        const updated = Reflect.set(target, property, value, target);
        if (updated) {
          const currentProperties = new Set(
            Array.from({ length: target.length }, (_value, index) =>
              stylePropertyKey(target.item(index)),
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
          if (typeof property === "string" && assigned === "") {
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
          if (typeof property === "string" && assigned !== "") {
            const probe = probeStyleDeclaration();
            if (probe !== undefined && Reflect.set(probe, property, value, probe)) {
              const probeProperties = Array.from(
                { length: probe.length },
                (_probeValue, index) => probe.item(index),
              );
              const applied =
                probeProperties.length > 0 &&
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
                    assigned,
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
    value !== null &&
    value.split(/[\t\n\f\r ]+/).some((token) => token.toLowerCase() === "stylesheet");

  const synchronizePhysicalLinkRel = (
    link: HTMLLinkElement,
    hrefPresent = nativeHasAttribute.call(link, "href"),
  ): void => {
    const authoredRel = authoredLinkRelValues.get(link) ?? null;
    if (hrefPresent && linkRelIncludesStylesheet(authoredRel)) {
      nativeSetAttribute.call(link, "rel", NEUTRALIZED_STYLESHEET_REL);
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
    let authoredRel = value;
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
  const rememberAuthoredStyleAttribute = (element: Element): void => {
    if (
      !styleSelectorValues.has(element) &&
      nativeHasAttribute.call(element, options.inlineStyleSelectorAttribute)
    ) {
      removeStyleSelector(element);
    }

    const authoredStyle = nativeGetAttribute.call(element, "style");
    if (authoredStyle === null) {
      return;
    }
    if (!options.authoredStyleAttributes.has(element)) {
      options.authoredStyleAttributes.set(element, authoredStyle);
      const existingDeclaration = styleDeclarations.get(element);
      if (existingDeclaration !== undefined) {
        existingDeclaration.cssText = authoredStyle;
      }
    }
    clearPhysicalStyleAttribute(element);
    updateInlineStyle(element);
  };

  const rememberAuthoredLinkRel = (link: HTMLLinkElement): void => {
    if (!linkDisabledValues.has(link)) {
      linkDisabledValues.set(
        link,
        options.linkedStyles.get(link)?.disabled ??
          Boolean(nativeLinkDisabled?.get?.call(link)),
      );
    }
    const authoredRel = authoredLinkRelValues.has(link)
      ? (authoredLinkRelValues.get(link) ?? null)
      : nativeGetAttribute.call(link, "rel");
    authoredLinkRelValues.set(link, authoredRel);
    synchronizePhysicalLinkRel(link);
    options.onLinkElementChange(link, authoredRel);
  };

  function synchronizeStyleAttribute(element: Element): void {
    if (!virtualNodes.has(element)) {
      return;
    }
    const physicalValue = nativeGetAttribute.call(element, "style");
    if ((physicalStyleAttributeValues.get(element) ?? null) === physicalValue) {
      return;
    }
    if (physicalValue === null) {
      physicalStyleAttributeValues.set(element, null);
      return;
    }

    const existingDeclaration = styleDeclarations.get(element);
    if (existingDeclaration !== undefined) {
      existingDeclaration.cssText = physicalValue;
    }
    options.authoredStyleAttributes.set(element, physicalValue);
    cssomMutatedStyleElements.delete(element);
    clearPhysicalStyleAttribute(element);
    updateInlineStyle(element);
  }

  const installPatches = (): void => {
    if (nativeStyleSheet?.get !== undefined) {
      patch(window.HTMLStyleElement.prototype, "sheet", {
        get(this: HTMLStyleElement): CSSStyleSheet | null {
          if (virtualNodes.has(this)) {
            options.onStyleSheetAccess?.(this);
          }
          return nativeStyleSheet.get?.call(this) ?? null;
        },
      });
    }
    if (nativeLinkSheet?.get !== undefined) {
      patch(window.HTMLLinkElement.prototype, "sheet", {
        get(this: HTMLLinkElement): CSSStyleSheet | null {
          if (!virtualNodes.has(this)) {
            return nativeLinkSheet.get?.call(this) ?? null;
          }
          const linked = options.linkedStyles.get(this);
          if (linked !== undefined) {
            options.onStyleSheetAccess?.(linked.style);
            return linked.style.sheet;
          }
          return null;
        },
      });
    }
    if (nativeLinkDisabled?.get !== undefined && nativeLinkDisabled.set !== undefined) {
      patch(window.HTMLLinkElement.prototype, "disabled", {
        get(this: HTMLLinkElement): boolean {
          if (!virtualNodes.has(this)) {
            return nativeLinkDisabled.get?.call(this);
          }
          const value = this.sheet?.disabled ?? linkDisabledValues.get(this) ?? false;
          linkDisabledValues.set(this, value);
          return value;
        },
        set(this: HTMLLinkElement, value: boolean) {
          if (!virtualNodes.has(this)) {
            nativeLinkDisabled.set?.call(this, value);
            return;
          }
          linkDisabledValues.set(this, Boolean(value));
          const linked = options.linkedStyles.get(this);
          if (linked !== undefined) {
            // An alternate sheet stays off natively even when its link is enabled.
            const alternate = (authoredLinkRelValues.get(this) ?? "")
              .split(/[\t\n\f\r ]+/)
              .some((token) => token.toLowerCase() === "alternate");
            linked.disabled = Boolean(value) || alternate;
            linked.style.disabled = linked.disabled;
          }
          options.onLinkElementChange(this, authoredLinkRelValues.get(this) ?? null);
        },
      });
    }
    if (nativeLinkMedia?.get !== undefined && nativeLinkMedia.set !== undefined) {
      patch(window.HTMLLinkElement.prototype, "media", {
        get: nativeLinkMedia.get,
        set(this: HTMLLinkElement, value: string) {
          nativeLinkMedia.set?.call(this, value);
          if (virtualNodes.has(this)) {
            options.onLinkElementChange(this, authoredLinkRelValues.get(this) ?? null);
          }
        },
      });
    }
    if (nativeLinkTitle?.get !== undefined && nativeLinkTitle.set !== undefined) {
      patch(window.HTMLLinkElement.prototype, "title", {
        get: nativeLinkTitle.get,
        set(this: HTMLLinkElement, value: string) {
          nativeLinkTitle.set?.call(this, value);
          if (virtualNodes.has(this)) {
            options.onLinkElementChange(this, authoredLinkRelValues.get(this) ?? null);
          }
        },
      });
    }
    const patchStyleProperty = (
      prototype: object,
      nativeStyle: PropertyDescriptor | undefined,
    ): void => {
      if (nativeStyle?.get === undefined) {
        return;
      }
      patch(prototype, "style", {
        get(this: Element): CSSStyleDeclaration {
          return virtualNodes.has(this) ? styleFacade(this) : nativeStyle.get?.call(this);
        },
        set(this: Element, value: string) {
          if (virtualNodes.has(this)) {
            setLogicalStyleAttribute(this, toLegacyNullToEmptyString(value), true);
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
            setLogicalLinkRel(this, toDOMString(value), false);
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
  };

  applyInlineStyleNonce();
  options.inlineStyleSheet.textContent = "";
  options.shadowRoot.append(options.inlineStyleSheet);
  refreshInlineStyleSheet();

  return {
    refreshInlineStyleSheet,
    updateInlineStyle,
    removeStyleSelector,
    ensureStyleSelector,
    setLogicalStyleAttribute,
    removeLogicalStyleAttribute,
    styleFacade,
    synchronizePhysicalLinkRel,
    setLogicalLinkRel,
    removeLogicalLinkRel,
    linkRelListFacade,
    rememberAuthoredStyleAttribute,
    rememberAuthoredLinkRel,
    synchronizeStyleAttribute,
    installPatches,
  };
}
