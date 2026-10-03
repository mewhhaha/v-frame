// The facade is one closure split across modules: every part shares the context
// and the parts reference each other in both directions, so composition happens
// here rather than through imports between them.
//
// The order below is load-bearing. Creating a module only defines its
// functions, except for style.ts, which emits the inline stylesheet, and
// nodes.ts, which marks the shell tree — that marking has to see a finished
// style, event and attribute facade. Everything that patches a realm prototype
// waits for an explicit install call so that the patches still land in the
// order they landed in when this was a single function.

import { installAttributeFacade } from "./attributes.js";
import { installCollectionFacade } from "./collections.js";
import {
  createFacadeContext,
  type DocumentFacadeOptions,
  type NativeDocumentHandles,
} from "./context.js";
import { installDocumentProperties } from "./document.js";
import { installEventFacade } from "./events.js";
import { installNodeFacade } from "./nodes.js";
import { installSelectionFacade } from "./selection.js";
import { installStyleFacade } from "./style.js";

export type { DocumentFacadeOptions, NativeDocumentHandles } from "./context.js";

export interface DocumentFacade {
  native: NativeDocumentHandles;
  getSelection(): Selection;
  markVirtualTree(node: Node): void;
  rebaseURLs(): void;
  synchronizeURLAttribute(
    element: Element,
    attributeName: string,
    namespaceURI: string | null,
  ): void;
  synchronizeStyleAttribute(element: Element): void;
  eventForListener(event: Event, currentTarget: EventTarget): Event;
  finishEventListener(event: Event): void;
  suppressEventDefault(event: Event): void;
  suppressNativeLinkDefault(event: Event, anchor: Element): void;
  wasEventDefaultPrevented(event: Event): boolean;
  setReadyState(state: DocumentReadyState): void;
  dispatchDocumentEvent(type: string, options?: EventInit): boolean;
  dispose(): void;
}

export function installDocumentFacade(options: DocumentFacadeOptions): DocumentFacade {
  const context = createFacadeContext(options);
  const {
    document,
    privateHead,
    nativeCreateElement,
    nativeAppendChild,
    nativeGetAttribute,
    nativeSetAttribute,
    virtualNodes,
  } = context;

  const style = installStyleFacade(context);
  const events = installEventFacade(context);
  const attributes = installAttributeFacade(context, style, events);
  const nodes = installNodeFacade(context, style, events, attributes);

  events.installHandlerProperties();
  nodes.installMutationPatches();
  events.installRelays();
  events.installPatches();
  attributes.installPatches();
  style.installPatches();
  nodes.installNodePatches();

  const collections = installCollectionFacade(context);
  collections.installPatches();

  const selectionFacade = installSelectionFacade(context, nodes);
  const documentProperties = installDocumentProperties(
    context,
    events,
    nodes,
    collections,
    selectionFacade,
  );

  return {
    native: {
      privateHead,
      createElement<K extends keyof HTMLElementTagNameMap>(name: K) {
        return nativeCreateElement.call(document, name) as HTMLElementTagNameMap[K];
      },
      appendChild<T extends Node>(parent: Node, child: T): T {
        return nativeAppendChild.call(parent, child) as T;
      },
      getAttribute(element: Element, name: string) {
        return nativeGetAttribute.call(element, name);
      },
      setAttribute(element: Element, name: string, value: string) {
        nativeSetAttribute.call(element, name, value);
      },
    },
    getSelection: () => selectionFacade.selection,
    markVirtualTree: nodes.markVirtualNode,
    rebaseURLs() {
      for (const element of options.authoredURLAttributes.keys()) {
        if (virtualNodes.has(element)) {
          attributes.rebaseElementURLs(element);
        }
      }
      style.refreshInlineStyleSheet();
    },
    synchronizeURLAttribute: attributes.synchronizeURLAttribute,
    synchronizeStyleAttribute: style.synchronizeStyleAttribute,
    eventForListener: events.eventForListener,
    finishEventListener: events.finishEventListener,
    suppressEventDefault: events.suppressEventDefault,
    suppressNativeLinkDefault: events.suppressNativeLinkDefault,
    wasEventDefaultPrevented: events.wasEventDefaultPrevented,
    setReadyState: documentProperties.setReadyState,
    dispatchDocumentEvent: documentProperties.dispatchDocumentEvent,
    dispose() {
      collections.dispose();
      selectionFacade.dispose();
      context.dispose();
      events.dispose();
      context.restorePatches();
      nodes.dispose();
      documentProperties.dispose();
      // Cached native accessor shapes may outlive the realm. Sever their
      // remaining options references to the disposed virtual document.
      options.html = document.documentElement ?? privateHead;
      options.head = document.head ?? privateHead;
      options.body = document.body ?? privateHead;
    },
  };
}
