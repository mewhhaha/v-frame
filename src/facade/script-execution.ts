// A script the guest creates with the DOM runs once, when it is both connected
// and runnable, and in the mode its `async` property chose. Everything that can
// complete a script — insertion, a `src` or `text` write — asks this module
// rather than deciding for itself, so "once" holds across all of them.

import { scriptCategory } from "../script-type.js";
import type { FacadeContext } from "./context.js";

export interface ScriptExecution {
  executeConnectedScript(script: HTMLScriptElement): void;
  dynamicScriptExecution: WeakMap<HTMLScriptElement, "async" | "ordered">;
  executedScripts: WeakSet<HTMLScriptElement>;
}

export function createScriptExecution(context: FacadeContext): ScriptExecution {
  const { createdScripts } = context;
  const options = context.options;

  const dynamicScriptExecution = new WeakMap<HTMLScriptElement, "async" | "ordered">();
  const executedScripts = new WeakSet<HTMLScriptElement>();

  const scriptCanExecute = (script: HTMLScriptElement): boolean => {
    if (scriptCategory(script) === "inert") {
      return false;
    }
    const source = script.getAttribute("src");
    return source !== null || script.text !== "";
  };

  const executeConnectedScript = (script: HTMLScriptElement): void => {
    if (
      !script.isConnected ||
      !createdScripts.has(script) ||
      executedScripts.has(script) ||
      !scriptCanExecute(script)
    ) {
      return;
    }
    executedScripts.add(script);
    options.onDynamicScript(script, dynamicScriptExecution.get(script) ?? "async");
  };

  return { executeConnectedScript, dynamicScriptExecution, executedScripts };
}
