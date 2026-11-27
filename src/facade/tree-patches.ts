// The tree-mutation methods, patched so that every node entering or leaving a
// virtual parent goes through insertion's bookkeeping. A parent the facade does
// not own takes the native path untouched.

import type { NodeCloning } from "./clone.js";
import type { FacadeContext } from "./context.js";
import type { NodeInsertion } from "./insertion.js";
import type { NodeMarking } from "./marking.js";
import type { NodeArguments } from "./node-arguments.js";
import type { ScriptExecution } from "./script-execution.js";

export interface TreePatches {
  installPatches(): void;
}

export function createTreePatches(
  context: FacadeContext,
  marking: NodeMarking,
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
    insertDirect,
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

  const maybeNoteDetached = (node: Node): void => {
    if (node.nodeType !== 1 || !isInVirtualDocumentTree(node)) {
      return;
    }
    const element = node as Element;
    const firstChildEl = element.firstElementChild;
    // Skip tiny shallow branches where watching costs more than walking on re-attach.
    if (
      firstChildEl === null ||
      (element.childElementCount < 4 && firstChildEl.firstElementChild === null)
    ) {
      return;
    }
    marking.noteDetachedCandidate(element);
  };

  const installPatches = (): void => {
    patch(nodePrototype, "appendChild", {
      writable: true,
      value<T extends Node>(this: Node, node: T): T {
        return insertDirect(this, node, "appendChild");
      },
    });
    patch(nodePrototype, "insertBefore", {
      writable: true,
      value<T extends Node>(this: Node, node: T, child: Node | null): T {
        return insertDirect(this, node, "insertBefore", child);
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
        const scan = prepareInsertion(node);
        const nodes = insertedNodes(node);
        const baseElementChanged =
          subtreeHasBaseElement(child) ||
          (scan !== undefined ? scan.hasBase : nodes.some(subtreeHasBaseElement));
        const result = nativeReplaceChild.call(this, node, child) as T;
        // Replacing a node with itself leaves it where it was.
        if (node !== child) {
          options.onDisconnectedNodes([child]);
        }
        if (this.isConnected) {
          finishInsertion(nodes, baseElementChanged, scan);
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
        const removingConnected = this.isConnected && child.parentNode === this;
        if (removingConnected) {
          maybeNoteDetached(child);
        }
        const hasSpecial = removingConnected
          ? options.settledSubtreeHas?.(child, false)
          : undefined;
        const baseElementChanged =
          this.isConnected &&
          (options.settledSubtreeHas?.(child, true) ?? subtreeHasBaseElement(child));
        const result = nativeRemoveChild.call(this, child) as T;
        if (hasSpecial !== false) {
          options.onDisconnectedNodes([child]);
        }
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
        const inVirtualTree = this.parentNode !== null && isInVirtualDocumentTree(this);
        if (virtual && inVirtualTree) {
          maybeNoteDetached(this);
        }
        const hasSpecial =
          virtual && inVirtualTree ? options.settledSubtreeHas?.(this, false) : undefined;
        const baseElementChanged =
          inVirtualTree &&
          (options.settledSubtreeHas?.(this, true) ?? subtreeHasBaseElement(this));
        nativeElementRemove.call(this);
        if (virtual && hasSpecial !== false) {
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
          let combinedScan:
            | {
                styles: HTMLStyleElement[];
                links: HTMLLinkElement[];
                scripts: HTMLScriptElement[];
                hasBase: boolean;
                hasTarget: boolean;
              }
            | undefined = {
            styles: [],
            links: [],
            scripts: [],
            hasBase: false,
            hasTarget: false,
          };
          for (const node of nodes) {
            if (prepareInsertion(node, combinedScan) === undefined) {
              combinedScan = undefined;
            }
          }
          const inserted = Array.from(new Set(nodes.flatMap(insertedNodes)));
          const removed = Array.from(this.childNodes);
          const baseElementChanged =
            this.isConnected &&
            (removed.some(subtreeHasBaseElement) ||
              (combinedScan !== undefined
                ? combinedScan.hasBase
                : inserted.some(subtreeHasBaseElement)));
          performStyleMutationBatch(this, () => {
            Reflect.apply(nativeReplaceChildren, this, nodes);
            options.onDisconnectedNodes(removed);
            if (this.isConnected) {
              finishInsertion(inserted, baseElementChanged, combinedScan);
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
