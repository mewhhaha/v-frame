// Everything that has to happen around a node entering the tree: marking it
// first, noticing a <base> or <style> among what came in, running scripts that
// became runnable, and telling the realm's connection observers once the
// browser has actually done the insertion. The patched methods in
// tree-patches.ts, the Range overrides in selection.ts and innerHTML all go
// through here.

import type { FacadeContext } from "./context.js";
import type { NodeMarking } from "./marking.js";
import type { NodeArguments } from "./node-arguments.js";
import type { ScriptExecution } from "./script-execution.js";

export interface NodeInsertion {
  collectElements(node: Node): Element[];
  prepareInsertion(node: Node): void;
  insertedNodes(node: Node): Node[];
  finishInsertion(nodes: readonly Node[], baseElementChanged: boolean): void;
  insert<T extends Node>(parent: Node, node: T, method: string, operation: () => T): T;
  styleElementChanged(node: Node): void;
  performStyleMutationBatch(parent: Node, mutation: () => void): void;
  appendValues(parent: Node, values: Array<Node | string>, prepend: boolean): void;
  /** ChildNode.before, after and replaceWith, for an element, text or doctype. */
  insertValuesAround(
    self: ChildNode,
    values: Array<Node | string>,
    placement: "before" | "after" | "replace",
  ): void;
}

export function createNodeInsertion(
  context: FacadeContext,
  marking: NodeMarking,
  scripts: ScriptExecution,
  nodeArguments: NodeArguments,
): NodeInsertion {
  const options = context.options;
  const {
    isElementNode,
    isDocumentFragmentNode,
    isHTMLStyleElement,
    isHTMLScriptElement,
    isInVirtualDocumentTree,
    subtreeHasBaseElement,
    virtualNodes,
    window,
    document,
    nativeQuerySelectorAll,
    nativeFragmentQuerySelectorAll,
  } = context;
  const { markVirtualNode } = marking;
  const { executeConnectedScript } = scripts;
  const { requireNode, toNodes } = nodeArguments;

  const styleMutationBatches = new WeakSet<HTMLStyleElement>();
  const styleElementForMutation = (node: Node): HTMLStyleElement | null => {
    if (isElementNode(node) && isHTMLStyleElement(node)) {
      return isInVirtualDocumentTree(node) ? node : null;
    }
    const parent = node.parentNode;
    return parent !== null &&
      isElementNode(parent) &&
      isHTMLStyleElement(parent) &&
      isInVirtualDocumentTree(parent)
      ? parent
      : null;
  };
  const styleElementChanged = (node: Node): void => {
    const style = styleElementForMutation(node);
    if (style !== null && !styleMutationBatches.has(style)) {
      options.onStyleElementChange(style);
    }
  };

  // The native walks: a guest that patches querySelectorAll must not run inside
  // the facade's own insertion bookkeeping.
  const collectElements = (node: Node): Element[] => {
    const elements: Element[] = [];
    if (isElementNode(node)) {
      elements.push(node, ...nativeQuerySelectorAll.call(node, "*"));
    } else if (isDocumentFragmentNode(node)) {
      elements.push(...nativeFragmentQuerySelectorAll.call(node, "*"));
    }
    return elements;
  };

  const prepareInsertion = (node: Node): void => {
    markVirtualNode(node);

    for (const element of collectElements(node)) {
      if (isHTMLStyleElement(element)) {
        const nonce = options.getNonce();
        if (nonce !== "") {
          element.nonce = nonce;
        }
      }
    }
  };

  const insertedNodes = (node: Node): Node[] =>
    isDocumentFragmentNode(node) ? Array.from(node.childNodes) : [node];

  const finishInsertion = (nodes: readonly Node[], baseElementChanged: boolean): void => {
    if (baseElementChanged) {
      options.onBaseElementChange();
    }
    for (const node of nodes) {
      for (const element of collectElements(node)) {
        if (isHTMLScriptElement(element)) {
          executeConnectedScript(element);
        }
      }
    }
    const observableNodes = nodes.filter((node) => {
      const parent = node.parentNode;
      return !(
        parent !== null &&
        isElementNode(parent) &&
        isHTMLStyleElement(parent) &&
        styleMutationBatches.has(parent)
      );
    });
    if (observableNodes.length > 0) {
      options.onConnectedNodes(observableNodes);
    }
  };

  const insert = <T extends Node>(
    parent: Node,
    node: T,
    method: string,
    operation: () => T,
  ): T => {
    if (!virtualNodes.has(parent)) {
      return operation();
    }
    requireNode(node, method, 1);
    prepareInsertion(node);
    const nodes = insertedNodes(node);
    const baseElementChanged = nodes.some(subtreeHasBaseElement);
    const result = operation();
    if (parent.isConnected) {
      finishInsertion(nodes, baseElementChanged);
      if (parent instanceof window.HTMLScriptElement) {
        executeConnectedScript(parent);
      }
    }
    return result;
  };

  // One batch per style element: however many nodes a method inserts, the
  // stylesheet is re-read once, after the last of them. A batch that is already
  // open belongs to an outer caller and is left for it to close.
  const performStyleMutationBatch = (parent: Node, mutation: () => void): void => {
    const parentStyle =
      isElementNode(parent) && isHTMLStyleElement(parent) ? parent : null;
    if (parentStyle === null || styleMutationBatches.has(parentStyle)) {
      mutation();
      return;
    }

    styleMutationBatches.add(parentStyle);
    try {
      mutation();
    } finally {
      styleMutationBatches.delete(parentStyle);
      styleElementChanged(parentStyle);
    }
  };

  // "Convert nodes into a node": a single value goes in as it is, several are
  // gathered into a fragment first. Gathering moves them out of wherever they
  // were, which is why every reference below is chosen from outside the set, and
  // the one insertion that follows is validated and observed as a single change.
  const convertToNode = (nodes: Node[]): Node => {
    if (nodes.length === 1) {
      return nodes[0]!;
    }
    const fragment = document.createDocumentFragment();
    for (const node of nodes) {
      fragment.appendChild(node);
    }
    return fragment;
  };

  const appendValues = (
    parent: Node,
    values: Array<Node | string>,
    prepend: boolean,
  ): void => {
    const nodes = toNodes(values);
    performStyleMutationBatch(parent, () => {
      const node = convertToNode(nodes);
      parent.insertBefore(node, prepend ? parent.firstChild : null);
    });
  };

  const insertValuesAround = (
    self: ChildNode,
    values: Array<Node | string>,
    placement: "before" | "after" | "replace",
  ): void => {
    const parent = self.parentNode;
    if (parent === null) {
      return;
    }
    const nodes = toNodes(values);
    const excluded = new Set<Node>(nodes);
    // The neighbor that stays put: the nearest sibling that is not itself being
    // inserted, since inserting moves it.
    let viable: ChildNode | null =
      placement === "before" ? self.previousSibling : self.nextSibling;
    while (viable !== null && excluded.has(viable)) {
      viable = placement === "before" ? viable.previousSibling : viable.nextSibling;
    }
    performStyleMutationBatch(parent, () => {
      const node = convertToNode(nodes);
      if (placement === "replace" && self.parentNode === parent) {
        parent.replaceChild(node, self);
      } else {
        const reference =
          placement === "before"
            ? viable === null
              ? parent.firstChild
              : viable.nextSibling
            : viable;
        parent.insertBefore(node, reference);
      }
    });
  };

  return {
    collectElements,
    prepareInsertion,
    insertedNodes,
    finishInsertion,
    insert,
    styleElementChanged,
    performStyleMutationBatch,
    appendValues,
    insertValuesAround,
  };
}
