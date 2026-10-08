import type { VFrameWindow } from "../types.js";

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
