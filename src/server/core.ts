import { createStylesheetContext, extractFontFaces, rewriteStylesheet } from "../css.js";
import { rewriteAssetAttribute, XLINK_NAMESPACE } from "../asset-urls.js";
import type {
  StylesheetFetch,
  StylesheetFetchOptions,
  StylesheetImportFailure,
} from "../css.js";
import {
  INERT_SCRIPT_TYPE,
  SCRIPT_MARKER_ATTRIBUTE,
  SCRIPT_TYPE_ATTRIBUTE,
  SHELL_ELEMENT_NAMES,
  SSR_ATTRIBUTES,
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
export const SHELL_DISPLAY_STYLE: string = `<style ${SSR_STYLE}>:host{contain:layout;display:block;position:relative;overflow:auto}v-html,v-body{display:block}v-head{display:none!important}</style>`;

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
  const authored: Record<string, string> = {};
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
      authored[name] = value;
      assignments.push({ name, value: rewritten });
    }
  }
  if (assignments.length) {
    // Materializing nested, already-materialized markup must not discard its
    // original attributes. Existing provenance belongs to that inner guest.
    const existing = element.getAttribute(SSR_ATTRIBUTES);
    assignments.push({
      name: SSR_ATTRIBUTES,
      value: existing ?? JSON.stringify(authored),
    });
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
  /** Fetches a linked stylesheet or `@import`. Defaults to platform `fetch`. */
  fetchText?: StylesheetFetch;
  /** Called when an `@import` cannot be inlined (the rule is dropped), or when a linked or inline stylesheet cannot be materialized at all (the runtime handles it at activation). Not called once `signal` is aborted. */
  onImportFailure?(failure: StylesheetImportFailure): void;
  /** HTML-safe font declarations to put in a host style before the SSR frame. */
  onFontFace?(css: string): void;
  /** Aborts the fetches still in flight and silences their failures. */
  signal?: AbortSignal;
}

export async function fetchStylesheetSource(
  url: string,
  { signal }: StylesheetFetchOptions = {},
) {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new TypeError(
      `v-frame SSR stylesheet ${url} returned ${response.status} ${response.statusText}`,
    );
  }
  return { text: await response.text(), url: response.url || url };
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
  const context = createStylesheetContext(
    options.fetchText ?? fetchStylesheetSource,
    options.onImportFailure,
    options.signal,
  );
  const rewritten = await rewriteStylesheet(source, documentURL, context);
  const fonts = options.onFontFace ? extractFontFaces(rewritten, documentURL) : "";
  if (fonts) options.onFontFace?.(escapeStylesheetText(fonts));
  return escapeStylesheetText(rewritten);
}
