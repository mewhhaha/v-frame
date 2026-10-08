// Node and script properties whose setters can change what the facade tracks:
// shadow roots a guest attaches, a script's execution mode and text, and the
// character data of a <style>, whose rules are re-read on every change.

import type { FacadeContext } from "./context.js";
import type { NodeInsertion } from "./insertion.js";
import type { NodeMarking } from "./marking.js";
import type { ScriptExecution } from "./script-execution.js";

export interface NodePatches {
  installPatches(): void;
}

export function createNodePatches(
  context: FacadeContext,
  marking: NodeMarking,
  insertion: NodeInsertion,
  scripts: ScriptExecution,
): NodePatches {
  const options = context.options;
  const {
    window,
    nodePrototype,
    characterDataPrototype,
    elementPrototype,
    nativeAttachShadow,
    nativeTextContent,
    nativeNodeValue,
    nativeCharacterData,
    nativeAppendData,
    nativeDeleteData,
    nativeInsertData,
    nativeReplaceData,
    nativeScriptAsync,
    nativeScriptText,
    nativeScriptType,
    isInVirtualDocumentTree,
    subtreeHasBaseElement,
    virtualNodes,
    createdScripts,
    protectedScriptAttributes,
    patch,
  } = context;
  const { markVirtualNode } = marking;
  const { styleElementChanged } = insertion;
  const { executeConnectedScript, dynamicScriptExecution } = scripts;

  const installPatches = (): void => {
    patch(elementPrototype, "attachShadow", {
      writable: true,
      value(this: Element, init: ShadowRootInit): ShadowRoot {
        const shadowRoot = nativeAttachShadow.call(this, init);
        if (virtualNodes.has(this)) {
          markVirtualNode(shadowRoot);
        }
        return shadowRoot;
      },
    });
    if (nativeScriptAsync?.get !== undefined && nativeScriptAsync.set !== undefined) {
      patch(window.HTMLScriptElement.prototype, "async", {
        get: nativeScriptAsync.get,
        set(this: HTMLScriptElement, value: boolean) {
          if (createdScripts.has(this)) {
            dynamicScriptExecution.set(this, value ? "async" : "ordered");
          }
          nativeScriptAsync.set?.call(this, value);
        },
      });
    }
    if (nativeScriptText?.get !== undefined && nativeScriptText.set !== undefined) {
      patch(window.HTMLScriptElement.prototype, "text", {
        get: nativeScriptText.get,
        set(this: HTMLScriptElement, value: string) {
          nativeScriptText.set?.call(this, value);
          if (virtualNodes.has(this)) {
            executeConnectedScript(this);
          }
        },
      });
    }
    if (nativeScriptType?.get !== undefined && nativeScriptType.set !== undefined) {
      patch(window.HTMLScriptElement.prototype, "type", {
        get(this: HTMLScriptElement) {
          if (!protectedScriptAttributes.has(this)) {
            return nativeScriptType.get?.call(this) ?? "";
          }
          return protectedScriptAttributes.get(this)?.get("type") ?? "";
        },
        set(this: HTMLScriptElement, value: string) {
          if (!protectedScriptAttributes.has(this)) {
            nativeScriptType.set?.call(this, value);
            return;
          }
          this.setAttribute("type", value);
        },
      });
    }
    if (nativeTextContent?.get !== undefined && nativeTextContent.set !== undefined) {
      patch(nodePrototype, "textContent", {
        get: nativeTextContent.get,
        set(this: Node, value: string | null) {
          const removedNodes = virtualNodes.has(this) ? Array.from(this.childNodes) : [];
          const baseElementChanged =
            isInVirtualDocumentTree(this) && subtreeHasBaseElement(this);
          nativeTextContent.set?.call(this, value);
          if (removedNodes.length > 0) {
            options.onDisconnectedNodes(removedNodes);
          }
          styleElementChanged(this);
          if (baseElementChanged) {
            options.onBaseElementChange();
          }
          if (virtualNodes.has(this) && this instanceof window.HTMLScriptElement) {
            executeConnectedScript(this);
          }
        },
      });
    }
    if (nativeNodeValue?.get !== undefined && nativeNodeValue.set !== undefined) {
      patch(nodePrototype, "nodeValue", {
        get: nativeNodeValue.get,
        set(this: Node, value: string | null) {
          nativeNodeValue.set?.call(this, value);
          styleElementChanged(this);
        },
      });
    }
    if (nativeCharacterData?.get !== undefined && nativeCharacterData.set !== undefined) {
      patch(characterDataPrototype, "data", {
        get: nativeCharacterData.get,
        set(this: CharacterData, value: string) {
          nativeCharacterData.set?.call(this, value);
          styleElementChanged(this);
        },
      });
    }
    for (const [methodName, nativeMethod] of [
      ["appendData", nativeAppendData],
      ["deleteData", nativeDeleteData],
      ["insertData", nativeInsertData],
      ["replaceData", nativeReplaceData],
    ] as const) {
      patch(characterDataPrototype, methodName, {
        writable: true,
        value(this: CharacterData, ...args: unknown[]) {
          const result = Reflect.apply(nativeMethod, this, args);
          styleElementChanged(this);
          return result;
        },
      });
    }
  };

  return { installPatches };
}
