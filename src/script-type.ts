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

export function scriptCategory(script: HTMLScriptElement): ScriptCategory {
  const type = script.getAttribute("type")?.trim().toLowerCase() ?? "";
  if (type === "module" || type === "importmap") {
    return type;
  }
  return CLASSIC_SCRIPT_TYPES.has(type) && !script.hasAttribute("nomodule")
    ? "classic"
    : "inert";
}
