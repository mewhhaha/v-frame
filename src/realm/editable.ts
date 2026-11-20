import { HTML_NAMESPACE } from "../asset-urls.js";

let editingHost: ((element: Element) => boolean) | undefined;

export function isEditingHost(element: Element): boolean {
  if (!editingHost) {
    const namespace = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "namespaceURI",
    )!.get!;
    const parent = Object.getOwnPropertyDescriptor(Node.prototype, "parentElement")!.get!;
    const editable = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "isContentEditable",
    )!.get!;
    const isEditable = (node: Element | null) =>
      node && namespace.call(node) === HTML_NAMESPACE && editable.call(node);
    editingHost = (node) => !!isEditable(node) && !isEditable(parent.call(node));
  }
  return editingHost(element);
}

function isWidget(node: Node): boolean {
  return (node as HTMLElement).contentEditable === "false";
}

function sameWidget(original: Element, candidate: Element): boolean {
  if (!isWidget(candidate)) return false;
  if (!original.id) return candidate.isEqualNode(original);
  return (
    candidate.id === original.id &&
    candidate.localName === original.localName &&
    candidate.namespaceURI === original.namespaceURI
  );
}

export class EditableWidgets {
  readonly #children = new WeakMap<Node, Set<Element>>();
  readonly #parents = new WeakMap<Element, Element>();

  capture(parent: Node, children: Iterable<Element>): void {
    for (const child of children) {
      if (!isWidget(child)) continue;
      let widgets = this.#children.get(parent);
      if (!widgets) this.#children.set(parent, (widgets = new Set()));
      widgets.add(child);
    }
  }

  removeMissing(
    editor: Element,
    from: Element,
    to: Element,
    originals: WeakMap<Element, Element>,
  ): void {
    const widgets = this.#children.get(from);
    if (!widgets) return;
    const previous = this.#parents.get(from) ?? originals.get(from);
    if (previous && previous !== to) {
      // Match only widgets that actually belonged to the previous parent.
      // Equal repeated mentions keep their order when the counts agree.
      const prior: { widget: Element; old: Element }[] = [];
      for (const widget of widgets) {
        const old = originals.get(widget);
        if (old?.parentNode === previous) prior.push({ widget, old });
      }
      const current = Array.from(to.children).filter(isWidget);
      for (const entry of prior) {
        const siblings = prior.filter(({ old }) => sameWidget(entry.old, old));
        const matches = current.filter((candidate) => sameWidget(entry.old, candidate));
        if (siblings.length === matches.length)
          originals.set(entry.widget, matches[siblings.indexOf(entry)]!);
      }
    }
    this.#parents.set(from, to);
    for (const widget of widgets) {
      const original = originals.get(widget);
      if (original?.parentNode === to && !editor.contains(widget)) original.remove();
    }
  }
}

/** Apply the edited DOM without reparsing HTML or detaching unchanged guest nodes. */
export function syncEditable(
  source: Element,
  target: Element,
  originals: WeakMap<Element, Element>,
  formatting: WeakMap<Element, Set<string>>,
  widgets: EditableWidgets,
): void {
  const visit = (from: Element, to: Element) => {
    widgets.removeMissing(source, from, to, originals);
    for (const name of formatting.get(from) ?? []) {
      const value = from.getAttribute(name);
      if (to.getAttribute(name) === value) continue;
      if (value === null) to.removeAttribute(name);
      else to.setAttribute(name, value);
    }
    let cursor = to.firstChild;
    for (const child of from.childNodes) {
      while (cursor && isWidget(cursor) && !isWidget(child)) cursor = cursor.nextSibling;
      let copy: Node | null = cursor;
      if (child.nodeType === 1) {
        const element = child as Element;
        const original = originals.get(element);
        if (original && target.contains(original)) copy = original;
        else if (original && isWidget(child)) {
          // A guest may have inserted its own identical control in this parent.
          if (
            Array.from(to.children).some((candidate) => sameWidget(original, candidate))
          )
            continue;
          copy = null;
        } else if (original) {
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
        if (isWidget(child)) widgets.capture(from, [child as Element]);
        if (!isWidget(child) || !copy.hasChildNodes())
          visit(child as Element, copy as Element);
        originals.set(child as Element, copy as Element);
      } else if (copy.nodeValue !== child.nodeValue) copy.nodeValue = child.nodeValue;
      cursor = copy.nextSibling;
    }
    while (cursor) {
      const next = cursor.nextSibling;
      if (!isWidget(cursor)) to.removeChild(cursor);
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
