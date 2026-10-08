// The facade is one closure split across modules: every part shares the
// context and the parts reference each other in both directions, so
// composition happens here rather than through imports between them.
//
// The order below is load-bearing, and the contract is this list:
//
//  1. Creating a module only defines its functions, except for style (emits the
//     inline stylesheet) and marking, whose markShell() marks the shell tree —
//     that has to see a finished style, event and attribute facade.
//  2. Script execution and the mutation observer depend only on the context, so
//     they come first and are passed to the parts that call them. The one
//     genuine cycle is attributes -> marking -> attributes: marking is built
//     from the attribute facade, which hands it back its marker through
//     setAttributeMarker. markShell() needs that marker, so it follows.
//  3. Everything that patches a realm prototype waits for an explicit install
//     call, and the patches land in the order below. Two groups of node patches
//     sit around the event, attribute and style ones because they patch keys
//     those also touch; dispose() unwinds them newest-first.

import { installAttributeFacade } from "./attributes.js";
import { createNodeCloning } from "./clone.js";
import { installCollectionFacade } from "./collections.js";
import {
  createFacadeContext,
  type DocumentFacadeOptions,
  type NativeDocumentHandles,
} from "./context.js";
import { installDocumentProperties } from "./document.js";
import { installEventFacade } from "./events.js";
import { createForeignElementFacade } from "./foreign-element.js";
import { createNodeInsertion } from "./insertion.js";
import { installNodeMarking } from "./marking.js";
import { installMarkupFacade } from "./markup.js";
import { createMutationObserverFacade } from "./mutation-observer.js";
import { createNodeArguments } from "./node-arguments.js";
import { createNodePatches } from "./node-patches.js";
import { createScriptExecution } from "./script-execution.js";
import { installSelectionFacade } from "./selection.js";
import { installStyleFacade } from "./style.js";
import { createTreePatches } from "./tree-patches.js";

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
  const mutationObserver = createMutationObserverFacade(context);
  const scripts = createScriptExecution(context);
  const events = installEventFacade(context, mutationObserver);
  const attributes = installAttributeFacade(context, style, events, scripts);

  const foreignElement = createForeignElementFacade(context, style, attributes);
  const marking = installNodeMarking(context, style, events, attributes, foreignElement);
  attributes.setAttributeMarker(marking.markVirtualAttribute);
  marking.markShell();

  const nodeArguments = createNodeArguments(context);
  const insertion = createNodeInsertion(context, marking, scripts, nodeArguments);
  const cloning = createNodeCloning(context, style, events, marking, insertion, scripts);
  const treePatches = createTreePatches(
    context,
    insertion,
    cloning,
    scripts,
    nodeArguments,
  );
  const markup = installMarkupFacade(context, marking, nodeArguments, attributes);
  const nodePatches = createNodePatches(context, marking, insertion, scripts);

  events.installHandlerProperties();
  marking.installIdentityPatches();
  treePatches.installPatches();
  markup.installPatches();
  events.installRelays();
  events.installPatches();
  attributes.installPatches();
  style.installPatches();
  nodePatches.installPatches();
  mutationObserver.installPatches();

  const collections = installCollectionFacade(context);
  collections.installPatches();

  const selectionFacade = installSelectionFacade(
    context,
    insertion,
    cloning,
    nodeArguments,
  );
  const documentProperties = installDocumentProperties(
    context,
    events,
    marking,
    cloning,
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
    markVirtualTree: marking.markVirtualNode,
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
      marking.dispose();
      documentProperties.dispose();
      // Cached native accessor shapes may outlive the realm. Sever their
      // remaining options references to the disposed virtual document.
      options.html = document.documentElement ?? privateHead;
      options.head = document.head ?? privateHead;
      options.body = document.body ?? privateHead;
    },
  };
}
