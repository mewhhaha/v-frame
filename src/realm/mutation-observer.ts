// Watches the live markup for the edits that bypass the facade — a node
// inserted through a native method or by a framework holding the real DOM —
// and feeds them to the dynamic style pipeline. Records are only collected
// while the callback walks them; the work is scheduled afterwards so that a
// style inserted and removed in one batch never reaches the pipeline.

import { HTML_NAMESPACE } from "../asset-urls.js";
import type { DocumentFacade } from "../facade/index.js";
import type { VFrameWindow } from "../types.js";
import type { DynamicStyles } from "./dynamic-styles.js";
import { captureNativeDOM } from "./native-dom.js";

interface RealmMutationObserverOptions {
  window: VFrameWindow;
  root: Element;
  styles: DynamicStyles;
  /** The realm's own inline stylesheet, which the pipeline must never rewrite. */
  inlineStyleSheet: HTMLStyleElement;
  getFacade(): DocumentFacade | null;
  isConnectedToRealm(node: Node): boolean;
  onBaseElementChange(): void;
}

/** Returns the disposer that disconnects the observer. */
export function observeRealmMutations(options: RealmMutationObserverOptions): () => void {
  const { window, styles, inlineStyleSheet } = options;
  const nativeDOM = captureNativeDOM(window);

  // Only HTML-namespace base elements affect the document base URL;
  // querySelector's unprefixed type selector also matches foreign ones.
  const isHTMLBase = (element: Element): boolean =>
    element.localName === "base" && element.namespaceURI === HTML_NAMESPACE;
  const subtreeHasBaseElement = (node: Node): boolean =>
    (node instanceof window.Element && isHTMLBase(node)) ||
    ("querySelectorAll" in node &&
      nativeDOM.querySelectorAll(node as ParentNode, "base").some(isHTMLBase));

  const observer = new globalThis.MutationObserver((records) => {
    const facade = options.getFacade();
    const stylesWithContentChanges = new Set<HTMLStyleElement>();
    const stylesWithAttributeChanges = new Set<HTMLStyleElement>();
    const linksWithAttributeChanges = new Set<HTMLLinkElement>();
    const stylesConnectedWithoutFacade = new Set<HTMLStyleElement>();
    const linksConnectedWithoutFacade = new Set<HTMLLinkElement>();
    const removedStyles = new Set<HTMLStyleElement>();
    const removedLinks = new Set<HTMLLinkElement>();
    let baseElementsChanged = false;
    for (const record of records) {
      if (record.type === "childList") {
        if (
          record.target instanceof window.HTMLStyleElement &&
          record.target !== inlineStyleSheet
        ) {
          stylesWithContentChanges.add(record.target);
        }
        for (const node of record.addedNodes) {
          facade?.markVirtualTree(node);
          for (const style of styles.virtualStylesFrom([node])) {
            if (!styles.claimAwaitedStyle(style)) {
              stylesConnectedWithoutFacade.add(style);
            }
          }
          for (const link of styles.dynamicLinksFrom([node])) {
            if (!styles.claimAwaitedLink(link)) {
              linksConnectedWithoutFacade.add(link);
            }
          }
          baseElementsChanged ||= subtreeHasBaseElement(node);
        }
        for (const node of record.removedNodes) {
          for (const style of styles.virtualStylesFrom([node])) {
            removedStyles.add(style);
          }
          for (const link of styles.dynamicLinksFrom([node])) {
            removedLinks.add(link);
          }
          baseElementsChanged ||= subtreeHasBaseElement(node);
        }
      } else if (record.type === "characterData") {
        const parentStyle =
          record.target.parentNode instanceof window.HTMLStyleElement
            ? record.target.parentNode
            : null;
        if (parentStyle !== null) {
          stylesWithContentChanges.add(parentStyle);
        }
      } else if (
        record.type === "attributes" &&
        record.target instanceof window.Element
      ) {
        facade?.synchronizeURLAttribute(
          record.target,
          record.attributeName ?? "",
          record.attributeNamespace,
        );
        if (record.attributeName === "style") {
          facade?.synchronizeStyleAttribute(record.target);
        }
        if (
          record.target instanceof window.HTMLStyleElement &&
          record.target !== inlineStyleSheet
        ) {
          stylesWithAttributeChanges.add(record.target);
        } else if (record.target instanceof window.HTMLLinkElement) {
          linksWithAttributeChanges.add(record.target);
        }
      }
    }
    if (baseElementsChanged) {
      options.onBaseElementChange();
    }
    for (const style of removedStyles) {
      if (!options.isConnectedToRealm(style)) {
        styles.invalidateDynamicStyle(style);
      }
    }
    for (const link of removedLinks) {
      if (!options.isConnectedToRealm(link)) {
        styles.invalidateDynamicLink(link);
      }
    }
    for (const style of stylesConnectedWithoutFacade) {
      styles.scheduleConnectedDynamicStyle(style);
    }
    for (const link of linksConnectedWithoutFacade) {
      styles.scheduleDynamicLink(link, true);
    }
    for (const style of stylesWithContentChanges) {
      styles.scheduleDynamicStyleContent(style);
    }
    for (const style of stylesWithAttributeChanges) {
      styles.scheduleDynamicStyleAttributes(style);
    }
    for (const link of linksWithAttributeChanges) {
      styles.scheduleDynamicLink(link);
    }
  });
  observer.observe(options.root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "action",
      "cite",
      "data",
      "disabled",
      "formaction",
      "href",
      "media",
      "poster",
      "rel",
      "src",
      "srcset",
      "style",
    ],
  });
  return () => observer.disconnect();
}
