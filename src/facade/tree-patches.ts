// The tree-mutation methods, patched so that every node entering or leaving a
// virtual parent goes through insertion's bookkeeping. A parent the facade does
// not own takes the native path untouched.

import type { NodeCloning } from "./clone.js";
import type { FacadeContext } from "./context.js";
import type { NodeInsertion } from "./insertion.js";
import type { NodeArguments } from "./node-arguments.js";
import type { ScriptExecution } from "./script-execution.js";

export interface TreePatches {
  installPatches(): void;
}

export function createTreePatches(
  context: FacadeContext,
  insertion: NodeInsertion,
  cloning: NodeCloning,
  scripts: ScriptExecution,
  nodeArguments: NodeArguments,
): TreePatches {
  const options = context.options;
  const {
    window,
    document,
    hostDocument,
    nodePrototype,
    elementPrototype,
    documentFragmentPrototype,
    nativeAppendChild,
    nativeInsertBefore,
    nativeReplaceChild,
    nativeRemoveChild,
    nativeCloneNode,
    nativeImportNode,
    nativeElementRemove,
    isInVirtualDocumentTree,
    subtreeHasBaseElement,
    virtualNodes,
    patch,
  } = context;
  const {
    insert,
    prepareInsertion,
    insertedNodes,
    finishInsertion,
    styleElementChanged,
    performStyleMutationBatch,
    appendValues,
    insertValuesAround,
  } = insertion;
  const { finishVirtualClone } = cloning;
  const { executeConnectedScript } = scripts;
  const { requireNode, toNodes } = nodeArguments;

  const installPatches = (): void => {
    patch(nodePrototype, "appendChild", {
      writable: true,
      value<T extends Node>(this: Node, node: T): T {
        return insert(
          this,
          node,
          "appendChild",
          () => nativeAppendChild.call(this, node) as T,
        );
      },
    });
    patch(nodePrototype, "insertBefore", {
      writable: true,
      value<T extends Node>(this: Node, node: T, child: Node | null): T {
        return insert(
          this,
          node,
          "insertBefore",
          () => nativeInsertBefore.call(this, node, child) as T,
        );
      },
    });
    patch(nodePrototype, "replaceChild", {
      writable: true,
      value<T extends Node>(this: Node, node: Node, child: T): T {
        if (!virtualNodes.has(this)) {
          return nativeReplaceChild.call(this, node, child) as T;
        }
        requireNode(node, "replaceChild", 1);
        requireNode(child, "replaceChild", 2);
        prepareInsertion(node);
        const nodes = insertedNodes(node);
        const baseElementChanged =
          subtreeHasBaseElement(child) || nodes.some(subtreeHasBaseElement);
        const result = nativeReplaceChild.call(this, node, child) as T;
        // Replacing a node with itself leaves it where it was.
        if (node !== child) {
          options.onDisconnectedNodes([child]);
        }
        if (this.isConnected) {
          finishInsertion(nodes, baseElementChanged);
          if (this instanceof window.HTMLScriptElement) {
            executeConnectedScript(this);
          }
        }
        return result;
      },
    });
    patch(nodePrototype, "removeChild", {
      writable: true,
      value<T extends Node>(this: Node, child: T): T {
        if (!virtualNodes.has(this)) {
          return nativeRemoveChild.call(this, child) as T;
        }
        const baseElementChanged = this.isConnected && subtreeHasBaseElement(child);
        const result = nativeRemoveChild.call(this, child) as T;
        options.onDisconnectedNodes([child]);
        styleElementChanged(this);
        if (baseElementChanged) {
          options.onBaseElementChange();
        }
        return result;
      },
    });
    patch(elementPrototype, "remove", {
      writable: true,
      value(this: Element): void {
        const virtual = virtualNodes.has(this);
        const baseElementChanged =
          isInVirtualDocumentTree(this) && subtreeHasBaseElement(this);
        nativeElementRemove.call(this);
        if (virtual) {
          options.onDisconnectedNodes([this]);
        }
        if (baseElementChanged) {
          options.onBaseElementChange();
        }
      },
    });
    patch(nodePrototype, "cloneNode", {
      writable: true,
      value(this: Node, deep = false): Node {
        if (!virtualNodes.has(this)) {
          return nativeCloneNode.call(this, deep);
        }
        const clone = nativeImportNode.call(document, this, deep);
        hostDocument.adoptNode(clone);
        return finishVirtualClone(this, clone);
      },
    });

    for (const prototype of [elementPrototype, documentFragmentPrototype]) {
      patch(prototype, "append", {
        writable: true,
        value(this: Node, ...values: Array<Node | string>) {
          appendValues(this, values, false);
        },
      });
      patch(prototype, "prepend", {
        writable: true,
        value(this: Node, ...values: Array<Node | string>) {
          appendValues(this, values, true);
        },
      });
      const nativeReplaceChildren = prototype.replaceChildren;
      // The browser validates the whole replacement before it removes anything
      // and reports it as one mutation, so the insertion goes through it whole:
      // removing the children first would leave them gone when it is rejected,
      // and would hand observers a record per child.
      patch(prototype, "replaceChildren", {
        writable: true,
        value(this: Node, ...values: Array<Node | string>) {
          if (!virtualNodes.has(this)) {
            return Reflect.apply(nativeReplaceChildren, this, values);
          }
          const nodes = toNodes(values);
          for (const node of nodes) {
            prepareInsertion(node);
          }
          const inserted = nodes.flatMap(insertedNodes);
          const removed = Array.from(this.childNodes);
          const baseElementChanged =
            this.isConnected &&
            (removed.some(subtreeHasBaseElement) || inserted.some(subtreeHasBaseElement));
          performStyleMutationBatch(this, () => {
            Reflect.apply(nativeReplaceChildren, this, nodes);
            options.onDisconnectedNodes(removed);
            if (this.isConnected) {
              finishInsertion(inserted, baseElementChanged);
              if (this instanceof window.HTMLScriptElement) {
                executeConnectedScript(this);
              }
            }
          });
        },
      });
    }

    for (const prototype of [
      elementPrototype,
      window.CharacterData.prototype,
      window.DocumentType.prototype,
    ]) {
      for (const placement of ["before", "after", "replace"] as const) {
        patch(prototype, placement === "replace" ? "replaceWith" : placement, {
          writable: true,
          value(this: ChildNode, ...values: Array<Node | string>) {
            insertValuesAround(this, values, placement);
          },
        });
      }
    }
  };

  return { installPatches };
}
