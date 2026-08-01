import {
  createFacadeContext,
  type DocumentFacadeOptions,
  type NativeDocumentHandles,
} from "./facade/context.js";
import { installAttributeFacade } from "./facade/attributes.js";
import { installCollectionFacade } from "./facade/collections.js";
import { installNodeFacade } from "./facade/nodes.js";
import { installDocumentProperties } from "./facade/document.js";
import { installEventFacade } from "./facade/events.js";
import { installStyleFacade } from "./facade/style.js";
import { installSelectionFacade } from "./facade/selection.js";

export type {
  DocumentFacadeOptions,
  NativeDocumentHandles,
} from "./facade/context.js";

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
  suppressEventDefault(event: Event): void;
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
  const {
    refreshInlineStyleSheet,
    synchronizeStyleAttribute,
    installPatches: installStylePatches,
  } = style;

  const events = installEventFacade(context);
  const {
    eventForListener,
    suppressEventDefault,
    wasEventDefaultPrevented,
    installHandlerProperties: installEventHandlerProperties,
    installRelays: installEventRelays,
    installPatches: installEventPatches,
    dispose: disposeEventFacade,
  } = events;

  const attributes = installAttributeFacade(context, style, events);
  const {
    rebaseElementURLs,
    synchronizeURLAttribute,
    installPatches: installAttributePatches,
  } = attributes;

  const nodes = installNodeFacade(context, style, events, attributes);
  const {
    markVirtualNode,
    installMutationPatches,
    installNodePatches,
    dispose: disposeNodeFacade,
  } = nodes;

  installEventHandlerProperties();

  installMutationPatches();

  installEventRelays();

  installEventPatches();

  installAttributePatches();
  installStylePatches();
  installNodePatches();
  const collections = installCollectionFacade(context);
  collections.installPatches();

  const selectionFacade = installSelectionFacade(context, nodes);

  const { setReadyState, dispatchDocumentEvent } = installDocumentProperties(
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
    markVirtualTree: markVirtualNode,
    rebaseURLs() {
      for (const element of options.authoredURLAttributes.keys()) {
        if (virtualNodes.has(element)) {
          rebaseElementURLs(element);
        }
      }
      refreshInlineStyleSheet();
    },
    synchronizeURLAttribute,
    synchronizeStyleAttribute,
    eventForListener,
    suppressEventDefault,
    wasEventDefaultPrevented,
    setReadyState,
    dispatchDocumentEvent,
    dispose() {
      selectionFacade.dispose();
      context.dispose();
      disposeEventFacade();
      context.restorePatches();
      disposeNodeFacade();
    },
  };
}
