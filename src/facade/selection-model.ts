// The guest's Selection as a state machine over the host's: the host selection
// can only point into the shadow tree, so the model tracks what the guest sees
// (the shell standing in for its document) and reconciles it with native
// selection changes. It takes everything it touches through its options and
// knows nothing of the facade; selection.ts is the wiring that supplies them.

export interface SelectionModelOptions {
  window: Window & typeof globalThis;
  hostDocument: Document;
  root: HTMLElement;
  // The guest's document, which stands for the root in selection endpoints.
  document: Document;
  // Gives a range handed to the guest the behavior of a guest range.
  adoptRange(range: Range): Range;
  onSelectionChange(): void;
}

export interface SelectionModel {
  selection: Selection;
  dispose(): void;
}

interface SelectionState {
  range: Range;
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}

interface SelectionSnapshot {
  rangeStartContainer: Node;
  rangeStartOffset: number;
  rangeEndContainer: Node;
  rangeEndOffset: number;
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}

function selectionStateFromRange(range: Range, backward = false): SelectionState {
  return {
    range,
    anchorNode: backward ? range.endContainer : range.startContainer,
    anchorOffset: backward ? range.endOffset : range.startOffset,
    focusNode: backward ? range.startContainer : range.endContainer,
    focusOffset: backward ? range.startOffset : range.endOffset,
  };
}

export function createSelectionModel(options: SelectionModelOptions): SelectionModel {
  const { window, hostDocument, onSelectionChange, adoptRange } = options;
  let virtualRoot: HTMLElement | null = options.root;
  let privateSelection: { range: Range; backward: boolean } | null = null;
  let expectedNativeSelectionChange: SelectionSnapshot | null = null;
  let previousNativeSelectionSnapshot: SelectionSnapshot | null = null;

  const nativeGetRootNode = hostDocument.defaultView!.Node.prototype.getRootNode;
  const containsVirtualNode = (node: Node): boolean => {
    if (virtualRoot === null) return false;
    if (node === virtualRoot || virtualRoot.contains(node)) return true;
    // contains() stops at a shadow boundary, but the selection API treats a
    // shadow tree as part of the document that hosts it, so a node inside a
    // component the guest attached a shadow root to belongs to the guest too.
    let root = nativeGetRootNode.call(node);
    while (root.nodeType === 11 && "host" in root) {
      const host = (root as ShadowRoot).host;
      if (host === virtualRoot || virtualRoot.contains(host)) return true;
      root = nativeGetRootNode.call(host);
    }
    return false;
  };
  // The guest document's children are the doctype and the root, and a selection
  // endpoint on the document itself has no node of its own to land on in the
  // shell. Offsets up to the root's slot land before the root's content, the one
  // after it lands at the end.
  const virtualEndpoint = (node: Node, offset: number): [Node, number] =>
    node === options.document
      ? [virtualRoot!, Number(offset) > 1 ? virtualRoot!.childNodes.length : 0]
      : [node, offset];
  const containsVirtualRange = (range: Range): boolean =>
    containsVirtualNode(range.startContainer) && containsVirtualNode(range.endContainer);
  const nativeSelection = (): Selection | null => hostDocument.getSelection();
  const virtualNativeRanges = (): Range[] => {
    if (!virtualRoot) return [];
    const selection = nativeSelection();
    if (selection === null || selection.rangeCount === 0) {
      return [];
    }

    const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
      selection.getRangeAt(index),
    );
    if (ranges.every(containsVirtualRange)) return ranges;
    // WebKit retargets getRangeAt() to the shadow host. Composed ranges expose
    // the actual endpoints when their owning shadow root is explicitly allowed.
    const root = hostDocument.defaultView!.Node.prototype.getRootNode.call(
      virtualRoot,
    ) as ShadowRoot;
    const composed = selection.getComposedRanges?.({ shadowRoots: [root] }) ?? [];
    return composed.flatMap((range) => {
      if (
        !containsVirtualNode(range.startContainer) ||
        !containsVirtualNode(range.endContainer)
      )
        return [];
      const live = hostDocument.createRange();
      live.setStart(range.startContainer, range.startOffset);
      live.setEnd(range.endContainer, range.endOffset);
      return [live];
    });
  };
  const nativeState = (selection: Selection, range: Range): SelectionState => {
    const backward = selection.direction === "backward";
    return {
      range,
      anchorNode:
        selection.anchorNode && containsVirtualNode(selection.anchorNode)
          ? selection.anchorNode
          : backward
            ? range.endContainer
            : range.startContainer,
      anchorOffset:
        selection.anchorNode && containsVirtualNode(selection.anchorNode)
          ? selection.anchorOffset
          : backward
            ? range.endOffset
            : range.startOffset,
      focusNode:
        selection.focusNode && containsVirtualNode(selection.focusNode)
          ? selection.focusNode
          : backward
            ? range.startContainer
            : range.endContainer,
      focusOffset:
        selection.focusNode && containsVirtualNode(selection.focusNode)
          ? selection.focusOffset
          : backward
            ? range.startOffset
            : range.endOffset,
    };
  };
  const currentSelection = (): SelectionState | null => {
    if (privateSelection !== null) {
      return selectionStateFromRange(privateSelection.range, privateSelection.backward);
    }

    const selection = nativeSelection();
    const ranges = virtualNativeRanges();
    if (selection === null || ranges.length === 0) {
      return null;
    }
    return nativeState(selection, ranges[0]!);
  };
  const selectionSnapshot = (state: SelectionState | null): SelectionSnapshot | null => {
    if (state === null) {
      return null;
    }
    return {
      rangeStartContainer: state.range.startContainer,
      rangeStartOffset: state.range.startOffset,
      rangeEndContainer: state.range.endContainer,
      rangeEndOffset: state.range.endOffset,
      anchorNode: state.anchorNode,
      anchorOffset: state.anchorOffset,
      focusNode: state.focusNode,
      focusOffset: state.focusOffset,
    };
  };
  const sameSelectionSnapshot = (
    left: SelectionSnapshot | null,
    right: SelectionSnapshot | null,
  ): boolean =>
    left === right ||
    (left !== null &&
      right !== null &&
      left.rangeStartContainer === right.rangeStartContainer &&
      left.rangeStartOffset === right.rangeStartOffset &&
      left.rangeEndContainer === right.rangeEndContainer &&
      left.rangeEndOffset === right.rangeEndOffset &&
      left.anchorNode === right.anchorNode &&
      left.anchorOffset === right.anchorOffset &&
      left.focusNode === right.focusNode &&
      left.focusOffset === right.focusOffset);
  const nativeSelectionSnapshot = (): SelectionSnapshot | null => {
    const selection = nativeSelection();
    const ranges = virtualNativeRanges();
    return selection === null || ranges.length === 0
      ? null
      : selectionSnapshot(nativeState(selection, ranges[0]!));
  };
  const notifySelectionChange = (
    previous: SelectionSnapshot | null,
    nativeSelectionMayHaveChanged = false,
  ): void => {
    if (sameSelectionSnapshot(previous, selectionSnapshot(currentSelection()))) {
      return;
    }
    if (nativeSelectionMayHaveChanged) {
      expectedNativeSelectionChange = nativeSelectionSnapshot();
      previousNativeSelectionSnapshot = expectedNativeSelectionChange;
    }
    onSelectionChange();
  };
  const nativeSelectionCanChange = (): boolean => {
    if (privateSelection !== null) {
      return false;
    }
    const selection = nativeSelection();
    return (
      selection !== null &&
      (selection.rangeCount === 0 || virtualNativeRanges().length > 0)
    );
  };
  const retainPrivateRange = (state: SelectionState): void => {
    // The Range stays live through text edits, node removal and direct range
    // mutations. Only its orientation is independent of those boundaries.
    privateSelection = {
      range: state.range,
      backward: directionFor(state) === "backward",
    };
  };
  const setRange = (state: SelectionState): boolean => {
    if (!nativeSelectionCanChange()) {
      retainPrivateRange(state);
      return false;
    }

    const selection = nativeSelection();
    if (selection === null) {
      retainPrivateRange(state);
      return false;
    }

    try {
      // addRange would normalize the selection to forward; setBaseAndExtent
      // preserves the caller's anchor/focus direction.
      selection.setBaseAndExtent(
        state.anchorNode,
        state.anchorOffset,
        state.focusNode,
        state.focusOffset,
      );
      if (virtualNativeRanges().length === 0) {
        retainPrivateRange(state);
      }
      return true;
    } catch {
      retainPrivateRange(state);
      return true;
    }
  };
  const collapsedRange = (node: Node, offset: number): Range => {
    const range = hostDocument.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    return range;
  };
  const rangeBetween = (
    anchorNode: Node,
    anchorOffset: number,
    focusNode: Node,
    focusOffset: number,
  ): Range => {
    const anchor = collapsedRange(anchorNode, anchorOffset);
    const focusIsBeforeAnchor = anchor.comparePoint(focusNode, focusOffset) === -1;
    const range = hostDocument.createRange();
    if (focusIsBeforeAnchor) {
      range.setStart(focusNode, focusOffset);
      range.setEnd(anchorNode, anchorOffset);
    } else {
      range.setStart(anchorNode, anchorOffset);
      range.setEnd(focusNode, focusOffset);
    }
    return range;
  };
  const directionFor = (state: SelectionState): string => {
    if (state.range.collapsed) {
      return "none";
    }

    const anchor = collapsedRange(state.anchorNode, state.anchorOffset);
    return anchor.comparePoint(state.focusNode, state.focusOffset) === -1
      ? "backward"
      : "forward";
  };
  const invalidSelectionState = (): never => {
    throw new window.DOMException(
      "There is no range in the selection",
      "InvalidStateError",
    );
  };
  const currentRanges = (): Range[] =>
    privateSelection === null ? virtualNativeRanges() : [privateSelection.range];
  const rangeAt = (index: number): Range => {
    const range = currentRanges()[index];
    if (range === undefined) {
      throw new window.DOMException(
        "The selection has no range at that index",
        "IndexSizeError",
      );
    }
    return adoptRange(range);
  };
  const hostSelectionChanged = (): void => {
    const snapshot = nativeSelectionSnapshot();
    if (
      expectedNativeSelectionChange !== null &&
      sameSelectionSnapshot(expectedNativeSelectionChange, snapshot)
    ) {
      expectedNativeSelectionChange = null;
      return;
    }
    expectedNativeSelectionChange = null;

    if (sameSelectionSnapshot(previousNativeSelectionSnapshot, snapshot)) {
      return;
    }
    previousNativeSelectionSnapshot = snapshot;
    onSelectionChange();
  };
  hostDocument.addEventListener("selectionchange", hostSelectionChanged);
  const facade = Object.create(window.Selection.prototype) as Selection;

  Object.defineProperties(facade, {
    anchorNode: {
      enumerable: true,
      get: () => currentSelection()?.anchorNode ?? null,
    },
    anchorOffset: {
      enumerable: true,
      get: () => currentSelection()?.anchorOffset ?? 0,
    },
    focusNode: {
      enumerable: true,
      get: () => currentSelection()?.focusNode ?? null,
    },
    focusOffset: {
      enumerable: true,
      get: () => currentSelection()?.focusOffset ?? 0,
    },
    isCollapsed: {
      enumerable: true,
      get: () => currentSelection()?.range.collapsed ?? true,
    },
    rangeCount: {
      enumerable: true,
      get: () => currentRanges().length,
    },
    type: {
      enumerable: true,
      get: () => {
        const state = currentSelection();
        if (state === null) {
          return "None";
        }
        return state.range.collapsed ? "Caret" : "Range";
      },
    },
    direction: {
      enumerable: true,
      get: () => {
        const state = currentSelection();
        return state === null ? "none" : directionFor(state);
      },
    },
    [Symbol.toStringTag]: { value: "Selection" },
    addRange: {
      value(range: Range): void {
        if (!containsVirtualRange(range)) {
          return;
        }
        // The Selection API makes addRange a no-op when a range is already set.
        if (currentRanges().length !== 0) {
          return;
        }

        const previous = selectionSnapshot(currentSelection());

        if (!nativeSelectionCanChange()) {
          retainPrivateRange(selectionStateFromRange(range));
          notifySelectionChange(previous);
          return;
        }

        const selection = nativeSelection();
        if (selection === null) {
          retainPrivateRange(selectionStateFromRange(range));
          notifySelectionChange(previous);
          return;
        }

        let nativeSelectionMayHaveChanged = false;
        try {
          selection.addRange(range);
          nativeSelectionMayHaveChanged = true;
          if (virtualNativeRanges().length === 0) {
            retainPrivateRange(selectionStateFromRange(range));
          }
        } catch {
          nativeSelectionMayHaveChanged = true;
          retainPrivateRange(selectionStateFromRange(range));
        }
        notifySelectionChange(previous, nativeSelectionMayHaveChanged);
      },
    },
    collapse: {
      value(node: Node | null, offset = 0): void {
        if (node === null) {
          facade.removeAllRanges();
          return;
        }
        [node, offset] = virtualEndpoint(node, offset);
        if (!containsVirtualNode(node)) {
          return;
        }

        const range = collapsedRange(node, offset);
        const previous = selectionSnapshot(currentSelection());
        const nativeSelectionMayHaveChanged = setRange(selectionStateFromRange(range));
        notifySelectionChange(previous, nativeSelectionMayHaveChanged);
      },
    },
    collapseToEnd: {
      value(): void {
        const range = currentSelection()?.range ?? invalidSelectionState();
        facade.collapse(range.endContainer, range.endOffset);
      },
    },
    collapseToStart: {
      value(): void {
        const range = currentSelection()?.range ?? invalidSelectionState();
        facade.collapse(range.startContainer, range.startOffset);
      },
    },
    containsNode: {
      value(node: Node, allowPartialContainment = false): boolean {
        const range = currentSelection()?.range;
        if (range === undefined || !containsVirtualNode(node)) {
          return false;
        }
        if (allowPartialContainment) {
          return range.intersectsNode(node);
        }

        const nodeRange = hostDocument.createRange();
        nodeRange.selectNode(node);
        return (
          range.compareBoundaryPoints(Range.START_TO_START, nodeRange) <= 0 &&
          range.compareBoundaryPoints(Range.END_TO_END, nodeRange) >= 0
        );
      },
    },
    deleteFromDocument: {
      value(): void {
        const state = currentSelection();
        if (state === null) {
          return;
        }

        const previous = selectionSnapshot(state);
        state.range.deleteContents();
        if (privateSelection !== null) {
          retainPrivateRange(selectionStateFromRange(state.range));
        }
        notifySelectionChange(previous);
      },
    },
    empty: {
      value(): void {
        facade.removeAllRanges();
      },
    },
    extend: {
      value(node: Node, offset = 0): void {
        const state = currentSelection();
        if (state === null) {
          return invalidSelectionState();
        }
        [node, offset] = virtualEndpoint(node, offset);
        if (!containsVirtualNode(node)) {
          return;
        }

        const range = rangeBetween(state.anchorNode, state.anchorOffset, node, offset);
        const previous = selectionSnapshot(state);
        const nativeSelectionMayHaveChanged = setRange({
          range,
          anchorNode: state.anchorNode,
          anchorOffset: state.anchorOffset,
          focusNode: node,
          focusOffset: offset,
        });
        notifySelectionChange(previous, nativeSelectionMayHaveChanged);
      },
    },
    getComposedRanges: {
      value(): StaticRange[] {
        if (typeof window.StaticRange !== "function") {
          return [];
        }
        return currentRanges().map(
          (range) =>
            new window.StaticRange({
              startContainer: range.startContainer,
              startOffset: range.startOffset,
              endContainer: range.endContainer,
              endOffset: range.endOffset,
            }),
        );
      },
    },
    getRangeAt: { value: rangeAt },
    modify: {
      value(): never {
        // Moving by rendered text needs the browser's own selection, which only
        // ever holds host-page endpoints; a silent no-op would let the guest
        // believe the caret moved.
        throw new window.DOMException(
          "Selection.modify() is unsupported inside v-frame",
          "NotSupportedError",
        );
      },
    },
    removeAllRanges: {
      value(): void {
        const previous = selectionSnapshot(currentSelection());
        if (privateSelection !== null) {
          privateSelection = null;
          notifySelectionChange(previous);
          return;
        }
        if (virtualNativeRanges().length > 0) {
          nativeSelection()?.removeAllRanges();
          notifySelectionChange(previous, true);
        }
      },
    },
    removeRange: {
      value(range: Range): void {
        const previous = selectionSnapshot(currentSelection());
        if (privateSelection !== null) {
          if (privateSelection.range !== range) {
            throw new window.DOMException("The range is not selected", "NotFoundError");
          }
          privateSelection = null;
          notifySelectionChange(previous);
          return;
        }
        if (virtualNativeRanges().length === 0) {
          throw new window.DOMException("The range is not selected", "NotFoundError");
        }

        nativeSelection()?.removeRange(range);
        notifySelectionChange(previous, true);
      },
    },
    selectAllChildren: {
      value(node: Node): void {
        if (node === options.document) {
          node = virtualRoot!;
        }
        if (!containsVirtualNode(node)) {
          return;
        }

        const range = hostDocument.createRange();
        range.selectNodeContents(node);
        const previous = selectionSnapshot(currentSelection());
        const nativeSelectionMayHaveChanged = setRange(selectionStateFromRange(range));
        notifySelectionChange(previous, nativeSelectionMayHaveChanged);
      },
    },
    setBaseAndExtent: {
      value(
        anchorNode: Node,
        anchorOffset: number,
        focusNode: Node,
        focusOffset: number,
      ): void {
        [anchorNode, anchorOffset] = virtualEndpoint(anchorNode, anchorOffset);
        [focusNode, focusOffset] = virtualEndpoint(focusNode, focusOffset);
        if (!containsVirtualNode(anchorNode) || !containsVirtualNode(focusNode)) {
          return;
        }

        const range = rangeBetween(anchorNode, anchorOffset, focusNode, focusOffset);
        const previous = selectionSnapshot(currentSelection());
        const nativeSelectionMayHaveChanged = setRange({
          range,
          anchorNode,
          anchorOffset,
          focusNode,
          focusOffset,
        });
        notifySelectionChange(previous, nativeSelectionMayHaveChanged);
      },
    },
    setPosition: {
      value(node: Node | null, offset = 0): void {
        facade.collapse(node, offset);
      },
    },
    toString: {
      value(): string {
        return currentRanges()
          .map((range) => range.toString())
          .join("");
      },
    },
  });

  return {
    selection: facade,
    dispose() {
      hostDocument.removeEventListener("selectionchange", hostSelectionChanged);
      expectedNativeSelectionChange = null;
      previousNativeSelectionSnapshot = null;
      privateSelection = null;
      virtualRoot = null;
    },
  };
}
