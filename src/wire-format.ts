/**
 * The markup contract between a server materializer and the client runtime that
 * adopts its output. Both sides spell these names, so they live in one module
 * that stays free of DOM globals for the server entry to import.
 */

/** The parser-inert type a materialized guest script carries until activation. */
export const INERT_SCRIPT_TYPE = "application/vnd.v-frame";

/** Marks a script that a materializer neutralized. */
export const SCRIPT_MARKER_ATTRIBUTE = "data-v-frame-script";

/** Carries the authored script type across neutralization. */
export const SCRIPT_TYPE_ATTRIBUTE = "data-v-frame-type";

/** Authored asset values retained while the server preview uses absolute URLs. */
export const SSR_ATTRIBUTES = "data-v-frame-attributes";

/** Attributes suppressed or changed until the preview activates. */
export const SSR_PREVIEW_ATTRIBUTES = "data-v-frame-preview-attributes";

/** The authored `rel` of a stylesheet link the server neutralized. */
export const SSR_LINK_REL = "data-v-frame-rel";

/** Marks the `<style>` a server materialized beside its authored link. */
export const SSR_LINK_STYLE = "data-v-frame-linked";

/** Where the server preview records the URL a materialized stylesheet came from. */
export const SSR_LINK_SOURCE = "data-v-frame-source";

/** Integrity metadata verified on a materialized linked stylesheet. */
export const SSR_LINK_INTEGRITY = "data-v-frame-integrity";

/** Marks the element a guest URL's fragment targets, for `:target` to match. */
export const FRAGMENT_TARGET_ATTRIBUTE = "data-v-frame-target";

/**
 * The `rel` of a stylesheet link whose loading v-frame has taken over: the server
 * neutralizes the link in markup, and the client recognizes and writes it.
 */
export const NEUTRALIZED_STYLESHEET_REL = "v-frame-stylesheet";

/** Marks a `<style>` the server materialized; unmarked guest styles are rewritten at activation. */
export const SSR_STYLE = "data-v-frame-materialized";

/** The shell tags the guest document has and the custom elements that stand in for them. */
export const SHELL_ELEMENT_NAMES: ReadonlyMap<string, string> = new Map([
  ["html", "v-html"],
  ["head", "v-head"],
  ["body", "v-body"],
]);

const RESERVED_SSR_ATTRIBUTES = new Set([
  SCRIPT_MARKER_ATTRIBUTE,
  SCRIPT_TYPE_ATTRIBUTE,
  SSR_ATTRIBUTES,
  SSR_PREVIEW_ATTRIBUTES,
  SSR_LINK_REL,
  SSR_LINK_STYLE,
  SSR_LINK_SOURCE,
  SSR_LINK_INTEGRITY,
  FRAGMENT_TARGET_ATTRIBUTE,
  SSR_STYLE,
]);

/** True when an attribute name belongs to the SSR wire format and must be server-owned. */
export function isReservedSSRAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    RESERVED_SSR_ATTRIBUTES.has(lower) ||
    lower.startsWith(`${SSR_ATTRIBUTES}-`) ||
    lower.startsWith(`${SSR_PREVIEW_ATTRIBUTES}-`)
  );
}
