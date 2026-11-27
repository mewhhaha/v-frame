// Everything that has to happen around a node entering the tree: marking it
// first, noticing a <base> or <style> among what came in, running scripts that
// became runnable, and telling the realm's connection observers once the
// browser has actually done the insertion. The patched methods in
// tree-patches.ts, the Range overrides in selection.ts and innerHTML all go
// through here.

import { FRAGMENT_TARGET_ATTRIBUTE } from "../wire-format.js";
import type { FacadeContext, SubtreeScan } from "./context.js";
import type { NodeMarking } from "./marking.js";
import type { NodeArguments } from "./node-arguments.js";
import type { ScriptExecution } from "./script-execution.js";

const SETTLED_MOVE_POST_SELECTOR = "script,style,link,[data-v-frame-target]";

export interface NodeInsertion {
  collectElements(node: Node): Element[];
  prepareInsertion(
    node: Node,
    scan?: SubtreeScan,
    collectScan?: boolean,
  ): SubtreeScan | undefined;
  insertedNodes(node: Node): Node[];
  finishInsertion(
    nodes: readonly Node[],
    baseElementChanged: boolean,
    scan?: SubtreeScan,
    alreadyFlushed?: boolean,
  ): void;
  insert<T extends Node>(parent: Node, node: T, method: string, operation: () => T): T;
  insertDirect<T extends Node>(
    parent: Node,
    node: T,
    method: string,
    reference?: Node | null,
    parentVerifiedVirtual?: boolean,
    nodeVerified?: boolean,
  ): T;
  replaceElementChildren(parent: Element, fragment: DocumentFragment | null): void;
  replaceNodeWith<T extends Node>(parent: Node, node: Node, child: T): T;
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
    isHTMLLinkElement,
    isHTMLScriptElement,
    isBaseElement,
    isHTMLTemplateElement,
    isInVirtualDocumentTree,
    subtreeHasBaseElement,
    virtualNodes,
    fragmentNodes,
    document,
    nativeAppendChild,
    nativeInsertBefore,
    nativeReplaceChild,
    nativeElementReplaceChildren,
    nativeHasAttributes,
    nativeHasAttribute,
    nativeQuerySelector,
    nativeQuerySelectorAll,
    nativeFragmentQuerySelector,
    nativeFragmentQuerySelectorAll,
  } = context;
  const {
    markVirtualNode,
    markVirtualSubtree,
    armDetachedWatchIfCandidate,
    consumeDetachedWatch,
  } = marking;
  const { executeConnectedScript } = scripts;
  const { isNodeValue, requireNode, toNodes } = nodeArguments;

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

  const createScan = (): SubtreeScan => ({
    styles: [],
    links: [],
    scripts: [],
    hasBase: false,
    hasTarget: false,
  });
  const emptyScan = createScan();
  const scratchScan = createScan();
  let scratchInUse = false;

  const isSettledMovePostCandidate = (node: Node): boolean => {
    if (isElementNode(node)) {
      return (
        isHTMLScriptElement(node) ||
        isHTMLStyleElement(node) ||
        isHTMLLinkElement(node) ||
        nativeHasAttribute.call(node, FRAGMENT_TARGET_ATTRIBUTE) ||
        (node.firstElementChild !== null &&
          nativeQuerySelector.call(node, SETTLED_MOVE_POST_SELECTOR) !== null)
      );
    }
    if (isDocumentFragmentNode(node)) {
      return (
        node.firstElementChild !== null &&
        nativeFragmentQuerySelector.call(node, SETTLED_MOVE_POST_SELECTOR) !== null
      );
    }
    return false;
  };

  const isPlainMarkedLeafElement = (element: Element): boolean => {
    if (
      !virtualNodes.has(element) ||
      nativeHasAttributes.call(element) ||
      options.authoredURLAttributes.has(element) ||
      isHTMLStyleElement(element) ||
      isHTMLLinkElement(element) ||
      isHTMLScriptElement(element) ||
      isBaseElement(element) ||
      isHTMLTemplateElement(element)
    ) {
      return false;
    }
    const first = element.firstChild;
    return (
      first === null ||
      (first.nextSibling === null && first.nodeType === 3 && virtualNodes.has(first))
    );
  };

  const prepareInsertion = (
    node: Node,
    scan?: SubtreeScan,
    collectScan = true,
  ): SubtreeScan | undefined => {
    const nodeType = node.nodeType;
    if (nodeType !== 1 && nodeType !== 11) {
      markVirtualNode(node);
      return scan ?? emptyScan;
    }
    const alreadyVirtual = virtualNodes.has(node);
    if (alreadyVirtual && isInVirtualDocumentTree(node)) {
      return scan === undefined ? undefined : undefined;
    }
    if (nodeType === 1 && alreadyVirtual && isPlainMarkedLeafElement(node as Element)) {
      return scan ?? emptyScan;
    }
    if (
      nodeType === 1 &&
      alreadyVirtual &&
      consumeDetachedWatch(node, collectScan && scan === undefined)
    ) {
      return scan ?? emptyScan;
    }
    const nonce = options.getNonce();
    if (!collectScan && scan === undefined && nonce === "") {
      markVirtualSubtree(node);
      return emptyScan;
    }
    const useScratch = scan === undefined && !scratchInUse;
    const targetScan = scan ?? (useScratch ? scratchScan : createScan());
    if (useScratch) {
      scratchInUse = true;
      scratchScan.styles.length = 0;
      scratchScan.links.length = 0;
      scratchScan.scripts.length = 0;
      scratchScan.hasBase = false;
      scratchScan.hasTarget = false;
    }
    try {
      markVirtualSubtree(node, targetScan);

      if (nonce !== "" && targetScan.styles.length > 0) {
        for (const element of targetScan.styles) {
          if (!fragmentNodes.has(element)) {
            element.nonce = nonce;
          }
        }
      }
      if (!useScratch) {
        return targetScan;
      }
      if (
        scratchScan.styles.length === 0 &&
        scratchScan.links.length === 0 &&
        scratchScan.scripts.length === 0 &&
        !scratchScan.hasBase &&
        !scratchScan.hasTarget
      ) {
        if (collectScan && nodeType === 1) {
          armDetachedWatchIfCandidate(node as Element);
        }
        return emptyScan;
      }
      return {
        styles: scratchScan.styles.slice(),
        links: scratchScan.links.slice(),
        scripts: scratchScan.scripts.slice(),
        hasBase: scratchScan.hasBase,
        hasTarget: scratchScan.hasTarget,
      };
    } finally {
      if (useScratch) {
        scratchScan.styles.length = 0;
        scratchScan.links.length = 0;
        scratchScan.scripts.length = 0;
        scratchInUse = false;
      }
    }
  };

  const insertedNodes = (node: Node): Node[] =>
    isDocumentFragmentNode(node) ? Array.from(node.childNodes) : [node];

  const finishInsertion = (
    nodes: readonly Node[],
    baseElementChanged: boolean,
    scan?: SubtreeScan,
    alreadyFlushed = false,
  ): void => {
    if (baseElementChanged) {
      options.onBaseElementChange();
    }
    if (scan !== undefined) {
      for (const script of scan.scripts) {
        executeConnectedScript(script);
      }
    } else {
      for (const node of nodes) {
        if (isElementNode(node)) {
          if (isHTMLScriptElement(node)) {
            executeConnectedScript(node);
          } else if (node.firstElementChild !== null) {
            for (const element of nativeQuerySelectorAll.call(node, "script")) {
              if (isHTMLScriptElement(element)) {
                executeConnectedScript(element);
              }
            }
          }
        } else if (isDocumentFragmentNode(node) && node.firstElementChild !== null) {
          for (const element of nativeFragmentQuerySelectorAll.call(node, "script")) {
            if (isHTMLScriptElement(element)) {
              executeConnectedScript(element);
            }
          }
        }
      }
    }
    if (nodes.length === 0) {
      return;
    }
    const isBatchedStyleChild = (node: Node): boolean => {
      const parent = node.parentNode;
      return (
        parent !== null &&
        isElementNode(parent) &&
        isHTMLStyleElement(parent) &&
        styleMutationBatches.has(parent)
      );
    };
    if (nodes.length === 1) {
      if (!isBatchedStyleChild(nodes[0]!)) {
        options.onConnectedNodes(nodes, scan, alreadyFlushed);
      }
      return;
    }
    const observableNodes = nodes.filter((node) => !isBatchedStyleChild(node));
    if (observableNodes.length > 0) {
      options.onConnectedNodes(observableNodes, scan, alreadyFlushed);
    }
  };

  const settledNodeHas = (node: Node, baseOnly: boolean): boolean => {
    const tracked = options.settledSubtreeHas?.(node, baseOnly);
    return tracked !== undefined
      ? tracked
      : baseOnly
        ? subtreeHasBaseElement(node)
        : isSettledMovePostCandidate(node);
  };

  const finishDirectInsertion = (
    parent: Node,
    nodes: readonly Node[],
    scan: SubtreeScan | undefined,
    skippedScan: boolean,
    baseElementChanged: boolean,
  ): void => {
    if (skippedScan) {
      finishInsertion(nodes, nodes.some(subtreeHasBaseElement), undefined);
    } else if (scan === undefined) {
      const flushed = options.flushSettledMove?.(nodes) === true;
      const resolvedScan = nodes.some((n) => settledNodeHas(n, false))
        ? undefined
        : emptyScan;
      finishInsertion(nodes, baseElementChanged, resolvedScan, flushed);
    } else {
      finishInsertion(nodes, baseElementChanged, scan);
    }
    if (isElementNode(parent) && isHTMLScriptElement(parent)) {
      executeConnectedScript(parent);
    }
  };

  const insertDirect = <T extends Node>(
    parent: Node,
    node: T,
    method: string,
    reference?: Node | null,
    parentVerifiedVirtual = false,
    nodeVerified = false,
  ): T => {
    if (!parentVerifiedVirtual && !virtualNodes.has(parent)) {
      return (
        reference === undefined
          ? nativeAppendChild.call(parent, node)
          : nativeInsertBefore.call(parent, node, reference)
      ) as T;
    }
    if (!nodeVerified) {
      requireNode(node, method, 1);
    }
    const wasConnected = parent.isConnected;
    const scan = prepareInsertion(node, undefined, wasConnected);
    const isFragment = node.nodeType === 11;
    // Fragments empty their childNodes during insertion so must be snapshotted
    // beforehand; single nodes into a disconnected parent need no array unless
    // a custom-element callback connects the parent during insertion.
    const nodes =
      isFragment || wasConnected || scan === undefined ? insertedNodes(node) : null;
    const skippedScan = !wasConnected && scan === emptyScan;
    let baseElementChanged = false;
    if (scan === undefined) {
      options.flushSettledMove?.();
      baseElementChanged = nodes!.some((n) => settledNodeHas(n, true));
    } else if (!skippedScan) {
      baseElementChanged = scan.hasBase;
    }
    const result = (
      reference === undefined
        ? nativeAppendChild.call(parent, node)
        : nativeInsertBefore.call(parent, node, reference)
    ) as T;
    if (parent.isConnected) {
      finishDirectInsertion(
        parent,
        nodes ?? [node],
        scan,
        skippedScan,
        baseElementChanged,
      );
    }
    return result;
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
    const wasConnected = parent.isConnected;
    const scan = prepareInsertion(node, undefined, wasConnected);
    const nodes =
      node.nodeType === 11 || wasConnected || scan === undefined
        ? insertedNodes(node)
        : null;
    const skippedScan = !wasConnected && scan === emptyScan;
    let baseElementChanged = false;
    if (scan === undefined) {
      options.flushSettledMove?.();
      baseElementChanged = nodes!.some((n) => settledNodeHas(n, true));
    } else if (!skippedScan) {
      baseElementChanged = scan.hasBase;
    }
    const result = operation();
    if (parent.isConnected) {
      finishDirectInsertion(
        parent,
        nodes ?? [node],
        scan,
        skippedScan,
        baseElementChanged,
      );
    }
    return result;
  };

  const replaceNodeWith = <T extends Node>(parent: Node, node: Node, child: T): T => {
    const scan = prepareInsertion(node, undefined, parent.isConnected);
    const nodes = insertedNodes(node);
    const parentConnected = parent.isConnected;
    const childHasBase =
      parentConnected &&
      (options.settledSubtreeHas?.(child, true) ?? subtreeHasBaseElement(child));
    const baseElementChanged =
      childHasBase ||
      (scan !== undefined ? scan.hasBase : nodes.some(subtreeHasBaseElement));
    const result = nativeReplaceChild.call(parent, node, child) as T;
    if (node !== child) {
      options.onDisconnectedNodes([child]);
    }
    if (parent.isConnected) {
      finishInsertion(nodes, baseElementChanged, scan);
      if (isElementNode(parent) && isHTMLScriptElement(parent)) {
        executeConnectedScript(parent);
      }
    }
    return result;
  };

  const replaceElementChildren = (
    parent: Element,
    fragment: DocumentFragment | null,
  ): void => {
    const hadChildren = parent.firstChild !== null;
    if (fragment === null && !hadChildren) {
      return;
    }
    const wasConnected = parent.isConnected;
    const removed = hadChildren ? Array.from(parent.childNodes) : null;
    const removedHasBase =
      wasConnected &&
      removed !== null &&
      options.settledSubtreeHas?.(parent, true) !== false &&
      removed.some(subtreeHasBaseElement);
    if (fragment === null) {
      performStyleMutationBatch(parent, () => {
        nativeElementReplaceChildren.call(parent);
        if (removed !== null) {
          options.onDisconnectedNodes(removed);
        }
        if (removedHasBase) {
          options.onBaseElementChange();
        }
      });
      return;
    }
    const scan = prepareInsertion(fragment, undefined, wasConnected);
    const inserted = insertedNodes(fragment);
    const baseElementChanged =
      wasConnected &&
      (removedHasBase ||
        (scan !== undefined ? scan.hasBase : inserted.some(subtreeHasBaseElement)));
    performStyleMutationBatch(parent, () => {
      nativeElementReplaceChildren.call(parent, fragment);
      if (removed !== null) {
        options.onDisconnectedNodes(removed);
      }
      if (parent.isConnected) {
        finishInsertion(inserted, baseElementChanged, scan);
        if (isHTMLScriptElement(parent)) {
          executeConnectedScript(parent);
        }
      } else if (baseElementChanged) {
        options.onBaseElementChange();
      }
    });
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
    if (
      values.length === 1 &&
      isNodeValue(values[0]) &&
      virtualNodes.has(parent) &&
      !(isElementNode(parent) && isHTMLStyleElement(parent))
    ) {
      const node = values[0];
      insertDirect(
        parent,
        node,
        prepend ? "prepend" : "append",
        prepend ? parent.firstChild : undefined,
        true,
        true,
      );
      return;
    }
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
    insertDirect,
    replaceElementChildren,
    replaceNodeWith,
    styleElementChanged,
    performStyleMutationBatch,
    appendValues,
    insertValuesAround,
  };
}
