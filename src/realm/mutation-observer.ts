// Watches the live markup for the edits that bypass the facade — a node
// inserted through a native method or by a framework holding the real DOM —
// and feeds them to the dynamic style pipeline. Records are only collected
// while the callback walks them; the work is scheduled afterwards so that a
// style inserted and removed in one batch never reaches the pipeline.

import { HTML_NAMESPACE } from "../asset-urls.js";
import type { SubtreeScan } from "../facade/context.js";
import type { DocumentFacade } from "../facade/index.js";
import type { VFrameWindow } from "../types.js";
import { FRAGMENT_TARGET_ATTRIBUTE } from "../wire-format.js";
import type { DynamicStyles } from "./dynamic-styles.js";
import { captureNativeDOM, type NativeDOM } from "./native-dom.js";

const SPECIAL_TRACKING_CAP = 32;
const SPECIAL_SELECTOR = `base,script,style,link,[${FRAGMENT_TARGET_ATTRIBUTE}]`;

interface RealmMutationObserverOptions {
  window: VFrameWindow;
  nativeDOM?: NativeDOM;
  facadeConnectedCounts?: WeakMap<Node, number>;
  root: Element;
  styles: DynamicStyles;
  /** The realm's own inline stylesheet, which the pipeline must never rewrite. */
  inlineStyleSheet: HTMLStyleElement;
  skipInitialScan?: boolean;
  getFacade(): DocumentFacade | null;
  isConnectedToRealm(node: Node): boolean;
  onBaseElementChange(): void;
}

export interface RealmMutationObserver {
  observeMutations(): void;
  flushIndex(selfMovedNodes?: readonly Node[]): boolean;
  recordConnected(nodes: readonly Node[], scan?: SubtreeScan): void;
  trackElement(element: Element): void;
  subtreeHas(node: Node, baseOnly: boolean): boolean | undefined;
  dispose(): void;
}

function consumeCount(counts: WeakMap<Node, number> | undefined, node: Node): boolean {
  if (counts === undefined) return false;
  const remaining = counts.get(node);
  if (remaining === undefined || remaining <= 0) return false;
  if (remaining === 1) counts.delete(node);
  else counts.set(node, remaining - 1);
  return true;
}

/** Observes live markup mutations and tracks bounded connected special elements. */
export function observeRealmMutations(
  options: RealmMutationObserverOptions,
  initialElements?: readonly Element[],
): RealmMutationObserver {
  const { window, styles, inlineStyleSheet, facadeConnectedCounts } = options;
  const nativeDOM = options.nativeDOM ?? captureNativeDOM(window);
  const nativeContains = window.Node.prototype.contains;

  const tracked = new Set<Element>();
  let overflowed = false;

  const isHTMLBase = (element: Element): boolean =>
    element.localName === "base" && element.namespaceURI === HTML_NAMESPACE;
  const isTrackable = (element: Element): boolean => {
    if (element.namespaceURI === HTML_NAMESPACE) {
      const name = element.localName;
      if (
        name === "base" ||
        name === "link" ||
        name === "script" ||
        (name === "style" && element !== inlineStyleSheet)
      ) {
        return true;
      }
    }
    return nativeDOM.hasAttribute(element, FRAGMENT_TARGET_ATTRIBUTE);
  };
  const subtreeHasBaseElement = (node: Node): boolean =>
    (node.nodeType === 1 && isHTMLBase(node as Element)) ||
    ((node.nodeType === 1 || node.nodeType === 11) &&
      (node as ParentNode).firstElementChild !== null &&
      nativeDOM.querySelectorAll(node as ParentNode, "base").some(isHTMLBase));

  const pruneDisconnected = (): void => {
    for (const element of tracked) {
      if (!options.isConnectedToRealm(element)) tracked.delete(element);
    }
  };
  const trackElement = (element: Element): void => {
    if (
      overflowed ||
      tracked.has(element) ||
      !options.isConnectedToRealm(element) ||
      !isTrackable(element)
    )
      return;
    if (tracked.size >= SPECIAL_TRACKING_CAP) {
      pruneDisconnected();
      if (tracked.size >= SPECIAL_TRACKING_CAP) {
        overflowed = true;
        tracked.clear();
        return;
      }
    }
    tracked.add(element);
  };
  const trackSubtree = (node: Node): void => {
    if (overflowed || !options.isConnectedToRealm(node)) return;
    if (node.nodeType === 1) trackElement(node as Element);
    if (
      (node.nodeType === 1 || node.nodeType === 11) &&
      (node as ParentNode).firstElementChild !== null
    ) {
      for (const element of nativeDOM.querySelectorAll(
        node as ParentNode,
        SPECIAL_SELECTOR,
      ))
        trackElement(element);
    }
  };
  const subtreeHas = (node: Node, baseOnly: boolean): boolean | undefined => {
    // Only answer for nodes inside the observed light tree; guest shadow roots
    // and detached subtrees are outside `options.root` and fall back to scanning.
    if (overflowed || !options.isConnectedToRealm(node)) return undefined;
    for (const element of tracked) {
      if (
        baseOnly
          ? !isHTMLBase(element)
          : isHTMLBase(element) &&
            !nativeDOM.hasAttribute(element, FRAGMENT_TARGET_ATTRIBUTE)
      ) {
        continue;
      }
      if (!options.isConnectedToRealm(element)) {
        tracked.delete(element);
        continue;
      }
      if (nativeContains.call(node, element)) return true;
    }
    return false;
  };

  // Single MutationObserver with passive synchronous indexing and deferred
  // async processing: pure single-node self-moves discard their records inline
  // without scheduling a microtask, while all other records update the special
  // index synchronously and defer style/link/URL/base processing to a microtask
  // so stylesheet edits and batches preserve their original async schedule.
  const indexRecords = (records: MutationRecord[]): void => {
    if (overflowed) return;
    let sawRemoval = false;
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i]!;
      if (record.type === "childList") {
        const added = record.addedNodes;
        for (let j = 0; j < added.length; j += 1) {
          trackSubtree(added[j]!);
        }
        if (record.removedNodes.length > 0) sawRemoval = true;
      } else if (
        record.type === "attributes" &&
        record.attributeName === FRAGMENT_TARGET_ATTRIBUTE &&
        record.target.nodeType === 1
      ) {
        const target = record.target as Element;
        if (nativeDOM.hasAttribute(target, FRAGMENT_TARGET_ATTRIBUTE)) {
          trackElement(target);
        } else if (!isTrackable(target)) {
          tracked.delete(target);
        }
      }
    }
    if (sawRemoval) pruneDisconnected();
  };

  let mainObserving = false;
  let deferredRecords: MutationRecord[] = [];
  // Private detached Text node observed by the same MutationObserver so
  // draining records via takeRecords() can re-arm the observer's existing
  // microtask delivery slot rather than pushing deferred work behind already-
  // queued promises.
  const deliveryTrigger = options.root.ownerDocument.createTextNode("");

  const processRecords = (records: MutationRecord[]): void => {
    const facade = options.getFacade();
    const stylesWithContentChanges = new Set<HTMLStyleElement>();
    const stylesWithAttributeChanges = new Set<HTMLStyleElement>();
    const linksWithAttributeChanges = new Set<HTMLLinkElement>();
    const stylesConnectedWithoutFacade = new Set<HTMLStyleElement>();
    const linksConnectedWithoutFacade = new Set<HTMLLinkElement>();
    const removedStyles = new Set<HTMLStyleElement>();
    const removedLinks = new Set<HTMLLinkElement>();
    const checkedRemovedBase = new Set<Node>();
    let baseElementsChanged = false;
    let sawDisconnectedRemoval = false;
    for (const record of records) {
      if (record.target === deliveryTrigger) {
        continue;
      }
      if (record.type === "childList") {
        if (
          record.target instanceof window.HTMLStyleElement &&
          record.target !== inlineStyleSheet
        ) {
          stylesWithContentChanges.add(record.target);
        }
        for (const node of record.addedNodes) {
          if (consumeCount(facadeConnectedCounts, node)) {
            continue;
          }
          facade?.markVirtualTree(node);
          trackSubtree(node);
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
          if (options.isConnectedToRealm(node)) {
            if (!baseElementsChanged && !checkedRemovedBase.has(node)) {
              checkedRemovedBase.add(node);
              baseElementsChanged = subtreeHas(node, true) ?? subtreeHasBaseElement(node);
            }
            continue;
          }
          sawDisconnectedRemoval = true;
          for (const style of styles.virtualStylesFrom([node])) {
            removedStyles.add(style);
          }
          for (const link of styles.dynamicLinksFrom([node])) {
            removedLinks.add(link);
          }
          // Inspect removed subtrees independently of index membership so a
          // pruned or concurrently removed <base> always triggers URL rebasing.
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
        if (record.attributeName === FRAGMENT_TARGET_ATTRIBUTE) {
          if (nativeDOM.hasAttribute(record.target, FRAGMENT_TARGET_ATTRIBUTE)) {
            trackElement(record.target);
          } else if (!isTrackable(record.target)) {
            tracked.delete(record.target);
          }
          continue;
        }
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
    if (sawDisconnectedRemoval) pruneDisconnected();
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
  };

  const observer = new globalThis.MutationObserver((records) => {
    if (!mainObserving) {
      indexRecords(records);
      return;
    }
    if (deferredRecords.length > 0) {
      const pending = deferredRecords;
      deferredRecords = [];
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i]!;
        if (record.target !== deliveryTrigger) pending.push(record);
      }
      processRecords(pending);
      return;
    }
    processRecords(records);
  });

  const armDelivery = (): void => {
    if (mainObserving && deferredRecords.length > 0) {
      deliveryTrigger.data = deliveryTrigger.data === "" ? " " : "";
    }
  };

  const deferRecords = (records: MutationRecord[]): void => {
    if (!mainObserving || records.length === 0) return;
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i]!;
      if (record.target !== deliveryTrigger) deferredRecords.push(record);
    }
    armDelivery();
  };

  observer.observe(deliveryTrigger, { characterData: true });
  observer.observe(options.root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "action",
      "cite",
      "data",
      FRAGMENT_TARGET_ATTRIBUTE,
      "disabled",
      "formaction",
      "href",
      "integrity",
      "media",
      "poster",
      "rel",
      "src",
      "srcset",
      "style",
    ],
  });
  if (!options.skipInitialScan) {
    trackSubtree(options.root);
  } else if (initialElements !== undefined) {
    for (const element of initialElements) trackElement(element);
  }

  const flushIndex = (selfMovedNodes?: readonly Node[]): boolean => {
    const records = observer.takeRecords();
    if (records.length === 0) {
      armDelivery();
      return true;
    }
    if (
      selfMovedNodes?.length === 1 &&
      !overflowed &&
      options.isConnectedToRealm(selfMovedNodes[0]!) &&
      subtreeHas(selfMovedNodes[0]!, true) === false
    ) {
      const moved = selfMovedNodes[0]!;
      let pure = true;
      for (let i = 0; i < records.length; i += 1) {
        const r = records[i]!;
        if (r.target === deliveryTrigger) continue;
        if (
          r.type !== "childList" ||
          (r.target.nodeType === 1 &&
            (r.target as Element).localName === "style" &&
            (r.target as Element).namespaceURI === HTML_NAMESPACE) ||
          r.addedNodes.length > 1 ||
          r.removedNodes.length > 1 ||
          (r.addedNodes.length === 1 && r.addedNodes[0] !== moved) ||
          (r.removedNodes.length === 1 && r.removedNodes[0] !== moved)
        ) {
          pure = false;
          break;
        }
      }
      if (pure) {
        armDelivery();
        return true;
      }
    }
    indexRecords(records);
    deferRecords(records);
    return false;
  };

  return {
    observeMutations() {
      if (mainObserving) return;
      const bootstrapRecords = observer.takeRecords();
      if (bootstrapRecords.length > 0) indexRecords(bootstrapRecords);
      deferredRecords.length = 0;
      mainObserving = true;
    },
    flushIndex,
    recordConnected(nodes, scan) {
      if (scan !== undefined) {
        for (const style of scan.styles) trackElement(style);
        for (const link of scan.links) trackElement(link);
        for (const script of scan.scripts) trackElement(script);
        if (!scan.hasBase && !scan.hasTarget) return;
      }
      for (const node of nodes) trackSubtree(node);
    },
    trackElement,
    subtreeHas,
    dispose() {
      mainObserving = false;
      observer.disconnect();
      deferredRecords.length = 0;
      tracked.clear();
    },
  };
}
