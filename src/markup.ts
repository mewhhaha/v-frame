import {
  createStylesheetContext,
  fetchStylesheet,
  normalizeCrossOrigin,
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

export const MARKUP_FLAG_STYLES = 1;
export const MARKUP_FLAG_LINKS = 2;
export const MARKUP_FLAG_SVG = 4;
export const MARKUP_FLAG_TEMPLATES = 8;
export const MARKUP_FLAG_TARGET = 16;
export const MARKUP_FLAG_INLINE_EVENTS = 32;
export const MARKUP_FLAG_BASE = 64;

export interface PreparedMarkup {
  html: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  baseURL: string;
  scripts: HTMLScriptElement[];
  styles: HTMLStyleElement[];
  links: HTMLLinkElement[];
  bases: HTMLElement[];
  flags: number;
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
        const standardEnd = source.indexOf("-->", tagStart + 4);
        const bangEnd = source.indexOf("--!>", tagStart + 4);
        if (standardEnd === -1 && bangEnd === -1) {
          end = source.length;
        } else if (bangEnd !== -1 && (standardEnd === -1 || bangEnd < standardEnd)) {
          end = bangEnd + 4;
        } else {
          end = standardEnd + 3;
        }
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

  if (copiedThrough > 0) {
    rewritten.push(source.slice(copiedThrough));
    source = rewritten.join("");
  }
  return {
    source,
    inertStyleElementMarker,
    inertStyleAttribute,
    hasInertStyleElement,
    hasInertStyleAttribute,
  };
}

function collectTargetedElements(
  root: Element | DocumentFragment,
  selector: string,
  hasTemplates: boolean,
  skipTemplate?: (template: HTMLTemplateElement) => boolean,
  out: Element[] = [],
): Element[] {
  if (root.nodeType === 1 && (root as Element).matches(selector)) {
    out.push(root as Element);
  }
  for (const element of root.querySelectorAll(selector)) {
    out.push(element);
  }
  if (hasTemplates) {
    for (const element of root.querySelectorAll("template")) {
      if (element.namespaceURI !== HTML_NAMESPACE) continue;
      const template = element as HTMLTemplateElement;
      if (skipTemplate?.(template) !== true) {
        collectTargetedElements(template.content, selector, true, skipTemplate, out);
      }
    }
  }
  return out;
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
    for (const element of collectTargetedElements(
      root,
      `[${inertStyleAttribute}]`,
      hasTemplates,
      skipInertStyleTemplate,
    )) {
      const authoredStyle = element.getAttribute(inertStyleAttribute);
      if (authoredStyle === null) continue;
      authoredStyleAttributes.set(element, authoredStyle);
      element.removeAttribute(inertStyleAttribute);
    }
  }

  if (hasInertStyleElement) {
    for (const element of collectTargetedElements(
      root,
      `[${inertStyleElementMarker}]`,
      hasTemplates,
      skipInertStyleTemplate,
    )) {
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

const URL_CANDIDATE_PATTERN = /href|src|action|formaction|poster|cite|<object/;
const URL_ELEMENT_TAGS = [
  "a",
  "area",
  "audio",
  "base",
  "blockquote",
  "button",
  "del",
  "embed",
  "form",
  "iframe",
  "img",
  "input",
  "ins",
  "link",
  "object",
  "q",
  "script",
  "source",
  "track",
  "video",
  "feImage",
  "image",
  "use",
] as const;

function collectAndAbsolutizeURLAttributes(
  root: Element,
  lowerSource: string,
  restoredURLs: boolean,
  pageURL: string,
  baseURL: string,
  createScriptURL: PrepareMarkupOptions["createScriptURL"],
): EnumerableWeakMap<Element, Map<string, string>> {
  const authoredURLAttributes = new EnumerableWeakMap<Element, Map<string, string>>();
  if (!restoredURLs && !URL_CANDIDATE_PATTERN.test(lowerSource)) {
    return authoredURLAttributes;
  }

  let selector = URL_ELEMENT_SELECTOR;
  if (!restoredURLs) {
    const present: string[] = [];
    for (const tag of URL_ELEMENT_TAGS) {
      const lowerTag = tag === "feImage" ? "feimage" : tag;
      if (
        lowerSource.includes(`<${lowerTag}`) ||
        (tag === "img" && lowerSource.includes("<image"))
      ) {
        present.push(tag);
      }
    }
    if (present.length === 0) {
      return authoredURLAttributes;
    }
    selector = present.join(",");
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

interface VerifiedSSRLinkedStyle {
  style: HTMLStyleElement;
  href: string;
  integrity: string;
  sourceURL: string;
}

async function prepareLinkedStyle(
  link: HTMLLinkElement,
  nonce: string,
  context: StylesheetContext,
  document: Document,
  linkedStyles: WeakMap<HTMLLinkElement, LinkedStyle>,
  onError: PrepareMarkupOptions["onError"],
  verifiedSSRLink?: VerifiedSSRLinkedStyle,
): Promise<void> {
  const href = link.href;
  const integrity = link.integrity.trim();
  const crossOrigin = normalizeCrossOrigin(link.getAttribute("crossorigin"));
  const referrerPolicy = link.referrerPolicy as ReferrerPolicy | "";
  // An alternate sheet is not applied until the guest selects it.
  const disabled = link.disabled || link.relList.contains("alternate");

  try {
    if (
      verifiedSSRLink !== undefined &&
      link.nextElementSibling === verifiedSSRLink.style
    ) {
      const style = verifiedSSRLink.style;
      if (
        verifiedSSRLink.href === href &&
        (integrity === "" || verifiedSSRLink.integrity === integrity)
      ) {
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
          url: verifiedSSRLink.sourceURL,
          disabled,
          crossOrigin,
          referrerPolicy,
        });
        return;
      }
      style.remove();
    }
    const source = await fetchStylesheet(href, context, integrity, {
      crossOrigin,
      referrerPolicy,
    });
    const rewritten = await rewriteStylesheet(source.text, source.url, context);
    const style = createGeneratedStyle(document, rewritten, nonce, source.url);
    style.media = link.media;
    style.disabled = disabled;
    if (link.hasAttribute("title")) {
      style.title = link.title;
    }
    linkedStyles.set(link, {
      style,
      href,
      integrity,
      url: source.url,
      disabled,
      crossOrigin,
      referrerPolicy,
    });
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
const RESTORED_EVENT = 1;
const RESTORED_STYLE = 2;
const RESTORED_URL = 4;

interface MarkupParts {
  html: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  baseURL: string;
  lowerSource: string;
  restoredFlags: number;
  authoredStyleAttributes: EnumerableWeakMap<Element, string>;
  rewriteInlineStyles: boolean;
  hasPhysicalStyleAttributes: boolean;
  hasRestoredStyles?: boolean;
  verifiedSSRLinks?: Map<HTMLLinkElement, VerifiedSSRLinkedStyle>;
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
    restoredFlags,
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
    (restoredFlags & RESTORED_URL) !== 0,
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
  const mayHaveStyles =
    parts.hasRestoredStyles === true || lowerSource.includes("<style");
  const mayHaveLinks = lowerSource.includes("<link");
  const authoredStyles = mayHaveStyles ? Array.from(html.querySelectorAll("style")) : [];

  for (const style of authoredStyles) {
    // A server vouches for the styles it materialized; every other guest style
    // (all of them, in a fetched document) still resolves against the host
    // page until rewritten here. A linked preview is prepared with its link.
    const materialized = style.hasAttribute(SSR_STYLE);
    style.removeAttribute(SSR_STYLE);
    const ssrLinked = style.hasAttribute(SSR_LINK_STYLE);
    if (parts.rewriteInlineStyles && ssrLinked) {
      style.removeAttribute(SSR_LINK_STYLE);
      style.removeAttribute(SSR_LINK_INTEGRITY);
    }
    if (!parts.rewriteInlineStyles && (materialized || ssrLinked)) {
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

  const links = mayHaveLinks
    ? Array.from(html.querySelectorAll<HTMLLinkElement>("link"))
    : [];
  let hasLinkedStyles = false;
  for (const link of links) {
    if (
      link.namespaceURI !== HTML_NAMESPACE ||
      !link.hasAttribute("href") ||
      !(link.getAttribute("rel") ?? "")
        .split(/[\t\n\f\r ]+/)
        .some((token) => token.toLowerCase() === "stylesheet")
    ) {
      continue;
    }
    hasLinkedStyles = true;
    stylesheetJobs.push(
      prepareLinkedStyle(
        link,
        options.nonce,
        stylesheetContext,
        options.document,
        linkedStyles,
        options.onError,
        parts.verifiedSSRLinks?.get(link),
      ),
    );
  }

  await Promise.all(stylesheetJobs);

  let styles = authoredStyles;
  if (hasLinkedStyles) {
    const collected = new Set<HTMLStyleElement>();
    for (const style of authoredStyles) {
      if (html.contains(style)) collected.add(style);
    }
    for (const link of links) {
      const linked = linkedStyles.get(link);
      if (linked !== undefined && html.contains(linked.style)) {
        collected.add(linked.style);
      }
    }
    styles = [...collected];
  }

  const hasBase = lowerSource.includes("<base");
  const bases = hasBase
    ? Array.from(html.querySelectorAll<HTMLElement>("base")).filter(
        (base) => base.namespaceURI === HTML_NAMESPACE,
      )
    : [];

  return {
    html,
    head,
    body,
    baseURL,
    scripts: lowerSource.includes("<script")
      ? Array.from(html.querySelectorAll("script"))
      : [],
    styles,
    links,
    bases,
    flags:
      (styles.length > 0 ? MARKUP_FLAG_STYLES : 0) |
      (links.length > 0 ? MARKUP_FLAG_LINKS : 0) |
      (lowerSource.includes("<svg") ? MARKUP_FLAG_SVG : 0) |
      (lowerSource.includes("<template") ? MARKUP_FLAG_TEMPLATES : 0) |
      (lowerSource.includes(FRAGMENT_TARGET_ATTRIBUTE) ? MARKUP_FLAG_TARGET : 0) |
      ((restoredFlags & RESTORED_EVENT) !== 0 ||
      INLINE_EVENT_CANDIDATE_PATTERN.test(lowerSource)
        ? MARKUP_FLAG_INLINE_EVENTS
        : 0) |
      (bases.length > 0 ? MARKUP_FLAG_BASE : 0),
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
    for (const element of collectTargetedElements(parsedRoot, "[style]", hasTemplates)) {
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
    restoredFlags: 0,
    authoredStyleAttributes,
    rewriteInlineStyles: true,
    hasPhysicalStyleAttributes: false,
    hasRestoredStyles: neutralized.hasInertStyleElement,
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
    if (lower.startsWith("on") || PREVIEW_RESTORE_NAMES.has(lower)) {
      return true;
    }
    if (element.namespaceURI === HTML_NAMESPACE) {
      if (element.localName === "iframe") {
        return lower === "src" || lower === "srcdoc";
      }
      if (element.localName === "object") {
        return lower === "data";
      }
      if (element.localName === "embed") {
        return lower === "src";
      }
    }
    return false;
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

function restoreAuthoredAttributes(element: Element, marker: string): number {
  const provenance = element.getAttribute(marker);
  if (provenance === null) return 0;
  element.removeAttribute(marker);
  let authored: unknown;
  try {
    authored = JSON.parse(provenance);
  } catch {
    return 0;
  }
  if (authored === null || typeof authored !== "object") return 0;
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
  let restoredFlags = 0;
  for (const [name, value] of attributes) {
    if (!canRestoreAuthoredAttribute(element, marker, name)) continue;
    try {
      if (value === null) element.removeAttribute(name);
      else if (typeof value === "string") {
        if (name.startsWith("xlink:"))
          element.setAttributeNS(XLINK_NAMESPACE, name, value);
        else element.setAttribute(name, value);
        const lower = name.toLowerCase();
        if (lower.startsWith("on")) restoredFlags |= RESTORED_EVENT;
        else if (lower === "style") restoredFlags |= RESTORED_STYLE;
        else restoredFlags |= RESTORED_URL;
      }
    } catch {
      // Ignore malformed attribute names in provenance metadata.
    }
  }
  return restoredFlags;
}

function transferNestedFrameStyles(
  root: Element | DocumentFragment,
  styles: Map<Element, string>,
): void {
  for (
    let child = root.firstElementChild;
    child !== null && styles.size > 0;
    child = child.nextElementSibling
  ) {
    const style = styles.get(child);
    if (style !== undefined) {
      child.setAttribute("style", style);
      styles.delete(child);
    }
    if (child.firstElementChild !== null) transferNestedFrameStyles(child, styles);
    if (child.namespaceURI === HTML_NAMESPACE && child.localName === "template") {
      transferNestedFrameStyles((child as HTMLTemplateElement).content, styles);
    }
  }
}

function restoreNestedFrames(
  root: Element,
  hasTemplates: boolean,
  styles?: Map<Element, string>,
): void {
  if (!hasTemplates) return;
  const templates = collectTargetedElements(root, "template", true);
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
  let restoredFlags = 0;
  const ssrSelector = `[${SSR_ATTRIBUTES}],[${SSR_LINK_REL}]`;
  const restoreSsrElement = (element: Element): void => {
    restoredFlags |= restoreAuthoredAttributes(element, SSR_ATTRIBUTES);
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
    const previewTargets = collectTargetedElements(
      html,
      `[${SSR_PREVIEW_ATTRIBUTES}]`,
      hasTemplates,
    );
    for (const element of previewTargets) {
      restoredFlags |= restoreAuthoredAttributes(element, SSR_PREVIEW_ATTRIBUTES);
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
  if ((restoredFlags & RESTORED_STYLE) !== 0 || lowerSource.includes("style")) {
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
  const verifiedSSRLinks = new Map<HTMLLinkElement, VerifiedSSRLinkedStyle>();
  if (lowerSource.includes(SSR_LINK_STYLE)) {
    for (const link of html.querySelectorAll<HTMLLinkElement>("link[href]")) {
      if (link.namespaceURI !== HTML_NAMESPACE) continue;
      const sibling = link.nextElementSibling;
      if (
        sibling?.localName === "style" &&
        sibling.namespaceURI === HTML_NAMESPACE &&
        sibling.hasAttribute(SSR_LINK_STYLE)
      ) {
        const style = sibling as HTMLStyleElement;
        const resolvedHref = URL.parse(link.getAttribute("href") ?? "", baseURL)?.href;
        if (resolvedHref !== undefined) {
          verifiedSSRLinks.set(link, {
            style,
            href: resolvedHref,
            integrity: (style.getAttribute(SSR_LINK_INTEGRITY) ?? "").trim(),
            sourceURL: style.dataset.vFrameSource ?? resolvedHref,
          });
        }
      }
    }
  }
  return finishMarkup(options, {
    html,
    head,
    body,
    baseURL,
    lowerSource,
    restoredFlags,
    authoredStyleAttributes,
    // Server-materialized style elements arrive already rebased and marked;
    // those it could not materialize are rewritten like a fetched document's.
    rewriteInlineStyles: false,
    hasPhysicalStyleAttributes: true,
    verifiedSSRLinks,
  });
}
