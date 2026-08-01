import {
  createStylesheetContext,
  fetchStylesheetText,
  rewriteStyleAttribute,
  rewriteStylesheet,
  type StylesheetContext,
} from "./css.js";
import { EnumerableWeakMap } from "./enumerable-weak.js";
import type { VFrameWindow } from "./types.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
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

const URL_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  area: ["href"],
  audio: ["src"],
  base: ["href"],
  blockquote: ["cite"],
  button: ["formaction"],
  del: ["cite"],
  embed: ["src"],
  form: ["action"],
  iframe: ["src"],
  img: ["src"],
  input: ["src", "formaction"],
  ins: ["cite"],
  link: ["href"],
  object: ["data"],
  q: ["cite"],
  script: ["src"],
  source: ["src"],
  track: ["src"],
  video: ["src", "poster"],
};

const SVG_EXTERNAL_RESOURCE_ELEMENTS = new Set(["feImage", "image", "use"]);

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
  fetchStylesheet(url: string): Promise<string>;
  onError(error: MarkupError): void;
}

export interface PreparedMarkup {
  html: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  baseURL: string;
  scripts: HTMLScriptElement[];
  authoredURLAttributes: EnumerableWeakMap<Element, Map<string, string>>;
  authoredStyleAttributes: EnumerableWeakMap<Element, string>;
  inlineStyleSelectorAttribute: string;
  inlineStyleSheet: HTMLStyleElement;
  stylesheetContext: StylesheetContext;
}

interface NeutralizedStyleMarkup {
  source: string;
  inertStyleElementMarker: string;
  inertStyleAttribute: string;
}

interface NeutralizedTag {
  source: string;
  end: number;
}

function isASCIIWhitespace(character: string | undefined): boolean {
  return (
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r" ||
    character === " "
  );
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

function findUnusedAttributeName(source: string, purpose: string): string {
  const lowerSource = source.toLowerCase();
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
  tagStart: number,
  nameStart: number,
  nameEnd: number,
  styleAttributeReplacement: string | undefined,
  replacementName?: string,
  markerAttribute?: string,
): NeutralizedTag {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  if (replacementName !== undefined) {
    replacements.push({ start: nameStart, end: nameEnd, value: replacementName });
  }
  if (markerAttribute !== undefined) {
    replacements.push({ start: nameEnd, end: nameEnd, value: ` ${markerAttribute}` });
  }

  let cursor = nameEnd;
  while (cursor < source.length) {
    while (isASCIIWhitespace(source[cursor])) {
      cursor += 1;
    }

    if (source[cursor] === ">") {
      cursor += 1;
      break;
    }
    if (source[cursor] === "/") {
      cursor += 1;
      continue;
    }

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
      source.slice(attributeStart, attributeEnd).toLowerCase() === "style"
    ) {
      replacements.push({
        start: attributeStart,
        end: attributeEnd,
        value: styleAttributeReplacement,
      });
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

  let rewritten = "";
  let copiedThrough = tagStart;
  for (const replacement of replacements) {
    rewritten += source.slice(copiedThrough, replacement.start);
    rewritten += replacement.value;
    copiedThrough = replacement.end;
  }
  rewritten += source.slice(copiedThrough, cursor);
  return { source: rewritten, end: cursor };
}

function neutralizeStyleMarkup(source: string): NeutralizedStyleMarkup {
  const inertStyleElementMarker = findUnusedAttributeName(source, "inert-style-element");
  const inertStyleAttribute = findUnusedAttributeName(source, "inert-style-attribute");
  const lowerSource = source.toLowerCase();
  const rewritten: string[] = [];
  let cursor = 0;
  let rawTextElement: string | undefined;
  let closesStyleElement = false;

  while (cursor < source.length) {
    if (rawTextElement !== undefined) {
      if (rawTextElement === "plaintext") {
        rewritten.push(source.slice(cursor));
        break;
      }

      const rawTextEnd = findRawTextEnd(lowerSource, cursor, rawTextElement);
      const contentEnd = rawTextEnd === -1 ? source.length : rawTextEnd;
      const content = source.slice(cursor, contentEnd);
      rewritten.push(
        // Template contents use the data state, so protect raw CSS from tag and entity parsing.
        rawTextElement === "style"
          ? content.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
          : content,
      );
      if (rawTextEnd === -1) {
        break;
      }
      cursor = rawTextEnd;
      closesStyleElement = rawTextElement === "style";
      rawTextElement = undefined;
      continue;
    }

    const tagStart = source.indexOf("<", cursor);
    if (tagStart === -1) {
      rewritten.push(source.slice(cursor));
      break;
    }
    rewritten.push(source.slice(cursor, tagStart));

    if (source.startsWith("<!--", tagStart)) {
      const commentEnd = source.indexOf("-->", tagStart + 4);
      const end = commentEnd === -1 ? source.length : commentEnd + 3;
      rewritten.push(source.slice(tagStart, end));
      cursor = end;
      continue;
    }
    if (source.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = source.indexOf("]]>", tagStart + 9);
      const end = cdataEnd === -1 ? source.length : cdataEnd + 3;
      rewritten.push(source.slice(tagStart, end));
      cursor = end;
      continue;
    }
    if (source[tagStart + 1] === "!" || source[tagStart + 1] === "?") {
      const declarationEnd = source.indexOf(">", tagStart + 2);
      const end = declarationEnd === -1 ? source.length : declarationEnd + 1;
      rewritten.push(source.slice(tagStart, end));
      cursor = end;
      continue;
    }

    const isEndTag = source[tagStart + 1] === "/";
    const nameStart = tagStart + (isEndTag ? 2 : 1);
    if (!isASCIIAlpha(source[nameStart])) {
      rewritten.push("<");
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
    const tag = neutralizeTag(
      source,
      tagStart,
      nameStart,
      nameEnd,
      isEndTag ? undefined : inertStyleAttribute,
      isStyleElement && (!isEndTag || closesStyleElement) ? "template" : undefined,
      isStyleElement && !isEndTag ? inertStyleElementMarker : undefined,
    );
    rewritten.push(tag.source);
    cursor = tag.end;
    closesStyleElement = false;

    if (
      !isEndTag &&
      (RAW_TEXT_ELEMENTS.has(elementName) || elementName === "plaintext")
    ) {
      rawTextElement = elementName;
    }
  }

  return {
    source: rewritten.join(""),
    inertStyleElementMarker,
    inertStyleAttribute,
  };
}

function collectParsedElements(root: Element | DocumentFragment): Element[] {
  const elements = root.nodeType === 1 ? [root as Element] : [];
  elements.push(...Array.from(root.querySelectorAll("*")));

  for (const element of [...elements]) {
    if (element.namespaceURI === HTML_NAMESPACE && element.localName === "template") {
      elements.push(...collectParsedElements((element as HTMLTemplateElement).content));
    }
  }

  return elements;
}

function restoreStyleMarkup(
  root: Element,
  inertStyleElementMarker: string,
  inertStyleAttribute: string,
): Map<Element, string> {
  const elements = collectParsedElements(root);
  const authoredStyleAttributes = new Map<Element, string>();

  for (const element of elements) {
    const authoredStyle = element.getAttribute(inertStyleAttribute);
    if (authoredStyle === null) {
      continue;
    }
    authoredStyleAttributes.set(element, authoredStyle);
    element.removeAttribute(inertStyleAttribute);
  }

  for (const element of elements) {
    if (!element.hasAttribute(inertStyleElementMarker)) {
      continue;
    }

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

  return authoredStyleAttributes;
}

function lowerStyleAttributes(
  authoredStyleAttributes: EnumerableWeakMap<Element, string>,
  head: Element,
  baseURL: string,
  selectorAttribute: string,
  document: Document,
): HTMLStyleElement {
  const rules: string[] = [];

  for (const [element, authoredStyle] of authoredStyleAttributes) {
    try {
      const rewritten = rewriteStyleAttribute(authoredStyle, baseURL);
      if (rewritten === "") {
        continue;
      }

      const selectorValue = String(rules.length);
      element.setAttribute(selectorAttribute, selectorValue);
      rules.push(`[${selectorAttribute}="${selectorValue}"]{${rewritten}}`);
    } catch {
      continue;
    }
  }

  const style = document.createElement("style");
  style.dataset.vFrameInlineStyles = "";
  style.textContent = rules.join("\n");
  head.append(style);
  return style;
}

function resolveMarkupBaseURL(root: Element, fallbackURL: string): string {
  for (const base of root.querySelectorAll("base[href]")) {
    const resolvedBase = URL.parse(base.getAttribute("href") ?? "", fallbackURL);
    if (resolvedBase !== null) {
      return resolvedBase.href;
    }
  }

  return fallbackURL;
}

function collectAuthoredURLAttributes(
  root: Element,
): EnumerableWeakMap<Element, Map<string, string>> {
  const authoredURLAttributes = new EnumerableWeakMap<Element, Map<string, string>>();

  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    const authoredAttributes = new Map<string, string>();
    for (const attribute of Array.from(element.attributes)) {
      if (
        isURLAttribute(element, attribute.localName, attribute.namespaceURI) ||
        isSrcsetAttribute(element, attribute.localName, attribute.namespaceURI)
      ) {
        authoredAttributes.set(attribute.name, attribute.value);
      }
    }
    if (authoredAttributes.size > 0) {
      authoredURLAttributes.set(element, authoredAttributes);
    }
  }

  return authoredURLAttributes;
}

function copyAttributes(from: Element, to: Element): void {
  for (const attribute of from.attributes) {
    to.setAttribute(attribute.name, attribute.value);
  }
}

export function absolutizeSrcset(source: string, baseURL: string): string {
  const candidates: string[] = [];
  let position = 0;

  while (position < source.length) {
    while (
      position < source.length &&
      (source[position] === "," || isASCIIWhitespace(source[position]))
    ) {
      position += 1;
    }
    if (position >= source.length) {
      break;
    }

    const referenceStart = position;
    while (position < source.length && !isASCIIWhitespace(source[position])) {
      position += 1;
    }
    let reference = source.slice(referenceStart, position);
    let descriptor = "";

    const trailingCommas = reference.match(/,+$/)?.[0].length ?? 0;
    if (trailingCommas > 0) {
      reference = reference.slice(0, -trailingCommas);
    } else {
      while (position < source.length && isASCIIWhitespace(source[position])) {
        position += 1;
      }
      const descriptorStart = position;
      let parentheses = 0;
      while (position < source.length) {
        const character = source[position];
        if (character === "(") {
          parentheses += 1;
        } else if (character === ")" && parentheses > 0) {
          parentheses -= 1;
        } else if (character === "," && parentheses === 0) {
          break;
        }
        position += 1;
      }
      descriptor = source.slice(descriptorStart, position).trim();
    }

    if (position < source.length && source[position] === ",") {
      position += 1;
    }
    if (reference === "") {
      continue;
    }

    const resolvedReference = URL.parse(reference, baseURL);
    if (resolvedReference !== null) {
      reference = resolvedReference.href;
    }
    candidates.push(descriptor === "" ? reference : `${reference} ${descriptor}`);
  }

  return candidates.join(", ");
}

export function isSrcsetAttribute(
  element: Element,
  attributeName: string,
  namespaceURI: string | null = null,
): boolean {
  return (
    element.namespaceURI === HTML_NAMESPACE &&
    namespaceURI === null &&
    (element.localName === "img" || element.localName === "source") &&
    attributeName.toLowerCase() === "srcset"
  );
}

export function isURLAttribute(
  element: Element,
  attributeName: string,
  namespaceURI: string | null = null,
): boolean {
  if (element.namespaceURI === HTML_NAMESPACE && namespaceURI === null) {
    const names = URL_ATTRIBUTES[element.localName];
    return names?.includes(attributeName.toLowerCase()) ?? false;
  }

  if (
    element.namespaceURI !== SVG_NAMESPACE ||
    !SVG_EXTERNAL_RESOURCE_ELEMENTS.has(element.localName)
  ) {
    return false;
  }

  if (namespaceURI === XLINK_NAMESPACE) {
    return attributeName.toLowerCase() === "href";
  }

  return namespaceURI === null && attributeName.toLowerCase() === "href";
}

function absolutizeElementAttributes(
  element: Element,
  baseURL: string,
  createScriptURL: PrepareMarkupOptions["createScriptURL"],
): void {
  for (const attribute of Array.from(element.attributes)) {
    if (!isURLAttribute(element, attribute.localName, attribute.namespaceURI)) {
      continue;
    }

    const value = attribute.value;
    if (value.trim() === "" || value.trim().toLowerCase().startsWith("javascript:")) {
      continue;
    }

    const absoluteURL = URL.parse(value, baseURL);
    if (absoluteURL !== null) {
      const absoluteValue = absoluteURL.href;
      if (absoluteValue !== value) {
        if (attribute.namespaceURI === null) {
          element.setAttribute(
            attribute.name,
            element.localName === "script" && attribute.localName === "src"
              ? createScriptURL(absoluteValue)
              : absoluteValue,
          );
        } else {
          element.setAttributeNS(attribute.namespaceURI, attribute.name, absoluteValue);
        }
      }
    }
  }

  if (element.hasAttribute("srcset")) {
    const source = element.getAttribute("srcset") ?? "";
    const rewritten = absolutizeSrcset(source, baseURL);
    if (rewritten !== source) {
      element.setAttribute("srcset", rewritten);
    }
  }

  if (element.hasAttribute("style")) {
    try {
      const source = element.getAttribute("style") ?? "";
      const rewritten = rewriteStyleAttribute(source, baseURL);
      if (rewritten !== source) {
        element.setAttribute("style", rewritten);
      }
    } catch {
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
  onError: PrepareMarkupOptions["onError"],
): Promise<void> {
  const href = link.href;

  try {
    const source = await fetchStylesheetText(href, context);
    const rewritten = await rewriteStylesheet(source, href, context);
    const style = createGeneratedStyle(document, rewritten, nonce, href);
    style.media = link.media;
    style.disabled = link.disabled;
    if (link.hasAttribute("title")) {
      style.title = link.title;
    }
    link.replaceWith(style);
  } catch (error) {
    link.remove();
    onError({ phase: "stylesheet", url: href, error });
  }
}

// v-frame always executes guest scripts, so noscript content must stay the
// inert text a scripting-enabled parser produces. DOMParser parses with
// scripting disabled and would otherwise yield live elements whose styles
// and resources load. Text-only noscript (already inert) is left untouched
// because serializing it again would escape its markup a second time.
function neutralizeNoscriptContent(root: Element): void {
  for (const noscript of root.querySelectorAll("noscript")) {
    if (noscript.firstElementChild === null) {
      continue;
    }
    noscript.textContent = noscript.innerHTML;
  }
}

export async function prepareMarkup(
  options: PrepareMarkupOptions,
): Promise<PreparedMarkup> {
  const parser = new options.window.DOMParser();
  const neutralized = neutralizeStyleMarkup(options.source);
  const parsed = parser.parseFromString(
    options.createHTML(neutralized.source),
    "text/html",
  );
  const parsedRoot = parsed.documentElement;
  const parsedHead = parsed.head;
  const parsedBody = parsed.body;

  // Chromium enforces the host CSP on nodes connected to a DOMParser-created document.
  parsedRoot.remove();
  const parsedStyleAttributes = restoreStyleMarkup(
    parsedRoot,
    neutralized.inertStyleElementMarker,
    neutralized.inertStyleAttribute,
  );

  const baseURL = resolveMarkupBaseURL(parsedRoot, options.pageURL);
  const html = options.document.createElement("v-html") as HTMLElement;
  const head = options.document.createElement("v-head") as HTMLElement;
  const body = options.document.createElement("v-body") as HTMLElement;

  copyAttributes(parsedRoot, html);
  copyAttributes(parsedHead, head);
  copyAttributes(parsedBody, body);
  head.append(...Array.from(parsedHead.childNodes));
  body.append(...Array.from(parsedBody.childNodes));
  html.append(head, body);

  neutralizeNoscriptContent(html);
  const authoredURLAttributes = collectAuthoredURLAttributes(html);
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
  const inlineStyleSelectorAttribute = findUnusedAttributeName(
    options.source,
    "inline-style",
  );
  const inlineStyleSheet = lowerStyleAttributes(
    authoredStyleAttributes,
    head,
    baseURL,
    inlineStyleSelectorAttribute,
    options.document,
  );

  for (const element of html.querySelectorAll("*")) {
    const attributeBaseURL =
      element.namespaceURI === HTML_NAMESPACE && element.localName === "base"
        ? options.pageURL
        : baseURL;
    absolutizeElementAttributes(element, attributeBaseURL, options.createScriptURL);
  }

  const stylesheetContext = createStylesheetContext(
    options.fetchStylesheet,
    ({ url, error }) => options.onError({ phase: "stylesheet", url, error }),
  );
  const stylesheetJobs: Promise<void>[] = [];

  for (const style of html.querySelectorAll("style")) {
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

  for (const link of html.querySelectorAll<HTMLLinkElement>(
    'link[rel~="stylesheet"][href]',
  )) {
    stylesheetJobs.push(
      prepareLinkedStyle(
        link,
        options.nonce,
        stylesheetContext,
        options.document,
        options.onError,
      ),
    );
  }

  await Promise.all(stylesheetJobs);
  inlineStyleSheet.remove();

  return {
    html,
    head,
    body,
    baseURL,
    scripts: Array.from(html.querySelectorAll("script")),
    authoredURLAttributes,
    authoredStyleAttributes,
    inlineStyleSelectorAttribute,
    inlineStyleSheet,
    stylesheetContext,
  };
}

export async function prepareAdoptedMarkup(
  options: PrepareMarkupOptions,
): Promise<PreparedMarkup> {
  const parser = new options.window.DOMParser();
  const parsed = parser.parseFromString(options.createHTML(options.source), "text/html");
  const html = parsed.body.querySelector(":scope > v-html") as HTMLElement | null;
  const head = html?.querySelector(":scope > v-head") as HTMLElement | null;
  const body = html?.querySelector(":scope > v-body") as HTMLElement | null;
  if (html === null || head === null || body === null) {
    throw new TypeError(
      "v-frame adopted content must contain v-html with direct v-head and v-body children",
    );
  }
  html.remove();
  const shadowHosts = new WeakSet<Element>();
  for (const element of collectParsedElements(html)) {
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

  for (const script of html.querySelectorAll<HTMLScriptElement>(
    "script[data-v-frame-script]",
  )) {
    if (script.getAttribute("type") !== "application/vnd.v-frame") {
      continue;
    }
    const authoredType = script.getAttribute("data-v-frame-type");
    script.removeAttribute("data-v-frame-script");
    script.removeAttribute("data-v-frame-type");
    if (authoredType === null) {
      script.removeAttribute("type");
    } else {
      script.type = authoredType;
    }
  }

  neutralizeNoscriptContent(html);
  const baseURL = resolveMarkupBaseURL(html, options.pageURL);
  const authoredURLAttributes = collectAuthoredURLAttributes(html);
  const authoredStyleAttributes = new EnumerableWeakMap<Element, string>();
  for (const element of [html, ...Array.from(html.querySelectorAll("*"))]) {
    const authoredStyle = element.getAttribute("style");
    if (authoredStyle !== null) {
      authoredStyleAttributes.set(element, authoredStyle);
    }
  }
  const inlineStyleSelectorAttribute = findUnusedAttributeName(
    options.source,
    "inline-style",
  );
  const inlineStyleSheet = lowerStyleAttributes(
    authoredStyleAttributes,
    head,
    baseURL,
    inlineStyleSelectorAttribute,
    options.document,
  );

  for (const element of [html, ...Array.from(html.querySelectorAll("*"))]) {
    const attributeBaseURL =
      element.namespaceURI === HTML_NAMESPACE && element.localName === "base"
        ? options.pageURL
        : baseURL;
    absolutizeElementAttributes(element, attributeBaseURL, options.createScriptURL);
  }

  const stylesheetContext = createStylesheetContext(
    options.fetchStylesheet,
    ({ url, error }) => options.onError({ phase: "stylesheet", url, error }),
  );
  await Promise.all(
    Array.from(
      html.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'),
    ).map((link) =>
      prepareLinkedStyle(
        link,
        options.nonce,
        stylesheetContext,
        options.document,
        options.onError,
      ),
    ),
  );
  inlineStyleSheet.remove();

  return {
    html,
    head,
    body,
    baseURL,
    scripts: Array.from(html.querySelectorAll("script")),
    authoredURLAttributes,
    authoredStyleAttributes,
    inlineStyleSelectorAttribute,
    inlineStyleSheet,
    stylesheetContext,
  };
}
