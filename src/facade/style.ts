// Inline style attributes cannot survive in the shadow tree: a physical style
// attribute would be resolved against the host document's base URL, so the
// authored declarations live here instead and are re-emitted as one generated
// stylesheet keyed by a private selector attribute. The same indirection covers
// the CSSOM (element.style, cssText, setProperty) and the stylesheet link rel,
// which v-frame renames so the browser does not fetch the sheet itself.

import generateCSS from "css-tree/generator";
import parseCSS from "css-tree/parser";
import walkCSS from "css-tree/walker";
import type { DeclarationList } from "css-tree";
import { rewriteStyleAttribute } from "../css.js";
import type { FacadeContext } from "./context.js";

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
    const declarations = parseCSS(source, {
      context: "declarationList",
      parseCustomProperty: true,
    });
    walkCSS(declarations, {
      visit: "Declaration",
      enter(declaration) {
        const value = generateCSS(declaration.value);
        if (!/url\s*\(/i.test(value)) {
          return;
        }
        properties.set(stylePropertyKey(declaration.property), value);
      },
    });
  } catch {
    // The native declaration remains the source of truth for malformed CSS.
  }
  return properties;
}

function normalizeAuthoredStyleAttribute(source: string): string {
  const declarations = parseCSS(source, {
    context: "declarationList",
    parseCustomProperty: true,
  });
  return generateCSS(declarations);
}

function updateAuthoredStyleProperty(
  source: string,
  property: string,
  value: string,
  priority: string,
): string {
  const declarations = parseCSS(source, {
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
    const addition = parseCSS(
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
  return generateCSS(declarations);
}

export interface StyleFacade {
  refreshInlineStyleSheet(): void;
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
  const styleDeclarations = new WeakMap<Element, CSSStyleDeclaration>();
  const styleFacades = new WeakMap<Element, CSSStyleDeclaration>();
  const linkRelLists = new WeakMap<HTMLLinkElement, DOMTokenList>();
  const nativeLinkRelLists = new WeakMap<HTMLLinkElement, DOMTokenList>();
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
      nextStyleSelectorValue = Math.max(
        nextStyleSelectorValue,
        Number(selectorValue) + 1,
      );
    }
  }

  const nativeStyleDeclaration = (element: Element): CSSStyleDeclaration => {
    const existing = styleDeclarations.get(element);
    if (existing !== undefined) {
      return existing;
    }

    const scratch = nativeCreateElement.call(
      styleDeclarationDocument,
      "span",
    ) as HTMLElement;
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
    return nativeHTMLElementStyle?.get?.call(scratch) as CSSStyleDeclaration | undefined;
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
      if (requestedPriority !== "" && requestedPriority.toLowerCase() !== "important") {
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
      return (
        authoredStylePropertyValues(
          options.authoredStyleAttributes.get(element) ?? "",
        ).get(stylePropertyKey(propertyName)) ??
        declaration.getPropertyValue(propertyName)
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
          Array.from({ length: target.length }, (_value, index) =>
            stylePropertyKey(target.item(index)),
          ),
        );
        let logicalValue = options.authoredStyleAttributes.get(element) ?? "";
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
    value !== null &&
    value.split(/[\t\n\f\r ]+/).some((token) => token.toLowerCase() === "stylesheet");

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

  const installPatches = (): void => {
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
  };

  refreshInlineStyleSheet();
  options.shadowRoot.append(options.inlineStyleSheet);

  return {
    refreshInlineStyleSheet,
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
