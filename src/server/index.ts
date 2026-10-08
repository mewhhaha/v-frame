export { materializeVFrameDocument } from "./html-rewriter.js";
export type {
  HTMLRewriterConstructor,
  MaterializeDocumentOptions,
} from "./html-rewriter.js";
export { fragmentIdentifiers, fragmentTargetRank } from "../fragment.js";
export type { FragmentElement } from "../fragment.js";
export {
  escapeStylesheetText,
  materializeStylesheet,
  rewriteAssetAttributes,
  rewriteScriptElement,
  rewriteShellElement,
  SHELL_DISPLAY_STYLE,
} from "./core.js";
export {
  FRAGMENT_TARGET_ATTRIBUTE,
  INERT_SCRIPT_TYPE,
  SCRIPT_MARKER_ATTRIBUTE,
  SCRIPT_TYPE_ATTRIBUTE,
  NEUTRALIZED_STYLESHEET_REL,
  SSR_LINK_REL,
  SSR_LINK_SOURCE,
  SSR_LINK_STYLE,
  SSR_STYLE,
} from "../wire-format.js";
export type {
  AttributeAssignment,
  AssetElementAttributes,
  MaterializeStylesheetOptions,
  ScriptElementAttributes,
  ScriptElementRewrite,
  ShellElementRewrite,
} from "./core.js";

// The stylesheet rewriter is pure and runtime-neutral, so a host on any runtime
// can drive it from its own streaming HTML parser.
export { createStylesheetContext, rewriteStylesheet } from "../css.js";
export type {
  StylesheetContext,
  StylesheetFetch,
  StylesheetFetchOptions,
  StylesheetImportFailure,
  StylesheetSource,
} from "../css.js";
