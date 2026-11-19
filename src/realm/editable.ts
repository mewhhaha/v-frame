export function isEditingHost(element: Element): boolean {
  return (
    !!(element as HTMLElement).isContentEditable &&
    !(element.parentElement as HTMLElement | null)?.isContentEditable
  );
}

/** Apply the edited DOM without reparsing HTML or detaching unchanged guest nodes. */
export function syncEditable(
  source: Element,
  target: Element,
  originals: WeakMap<Element, Element>,
  formatting: WeakMap<Element, Set<string>>,
): void {
  const visit = (from: Element, to: Element) => {
    for (const name of formatting.get(from) ?? []) {
      const value = from.getAttribute(name);
      if (to.getAttribute(name) === value) continue;
      if (value === null) to.removeAttribute(name);
      else to.setAttribute(name, value);
    }
    let cursor = to.firstChild;
    const guestWidget = (node: Node) => (node as HTMLElement).contentEditable === "false";
    for (const child of from.childNodes) {
      while (cursor && guestWidget(cursor) && !guestWidget(child))
        cursor = cursor.nextSibling;
      let copy: Node | null = cursor;
      if (child.nodeType === 1) {
        const element = child as Element;
        const original = originals.get(element);
        if (original && target.contains(original)) copy = original;
        else if (original) {
          let match = cursor;
          while (match && !match.isEqualNode(original)) match = match.nextSibling;
          if (match) copy = match;
          else if ((copy as Element | null)?.id !== element.id) copy = null;
        } else copy = null;
      }
      if (!copy || copy.nodeName !== child.nodeName) {
        copy = target.ownerDocument.importNode(child, false);
      }
      if (copy !== cursor) to.insertBefore(copy, cursor);
      if (child.nodeType === 1) {
        originals.set(child as Element, copy as Element);
        if (!guestWidget(child) || !copy.hasChildNodes())
          visit(child as Element, copy as Element);
      } else if (copy.nodeValue !== child.nodeValue) copy.nodeValue = child.nodeValue;
      cursor = copy.nextSibling;
    }
    while (cursor) {
      const next = cursor.nextSibling;
      if (!guestWidget(cursor)) to.removeChild(cursor);
      cursor = next;
    }
  };
  visit(source, target);
}

/** Resolve both selection endpoints while the preview is still connected. */
export function editableSelection(
  source: Element,
  target: Element,
  originals: WeakMap<Element, Element>,
): (() => void) | undefined {
  const selection = source.ownerDocument.getSelection();
  if (!selection?.rangeCount) return;
  const root = source.getRootNode() as ShadowRoot;
  const range =
    selection.getComposedRanges?.({ shadowRoots: [root] })[0] ?? selection.getRangeAt(0);
  const match = (node: Node): Node | null => {
    if (node === source) return target;
    if (!node.parentNode || !source.contains(node)) return null;
    const original = originals.get(node as Element);
    if (original && target.contains(original)) return original;
    const parent = match(node.parentNode);
    const copy =
      parent?.childNodes[Array.prototype.indexOf.call(node.parentNode.childNodes, node)];
    if (copy?.nodeName === node.nodeName) return copy;
    return null;
  };
  const start = match(range.startContainer);
  const end = match(range.endContainer);
  if (!start || !end) return;
  const backward = selection.direction === "backward";
  const { startOffset, endOffset } = range;
  const valid = (node: Node, offset: number) =>
    target.contains(node) && offset <= (node.nodeValue?.length ?? node.childNodes.length);
  return () => {
    if (!valid(start, startOffset) || !valid(end, endOffset)) return;
    if (backward) selection.setBaseAndExtent(end, endOffset, start, startOffset);
    else selection.setBaseAndExtent(start, startOffset, end, endOffset);
  };
}
