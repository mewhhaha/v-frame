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

/** The authored `rel` of a stylesheet link the server neutralized. */
export const SSR_LINK_REL = "data-v-frame-rel";

/** Marks the `<style>` a server materialized beside its authored link. */
export const SSR_LINK_STYLE = "data-v-frame-linked";

/** Where the server preview records the URL a materialized stylesheet came from. */
export const SSR_LINK_SOURCE = "data-v-frame-source";

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
