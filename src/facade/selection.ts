// A guest range must behave like a range in the guest's own document: nodes it
// inserts have to be marked and connected the same way an insertion through the
// node facade would be. Selection change is not observable across the shadow
// boundary either, so the facade schedules its own selectionchange event on the
// virtual document.

import { createSelectionFacade } from "../selection-facade.js";
import type { FacadeContext } from "./context.js";
import type { NodeFacade } from "./nodes.js";

export interface SelectionFacadeInstallation {
  selection: Selection;
  createVirtualRange(): Range;
  dispose(): void;
}

export function installSelectionFacade(
  context: FacadeContext,
  nodes: NodeFacade,
): SelectionFacadeInstallation {
  const options = context.options;
  const {
    window,
    document,
    hostDocument,
    nativeDispatchEvent,
    subtreeHasBaseElement,
    logicalEventTargets,
  } = context;
  const { prepareInsertion, insertedNodes, finishInsertion } = nodes;

  const createVirtualRange = (): Range => {
    const range = hostDocument.createRange();
    const nativeInsertNode = range.insertNode.bind(range);
    const nativeSurroundContents = range.surroundContents.bind(range);
    Object.defineProperties(range, {
      insertNode: {
        configurable: true,
        value(node: Node) {
          prepareInsertion(node);
          const nodes = insertedNodes(node);
          const baseElementChanged = nodes.some(subtreeHasBaseElement);
          nativeInsertNode(node);
          if (range.startContainer.isConnected) {
            finishInsertion(nodes, baseElementChanged);
          }
        },
      },
      surroundContents: {
        configurable: true,
        value(node: Node) {
          prepareInsertion(node);
          const nodes = insertedNodes(node);
          const baseElementChanged = nodes.some(subtreeHasBaseElement);
          nativeSurroundContents(node);
          if (range.startContainer.isConnected) {
            finishInsertion(nodes, baseElementChanged);
          }
        },
      },
    });
    return range;
  };
  let disposed = false;
  let selectionChangeTimer: number | undefined;
  const dispatchSelectionChange = (): void => {
    if (disposed || selectionChangeTimer !== undefined) {
      return;
    }
    selectionChangeTimer = window.setTimeout(() => {
      selectionChangeTimer = undefined;
      if (disposed) {
        return;
      }
      const event = new window.Event("selectionchange");
      logicalEventTargets.set(event, document);
      nativeDispatchEvent.call(document, event);
    }, 0);
  };
  const selectionFacade = createSelectionFacade({
    window,
    hostDocument,
    root: options.html,
    onSelectionChange: dispatchSelectionChange,
  });
  const selection = selectionFacade.selection;

  const dispose = (): void => {
    disposed = true;
    if (selectionChangeTimer !== undefined) {
      window.clearTimeout(selectionChangeTimer);
      selectionChangeTimer = undefined;
    }
    selectionFacade.dispose();
  };

  return {
    selection,
    createVirtualRange,
    dispose,
  };
}
