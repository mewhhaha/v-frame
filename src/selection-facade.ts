export interface SelectionFacadeOptions {
  window: Window & typeof globalThis;
  hostDocument: Document;
  root: HTMLElement;
  onSelectionChange(): void;
}

export interface SelectionFacade {
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

function selectionStateFromRange(range: Range): SelectionState {
  return {
    range,
    anchorNode: range.startContainer,
    anchorOffset: range.startOffset,
    focusNode: range.endContainer,
    focusOffset: range.endOffset,
  };
}

function selectionStateFromNative(selection: Selection): SelectionState | null {
  if (
    selection.rangeCount === 0 ||
    selection.anchorNode === null ||
    selection.focusNode === null
  ) {
    return null;
  }

  return {
    range: selection.getRangeAt(0),
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };
}

export function createSelectionFacade(options: SelectionFacadeOptions): SelectionFacade {
  let privateSelection: SelectionState | null = null;
  let expectedNativeSelectionChange: SelectionSnapshot | null = null;
  let previousNativeSelectionSnapshot: SelectionSnapshot | null = null;

  const containsVirtualNode = (node: Node): boolean =>
    node === options.root || options.root.contains(node);
  const containsVirtualRange = (range: Range): boolean =>
    containsVirtualNode(range.startContainer) && containsVirtualNode(range.endContainer);
  const nativeSelection = (): Selection | null => options.hostDocument.getSelection();
  const virtualNativeRanges = (): Range[] => {
    const selection = nativeSelection();
    if (selection === null || selection.rangeCount === 0) {
      return [];
    }

    const ranges = Array.from(
      { length: selection.rangeCount },
      (_, index) => selection.getRangeAt(index),
    );
    return ranges.every(containsVirtualRange) ? ranges : [];
  };
  const currentSelection = (): SelectionState | null => {
    if (privateSelection !== null) {
      return privateSelection;
    }

    const selection = nativeSelection();
    const ranges = virtualNativeRanges();
    if (selection === null || ranges.length === 0) {
      return null;
    }
    return selectionStateFromNative(selection);
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
      : selectionSnapshot(selectionStateFromNative(selection));
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
    options.onSelectionChange();
  };
  const privateRange = (
    range: Range,
    anchorNode = range.startContainer,
    anchorOffset = range.startOffset,
    focusNode = range.endContainer,
    focusOffset = range.endOffset,
  ): void => {
    privateSelection = { range, anchorNode, anchorOffset, focusNode, focusOffset };
  };
  const nativeSelectionCanChange = (): boolean => {
    if (privateSelection !== null) {
      return false;
    }
    const selection = nativeSelection();
    return selection !== null && (selection.rangeCount === 0 || virtualNativeRanges().length > 0);
  };
  const setRange = (state: SelectionState): boolean => {
    if (!nativeSelectionCanChange()) {
      privateSelection = state;
      return false;
    }

    const selection = nativeSelection();
    if (selection === null) {
      privateSelection = state;
      return false;
    }

    try {
      selection.removeAllRanges();
      selection.addRange(state.range);
      if (virtualNativeRanges().length === 0) {
        privateSelection = state;
      }
      return true;
    } catch {
      privateSelection = state;
      return true;
    }
  };
  const collapsedRange = (node: Node, offset: number): Range => {
    const range = options.hostDocument.createRange();
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
    const range = options.hostDocument.createRange();
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
    throw new options.window.DOMException("There is no range in the selection", "InvalidStateError");
  };
  const rangeAt = (index: number): Range => {
    const ranges = privateSelection === null ? virtualNativeRanges() : [privateSelection.range];
    const range = ranges[index];
    if (range === undefined) {
      throw new options.window.DOMException("The selection has no range at that index", "IndexSizeError");
    }
    return range;
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
    options.onSelectionChange();
  };
  options.hostDocument.addEventListener("selectionchange", hostSelectionChanged);
  const facade = Object.create(options.window.Selection.prototype) as Selection;

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
      get: () => privateSelection === null ? virtualNativeRanges().length : 1,
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
        if ((privateSelection !== null ? 1 : virtualNativeRanges().length) !== 0) {
          return;
        }

        const previous = selectionSnapshot(currentSelection());

        if (!nativeSelectionCanChange()) {
          privateSelection = selectionStateFromRange(range);
          notifySelectionChange(previous);
          return;
        }

        const selection = nativeSelection();
        if (selection === null) {
          privateSelection = selectionStateFromRange(range);
          notifySelectionChange(previous);
          return;
        }

        let nativeSelectionMayHaveChanged = false;
        try {
          selection.addRange(range);
          nativeSelectionMayHaveChanged = true;
          if (virtualNativeRanges().length === 0) {
            privateSelection = selectionStateFromRange(range);
          }
        } catch {
          nativeSelectionMayHaveChanged = true;
          privateSelection = selectionStateFromRange(range);
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

        const nodeRange = options.hostDocument.createRange();
        nodeRange.selectNode(node);
        return range.compareBoundaryPoints(Range.START_TO_START, nodeRange) <= 0 &&
          range.compareBoundaryPoints(Range.END_TO_END, nodeRange) >= 0;
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
          privateRange(state.range);
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
        if (typeof options.window.StaticRange !== "function") {
          return [];
        }
        return (privateSelection === null ? virtualNativeRanges() : [privateSelection.range]).map(
          (range) => new options.window.StaticRange({
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
      value(): void {
        // Moving by rendered text depends on layout outside the virtual tree.
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
            throw new options.window.DOMException("The range is not selected", "NotFoundError");
          }
          privateSelection = null;
          notifySelectionChange(previous);
          return;
        }
        if (virtualNativeRanges().length === 0) {
          throw new options.window.DOMException("The range is not selected", "NotFoundError");
        }

        nativeSelection()?.removeRange(range);
        notifySelectionChange(previous, true);
      },
    },
    selectAllChildren: {
      value(node: Node): void {
        if (!containsVirtualNode(node)) {
          return;
        }

        const range = options.hostDocument.createRange();
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
        return (privateSelection === null ? virtualNativeRanges() : [privateSelection.range])
          .map((range) => range.toString())
          .join("");
      },
    },
  });

  return {
    selection: facade,
    dispose() {
      options.hostDocument.removeEventListener("selectionchange", hostSelectionChanged);
      expectedNativeSelectionChange = null;
    },
  };
}
