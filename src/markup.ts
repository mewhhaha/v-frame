import {
  createStylesheetContext,
  fetchStylesheet,
  rewriteStyleAttribute,
  rewriteStylesheet,
  type StylesheetContext,
  type StylesheetFetch,
} from "./css.js";
import { EnumerableWeakMap } from "./enumerable-weak.js";
import type { VFrameWindow } from "./types.js";
import type { LinkedStyle } from "./linked-styles.js";
import {
  canHaveURLAttributes,
  HTML_NAMESPACE,
  isASCIIWhitespace,
  isSrcsetAttribute,
  isURLAttribute,
  rewriteAssetAttribute,
  URL_ELEMENT_SELECTOR,
  XLINK_NAMESPACE,
} from "./asset-urls.js";
import {
  FRAGMENT_TARGET_ATTRIBUTE,
  INERT_SCRIPT_TYPE,
  SCRIPT_MARKER_ATTRIBUTE,
  SCRIPT_TYPE_ATTRIBUTE,
  SSR_ATTRIBUTES,
  SSR_LINK_REL,
  SSR_LINK_INTEGRITY,
  SSR_LINK_STYLE,
  SSR_PREVIEW_ATTRIBUTES,
  SSR_STYLE,
} from "./wire-format.js";

const RAW_TEXT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  // v-frame always executes guest scripts, so noscript tokenizes as raw text
  // exactly like a scripting-enabled parser; without this, a style marker
  // inside head noscript gets popped out of it and applies as a live style.
  "noscript",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

export interface MarkupError {
  phase: "stylesheet";
  url: string;
  error: unknown;
}

export interface PrepareMarkupOptions {
  window: VFrameWindow;
  document: Document;
  source: string;
  createHTML(source: string): string;
  createScriptURL(source: string): string;
  pageURL: string;
  nonce: string;
  fetchStylesheet: StylesheetFetch;
  onError(error: MarkupError): void;
}

export interface PreparedMarkup {
  html: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  baseURL: string;
  scripts: HTMLScriptElement[];
  hasStyleElements: boolean;
  hasTargetAttribute: boolean;
  hasInlineEventCandidate: boolean;
  authoredURLAttributes: EnumerableWeakMap<Element, Map<string, string>>;
  authoredStyleAttributes: EnumerableWeakMap<Element, string>;
  inlineStyleSelectorAttribute: string;
  inlineStyleSheet: HTMLStyleElement;
  stylesheetContext: StylesheetContext;
  linkedStyles: WeakMap<HTMLLinkElement, LinkedStyle>;
}

interface NeutralizedStyleMarkup {
  source: string;
  inertStyleElementMarker: string;
  inertStyleAttribute: string;
  hasInertStyleElement: boolean;
  hasInertStyleAttribute: boolean;
}

interface NeutralizedTag {
  source: string | null;
  end: number;
  selfClosing: boolean;
  replacedStyleAttribute: boolean;
}

function isASCIIAlpha(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isRawTextEndBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    isASCIIWhitespace(character) ||
    character === "/" ||
    character === ">"
  );
}

/** Length-preserving ASCII lowercasing so string offsets match `source` even around Unicode like `İ`. */
function asciiLower(source: string): string {
  return source.replace(/[A-Z]+/g, (segment) => segment.toLowerCase());
}

function findUnusedAttributeName(lowerSource: string, purpose: string): string {
  let suffix = 0;

  while (true) {
    const candidate = `data-v-frame-${purpose}-${suffix}`;
    if (!lowerSource.includes(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

function findRawTextEnd(
  lowerSource: string,
  cursor: number,
  elementName: string,
): number {
  if (elementName === "script") {
    let pos = cursor;
    let state = 0; // 0 = data, 1 = escaped, 2 = double-escaped
    while (pos < lowerSource.length) {
      if (state === 0) {
        if (lowerSource.startsWith("<!--", pos)) {
          state = 1;
          pos += 4;
          continue;
        }
        if (
          lowerSource.startsWith("</script", pos) &&
          isRawTextEndBoundary(lowerSource[pos + 8])
        ) {
          return pos;
        }
      } else if (lowerSource.startsWith("-->", pos)) {
        state = 0;
        pos += 3;
        continue;
      } else if (
        state === 1 &&
        lowerSource.startsWith("<script", pos) &&
        isRawTextEndBoundary(lowerSource[pos + 7])
      ) {
        state = 2;
        pos += 7;
        continue;
      } else if (
        lowerSource.startsWith("</script", pos) &&
        isRawTextEndBoundary(lowerSource[pos + 8])
      ) {
        if (state === 1) return pos;
        state = 1;
        pos += 8;
        continue;
      }
      pos += 1;
    }
    return -1;
  }
  const endTagPrefix = `</${elementName}`;
  let candidate = lowerSource.indexOf(endTagPrefix, cursor);

  while (candidate !== -1) {
    if (isRawTextEndBoundary(lowerSource[candidate + endTagPrefix.length])) {
      return candidate;
    }
    candidate = lowerSource.indexOf(endTagPrefix, candidate + endTagPrefix.length);
  }

  return -1;
}

function neutralizeTag(
  source: string,
  lowerSource: string,
  tagStart: number,
  nameStart: number,
  nameEnd: number,
  styleAttributeReplacement: string | undefined,
  replacementName?: string,
  markerAttribute?: string,
): NeutralizedTag {
  let replacements: Array<{ start: number; end: number; value: string }> | undefined;
  if (replacementName !== undefined) {
    (replacements ??= []).push({
      start: nameStart,
      end: nameEnd,
      value: replacementName,
    });
  }
  if (markerAttribute !== undefined) {
    (replacements ??= []).push({
      start: nameEnd,
      end: nameEnd,
      value: ` ${markerAttribute}`,
    });
  }

  let cursor = nameEnd;
  let selfClosing = false;
  let replacedStyleAttribute = false;
  while (cursor < source.length) {
    while (isASCIIWhitespace(source[cursor])) {
      cursor += 1;
    }

    if (source[cursor] === ">") {
      cursor += 1;
      break;
    }
    if (source[cursor] === "/") {
      selfClosing = true;
      cursor += 1;
      continue;
    }
    selfClosing = false;

    const attributeStart = cursor;
    while (
      cursor < source.length &&
      !isASCIIWhitespace(source[cursor]) &&
      source[cursor] !== "/" &&
      source[cursor] !== ">" &&
      source[cursor] !== "="
    ) {
      cursor += 1;
    }
    const attributeEnd = cursor;
    if (
      styleAttributeReplacement !== undefined &&
      attributeEnd - attributeStart === 5 &&
      lowerSource.startsWith("style", attributeStart)
    ) {
      (replacements ??= []).push({
        start: attributeStart,
        end: attributeEnd,
        value: styleAttributeReplacement,
      });
      replacedStyleAttribute = true;
    }

    while (isASCIIWhitespace(source[cursor])) {
      cursor += 1;
    }
    if (source[cursor] !== "=") {
      continue;
    }

    cursor += 1;
    while (isASCIIWhitespace(source[cursor])) {
      cursor += 1;
    }
    const quote = source[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const closingQuote = source.indexOf(quote, cursor);
      cursor = closingQuote === -1 ? source.length : closingQuote + 1;
      continue;
    }
    while (
      cursor < source.length &&
      !isASCIIWhitespace(source[cursor]) &&
      source[cursor] !== ">"
    ) {
      cursor += 1;
    }
  }

  if (replacements === undefined) {
    return { source: null, end: cursor, selfClosing, replacedStyleAttribute: false };
  }

  let rewritten = "";
  let copiedThrough = tagStart;
  for (const replacement of replacements) {
    rewritten += source.slice(copiedThrough, replacement.start);
    rewritten += replacement.value;
    copiedThrough = replacement.end;
  }
  rewritten += source.slice(copiedThrough, cursor);
  return { source: rewritten, end: cursor, selfClosing, replacedStyleAttribute };
}

function neutralizeStyleMarkup(
  source: string,
  lowerSource: string,
): NeutralizedStyleMarkup {
  const inertStyleElementMarker = findUnusedAttributeName(
    lowerSource,
    "inert-style-element",
  );
  const inertStyleAttribute = findUnusedAttributeName(
    lowerSource,
    "inert-style-attribute",
  );
  let nextStyle = lowerSource.indexOf("style");
  if (nextStyle === -1) {
    return {
      source,
      inertStyleElementMarker,
      inertStyleAttribute,
      hasInertStyleElement: false,
      hasInertStyleAttribute: false,
    };
  }

  const rewritten: string[] = [];
  let copiedThrough = 0;
  let cursor = 0;
  let rawTextElement: string | undefined;
  let closesStyleElement = false;
  let foreignDepth = 0;
  const foreignStack: string[] = [];
  let hasInertStyleElement = false;
  let hasInertStyleAttribute = false;

  while (cursor < source.length) {
    if (rawTextElement !== undefined) {
      if (rawTextElement === "plaintext") {
        break;
      }

      const rawTextEnd = findRawTextEnd(lowerSource, cursor, rawTextElement);
      const contentEnd = rawTextEnd === -1 ? source.length : rawTextEnd;
      if (rawTextElement === "style") {
        const content = source.slice(cursor, contentEnd);
        if (content.includes("&") || content.includes("<")) {
          rewritten.push(
            source.slice(copiedThrough, cursor),
            // Template contents use the data state, so protect raw CSS from tag and entity parsing.
            content.replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
          );
          copiedThrough = contentEnd;
        }
      }
      if (rawTextEnd === -1) {
        break;
      }
      cursor = rawTextEnd;
      closesStyleElement = rawTextElement === "style";
      rawTextElement = undefined;
      continue;
    }

    if (nextStyle !== -1 && nextStyle < cursor) {
      nextStyle = lowerSource.indexOf("style", cursor);
    }
    if (nextStyle === -1) {
      break;
    }

    const tagStart = source.indexOf("<", cursor);
    if (tagStart === -1) {
      break;
    }

    if (source.startsWith("<!--", tagStart)) {
      let end: number;
      if (source.startsWith("<!-->", tagStart)) end = tagStart + 5;
      else if (source.startsWith("<!--->", tagStart)) end = tagStart + 6;
      else {
        const commentEnd = source.indexOf("-->", tagStart + 4);
        end = commentEnd === -1 ? source.length : commentEnd + 3;
      }
      cursor = end;
      continue;
    }
    if (foreignDepth > 0 && source.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = source.indexOf("]]>", tagStart + 9);
      cursor = cdataEnd === -1 ? source.length : cdataEnd + 3;
      continue;
    }
    if (source[tagStart + 1] === "!" || source[tagStart + 1] === "?") {
      const declarationEnd = source.indexOf(">", tagStart + 2);
      cursor = declarationEnd === -1 ? source.length : declarationEnd + 1;
      continue;
    }

    const isEndTag = source[tagStart + 1] === "/";
    const nameStart = tagStart + (isEndTag ? 2 : 1);
    if (!isASCIIAlpha(source[nameStart])) {
      cursor = tagStart + 1;
      continue;
    }

    let nameEnd = nameStart + 1;
    while (
      nameEnd < source.length &&
      !isASCIIWhitespace(source[nameEnd]) &&
      source[nameEnd] !== "/" &&
      source[nameEnd] !== ">"
    ) {
      nameEnd += 1;
    }
    const elementName = lowerSource.slice(nameStart, nameEnd);
    const isStyleElement = elementName === "style";
    const rewriteAsTemplate = isStyleElement && (!isEndTag || closesStyleElement);
    const tag = neutralizeTag(
      source,
      lowerSource,
      tagStart,
      nameStart,
      nameEnd,
      isEndTag ? undefined : inertStyleAttribute,
      rewriteAsTemplate ? "template" : undefined,
      isStyleElement && !isEndTag ? inertStyleElementMarker : undefined,
    );
    if (tag.source !== null) {
      rewritten.push(source.slice(copiedThrough, tagStart), tag.source);
      copiedThrough = tag.end;
      if (isStyleElement && !isEndTag) hasInertStyleElement = true;
      if (tag.replacedStyleAttribute) hasInertStyleAttribute = true;
    }
    cursor = tag.end;
    closesStyleElement = false;

    const inForeign = foreignDepth > 0;
    if (!isEndTag) {
      if ((elementName === "svg" || elementName === "math") && !tag.selfClosing) {
        foreignStack.push(elementName);
        foreignDepth += 1;
      }
      if (
        !(inForeign && tag.selfClosing) &&
        (RAW_TEXT_ELEMENTS.has(elementName) ||
          (!inForeign && elementName === "plaintext"))
      ) {
        rawTextElement = elementName;
      }
    } else if (
      foreignStack.length > 0 &&
      foreignStack[foreignStack.length - 1] === elementName
    ) {
      foreignStack.pop();
      foreignDepth -= 1;
    }
  }

  if (copiedThrough === 0) {
    return {
      source,
      inertStyleElementMarker,
      inertStyleAttribute,
      hasInertStyleElement,
      hasInertStyleAttribute,
    };
  }
  rewritten.push(source.slice(copiedThrough));
  return {
    source: rewritten.join(""),
    inertStyleElementMarker,
    inertStyleAttribute,
    hasInertStyleElement,
    hasInertStyleAttribute,
  };
}

function collectTargetedElements(
  root: Element | DocumentFragment,
  selector: string,
  out: Element[],
  hasTemplates: boolean,
  skipTemplate?: (template: HTMLTemplateElement) => boolean,
): void {
  if (root.nodeType === 1 && (root as Element).matches(selector)) {
    out.push(root as Element);
  }
  for (const element of root.querySelectorAll(selector)) {
    out.push(element);
  }
  if (!hasTemplates) return;
  for (const element of root.querySelectorAll("template")) {
    if (element.namespaceURI !== HTML_NAMESPACE) continue;
    const template = element as HTMLTemplateElement;
    if (skipTemplate?.(template) === true) continue;
    collectTargetedElements(template.content, selector, out, true, skipTemplate);
  }
}

function restoreStyleMarkup(
  root: Element,
  inertStyleElementMarker: string,
  inertStyleAttribute: string,
  hasInertStyleElement: boolean,
  hasInertStyleAttribute: boolean,
  hasTemplates: boolean,
): Map<Element, string> {
  const authoredStyleAttributes = new Map<Element, string>();
  if (!hasInertStyleElement && !hasInertStyleAttribute) {
    return authoredStyleAttributes;
  }

  const skipInertStyleTemplate = (template: HTMLTemplateElement): boolean =>
    hasInertStyleElement && template.hasAttribute(inertStyleElementMarker);

  if (hasInertStyleAttribute) {
    const styledElements: Element[] = [];
    collectTargetedElements(
      root,
      `[${inertStyleAttribute}]`,
      styledElements,
      hasTemplates,
      skipInertStyleTemplate,
    );
    for (const element of styledElements) {
      const authoredStyle = element.getAttribute(inertStyleAttribute);
      if (authoredStyle === null) continue;
      authoredStyleAttributes.set(element, authoredStyle);
      element.removeAttribute(inertStyleAttribute);
    }
  }

  if (hasInertStyleElement) {
    const markerElements: Element[] = [];
    collectTargetedElements(
      root,
      `[${inertStyleElementMarker}]`,
      markerElements,
      hasTemplates,
      skipInertStyleTemplate,
    );
    for (const element of markerElements) {
      const style = element.ownerDocument.createElementNS(
        element.namespaceURI ?? HTML_NAMESPACE,
        "style",
      );
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name !== inertStyleElementMarker) {
          style.setAttribute(attribute.name, attribute.value);
        }
      }

      const children =
        element.namespaceURI === HTML_NAMESPACE && element.localName === "template"
          ? Array.from((element as HTMLTemplateElement).content.childNodes)
          : Array.from(element.childNodes);
      style.append(...children);
      element.replaceWith(style);

      const authoredStyle = authoredStyleAttributes.get(element);
      if (authoredStyle !== undefined) {
        authoredStyleAttributes.delete(element);
        authoredStyleAttributes.set(style, authoredStyle);
      }
    }
  }

  return authoredStyleAttributes;
}

/**
 * Tags every element whose authored style yields a rule with its selector
 * attribute. The rule text is deliberately not generated here: the facade owns
 * the live sheet, wipes any text this sheet carries and rebuilds each rule from
 * the authored value, so only the attribute values it adopts are load-bearing.
 */
function lowerStyleAttributes(
  authoredStyleAttributes: EnumerableWeakMap<Element, string>,
  baseURL: string,
  selectorAttribute: string,
  document: Document,
): HTMLStyleElement {
  let selectors = 0;

  for (const [element, authoredStyle] of authoredStyleAttributes) {
    try {
      if (rewriteStyleAttribute(authoredStyle, baseURL) === "") {
        continue;
      }

      element.setAttribute(selectorAttribute, String(selectors));
      selectors += 1;
    } catch {
      continue;
    }
  }

  const style = document.createElement("style");
  style.dataset.vFrameInlineStyles = "";
  return style;
}

function resolveMarkupBaseURL(
  root: Element,
  fallbackURL: string,
  lowerSource: string,
): string {
  if (!lowerSource.includes("<base")) {
    return fallbackURL;
  }
  for (const base of root.querySelectorAll("base[href]")) {
    if (base.namespaceURI !== HTML_NAMESPACE) continue;
    const resolvedBase = URL.parse(base.getAttribute("href") ?? "", fallbackURL);
    if (resolvedBase !== null) {
      return resolvedBase.href;
    }
  }

  return fallbackURL;
}

const URL_ATTRIBUTE_NAMES = [
  "href",
  "src",
  "srcset",
  "imagesrcset",
  "action",
  "formaction",
  "poster",
  "cite",
] as const;

function urlCandidateSelectorFor(
  lowerSource: string,
  restoredAttributes: boolean,
): string | null {
  if (restoredAttributes || lowerSource.includes(":href")) {
    return URL_ELEMENT_SELECTOR;
  }
  const selectors: string[] = [];
  for (const name of URL_ATTRIBUTE_NAMES) {
    if (lowerSource.includes(name)) {
      selectors.push(`[${name}]`);
    }
  }
  if (lowerSource.includes("<object")) {
    selectors.push("object[data]");
  }
  return selectors.length === 0 ? null : selectors.join(",");
}

function collectAndAbsolutizeURLAttributes(
  root: Element,
  lowerSource: string,
  restoredAttributes: boolean,
  pageURL: string,
  baseURL: string,
  createScriptURL: PrepareMarkupOptions["createScriptURL"],
): EnumerableWeakMap<Element, Map<string, string>> {
  const authoredURLAttributes = new EnumerableWeakMap<Element, Map<string, string>>();
  const selector = urlCandidateSelectorFor(lowerSource, restoredAttributes);
  if (selector === null) {
    return authoredURLAttributes;
  }

  for (const element of root.querySelectorAll(selector)) {
    if (!canHaveURLAttributes(element)) continue;
    const attrs = element.attributes;
    const attrCount = attrs.length;
    if (attrCount === 0) continue;
    const attributeBaseURL =
      element.localName === "base" && element.namespaceURI === HTML_NAMESPACE
        ? pageURL
        : baseURL;
    let authoredAttributes: Map<string, string> | undefined;
    for (let index = 0; index < attrCount; index += 1) {
      const attribute = attrs[index]!;
      const localName = attribute.localName;
      const namespaceURI = attribute.namespaceURI;
      if (
        !isURLAttribute(element, localName, namespaceURI) &&
        !isSrcsetAttribute(element, localName, namespaceURI)
      ) {
        continue;
      }
      const value = attribute.value;
      if (authoredAttributes === undefined) {
        authoredAttributes = new Map();
        authoredURLAttributes.set(element, authoredAttributes);
      }
      authoredAttributes.set(attribute.name, value);
      const rewritten = rewriteAssetAttribute(
        element,
        localName,
        namespaceURI,
        value,
        attributeBaseURL,
      );
      if (rewritten === null) continue;
      if (namespaceURI === null) {
        element.setAttribute(
          attribute.name,
          element.localName === "script" && localName === "src"
            ? createScriptURL(rewritten)
            : rewritten,
        );
      } else {
        element.setAttributeNS(namespaceURI, attribute.name, rewritten);
      }
    }
  }

  return authoredURLAttributes;
}

function copyAttributes(from: Element, to: Element): void {
  for (const attribute of from.attributes) {
    to.setAttribute(attribute.name, attribute.value);
  }
}

function absolutizePhysicalStyleAttributes(
  authoredStyleAttributes: EnumerableWeakMap<Element, string>,
  baseURL: string,
): void {
  for (const [element, value] of authoredStyleAttributes) {
    try {
      const rewritten = rewriteAssetAttribute(element, "style", null, value, baseURL);
      if (rewritten !== null) {
        element.setAttribute("style", rewritten);
      }
    } catch {
      // A style attribute the CSS parser rejects is dropped rather than left
      // to resolve its url()s against the host page.
      element.removeAttribute("style");
    }
  }
}

function createGeneratedStyle(
  document: Document,
  cssText: string,
  nonce: string,
  sourceURL?: string,
): HTMLStyleElement {
  const style = document.createElement("style");
  if (nonce !== "") {
    style.nonce = nonce;
  }
  if (sourceURL !== undefined) {
    style.dataset.vFrameSource = sourceURL;
  }
  style.textContent = cssText;
  return style;
}

async function prepareInlineStyle(
  style: HTMLStyleElement,
  baseURL: string,
  nonce: string,
  context: StylesheetContext,
  onError: PrepareMarkupOptions["onError"],
): Promise<void> {
  const source = style.textContent ?? "";

  try {
    style.textContent = await rewriteStylesheet(source, baseURL, context);
    if (nonce === "") {
      style.removeAttribute("nonce");
    } else {
      style.nonce = nonce;
    }
  } catch (error) {
    style.textContent = "";
    onError({ phase: "stylesheet", url: baseURL, error });
  }
}

async function prepareLinkedStyle(
  link: HTMLLinkElement,
  nonce: string,
  context: StylesheetContext,
  document: Document,
  linkedStyles: WeakMap<HTMLLinkElement, LinkedStyle>,
  onError: PrepareMarkupOptions["onError"],
): Promise<void> {
  const href = link.href;
  const integrity = link.integrity.trim();
  // An alternate sheet is not applied until the guest selects it.
  const disabled = link.disabled || link.relList.contains("alternate");

  try {
    const materialized = link.nextElementSibling;
    if (
      materialized?.localName === "style" &&
      materialized.hasAttribute(SSR_LINK_STYLE)
    ) {
      const style = materialized as HTMLStyleElement;
      if (integrity === "" || style.getAttribute(SSR_LINK_INTEGRITY) === integrity) {
        style.removeAttribute(SSR_LINK_STYLE);
        style.removeAttribute(SSR_LINK_INTEGRITY);
        style.media = link.media;
        style.disabled = disabled;
        if (nonce) style.nonce = nonce;
        else style.removeAttribute("nonce");
        linkedStyles.set(link, {
          style,
          href,
          integrity,
          url: style.dataset.vFrameSource ?? href,
          disabled,
        });
        return;
      }
      style.remove();
    }
    const source = await fetchStylesheet(href, context, integrity, {
      crossOrigin: link.getAttribute("crossorigin"),
      referrerPolicy: link.referrerPolicy as ReferrerPolicy | "",
    });
    const rewritten = await rewriteStylesheet(source.text, source.url, context);
    const style = createGeneratedStyle(document, rewritten, nonce, source.url);
    style.media = link.media;
    style.disabled = disabled;
    if (link.hasAttribute("title")) {
      style.title = link.title;
    }
    linkedStyles.set(link, { style, href, integrity, url: source.url, disabled });
    link.after(style);
  } catch (error) {
    onError({ phase: "stylesheet", url: href, error });
  }
}

// v-frame always executes guest scripts, so noscript content must stay the
// inert text a scripting-enabled parser produces. DOMParser parses with
// scripting disabled and would otherwise yield live elements whose styles
// and resources load. Text-only noscript (already inert) is left untouched
// because serializing it again would escape its markup a second time.
function neutralizeNoscriptContent(root: Element, lowerSource: string): void {
  if (!lowerSource.includes("<noscript")) return;
  for (const noscript of root.querySelectorAll("noscript")) {
    if (noscript.firstElementChild === null) {
      continue;
    }
    noscript.textContent = noscript.innerHTML;
  }
}

const INLINE_EVENT_CANDIDATE_PATTERN = /[\t\n\f\r /"']on[a-z]/;

interface MarkupParts {
  html: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  baseURL: string;
  lowerSource: string;
  restoredAttributes: boolean;
  authoredStyleAttributes: EnumerableWeakMap<Element, string>;
  rewriteInlineStyles: boolean;
  hasPhysicalStyleAttributes: boolean;
}

/** What parsed and adopted markup share once their tree and authored values exist. */
async function finishMarkup(
  options: PrepareMarkupOptions,
  parts: MarkupParts,
): Promise<PreparedMarkup> {
  const {
    html,
    head,
    body,
    baseURL,
    lowerSource,
    restoredAttributes,
    authoredStyleAttributes,
  } = parts;
  const inlineStyleSelectorAttribute = findUnusedAttributeName(
    lowerSource,
    "inline-style",
  );
  const inlineStyleSheet = lowerStyleAttributes(
    authoredStyleAttributes,
    baseURL,
    inlineStyleSelectorAttribute,
    options.document,
  );
  const authoredURLAttributes = collectAndAbsolutizeURLAttributes(
    html,
    lowerSource,
    restoredAttributes,
    options.pageURL,
    baseURL,
    options.createScriptURL,
  );
  if (parts.hasPhysicalStyleAttributes) {
    absolutizePhysicalStyleAttributes(authoredStyleAttributes, baseURL);
  }

  const stylesheetContext = createStylesheetContext(
    options.fetchStylesheet,
    ({ url, error }) => options.onError({ phase: "stylesheet", url, error }),
  );
  const stylesheetJobs: Promise<void>[] = [];
  const linkedStyles = new WeakMap<HTMLLinkElement, LinkedStyle>();
  const mayHaveStyles = lowerSource.includes("<style");
  const mayHaveLinks = lowerSource.includes("<link");

  if (mayHaveStyles) {
    for (const style of html.querySelectorAll("style")) {
      // A server vouches for the styles it materialized; every other guest style
      // (all of them, in a fetched document) still resolves against the host
      // page until rewritten here. A linked preview is prepared with its link.
      const materialized = style.hasAttribute(SSR_STYLE);
      style.removeAttribute(SSR_STYLE);
      if (
        !parts.rewriteInlineStyles &&
        (materialized || style.hasAttribute(SSR_LINK_STYLE))
      ) {
        continue;
      }
      stylesheetJobs.push(
        prepareInlineStyle(
          style,
          baseURL,
          options.nonce,
          stylesheetContext,
          options.onError,
        ),
      );
    }
  }

  let hasLinkedStyles = false;
  if (mayHaveLinks) {
    for (const link of html.querySelectorAll<HTMLLinkElement>(
      'link[rel~="stylesheet" i][href]',
    )) {
      if (link.namespaceURI !== HTML_NAMESPACE) continue;
      hasLinkedStyles = true;
      stylesheetJobs.push(
        prepareLinkedStyle(
          link,
          options.nonce,
          stylesheetContext,
          options.document,
          linkedStyles,
          options.onError,
        ),
      );
    }
  }

  await Promise.all(stylesheetJobs);

  return {
    html,
    head,
    body,
    baseURL,
    scripts: lowerSource.includes("<script")
      ? Array.from(html.querySelectorAll("script"))
      : [],
    hasStyleElements: mayHaveStyles || hasLinkedStyles,
    hasTargetAttribute: lowerSource.includes(FRAGMENT_TARGET_ATTRIBUTE),
    hasInlineEventCandidate:
      restoredAttributes || INLINE_EVENT_CANDIDATE_PATTERN.test(lowerSource),
    authoredURLAttributes,
    authoredStyleAttributes,
    inlineStyleSelectorAttribute,
    inlineStyleSheet,
    stylesheetContext,
    linkedStyles,
  };
}

export async function prepareMarkup(
  options: PrepareMarkupOptions,
): Promise<PreparedMarkup> {
  const parser = new options.window.DOMParser();
  const initialLowerSource = asciiLower(options.source);
  const neutralized = neutralizeStyleMarkup(options.source, initialLowerSource);
  const trustedHTML = options.createHTML(neutralized.source);
  const trustedString = String(trustedHTML);
  const policyRewrote = trustedString !== neutralized.source;
  const lowerSource = policyRewrote ? asciiLower(trustedString) : initialLowerSource;
  const hasTemplates = lowerSource.includes("<template");
  const parsed = parser.parseFromString(trustedHTML, "text/html");
  const parsedRoot = parsed.documentElement;
  const parsedHead = parsed.head;
  const parsedBody = parsed.body;

  // Chromium enforces the host CSP on nodes connected to a DOMParser-created document.
  parsedRoot.remove();
  const parsedStyleAttributes = restoreStyleMarkup(
    parsedRoot,
    neutralized.inertStyleElementMarker,
    neutralized.inertStyleAttribute,
    neutralized.hasInertStyleElement,
    neutralized.hasInertStyleAttribute,
    hasTemplates,
  );
  if (policyRewrote && lowerSource.includes("style")) {
    const policyStyled: Element[] = [];
    collectTargetedElements(parsedRoot, "[style]", policyStyled, hasTemplates);
    for (const element of policyStyled) {
      const physicalStyle = element.getAttribute("style");
      if (physicalStyle !== null) {
        parsedStyleAttributes.set(element, physicalStyle);
        element.removeAttribute("style");
      }
    }
  }

  restoreNestedFrames(parsedRoot, hasTemplates, parsedStyleAttributes);
  const baseURL = resolveMarkupBaseURL(parsedRoot, options.pageURL, lowerSource);
  // Moving images into the iframe document can start fetching even while
  // detached. Keep the tree inert until finishMarkup rebases the URLs.
  const html = parsed.createElement("v-html");
  const head = parsed.createElement("v-head");
  const body = parsed.createElement("v-body");

  copyAttributes(parsedRoot, html);
  copyAttributes(parsedHead, head);
  copyAttributes(parsedBody, body);
  head.append(...Array.from(parsedHead.childNodes));
  body.append(...Array.from(parsedBody.childNodes));
  html.append(head, body);

  neutralizeNoscriptContent(html, lowerSource);
  const authoredStyleAttributes = new EnumerableWeakMap<Element, string>();
  for (const [element, authoredStyle] of parsedStyleAttributes) {
    const reconstructedElement =
      element === parsedRoot
        ? html
        : element === parsedHead
          ? head
          : element === parsedBody
            ? body
            : element;
    authoredStyleAttributes.set(reconstructedElement, authoredStyle);
  }
  return finishMarkup(options, {
    html,
    head,
    body,
    baseURL,
    lowerSource,
    restoredAttributes: false,
    authoredStyleAttributes,
    rewriteInlineStyles: true,
    hasPhysicalStyleAttributes: false,
  });
}

const PREVIEW_RESTORE_NAMES = new Set([
  "href",
  "xlink:href",
  "aria-disabled",
  "role",
  "readonly",
  "method",
  "formmethod",
]);

function canRestoreAuthoredAttribute(
  element: Element,
  marker: string,
  name: string,
): boolean {
  const lower = name.toLowerCase();
  if (marker === SSR_PREVIEW_ATTRIBUTES) {
    return lower.startsWith("on") || PREVIEW_RESTORE_NAMES.has(lower);
  }
  const prefixed = lower.startsWith("xlink:");
  const local = prefixed ? lower.slice(6) : lower;
  const ns = prefixed ? XLINK_NAMESPACE : null;
  return (
    (ns === null && local === "style") ||
    isURLAttribute(element, local, ns) ||
    isSrcsetAttribute(element, local, ns)
  );
}

function restoreAuthoredAttributes(element: Element, marker: string): void {
  const provenance = element.getAttribute(marker);
  if (provenance === null) return;
  element.removeAttribute(marker);
  let authored: unknown;
  try {
    authored = JSON.parse(provenance);
  } catch {
    return;
  }
  if (authored === null || typeof authored !== "object") return;
  // Older materializers put values in the JSON marker itself. New ones let the
  // HTML parser decode the values as ordinary attributes before restoring them.
  let attributes: [string, string | null][];
  if (Array.isArray(authored)) {
    attributes = [];
    for (let index = 0; index < authored.length; index += 1) {
      const name = authored[index];
      const valueAttribute = `${marker}-${index}`;
      const value = element.getAttribute(valueAttribute);
      element.removeAttribute(valueAttribute);
      if (typeof name === "string") attributes.push([name, value]);
    }
  } else {
    attributes = Object.entries(authored as Record<string, string | null>);
  }
  for (const [name, value] of attributes) {
    if (!canRestoreAuthoredAttribute(element, marker, name)) continue;
    try {
      if (value === null) element.removeAttribute(name);
      else if (typeof value === "string") {
        if (name.startsWith("xlink:"))
          element.setAttributeNS(XLINK_NAMESPACE, name, value);
        else element.setAttribute(name, value);
      }
    } catch {
      // Ignore malformed attribute names in provenance metadata.
    }
  }
}

function transferNestedFrameStyles(
  root: DocumentFragment,
  styles: Map<Element, string>,
): void {
  const stack: Array<Element | DocumentFragment> = [root];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    for (
      let child = current.firstElementChild;
      child !== null;
      child = child.nextElementSibling
    ) {
      const style = styles.get(child);
      if (style !== undefined) {
        child.setAttribute("style", style);
        styles.delete(child);
        if (styles.size === 0) return;
      }
      if (child.firstElementChild !== null) {
        stack.push(child);
      }
      if (child.namespaceURI === HTML_NAMESPACE && child.localName === "template") {
        stack.push((child as HTMLTemplateElement).content);
      }
    }
  }
}

function restoreNestedFrames(
  root: Element,
  hasTemplates: boolean,
  styles?: Map<Element, string>,
): void {
  if (!hasTemplates) return;
  const templates: Element[] = [];
  collectTargetedElements(root, "template", templates, true);
  if (templates.length === 0) return;
  const shadowHosts = new WeakSet<Element>();
  for (const element of templates) {
    if (element.namespaceURI !== HTML_NAMESPACE || element.localName !== "template") {
      continue;
    }

    const template = element as HTMLTemplateElement;
    const host = template.parentElement;
    const mode = template.getAttribute("shadowrootmode");
    if (
      host === null ||
      host.namespaceURI !== HTML_NAMESPACE ||
      host.localName !== "v-frame" ||
      shadowHosts.has(host) ||
      mode !== "open"
    ) {
      continue;
    }

    // The fetched-document parser moved inline styles into a side table for CSP.
    // Give the nested guest its own styles back before handing it the preview.
    if (styles?.size) {
      transferNestedFrameStyles(template.content, styles);
    }
    const shadowRoot = host.attachShadow({
      mode,
      clonable: template.hasAttribute("shadowrootclonable"),
      delegatesFocus: template.hasAttribute("shadowrootdelegatesfocus"),
      serializable: template.hasAttribute("shadowrootserializable"),
    });
    shadowHosts.add(host);
    shadowRoot.append(template.content);
    template.remove();
  }
}

export async function prepareAdoptedMarkup(
  options: PrepareMarkupOptions,
): Promise<PreparedMarkup> {
  const parser = new options.window.DOMParser();
  const trustedHTML = options.createHTML(options.source);
  const lowerSource = asciiLower(String(trustedHTML));
  const hasTemplates = lowerSource.includes("<template");
  const parsed = parser.parseFromString(trustedHTML, "text/html");
  const html = parsed.body.querySelector(":scope > v-html") as HTMLElement | null;
  const head = html?.querySelector(":scope > v-head") as HTMLElement | null;
  const body = html?.querySelector(":scope > v-body") as HTMLElement | null;
  if (html === null || head === null || body === null) {
    throw new TypeError(
      "v-frame adopted content must contain v-html with direct v-head and v-body children",
    );
  }
  html.remove();
  let restoredAttributes = false;
  const ssrSelector = `[${SSR_ATTRIBUTES}],[${SSR_LINK_REL}]`;
  const restoreSsrElement = (element: Element): void => {
    restoredAttributes = true;
    restoreAuthoredAttributes(element, SSR_ATTRIBUTES);
    const rel = element.getAttribute(SSR_LINK_REL);
    if (element.localName === "link" && rel !== null) {
      element.setAttribute("rel", rel);
      element.removeAttribute(SSR_LINK_REL);
    }
  };
  if (html.matches(ssrSelector)) restoreSsrElement(html);
  for (const element of html.querySelectorAll(ssrSelector)) {
    restoreSsrElement(element);
  }
  restoreNestedFrames(html, hasTemplates);

  // Nested adopting shadows have already been moved out of this traversal.
  // Ordinary templates are owned by this guest even though their contents are inert.
  if (lowerSource.includes(SSR_PREVIEW_ATTRIBUTES)) {
    const previewTargets: Element[] = [];
    collectTargetedElements(
      html,
      `[${SSR_PREVIEW_ATTRIBUTES}]`,
      previewTargets,
      hasTemplates,
    );
    if (previewTargets.length > 0) {
      restoredAttributes = true;
    }
    for (const element of previewTargets) {
      restoreAuthoredAttributes(element, SSR_PREVIEW_ATTRIBUTES);
    }
  }

  if (lowerSource.includes(SCRIPT_MARKER_ATTRIBUTE)) {
    for (const script of html.querySelectorAll<HTMLScriptElement>(
      `script[${SCRIPT_MARKER_ATTRIBUTE}]`,
    )) {
      if (script.getAttribute("type") !== INERT_SCRIPT_TYPE) {
        continue;
      }
      const authoredType = script.getAttribute(SCRIPT_TYPE_ATTRIBUTE);
      script.removeAttribute(SCRIPT_MARKER_ATTRIBUTE);
      script.removeAttribute(SCRIPT_TYPE_ATTRIBUTE);
      if (authoredType === null) {
        script.removeAttribute("type");
      } else {
        script.type = authoredType;
      }
    }
  }

  neutralizeNoscriptContent(html, lowerSource);
  const baseURL = resolveMarkupBaseURL(html, options.pageURL, lowerSource);
  const authoredStyleAttributes = new EnumerableWeakMap<Element, string>();
  if (restoredAttributes || lowerSource.includes("style")) {
    const rootStyle = html.getAttribute("style");
    if (rootStyle !== null) {
      authoredStyleAttributes.set(html, rootStyle);
    }
    for (const element of html.querySelectorAll("[style]")) {
      const authoredStyle = element.getAttribute("style");
      if (authoredStyle !== null) {
        authoredStyleAttributes.set(element, authoredStyle);
      }
    }
  }
  return finishMarkup(options, {
    html,
    head,
    body,
    baseURL,
    lowerSource,
    restoredAttributes,
    authoredStyleAttributes,
    // Server-materialized style elements arrive already rebased and marked;
    // those it could not materialize are rewritten like a fetched document's.
    rewriteInlineStyles: false,
    hasPhysicalStyleAttributes: true,
  });
}
