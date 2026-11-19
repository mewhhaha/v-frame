import { createStylesheetContext, extractFontFaces, rewriteStylesheet } from "../css.js";
import {
  HTML_NAMESPACE,
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

/** Keeps preview controls editable while deferring executable and navigation attributes. */
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

/** Rebase preview resources while retaining authored values for hydration. */
export function rewriteAssetAttributes(
  element: AssetElementAttributes,
  baseURL: string,
): AttributeAssignment[] {
  const node = {
    localName: element.tagName,
    namespaceURI: element.namespaceURI,
  };
  const assignments: AttributeAssignment[] = [];
  const authored = new Map<string, string | null>();
  for (const [name, value] of element.attributes) {
    const prefixed = name.startsWith("xlink:");
    const rewritten = rewriteAssetAttribute(
      node,
      prefixed ? name.slice("xlink:".length) : name,
      prefixed ? XLINK_NAMESPACE : null,
      value,
      baseURL,
    );
    if (rewritten !== null) {
      authored.set(name, value);
      assignments.push({ name, value: rewritten });
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

export async function fetchStylesheetSource(
  url: string,
  { signal }: StylesheetFetchOptions = {},
): Promise<StylesheetBytes> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new TypeError(
      `v-frame SSR stylesheet ${url} returned ${response.status} ${response.statusText}`,
    );
  }
  return { bytes: await response.arrayBuffer(), url: response.url || url };
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
  const fetchText = options.fetchText ?? fetchStylesheetSource;
  const load: StylesheetFetch = async (url, request) =>
    readStylesheetSource(await fetchText(url, request), url, request?.integrity);
  const context = createStylesheetContext(load, options.onImportFailure, options.signal);
  const rewritten = await rewriteStylesheet(source, documentURL, context);
  const fonts = options.onFontFace ? extractFontFaces(rewritten, documentURL) : "";
  if (fonts) options.onFontFace?.(escapeStylesheetText(fonts));
  return escapeStylesheetText(rewritten);
}
