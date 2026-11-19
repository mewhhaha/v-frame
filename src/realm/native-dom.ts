import type { VFrameWindow } from "../types.js";

/** Detach a rendered document and unregister radios from its former tree scope. */
export function removeRenderedNode(node: Node, view: Window & typeof globalThis): void {
  const parentOf = Object.getOwnPropertyDescriptor(
    view.Node.prototype,
    "parentNode",
  )!.get!;
  const parent = parentOf.call(node) as Node | null;
  if (!parent) return;
  // Chromium's tree-scoped radio registry can retain a removed document through
  // a formless named radio. Release membership while the old scope is connected,
  // and restore the original attributes on the detached nodes in the same turn.
  const named: Array<[Element, string]> = [];
  const native = view.Element.prototype;
  try {
    if (node.nodeType === 1) {
      const form = Object.getOwnPropertyDescriptor(
        view.HTMLInputElement.prototype,
        "form",
      )!.get!;
      for (const input of native.querySelectorAll.call(
        node,
        'input[type="radio" i][name]',
      )) {
        if (input.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
        const name = native.getAttribute.call(input, "name");
        if (name && !form.call(input)) {
          named.push([input, name]);
          native.removeAttribute.call(input, "name");
        }
      }
    }
    if (parentOf.call(node) === parent)
      view.Node.prototype.removeChild.call(parent, node);
  } finally {
    for (const [input, name] of named) {
      if (!native.hasAttribute.call(input, "name"))
        native.setAttribute.call(input, "name", name);
    }
  }
}

/**
 * The guest's DOM accessors as they were before any guest script ran. Host
 * bookkeeping calls these instead of the prototype methods a guest may have
 * patched, so a guest override never runs inside the host's own traversals.
 */
export interface NativeDOM {
  querySelectorAll<T extends Element = Element>(root: ParentNode, selector: string): T[];
  getAttribute(element: Element, name: string): string | null;
  hasAttribute(element: Element, name: string): boolean;
}

export function captureNativeDOM(window: VFrameWindow): NativeDOM {
  const elementQuery = window.Element.prototype.querySelectorAll;
  const fragmentQuery = window.DocumentFragment.prototype.querySelectorAll;
  const documentQuery = window.Document.prototype.querySelectorAll;
  const getAttribute = window.Element.prototype.getAttribute;
  const hasAttribute = window.Element.prototype.hasAttribute;
  return {
    querySelectorAll<T extends Element>(root: ParentNode, selector: string) {
      // Node type rather than instanceof: adopted and foreign-document nodes belong
      // to another realm but are still valid receivers for these brand-checked methods.
      const query =
        root.nodeType === 1
          ? elementQuery
          : root.nodeType === 9
            ? documentQuery
            : fragmentQuery;
      return Array.from(query.call(root, selector) as NodeListOf<T>);
    },
    getAttribute: (element, name) => getAttribute.call(element, name),
    hasAttribute: (element, name) => hasAttribute.call(element, name),
  };
}
