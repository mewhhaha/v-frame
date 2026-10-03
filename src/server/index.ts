export { materializeVFrameDocument } from "./cloudflare.js";
export {
  fragmentIdentifiers,
  fragmentTargetRank,
  FRAGMENT_TARGET_ATTRIBUTE,
} from "../fragment.js";
export type { FragmentElement } from "../fragment.js";
export {
  escapeStylesheetText,
  INERT_SCRIPT_TYPE,
  materializeStylesheet,
  rewriteAssetAttributes,
  rewriteScriptElement,
  rewriteShellElement,
  SCRIPT_MARKER_ATTRIBUTE,
  SCRIPT_TYPE_ATTRIBUTE,
  SHELL_DISPLAY_STYLE,
} from "./core.js";
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
  StylesheetImportFailure,
  StylesheetSource,
} from "../css.js";
