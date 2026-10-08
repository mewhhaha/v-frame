export type ScriptCategory = "classic" | "module" | "importmap" | "inert";

const CLASSIC_SCRIPT_TYPES = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

// The type attribute is stripped of ASCII whitespace only: a type padded with
// U+00A0 or U+FEFF names no script type, and String.prototype.trim would strip both.
const ASCII_WHITESPACE_EDGES = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

export function scriptCategory(script: HTMLScriptElement): ScriptCategory {
  const type =
    script.getAttribute("type")?.replace(ASCII_WHITESPACE_EDGES, "").toLowerCase() ?? "";
  if (type === "module" || type === "importmap") {
    return type;
  }
  return CLASSIC_SCRIPT_TYPES.has(type) && !script.hasAttribute("nomodule")
    ? "classic"
    : "inert";
}
