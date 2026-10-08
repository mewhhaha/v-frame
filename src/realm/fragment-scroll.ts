import { findFragmentTarget, fragmentIdentifiers } from "../fragment.js";
import { FRAGMENT_TARGET_ATTRIBUTE } from "../wire-format.js";
import type { VFrameWindow } from "../types.js";
import { captureNativeDOM } from "./native-dom.js";

export interface FragmentTargets {
  readonly current: Element | null;
  /** Re-resolves the :target element for a URL and marks it. */
  update(url: string): void;
  /** Strips the marker from clones that copied it off the current target. */
  clearClones(nodes: readonly Node[]): void;
  dispose(): void;
}

export function createFragmentTargets(options: {
  window: VFrameWindow;
  getRoot(): Element | null;
  isDisposed(): boolean;
}): FragmentTargets {
  // Captured now, before any guest script can replace them on the prototype.
  const nativeSetAttribute = options.window.Element.prototype.setAttribute;
  const nativeRemoveAttribute = options.window.Element.prototype.removeAttribute;
  const nativeQuerySelectorAll = options.window.Element.prototype.querySelectorAll;
  const nativeDOM = captureNativeDOM(options.window);
  let target: Element | null = null;

  return {
    get current() {
      return target;
    },
    update(url) {
      const root = options.getRoot();
      if (root === null || options.isDisposed()) return;
      if (target) nativeRemoveAttribute.call(target, FRAGMENT_TARGET_ATTRIBUTE);
      target =
        new URL(url).hash === ""
          ? null
          : findFragmentTarget(
              [root, ...Array.from(nativeQuerySelectorAll.call(root, "*"))],
              url,
            );
      if (target) nativeSetAttribute.call(target, FRAGMENT_TARGET_ATTRIBUTE, "");
    },
    clearClones(nodes) {
      for (const node of nodes) {
        const elements = node.nodeType === 1 ? [node as Element] : [];
        if ("querySelectorAll" in node) {
          elements.push(
            ...nativeDOM.querySelectorAll(
              node as ParentNode,
              `[${FRAGMENT_TARGET_ATTRIBUTE}]`,
            ),
          );
        }
        for (const element of elements) {
          if (element !== target)
            nativeRemoveAttribute.call(element, FRAGMENT_TARGET_ATTRIBUTE);
        }
      }
    },
    dispose() {
      if (target) nativeRemoveAttribute.call(target, FRAGMENT_TARGET_ATTRIBUTE);
      target = null;
    },
  };
}

/** Native scrolling honors nested scrollports and CSS scroll margins/padding. */
export function scrollToFragment(
  host: HTMLElement,
  target: Element | null,
  url: string,
): void {
  if (!target) {
    const identifiers = fragmentIdentifiers(url);
    if (identifiers.length === 0 || identifiers.at(-1)!.toLowerCase() === "top") {
      host.scrollTo({ left: 0, top: 0, behavior: "instant" });
    }
    return;
  }

  // scrollIntoView also scrolls ancestors outside the frame. Preserve those
  // synchronously so only the guest's scrollports move, without an outer-page
  // jump or a smooth-scroll animation continuing after the restore.
  const ancestors: Array<{ element: Element; left: number; top: number }> = [];
  for (let node: Node | null = host.parentNode; node !== null;) {
    if (node.nodeType === 1) {
      const element = node as Element;
      ancestors.push({ element, left: element.scrollLeft, top: element.scrollTop });
    }
    node = node.parentNode ?? (node.nodeType === 11 ? (node as ShadowRoot).host : null);
  }
  target.scrollIntoView({ behavior: "instant", block: "start", inline: "nearest" });
  for (const { element, left, top } of ancestors) {
    if (element.scrollLeft !== left || element.scrollTop !== top) {
      element.scrollTo({ left, top, behavior: "instant" });
    }
  }
}
