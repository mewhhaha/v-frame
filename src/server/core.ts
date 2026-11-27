import { createStylesheetContext, extractFontFaces, rewriteStylesheet } from "../css.js";
import {
  HTML_NAMESPACE,
  isASCIIWhitespace,
  rewriteAssetAttribute,
  SVG_NAMESPACE,
  XLINK_NAMESPACE,
} from "../asset-urls.js";
import type {
  StylesheetFetch,
  StylesheetFetchOptions,
  StylesheetImportFailure,
  StylesheetSource,
} from "../css.js";
import {
  INERT_SCRIPT_TYPE,
  SCRIPT_MARKER_ATTRIBUTE,
  SCRIPT_TYPE_ATTRIBUTE,
  SHELL_ELEMENT_NAMES,
  SSR_ATTRIBUTES,
  SSR_PREVIEW_ATTRIBUTES,
  SSR_STYLE,
} from "../wire-format.js";

export const DEFAULT_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_STYLESHEET_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_STYLESHEETS = 64;
export const DEFAULT_MAX_IMPORT_DEPTH = 8;
export const DEFAULT_MAX_CONCURRENCY = 8;
export const DEFAULT_MAX_SLOTS = 32;
export const DEFAULT_MAX_TOTAL_FETCHES = 256;

const RAW_TEXT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

const SVG_HTML_INTEGRATION_POINTS = new Set(["foreignobject", "desc", "title"]);
const MATH_TEXT_INTEGRATION_POINTS = new Set(["mi", "mo", "mn", "ms", "mtext"]);
// HTML5 13.2.6.5 "in foreign content": start tags that immediately pop foreign
// elements back to the HTML namespace (plus <font color|face|size>).
const FOREIGN_BREAKOUT_TAGS = new Set([
  "b",
  "big",
  "blockquote",
  "body",
  "br",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "i",
  "img",
  "li",
  "listing",
  "menu",
  "meta",
  "nobr",
  "ol",
  "p",
  "pre",
  "ruby",
  "s",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "table",
  "tt",
  "u",
  "ul",
  "var",
]);

function isASCIIAlpha(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isRawTextBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    isASCIIWhitespace(character) ||
    character === "/" ||
    character === ">"
  );
}

const SCRIPT_DATA_PATTERN = /<!--|<\/script(?=[\t\n\f\r />]|$)/gi;
const SCRIPT_ESCAPED_PATTERN = /-->|<\/?script(?=[\t\n\f\r />]|$)/gi;
const RAW_TEXT_END_PATTERNS = new Map<string, RegExp>([
  ["iframe", /<\/iframe(?=[\t\n\f\r />]|$)/gi],
  ["noembed", /<\/noembed(?=[\t\n\f\r />]|$)/gi],
  ["noframes", /<\/noframes(?=[\t\n\f\r />]|$)/gi],
  ["noscript", /<\/noscript(?=[\t\n\f\r />]|$)/gi],
  ["style", /<\/style(?=[\t\n\f\r />]|$)/gi],
  ["textarea", /<\/textarea(?=[\t\n\f\r />]|$)/gi],
  ["title", /<\/title(?=[\t\n\f\r />]|$)/gi],
  ["xmp", /<\/xmp(?=[\t\n\f\r />]|$)/gi],
]);

function findScriptEnd(source: string, cursor: number): number {
  let pos = cursor;
  let state: "data" | "escaped" | "double-escaped" = "data";
  while (pos < source.length) {
    if (state === "data") {
      SCRIPT_DATA_PATTERN.lastIndex = pos;
      const match = SCRIPT_DATA_PATTERN.exec(source);
      if (match === null) return -1;
      if (match[0] === "<!--") {
        state = "escaped";
        pos = match.index + 4;
        continue;
      }
      return match.index;
    }
    SCRIPT_ESCAPED_PATTERN.lastIndex = pos;
    const match = SCRIPT_ESCAPED_PATTERN.exec(source);
    if (match === null) return -1;
    const token = match[0];
    if (token === "-->") {
      state = "data";
      pos = match.index + 3;
      continue;
    }
    if (state === "escaped") {
      if (token.charCodeAt(1) === 47 /* '/' */) {
        return match.index;
      }
      state = "double-escaped";
      pos = match.index + 7;
      continue;
    }
    if (token.charCodeAt(1) === 47 /* '/' */) {
      state = "escaped";
      pos = match.index + 8;
      continue;
    }
    pos = match.index + token.length;
  }
  return -1;
}

function findRawTextEnd(source: string, cursor: number, elementName: string): number {
  if (elementName === "script") return findScriptEnd(source, cursor);
  const pattern = RAW_TEXT_END_PATTERNS.get(elementName);
  if (pattern !== undefined) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    return match === null ? -1 : match.index;
  }
  const lowerSource = source.toLowerCase();
  const endTagPrefix = `</${elementName}`;
  let candidate = lowerSource.indexOf(endTagPrefix, cursor);
  while (candidate !== -1) {
    if (isRawTextBoundary(lowerSource[candidate + endTagPrefix.length])) {
      return candidate;
    }
    candidate = lowerSource.indexOf(endTagPrefix, candidate + endTagPrefix.length);
  }
  return -1;
}

function isASCIIWhitespaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function findTagEnd(
  source: string,
  startAfterName: number,
): { end: number; selfClosing: boolean } | null {
  const len = source.length;
  let cursor = startAfterName;
  if (cursor < len && source.charCodeAt(cursor) === 62 /* '>' */) {
    return { end: cursor + 1, selfClosing: false };
  }
  let selfClosing = false;
  while (cursor < len) {
    let code = source.charCodeAt(cursor);
    while (isASCIIWhitespaceCode(code)) {
      cursor += 1;
      if (cursor >= len) return null;
      code = source.charCodeAt(cursor);
    }
    if (code === 62 /* '>' */) {
      return { end: cursor + 1, selfClosing };
    }
    if (code === 47 /* '/' */) {
      selfClosing = true;
      cursor += 1;
      continue;
    }
    selfClosing = false;
    while (
      cursor < len &&
      !isASCIIWhitespaceCode(code) &&
      code !== 47 /* '/' */ &&
      code !== 62 /* '>' */ &&
      code !== 61 /* '=' */
    ) {
      cursor += 1;
      code = source.charCodeAt(cursor);
    }
    while (cursor < len && isASCIIWhitespaceCode(code)) {
      cursor += 1;
      code = source.charCodeAt(cursor);
    }
    if (cursor >= len) return null;
    if (code !== 61 /* '=' */) continue;
    cursor += 1;
    while (cursor < len && isASCIIWhitespaceCode(source.charCodeAt(cursor))) {
      cursor += 1;
    }
    if (cursor >= len) return null;
    const quote = source.charCodeAt(cursor);
    if (quote === 34 /* '"' */ || quote === 39 /* "'" */) {
      const close = source.indexOf(quote === 34 ? '"' : "'", cursor + 1);
      if (close === -1) return null;
      cursor = close + 1;
      continue;
    }
    while (cursor < len) {
      code = source.charCodeAt(cursor);
      if (isASCIIWhitespaceCode(code) || code === 62 /* '>' */) break;
      cursor += 1;
    }
  }
  return null;
}

// Fast-check whether a tag name outside foreign content could be one of the
// tags balanceTemplateTags tracks (template, svg, math, plaintext, or raw-text).
function mayBeSpecialHTMLTag(
  source: string,
  nameStart: number,
  nameLen: number,
): boolean {
  if (nameLen < 3 || nameLen > 9) return false;
  const c0 = source.charCodeAt(nameStart) | 32;
  switch (nameLen) {
    case 3:
      return c0 === 115 /* svg */ || c0 === 120; /* xmp */
    case 4:
      return c0 === 109; /* math */
    case 5:
      return c0 === 115 /* style */ || c0 === 116; /* title */
    case 6:
      return c0 === 115 /* script */ || c0 === 105; /* iframe */
    case 7:
      return c0 === 110; /* noembed */
    case 8:
      return c0 === 116 /* template, textarea */ || c0 === 110; /* noscript, noframes */
    case 9:
      return c0 === 112; /* plaintext */
    default:
      return false;
  }
}

function hasForeignFontBreakoutAttribute(tagText: string): boolean {
  return /[\t\n\f\r /](?:color|face|size)(?=[\t\n\f\r =/>])/i.test(tagText);
}

function isHTMLAnnotationXML(tagText: string): boolean {
  const match =
    /[\t\n\f\r /]encoding[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >]*))/i.exec(
      tagText,
    );
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim().toLowerCase();
  return value === "text/html" || value === "application/xhtml+xml";
}

/**
 * Ensures guest HTML cannot break out of or swallow an enclosing Declarative
 * Shadow DOM `<template shadowrootmode="open">...</template>` wrapper: drops
 * unmatched `</template>` end tags at depth 0 (accounting for SVG/MathML
 * foreign content and HTML5 foreign-content breakout tags), closes unclosed
 * `<template>`, comments, CDATA, and raw-text elements at EOF, discards
 * truncated tags at EOF, and neutralizes `<plaintext>`.
 */
export function balanceTemplateTags(source: string): string {
  // Copy-on-edit: clean documents avoid slicing every tag and return `source`
  // untouched without allocating a full-document lowercase copy.
  const out: string[] = [];
  let edited = false;
  let lastEmit = 0;
  const emitEdit = (from: number, to: number, replacement?: string): void => {
    edited = true;
    if (from > lastEmit) out.push(source.slice(lastEmit, from));
    if (replacement !== undefined && replacement !== "") out.push(replacement);
    lastEmit = to;
  };
  let cursor = 0;
  let templateDepth = 0;
  interface ForeignScope {
    kind: "svg" | "math";
    integrationTag: string | null;
    integrationDepth: number;
    foreignTemplateDepth: number;
    htmlTemplateDepthAtEntry: number;
  }
  const foreignStack: ForeignScope[] = [];

  const inForeignContent = (): boolean => {
    const top = foreignStack[foreignStack.length - 1];
    return top !== undefined && top.integrationTag === null;
  };

  while (cursor < source.length) {
    const tagStart = source.indexOf("<", cursor);
    if (tagStart === -1) {
      cursor = source.length;
      break;
    }

    if (source.startsWith("<!--", tagStart)) {
      if (source.startsWith("<!-->", tagStart)) {
        cursor = tagStart + 5;
        continue;
      }
      if (source.startsWith("<!--->", tagStart)) {
        cursor = tagStart + 6;
        continue;
      }
      const commentEnd = source.indexOf("-->", tagStart + 4);
      if (commentEnd === -1) {
        emitEdit(source.length, source.length, "-->");
        cursor = source.length;
        break;
      }
      cursor = commentEnd + 3;
      continue;
    }

    if (inForeignContent() && source.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = source.indexOf("]]>", tagStart + 9);
      if (cdataEnd === -1) {
        emitEdit(source.length, source.length, "]]>");
        cursor = source.length;
        break;
      }
      cursor = cdataEnd + 3;
      continue;
    }

    const nextChar = source[tagStart + 1];
    if (nextChar === "!" || nextChar === "?") {
      const declarationEnd = source.indexOf(">", tagStart + 2);
      if (declarationEnd === -1) {
        emitEdit(source.length, source.length, ">");
        cursor = source.length;
        break;
      }
      cursor = declarationEnd + 1;
      continue;
    }

    const isEndTag = nextChar === "/";
    const nameStart = tagStart + (isEndTag ? 2 : 1);
    if (!isASCIIAlpha(source[nameStart])) {
      if (isEndTag) {
        // HTML5 bogus comment for `</...` without ASCII alpha: runs to next `>`.
        const bogusEnd = source.indexOf(">", nameStart);
        if (bogusEnd === -1) {
          emitEdit(source.length, source.length, ">");
          cursor = source.length;
          break;
        }
        cursor = bogusEnd + 1;
        continue;
      }
      cursor = tagStart + 1;
      continue;
    }

    let nameEnd = nameStart + 1;
    while (nameEnd < source.length) {
      const code = source.charCodeAt(nameEnd);
      if (isASCIIWhitespaceCode(code) || code === 47 /* '/' */ || code === 62 /* '>' */) {
        break;
      }
      nameEnd += 1;
    }
    const parsedTag = findTagEnd(source, nameEnd);
    if (parsedTag === null) {
      // Truncated tag or unclosed attribute quote at EOF: discard it so it
      // cannot swallow the host's closing `</template>`.
      emitEdit(tagStart, source.length);
      cursor = source.length;
      break;
    }
    const { end: tagEnd, selfClosing } = parsedTag;
    if (
      foreignStack.length === 0 &&
      !mayBeSpecialHTMLTag(source, nameStart, nameEnd - nameStart)
    ) {
      cursor = tagEnd;
      continue;
    }
    const tagName = source.slice(nameStart, nameEnd).toLowerCase();
    let foreign = inForeignContent();

    if (isEndTag) {
      if (tagName === "template") {
        const top = foreignStack[foreignStack.length - 1];
        if (foreign && top !== undefined && top.foreignTemplateDepth > 0) {
          top.foreignTemplateDepth -= 1;
          cursor = tagEnd;
          continue;
        }
        if (templateDepth === 0) {
          // Stray `</template>` with no open HTML `<template>` would close the
          // host's DSD wrapper (including from inside foreign content).
          emitEdit(tagStart, tagEnd);
          cursor = tagEnd;
          continue;
        }
        while (
          foreignStack.length > 0 &&
          foreignStack[foreignStack.length - 1]!.htmlTemplateDepthAtEntry ===
            templateDepth
        ) {
          foreignStack.pop();
        }
        templateDepth -= 1;
      } else {
        const top = foreignStack[foreignStack.length - 1];
        if (top !== undefined && top.htmlTemplateDepthAtEntry === templateDepth) {
          if (top.integrationTag === tagName) {
            top.integrationDepth -= 1;
            if (top.integrationDepth <= 0) {
              top.integrationTag = null;
              top.integrationDepth = 0;
            }
          } else if (top.kind === tagName && top.integrationTag === null) {
            foreignStack.pop();
          }
        }
      }
      cursor = tagEnd;
      continue;
    }

    if (
      foreign &&
      (FOREIGN_BREAKOUT_TAGS.has(tagName) ||
        (tagName === "font" &&
          hasForeignFontBreakoutAttribute(source.slice(tagStart, tagEnd))))
    ) {
      while (inForeignContent()) {
        foreignStack.pop();
      }
      foreign = inForeignContent();
    }

    if (!foreign && tagName === "plaintext") {
      // `<plaintext>` has no closing tag in HTML5 and would swallow the host
      // document after the DSD wrapper. Render its remainder safely inside `<pre>`.
      const rest = source.slice(tagEnd).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
      emitEdit(tagStart, source.length, `<pre>${rest}</pre>`);
      cursor = source.length;
      break;
    }

    if (!foreign && (tagName === "svg" || tagName === "math")) {
      if (!selfClosing) {
        foreignStack.push({
          kind: tagName,
          integrationTag: null,
          integrationDepth: 0,
          foreignTemplateDepth: 0,
          htmlTemplateDepthAtEntry: templateDepth,
        });
      }
    } else if (foreign && !selfClosing) {
      const top = foreignStack[foreignStack.length - 1]!;
      if (tagName === "template") {
        top.foreignTemplateDepth += 1;
      } else if (
        (top.kind === "svg" && SVG_HTML_INTEGRATION_POINTS.has(tagName)) ||
        (top.kind === "math" &&
          (MATH_TEXT_INTEGRATION_POINTS.has(tagName) ||
            (tagName === "annotation-xml" &&
              isHTMLAnnotationXML(source.slice(tagStart, tagEnd)))))
      ) {
        top.integrationTag = tagName;
        top.integrationDepth = 1;
      }
    } else if (foreignStack.length > 0 && !selfClosing) {
      const top = foreignStack[foreignStack.length - 1]!;
      if (
        top.htmlTemplateDepthAtEntry === templateDepth &&
        top.integrationTag === tagName
      ) {
        top.integrationDepth += 1;
      }
    }

    if (!foreign && tagName === "template") {
      templateDepth += 1;
    }

    cursor = tagEnd;

    if (!foreign && RAW_TEXT_ELEMENTS.has(tagName)) {
      const rawEnd = findRawTextEnd(source, cursor, tagName);
      if (rawEnd === -1) {
        emitEdit(source.length, source.length, `</${tagName}>`);
        cursor = source.length;
        break;
      }
      const closeTag = findTagEnd(source, rawEnd + 2 + tagName.length);
      if (closeTag === null) {
        emitEdit(rawEnd, source.length, `</${tagName}>`);
        cursor = source.length;
        break;
      }
      cursor = closeTag.end;
    }
  }

  if (templateDepth > 0) {
    emitEdit(source.length, source.length, "</template>".repeat(templateDepth));
  }
  if (!edited) {
    return source;
  }
  if (lastEmit < source.length) {
    out.push(source.slice(lastEmit));
  }
  return out.join("");
}

/** Shared concurrency + request-count gate for composition and materialization. */
export function createFetchBudget(options: {
  maxRequests: number;
  maxConcurrency: number;
  label: string;
}): <T>(signal: AbortSignal | undefined, run: () => Promise<T>) => Promise<T> {
  const maxRequests = options.maxRequests;
  const maxConcurrency = Math.max(1, options.maxConcurrency);
  let total = 0;
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        active += 1;
        resolve();
      };
      const onAbort = () => {
        const index = waiters.indexOf(wake);
        if (index !== -1) waiters.splice(index, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(wake);
    });
  };
  const release = () => {
    active -= 1;
    waiters.shift()?.();
  };
  return async <T>(
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (total >= maxRequests) {
      throw new RangeError(
        `${options.label} exceeded maximum of ${maxRequests} requests`,
      );
    }
    total += 1;
    if (active < maxConcurrency) {
      if (signal?.aborted) throw signal.reason;
      active += 1;
    } else {
      await acquire(signal);
    }
    try {
      return await run();
    } finally {
      release();
    }
  };
}

/** Wraps a response body in a strict byte cap without buffering the whole stream up front. */
export function limitResponseBytes(
  response: Response,
  maxBytes: number,
  label: string,
): Response {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return response;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new RangeError(`${label} exceeded maximum size of ${maxBytes} bytes`);
  }
  if (response.body === null) return response;
  let seen = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(
          new RangeError(`${label} exceeded maximum size of ${maxBytes} bytes`),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limiter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<ArrayBuffer> {
  return limitResponseBytes(response, maxBytes, label).arrayBuffer();
}

/**
 * Runtime-neutral rules for turning a trusted guest document into markup that a
 * `v-frame` element can adopt. This module parses no HTML on purpose: server
 * HTML transformation APIs differ between runtimes, so it exposes the
 * per-element decisions and leaves the streaming to the host's own parser.
 */

/**
 * The shell elements are unknown to the user agent, so the materialized
 * document has to carry their display rules itself.
 */
export const SHELL_DISPLAY_STYLE: string = `<style ${SSR_STYLE}>:host{contain:layout;display:block;position:relative;overflow:auto}:host([hidden]:not([hidden="until-found" i])){display:none!important}v-html,v-body{display:block}v-head{display:none!important}</style>`;

export interface ShellElementRewrite {
  /** The custom element name that replaces the shell tag. */
  tagName: string;
  /** Markup to insert as the element's first child, or null when there is none. */
  prependHTML: string | null;
}

/**
 * Describes how a shell tag becomes its v-frame counterpart, or returns null
 * for every other element. The tag name is matched case-insensitively.
 */
export function rewriteShellElement(tagName: string): ShellElementRewrite | null {
  const replacement = SHELL_ELEMENT_NAMES.get(tagName.toLowerCase());
  if (replacement === undefined) {
    return null;
  }

  // The display rules go first in the head so a guest stylesheet of equal
  // specificity still wins, exactly as a user-agent rule would lose.
  return {
    tagName: replacement,
    prependHTML: replacement === "v-head" ? SHELL_DISPLAY_STYLE : null,
  };
}

/** The attribute reader a materializer needs from its parser's element handle. */
export interface ScriptElementAttributes {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

export interface AttributeAssignment {
  name: string;
  value: string;
}

export interface AssetElementAttributes extends ScriptElementAttributes {
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly attributes: Iterable<[string, string]>;
}

function recordAuthoredAttributes(
  assignments: AttributeAssignment[],
  marker: string,
  authored: Map<string, string | null>,
): void {
  // The parser decodes entity references in each value attribute once. Keeping
  // those values out of JSON prevents a decoded quote from changing the JSON.
  const names = Array.from(authored.keys());
  assignments.push({
    name: marker,
    value: JSON.stringify(names).replaceAll("&", "\\u0026"),
  });
  for (const [index, name] of names.entries()) {
    const value = authored.get(name);
    if (value != null) assignments.push({ name: `${marker}-${index}`, value });
  }
}

/** Defer interactions that cannot survive the handoff to the guest. */
export function rewritePreviewAttributes(element: AssetElementAttributes): {
  removeAttributes: string[];
  setAttributes: AttributeAssignment[];
} {
  const removeAttributes: string[] = [];
  const setAttributes: AttributeAssignment[] = [];
  const authored = new Map<string, string | null>();
  const remember = (name: string) => {
    if (!authored.has(name)) authored.set(name, element.getAttribute(name));
  };
  const html = element.namespaceURI === HTML_NAMESPACE;
  const anchor =
    (html && (element.tagName === "a" || element.tagName === "area")) ||
    (element.namespaceURI === SVG_NAMESPACE && element.tagName === "a");
  for (const [name] of element.attributes) {
    if (name.startsWith("on") || (anchor && (name === "href" || name === "xlink:href"))) {
      remember(name);
      removeAttributes.push(name);
    }
  }
  if (anchor && (authored.has("href") || authored.has("xlink:href"))) {
    remember("aria-disabled");
    setAttributes.push({ name: "aria-disabled", value: "true" });
    if (!element.hasAttribute("role")) {
      remember("role");
      setAttributes.push({ name: "role", value: "link" });
    }
  }
  if (
    html &&
    element.tagName === "input" &&
    element.getAttribute("type")?.toLowerCase() === "number" &&
    !element.hasAttribute("readonly")
  ) {
    remember("readonly");
    setAttributes.push({ name: "readonly", value: "" });
  }
  // The dialog method never submits to a URL, and keeps the existing form
  // ownership for input state, radio groups and focus in the preview.
  if (html && element.tagName === "form") {
    remember("method");
    setAttributes.push({ name: "method", value: "dialog" });
  }
  if (
    html &&
    (element.tagName === "button" || element.tagName === "input") &&
    element.hasAttribute("formmethod")
  ) {
    remember("formmethod");
    setAttributes.push({ name: "formmethod", value: "dialog" });
  }
  // The HTMLRewriter can expose nested provenance with entities still escaped.
  // Leave the already-materialized guest's marker for the browser to decode.
  if (authored.size !== 0 && !element.hasAttribute(SSR_PREVIEW_ATTRIBUTES)) {
    recordAuthoredAttributes(setAttributes, SSR_PREVIEW_ATTRIBUTES, authored);
  }
  return { removeAttributes, setAttributes };
}

export interface RewriteAssetAttributesOptions {
  /** Decodes raw HTML-encoded attribute values before URL/CSS rewriting. */
  decode?(value: string): string;
  /** Encodes rewritten attribute values for a rewriter whose setAttribute preserves entities. */
  encode?(value: string): string;
}

/** Rebase preview resources while retaining authored values for hydration. */
export function rewriteAssetAttributes(
  element: AssetElementAttributes,
  baseURL: string,
  options: RewriteAssetAttributesOptions = {},
): AttributeAssignment[] {
  const node = {
    localName: element.tagName,
    namespaceURI: element.namespaceURI,
  };
  const decode = options.decode;
  const encode = options.encode;
  const assignments: AttributeAssignment[] = [];
  const authored = new Map<string, string | null>();
  for (const [name, rawValue] of element.attributes) {
    const prefixed = name.startsWith("xlink:");
    const decoded = decode ? decode(rawValue) : rawValue;
    let rewritten: string | null;
    try {
      rewritten = rewriteAssetAttribute(
        node,
        prefixed ? name.slice("xlink:".length) : name,
        prefixed ? XLINK_NAMESPACE : null,
        decoded,
        baseURL,
      );
    } catch {
      continue;
    }
    if (rewritten !== null) {
      authored.set(name, rawValue);
      assignments.push({ name, value: encode ? encode(rewritten) : rewritten });
    }
  }
  if (authored.size !== 0 && !element.hasAttribute(SSR_ATTRIBUTES)) {
    // Materializing nested, already-materialized markup must not discard its
    // original attributes. Existing provenance belongs to that inner guest.
    recordAuthoredAttributes(assignments, SSR_ATTRIBUTES, authored);
  }
  return assignments;
}

export interface ScriptElementRewrite {
  /** Attributes to remove, before the assignments below are applied. */
  removeAttributes: readonly string[];
  setAttributes: readonly AttributeAssignment[];
}

/**
 * Describes the attribute edits that make a guest script parser-inert, or
 * returns null when the script is already materialized. Materializing an inert
 * script twice would record `application/vnd.v-frame` as its authored type and
 * leave the guest with a script the runtime can never restore.
 */
export function rewriteScriptElement(
  script: ScriptElementAttributes,
): ScriptElementRewrite | null {
  const authoredType = script.getAttribute("type");
  if (
    authoredType === INERT_SCRIPT_TYPE &&
    script.hasAttribute(SCRIPT_MARKER_ATTRIBUTE)
  ) {
    return null;
  }

  const setAttributes: AttributeAssignment[] = [
    { name: "type", value: INERT_SCRIPT_TYPE },
    { name: SCRIPT_MARKER_ATTRIBUTE, value: "" },
  ];
  if (authoredType !== null) {
    setAttributes.push({ name: SCRIPT_TYPE_ATTRIBUTE, value: authoredType });
  }

  return {
    // A guest that authors the marker attributes itself must not be able to
    // smuggle a stale authored type past neutralization.
    removeAttributes: [SCRIPT_MARKER_ATTRIBUTE, SCRIPT_TYPE_ATTRIBUTE],
    setAttributes,
  };
}

export interface MaterializeStylesheetOptions {
  /** Fetches a stylesheet. Return original bytes for links with integrity metadata. */
  fetchText?: ServerStylesheetFetch;
  /** Called when an `@import` cannot be inlined (the rule is dropped), or when a linked or inline stylesheet cannot be materialized at all (the runtime handles it at activation). Not called once `signal` is aborted. */
  onImportFailure?(failure: StylesheetImportFailure): void;
  /** HTML-safe font declarations to put in a host style before the SSR frame. */
  onFontFace?(css: string): void;
  /** Aborts the fetches still in flight and silences their failures. */
  signal?: AbortSignal;
  /** Maximum byte length accepted for a single stylesheet. Defaults to 2 MiB. */
  maxStylesheetBytes?: number;
  /** Maximum distinct stylesheet fetches per materialization. Defaults to 64. */
  maxStylesheets?: number;
  /** Maximum nested `@import` depth. Defaults to 8. */
  maxImportDepth?: number;
  /** Maximum concurrent stylesheet fetches. Defaults to 8. */
  maxConcurrency?: number;
}

export interface StylesheetBytes {
  bytes: ArrayBuffer;
  /** Final public URL, including redirects. */
  url: string;
}

export interface ServerStylesheetFetch {
  (
    url: string,
    options?: StylesheetFetchOptions,
  ): Promise<string | StylesheetSource | StylesheetBytes>;
}

/**
 * Default SSR stylesheet fetcher: restricted to same-origin HTTP(S) URLs
 * without embedded credentials, manual redirects, 200 responses, and a byte cap.
 * Pass a custom `options.fetchText` for cross-origin or internal routing.
 */
export function createDefaultStylesheetFetch(
  documentURL: string,
  maxBytes = DEFAULT_MAX_STYLESHEET_BYTES,
): ServerStylesheetFetch {
  const allowedOrigin = URL.parse(documentURL)?.origin ?? null;
  return async (url, { signal } = {}) => {
    const target = URL.parse(url);
    if (
      target === null ||
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username !== "" ||
      target.password !== "" ||
      (allowedOrigin !== null && target.origin !== allowedOrigin)
    ) {
      throw new TypeError(
        `v-frame SSR stylesheet ${url} must be a same-origin HTTP(S) URL`,
      );
    }
    const init: RequestInit = { redirect: "manual" };
    if (signal !== undefined) init.signal = signal;
    const response = await fetch(target.href, init);
    if (response.redirected || response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw new TypeError(
        `v-frame SSR stylesheet ${url} returned ${response.status} ${response.statusText}`,
      );
    }
    return {
      bytes: await readBoundedBytes(response, maxBytes, `v-frame SSR stylesheet ${url}`),
      url: response.url || target.href,
    };
  };
}

export async function fetchStylesheetSource(
  url: string,
  { signal }: StylesheetFetchOptions = {},
): Promise<StylesheetBytes> {
  return createDefaultStylesheetFetch(url)(
    url,
    signal ? { signal } : undefined,
  ) as Promise<StylesheetBytes>;
}

/** Wraps a stylesheet fetcher with total fetch budget, concurrency cap, and byte limit. */
export function createBoundedStylesheetFetch(
  fetchText: ServerStylesheetFetch,
  options: {
    maxStylesheets?: number;
    maxConcurrency?: number;
    maxStylesheetBytes?: number;
  } = {},
): ServerStylesheetFetch {
  const maxStylesheets = options.maxStylesheets ?? DEFAULT_MAX_STYLESHEETS;
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const maxStylesheetBytes = options.maxStylesheetBytes ?? DEFAULT_MAX_STYLESHEET_BYTES;
  let totalFetches = 0;
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active < maxConcurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        active += 1;
        resolve();
      };
      const onAbort = () => {
        const index = waiters.indexOf(wake);
        if (index !== -1) waiters.splice(index, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(wake);
    });
  };
  const release = () => {
    active -= 1;
    waiters.shift()?.();
  };
  return async (url, request) => {
    if (totalFetches >= maxStylesheets) {
      throw new RangeError(
        `v-frame SSR exceeded maximum of ${maxStylesheets} stylesheet fetches`,
      );
    }
    totalFetches += 1;
    if (active < maxConcurrency) {
      if (request?.signal?.aborted) throw request.signal.reason;
      active += 1;
    } else {
      await acquire(request?.signal);
    }
    try {
      const result = await fetchText(url, request);
      const byteLength =
        typeof result === "string"
          ? new TextEncoder().encode(result).byteLength
          : "bytes" in result
            ? result.bytes.byteLength
            : new TextEncoder().encode(result.text).byteLength;
      if (byteLength > maxStylesheetBytes) {
        throw new RangeError(
          `v-frame SSR stylesheet ${url} exceeded maximum size of ${maxStylesheetBytes} bytes`,
        );
      }
      return result;
    } finally {
      release();
    }
  };
}

const INTEGRITY_ALGORITHMS = ["SHA-256", "SHA-384", "SHA-512"];

/** Verify before decoding: the authored digest covers the response's original bytes. */
export async function readStylesheetSource(
  source: string | StylesheetSource | StylesheetBytes,
  url: string,
  integrity = "",
): Promise<StylesheetSource> {
  if (integrity.trim() !== "") {
    let strength = -1;
    const expected = new Set<string>();
    for (const token of integrity.trim().split(/[\t\n\f\r ]+/)) {
      const expression = token.split("?", 1)[0]!;
      const match = /^sha(256|384|512)(?:-|$)/.exec(expression);
      if (!match) continue;
      const candidate = INTEGRITY_ALGORITHMS.indexOf(`SHA-${match[1]}`);
      if (candidate < strength) continue;
      if (candidate > strength) {
        expected.clear();
        strength = candidate;
      }
      expected.add(
        expression
          .slice(match[0].length)
          .replaceAll("-", "+")
          .replaceAll("_", "/")
          .replace(/={1,2}$/, ""),
      );
    }
    if (strength !== -1) {
      if (typeof source === "string" || !("bytes" in source)) {
        throw new TypeError(
          `v-frame SSR stylesheet ${url} needs original bytes to verify integrity`,
        );
      }
      const digest = new Uint8Array(
        await crypto.subtle.digest(INTEGRITY_ALGORITHMS[strength]!, source.bytes),
      );
      const actual = btoa(String.fromCharCode(...digest)).replace(/=+$/, "");
      if (!expected.has(actual)) {
        throw new TypeError(`v-frame SSR stylesheet ${url} failed its integrity check`);
      }
    }
  }
  if (typeof source === "string") return { text: source, url };
  if ("bytes" in source)
    return { text: new TextDecoder().decode(source.bytes), url: source.url };
  return source;
}

/**
 * Escapes a rewritten stylesheet for insertion into an HTML `style` element.
 * The text is inserted raw so CSS operators such as `>` survive, which leaves
 * exactly one sequence that could terminate the element early; a CSS escape
 * neutralizes it without changing what the CSS parser sees.
 */
export function escapeStylesheetText(source: string): string {
  return source.replace(/<\/style/gi, "\\3c /style");
}

/**
 * Rewrites one inline stylesheet for the guest's public URL and returns text
 * that can be written straight back into the `style` element it came from.
 */
export async function materializeStylesheet(
  source: string,
  documentURL: string,
  options: MaterializeStylesheetOptions = {},
): Promise<string> {
  const maxStylesheetBytes = options.maxStylesheetBytes ?? DEFAULT_MAX_STYLESHEET_BYTES;
  const maxImportDepth = options.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH;
  const baseFetch =
    options.fetchText ?? createDefaultStylesheetFetch(documentURL, maxStylesheetBytes);
  const fetchText = createBoundedStylesheetFetch(baseFetch, {
    maxStylesheetBytes,
    ...(options.maxStylesheets !== undefined
      ? { maxStylesheets: options.maxStylesheets }
      : {}),
    ...(options.maxConcurrency !== undefined
      ? { maxConcurrency: options.maxConcurrency }
      : {}),
  });
  const load: StylesheetFetch = async (url, request) =>
    readStylesheetSource(await fetchText(url, request), url, request?.integrity);
  const context = createStylesheetContext(
    load,
    options.onImportFailure,
    options.signal,
    maxImportDepth,
  );
  const rewritten = await rewriteStylesheet(source, documentURL, context);
  const fonts = options.onFontFace ? extractFontFaces(rewritten, documentURL) : "";
  if (fonts) options.onFontFace?.(escapeStylesheetText(fonts));
  return escapeStylesheetText(rewritten);
}
