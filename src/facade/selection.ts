// A guest range must behave like a range in the guest's own document: nodes it
// inserts have to be marked and connected the same way an insertion through the
// node facade would be. Selection change is not observable across the shadow
// boundary either, so the facade schedules its own selectionchange event on the
// virtual document.

import { createSelectionModel } from "./selection-model.js";
import type { FacadeContext } from "./context.js";
import type { NodeCloning } from "./clone.js";
import type { NodeInsertion } from "./insertion.js";
import type { NodeArguments } from "./node-arguments.js";

export interface SelectionFacadeInstallation {
  selection: Selection;
  createVirtualRange(): Range;
  dispose(): void;
}

export function installSelectionFacade(
  context: FacadeContext,
  insertion: NodeInsertion,
  cloning: NodeCloning,
  nodeArguments: NodeArguments,
): SelectionFacadeInstallation {
  const options = context.options;
  const {
    window,
    document,
    hostDocument,
    nativeDispatchEvent,
    subtreeHasBaseElement,
    logicalEventTargets,
    virtualNodes,
    patch,
  } = context;
  const { prepareInsertion, insertedNodes, finishInsertion } = insertion;
  const { copyNodeMetadata, activateVirtualClone } = cloning;

  const virtualRanges = new WeakSet<Range>();

  const insertThrough = (
    range: Range,
    node: Node,
    method: "insertNode" | "surroundContents",
    nativeInsert: (node: Node) => void,
  ): void => {
    nodeArguments.requireNode(node, method, 1);
    prepareInsertion(node);
    const nodes = insertedNodes(node);
    const baseElementChanged = nodes.some(subtreeHasBaseElement);
    nativeInsert(node);
    if (range.startContainer.isConnected) {
      finishInsertion(nodes, baseElementChanged);
    }
  };

  // What the browser clones or splits off for a range is physical: the rewritten
  // attributes of the originals, none of what marking recorded about them. The
  // elements that came out are matched to the ones they were made from, by the
  // order the tree gives both, and take their recorded state.
  const elementsBetween = (range: Range): Element[] => {
    const root = range.commonAncestorContainer;
    const afterSubtree = (node: Node): Node | null => {
      while (node !== root) {
        if (node.nextSibling !== null) return node.nextSibling;
        if (node.parentNode === null) return null;
        node = node.parentNode;
      }
      return null;
    };
    const elements: Element[] = [];
    // Partially selected ancestors are cloned too. Start at the boundary after
    // recording these, so unrelated siblings and their descendants are never visited.
    for (
      let node: Node | null = range.startContainer;
      node !== root;
      node = node.parentNode
    ) {
      if (node === null) break;
      if (node.nodeType === 1) elements.push(node as Element);
    }
    elements.reverse();
    const end =
      range.endContainer.childNodes[range.endOffset] ?? afterSubtree(range.endContainer);
    for (
      let node =
        range.startContainer.childNodes[range.startOffset] ??
        afterSubtree(range.startContainer);
      node !== null && node !== end;
      node = node.firstChild ?? afterSubtree(node)
    ) {
      if (node.nodeType === 1) elements.push(node as Element);
    }
    return elements;
  };
  // The elements a range splits rather than takes whole, outermost first on the
  // start side and then the end side, which is the order their copies nest in.
  const elementsSplit = (range: Range): Element[] => {
    const side = (container: Node): Element[] => {
      const path: Element[] = [];
      for (
        let node: Node | null = container;
        node !== null && node !== range.commonAncestorContainer;
        node = node.parentNode
      ) {
        if (node.nodeType === 1) {
          path.unshift(node as Element);
        }
      }
      return path;
    };
    return [...side(range.startContainer), ...side(range.endContainer)];
  };
  const adoptCopies = (
    fragment: DocumentFragment,
    sources: readonly Element[],
    copies: readonly Element[],
  ): DocumentFragment => {
    if (sources.length === copies.length) {
      sources.forEach((source, index) => copyNodeMetadata(source, copies[index]!));
    }
    return activateVirtualClone(fragment);
  };
  const cloneThrough = (
    range: Range,
    nativeClone: () => DocumentFragment,
  ): DocumentFragment => {
    const sources = range.collapsed ? [] : elementsBetween(range);
    const fragment = nativeClone();
    return adoptCopies(fragment, sources, Array.from(fragment.querySelectorAll("*")));
  };
  const extractThrough = (
    range: Range,
    nativeExtract: () => DocumentFragment,
  ): DocumentFragment => {
    const sources = range.collapsed ? [] : elementsSplit(range);
    const fragment = nativeExtract();
    // Whole nodes moved and kept their state; only the copies of split ones are new.
    const copies = Array.from(fragment.querySelectorAll("*")).filter(
      (element) => !virtualNodes.has(element),
    );
    return adoptCopies(fragment, sources, copies);
  };

  // A range the selection hands out is one of the host's, so it has to learn the
  // insertions a guest range knows to report. Once is enough: the overrides
  // belong to the range, which the selection returns for as long as it lasts.
  const virtualizeRange = (range: Range): Range => {
    if (virtualRanges.has(range)) {
      return range;
    }
    virtualRanges.add(range);
    const nativeInsertNode = range.insertNode.bind(range);
    const nativeSurroundContents = range.surroundContents.bind(range);
    const nativeCloneContents = range.cloneContents.bind(range);
    const nativeExtractContents = range.extractContents.bind(range);
    Object.defineProperties(range, {
      insertNode: {
        configurable: true,
        value: (node: Node) => insertThrough(range, node, "insertNode", nativeInsertNode),
      },
      surroundContents: {
        configurable: true,
        value: (node: Node) =>
          insertThrough(range, node, "surroundContents", nativeSurroundContents),
      },
      cloneContents: {
        configurable: true,
        value: () => cloneThrough(range, nativeCloneContents),
      },
      extractContents: {
        configurable: true,
        value: () => extractThrough(range, nativeExtractContents),
      },
    });
    return range;
  };

  // A guest can also construct its own Range, which belongs to the realm and
  // never passes through virtualizeRange. Those are covered where they inherit
  // from, for the ranges that sit in the guest's tree.
  const realmRange = window.Range.prototype;
  const nativeInsertNode = realmRange.insertNode;
  const nativeSurroundContents = realmRange.surroundContents;
  const nativeCloneContents = realmRange.cloneContents;
  const nativeExtractContents = realmRange.extractContents;
  const inGuestTree = (range: Range): boolean => virtualNodes.has(range.startContainer);
  patch(realmRange, "insertNode", {
    writable: true,
    value(this: Range, node: Node) {
      if (!inGuestTree(this)) {
        return nativeInsertNode.call(this, node);
      }
      insertThrough(this, node, "insertNode", (inserted) =>
        nativeInsertNode.call(this, inserted),
      );
    },
  });
  patch(realmRange, "surroundContents", {
    writable: true,
    value(this: Range, node: Node) {
      if (!inGuestTree(this)) {
        return nativeSurroundContents.call(this, node);
      }
      insertThrough(this, node, "surroundContents", (inserted) =>
        nativeSurroundContents.call(this, inserted),
      );
    },
  });
  patch(realmRange, "cloneContents", {
    writable: true,
    value(this: Range) {
      return inGuestTree(this)
        ? cloneThrough(this, () => nativeCloneContents.call(this))
        : nativeCloneContents.call(this);
    },
  });
  patch(realmRange, "extractContents", {
    writable: true,
    value(this: Range) {
      return inGuestTree(this)
        ? extractThrough(this, () => nativeExtractContents.call(this))
        : nativeExtractContents.call(this);
    },
  });
  const createVirtualRange = (): Range => virtualizeRange(hostDocument.createRange());
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
  const selectionModel = createSelectionModel({
    window,
    hostDocument,
    root: options.html,
    document,
    adoptRange: virtualizeRange,
    onSelectionChange: dispatchSelectionChange,
  });
  const selection = selectionModel.selection;

  const dispose = (): void => {
    disposed = true;
    if (selectionChangeTimer !== undefined) {
      window.clearTimeout(selectionChangeTimer);
      selectionChangeTimer = undefined;
    }
    selectionModel.dispose();
  };

  return {
    selection,
    createVirtualRange,
    dispose,
  };
}
