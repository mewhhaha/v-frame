import { connectChannels } from "../channel-context.js";
// createRealm composes the modules in this directory around one closure. The
// closure is the design: markup, the facade, the script runner and the history
// all become available at different points during bootstrap, so the modules
// receive getters rather than values and read the current one when they run.
//
// The order below is load-bearing. Nothing here is a free reordering: patches
// have to land in the order a real document would install them, and the
// disposers unwind in the reverse of that order.

import { installDocumentFacade, type DocumentFacade } from "../facade/index.js";
import {
  BoundHistory,
  type DocumentHistoryMode,
  type NavigateDispatchOptions,
  type NavigationControls,
  VirtualHistory,
  VirtualHistorySession,
} from "../history.js";
import {
  prepareAdoptedMarkup,
  prepareMarkup,
  type PreparedMarkup,
  type PrepareMarkupOptions,
} from "../markup.js";
import { installNetworkPatches } from "../network.js";
import type { AdoptionState } from "./adoption-state.js";
import { createDocumentBase } from "./base-url.js";
import { captureNativeDOM, removeRenderedNode } from "./native-dom.js";
import { createFragmentTargets, scrollToFragment } from "./fragment-scroll.js";
import { observeRealmMutations } from "./mutation-observer.js";
import { ScriptRunner } from "../scripts.js";
import { createStagedRoot } from "./staging.js";
import { abortError, type RealmFailure, type RealmTrustedTypes } from "./connect.js";
import { createDynamicStyles } from "./dynamic-styles.js";
import {
  installRealmNavigation,
  type DocumentNavigationRequest,
  type NativeLocationNavigationMode,
} from "./navigation.js";
import {
  installCSSStyleSheetBridge,
  installInternalStyles,
  installStagedFocus,
  installStagedTopLayer,
  installViewportPatches,
  installWindowEventBridge,
} from "./window-patches.js";
import type {
  VFrameCredentials,
  VFrameNavigateEventDetail,
  VFrameNavigationKind,
  VFrameWindow,
} from "../types.js";

export {
  abortError,
  connectRealmIframe,
  type ConnectedRealmIframe,
  type RealmFailure,
} from "./connect.js";
export type { DocumentNavigationRequest } from "./navigation.js";

export interface CreateRealmOptions {
  host: HTMLElement;
  shadowRoot: ShadowRoot;
  iframe: HTMLIFrameElement;
  trustedTypes: RealmTrustedTypes;
  markup:
    | { kind: "document"; source: string }
    | {
        kind: "adopted";
        source: string;
        previewNodes: Node[];
        state: AdoptionState;
      };
  pageURL: string;
  historySession: VirtualHistorySession;
  boundNavigation: boolean;
  stageMarkup: boolean;
  preserveScroll: boolean;
  restoreScroll: boolean;
  credentials: VFrameCredentials;
  signal: AbortSignal;
  getNonce(): string;
  fetchStylesheet: PrepareMarkupOptions["fetchStylesheet"];
  onURLChange(url: string, kind: VFrameNavigationKind | null): void;
  onNavigate(
    detail: VFrameNavigateEventDetail,
    options?: NavigateDispatchOptions,
  ): boolean;
  onDocumentNavigation(
    detail: VFrameNavigateEventDetail,
    mode: DocumentHistoryMode,
    request?: DocumentNavigationRequest,
  ): boolean;
  onDocumentTraversal(session: VirtualHistorySession): Promise<void>;
  onShellNavigation(detail: VFrameNavigateEventDetail): boolean;
  onNativeLocationNavigation(
    detail: VFrameNavigateEventDetail,
    mode: NativeLocationNavigationMode,
  ): void;
  onError(failure: RealmFailure): void;
}

export interface VFrameRealm {
  readonly window: VFrameWindow;
  readonly navigation: NavigationControls;
  readonly shadowRoot: ShadowRoot;
  executeInitialScripts(): Promise<void>;
  reveal(): void;
  dispose(): void;
}

export async function createRealm(options: CreateRealmOptions): Promise<VFrameRealm> {
  // Unwind resources in reverse order on both bootstrap failure and disposal.
  const disposers: Array<() => void> = [];
  let disconnectChannels: (() => void) | undefined;
  const teardown = (): void => {
    const failures: unknown[] = [];
    // Removing the rendered DOM can synchronously call guest disconnectedCallback.
    let dispose = disconnectChannels ?? disposers.pop();
    disconnectChannels = undefined;
    while (dispose !== undefined) {
      try {
        dispose();
      } catch (error) {
        failures.push(error);
      }
      dispose = disposers.pop();
    }
    for (const error of failures) {
      options.onError({ phase: "runtime", url: options.pageURL, error });
    }
  };
  const adoptionState = options.markup.kind === "adopted" ? options.markup.state : null;
  let markup: PreparedMarkup | null = null;

  try {
    if (adoptionState) disposers.push(() => adoptionState.dispose());
    disposers.push(() => options.iframe.remove());
    const iframe = options.iframe;
    const window = iframe.contentWindow as VFrameWindow | null;
    const document = iframe.contentDocument;
    if (window === null || document === null) {
      throw new Error("The connected iframe has no same-origin execution realm");
    }
    const hostListenerLifetime = new AbortController();
    const childListenerLifetime = new window.AbortController();
    disposers.push(() => hostListenerLifetime.abort());
    disposers.push(() => childListenerLifetime.abort());

    const nativeDOM = captureNativeDOM(window);
    const facadeConnectedNodes = new WeakSet<Node>();
    const nativeCurrentScriptGetter = Object.getOwnPropertyDescriptor(
      window.Document.prototype,
      "currentScript",
    )?.get;
    const nativeWindowOpen = window.open.bind(window);
    const scheduleNavigationDefault = window.setTimeout.bind(window);

    const prepare =
      options.markup.kind === "adopted" ? prepareAdoptedMarkup : prepareMarkup;
    markup = await prepare({
      window,
      document,
      source: options.markup.source,
      createHTML: options.trustedTypes.createHTML,
      createScriptURL: options.trustedTypes.createScriptURL,
      pageURL: options.pageURL,
      nonce: options.getNonce(),
      fetchStylesheet: options.fetchStylesheet,
      onError(failure) {
        if (!options.signal.aborted) {
          options.onError(failure);
        }
      },
    });

    if (options.signal.aborted) {
      throw abortError();
    }

    // The serialized document is parsed into `markup`; the realm outlives the load
    // that built these options, so it must not keep a second copy of an SSR payload.
    options.markup.source = "";
    const preparedMarkup = markup;
    const hostView = options.host.ownerDocument.defaultView!;
    disconnectChannels = connectChannels(window, hostView);
    const staged =
      options.stageMarkup || adoptionState !== null
        ? createStagedRoot(options.shadowRoot)
        : null;
    if (staged) disposers.push(staged.dispose);
    const renderRoot = staged?.root ?? options.shadowRoot;
    const internalStyles = installInternalStyles(options.shadowRoot, renderRoot);
    disposers.push(internalStyles.dispose);
    disposers.push(() => {
      removeRenderedNode(preparedMarkup.html, hostView);
      hostView.Element.prototype.remove.call(preparedMarkup.inlineStyleSheet);
    });

    const privateHead = document.head;
    if (privateHead === null) {
      throw new Error("The execution document lost its private head before bootstrap");
    }
    const privateBase = document.createElement("base");
    privateBase.href = markup.baseURL;
    privateHead.append(privateBase);

    let currentURL = options.pageURL;
    let disposed = false;
    let scriptRunner: ScriptRunner | null = null;
    let facade: DocumentFacade | null = null;
    let markupRevealed = staged === null;
    const fragmentTargets = createFragmentTargets({
      window,
      nativeDOM,
      getRoot: () => markup?.html ?? null,
      isDisposed: () => disposed,
    });
    disposers.push(() => fragmentTargets.dispose());
    const isConnectedToRealm = (node: Node): boolean =>
      markup?.html.contains(node) ?? false;
    const scrollFragment = (url: string): void => {
      if (!disposed && markupRevealed) {
        scrollToFragment(options.host, fragmentTargets.current, url);
      }
    };

    const documentBase = createDocumentBase({
      window,
      privateBase,
      getMarkup: () => markup,
      getCurrentURL: () => currentURL,
      onRebase: () => facade?.rebaseURLs(),
    });
    const getDocumentBaseURL = documentBase.getBaseURL;
    const getDocumentBaseTarget = documentBase.getBaseTarget;
    const updateDocumentBaseURL = documentBase.update;

    const historyURLChanged = (url: string, kind: VFrameNavigationKind | null) => {
      currentURL = url;
      updateDocumentBaseURL();
      options.onURLChange(url, kind);
    };
    const history = options.boundNavigation
      ? new BoundHistory({
          window,
          hostWindow: options.host.ownerDocument.defaultView!,
          getBaseURL: getDocumentBaseURL,
          onNavigate: options.onNavigate,
          onURLChange: historyURLChanged,
          onActivate: fragmentTargets.update,
          onFragmentScroll: scrollFragment,
        })
      : new VirtualHistory({
          window,
          host: options.host,
          session: options.historySession,
          getBaseURL: getDocumentBaseURL,
          onNavigate: options.onNavigate,
          onURLChange: historyURLChanged,
          onActivate: fragmentTargets.update,
          onFragmentScroll: scrollFragment,
          onDocumentTraversal: options.onDocumentTraversal,
        });
    history.install();
    fragmentTargets.clearClones([markup.html]);
    fragmentTargets.update(currentURL);
    disposers.push(() => history.dispose());

    const networkDispose = installNetworkPatches({
      window,
      signal: options.signal,
      credentials: options.credentials,
      getBaseURL: getDocumentBaseURL,
      // A src replacement leaves this guest live until handoff. Its signal and
      // network disposer, not the changed attribute, determine its lifetime.
      isActive: () => options.host.isConnected,
    });
    disposers.push(networkDispose);
    const constructedSheetBaseURLs = new WeakMap<CSSStyleSheet, string>();
    disposers.push(
      installCSSStyleSheetBridge(
        window,
        hostView,
        getDocumentBaseURL,
        constructedSheetBaseURLs,
      ),
    );
    const viewport = installViewportPatches(
      options.host,
      window,
      markup.html,
      () => !markupRevealed,
      options.preserveScroll || options.restoreScroll || adoptionState !== null,
      () => facade?.getSelection() ?? null,
      () => facade?.dispatchDocumentEvent("scroll", { bubbles: true }),
    );
    disposers.push(() => viewport.dispose());
    if (history instanceof VirtualHistory) history.setScrollHost(viewport.scroll);
    const styles = createDynamicStyles({
      window,
      document,
      nativeDOM,
      stylesheetContext: markup.stylesheetContext,
      linkedStyles: markup.linkedStyles,
      signal: options.signal,
      getNonce: options.getNonce,
      getBaseURL: getDocumentBaseURL,
      getInlineStyleSheet: () => markup?.inlineStyleSheet ?? null,
      getFacade: () => facade,
      isConnectedToRealm,
      isDisposed: () => disposed,
      onError: options.onError,
    });

    const initialStyleSources = new Map<HTMLStyleElement, string>();
    for (const style of markup.html.querySelectorAll("style")) {
      const source = style.textContent ?? "";
      initialStyleSources.set(style, source);
      styles.recordProcessedStyle(style, source);
      style.textContent = "";
    }

    const liveMarkup = markup.html;
    let topLayer: ReturnType<typeof installStagedTopLayer> | undefined;
    let focus: ReturnType<typeof installStagedFocus> | undefined;
    if (!markupRevealed) {
      const isActive = () => !disposed && !options.signal.aborted;
      focus = installStagedFocus(
        window,
        renderRoot.ownerDocument.defaultView!,
        options.host,
        liveMarkup,
        () => !markupRevealed,
        isActive,
      );
      disposers.push(focus.dispose);
      topLayer = installStagedTopLayer(
        window,
        liveMarkup,
        renderRoot,
        isActive,
        () => facade,
      );
      disposers.push(topLayer.dispose);
    }
    facade = installDocumentFacade({
      host: options.host,
      shadowRoot: renderRoot,
      scroll: viewport.scroll,
      window,
      document,
      html: markup.html,
      head: markup.head,
      body: markup.body,
      authoredURLAttributes: markup.authoredURLAttributes,
      authoredStyleAttributes: markup.authoredStyleAttributes,
      inlineStyleSelectorAttribute: markup.inlineStyleSelectorAttribute,
      inlineStyleSheet: markup.inlineStyleSheet,
      linkedStyles: markup.linkedStyles,
      constructedSheetBaseURLs,
      createHTML: options.trustedTypes.createHTML,
      createGuestHTML: options.trustedTypes.createGuestHTML,
      createScript: options.trustedTypes.createScript,
      updateTopLayerViewport: internalStyles.updateTopLayerViewport,
      getNonce: options.getNonce,
      getBaseURL: getDocumentBaseURL,
      getCurrentURL: () => currentURL,
      getCurrentScript: () => scriptRunner?.currentScript ?? null,
      onBaseElementChange: updateDocumentBaseURL,
      onEventHandlerError(error) {
        if (!options.signal.aborted) {
          options.onError({ phase: "runtime", url: currentURL, error });
        }
      },
      onDynamicScript(script, execution) {
        scriptRunner?.executeDynamic(script, execution);
      },
      onStyleElementChange(style) {
        if (style === markup?.inlineStyleSheet || styles.isGeneratedStyleWrite(style)) {
          return;
        }
        styles.scheduleDynamicStyle(style, style.textContent ?? "", true);
      },
      onStyleSheetAccess(style) {
        if (style !== markup?.inlineStyleSheet && isConnectedToRealm(style)) {
          styles.installCSSOMStyleSheet(style);
        }
      },
      onLinkElementChange(link, authoredRel) {
        styles.scheduleDynamicLink(link, true, authoredRel);
      },
      onDisconnectedNodes(nodes) {
        for (const link of styles.dynamicLinksFrom(nodes)) {
          if (!isConnectedToRealm(link)) {
            styles.invalidateDynamicLink(link);
          }
        }
      },
      onConnectedNodes(nodes, scan) {
        for (const node of nodes) {
          facadeConnectedNodes.add(node);
        }
        if (scan === undefined || scan.hasTarget) {
          fragmentTargets.clearClones(nodes);
        }
        styles.observeConnectedNodes(nodes, scan);
        staged?.partsConnected(nodes);
      },
      ...(topLayer && { onShadowRoot: topLayer.observe }),
    });
    disposers.push(() => facade?.dispose());
    if (!markupRevealed) styles.installCSSOMStyleSheet(markup.inlineStyleSheet);
    if (!options.signal.aborted) {
      renderRoot.append(liveMarkup);
      for (const [style, source] of initialStyleSources) {
        styles.applyNonce(style);
        style.textContent = source;
      }
      for (const link of styles.dynamicLinksFrom([liveMarkup])) {
        const linked = markup.linkedStyles.get(link);
        if (linked !== undefined) {
          linked.style.disabled = linked.disabled;
        }
      }
      for (const link of styles.dynamicLinksFrom([liveMarkup])) {
        styles.scheduleDynamicLink(link);
      }
      if (!options.stageMarkup && !options.restoreScroll && new URL(currentURL).hash) {
        scrollFragment(currentURL);
      }
    }
    initialStyleSources.clear();
    if (options.signal.aborted) {
      throw abortError();
    }

    adoptionState?.connect(liveMarkup, window);
    scriptRunner = new ScriptRunner({
      window,
      native: facade.native,
      facade,
      scripts: markup.scripts,
      signal: options.signal,
      credentials: options.credentials,
      executionOrigin: options.host.ownerDocument.location.origin,
      createScript: options.trustedTypes.createScript,
      createScriptURL: options.trustedTypes.createScriptURL,
      getNonce: options.getNonce,
      getCurrentURL: () => currentURL,
      getNativeCurrentScript: () =>
        (nativeCurrentScriptGetter?.call(document) as
          | HTMLScriptElement
          | null
          | undefined) ?? null,
      onError(failure) {
        options.onError({ phase: "script", ...failure });
      },
      onRuntimeError(failure) {
        options.onError({ phase: "runtime", ...failure });
      },
    });
    const windowEventDispose = installWindowEventBridge(
      window,
      renderRoot,
      liveMarkup,
      facade.eventForListener,
      facade.finishEventListener,
    );
    disposers.push(windowEventDispose);

    disposers.push(
      observeRealmMutations({
        window,
        nativeDOM,
        facadeConnectedNodes,
        root: markup.html,
        styles,
        inlineStyleSheet: markup.inlineStyleSheet,
        getFacade: () => facade,
        isConnectedToRealm,
        onBaseElementChange: updateDocumentBaseURL,
      }),
    );

    const navigation = installRealmNavigation({
      window,
      host: options.host,
      shadowRoot: renderRoot,
      boundNavigation: options.boundNavigation,
      history,
      hostListenerSignal: hostListenerLifetime.signal,
      childListenerSignal: childListenerLifetime.signal,
      nativeWindowOpen,
      scheduleNavigationDefault,
      getCurrentURL: () => currentURL,
      getBaseURL: getDocumentBaseURL,
      getBaseTarget: getDocumentBaseTarget,
      getFacade: () => facade,
      guestRoot: liveMarkup,
      isDisposed: () => disposed,
      onURLChange: historyURLChanged,
      onNavigate: options.onNavigate,
      onDocumentNavigation: options.onDocumentNavigation,
      onShellNavigation: options.onShellNavigation,
      onNativeLocationNavigation: options.onNativeLocationNavigation,
      onError: options.onError,
    });
    disposers.push(() => navigation.dispose());

    const runtimeErrorURL = (filename: string): string => {
      if (filename === "") {
        return currentURL;
      }

      const executionDocumentURL = new URL(window.location.href);
      executionDocumentURL.hash = "";
      if (
        filename === executionDocumentURL.href ||
        filename.startsWith(`${executionDocumentURL.href}:`) ||
        filename.startsWith(`${executionDocumentURL.href} `)
      ) {
        return currentURL;
      }
      return filename;
    };
    const runtimeErrorListener = (event: ErrorEvent) => {
      if (scriptRunner?.claimsRuntimeError(event) === true) {
        return;
      }
      options.onError({
        phase: "runtime",
        url: runtimeErrorURL(event.filename),
        error: event.error ?? new Error(event.message),
      });
    };
    const rejectionListener = (event: PromiseRejectionEvent) => {
      options.onError({ phase: "runtime", url: currentURL, error: event.reason });
    };
    const trustedHashChangeListener = (event: HashChangeEvent) => {
      if (!event.isTrusted) {
        return;
      }

      event.stopImmediatePropagation();
      const nativeURL = new URL(event.newURL);
      const virtualURL = new URL(currentURL);
      virtualURL.hash = nativeURL.hash;
      if (nativeURL.hash === "" && event.newURL.endsWith("#")) {
        virtualURL.href += "#";
      }
      const detail = {
        from: currentURL,
        to: virtualURL.href,
        kind: "fragment",
        state: null,
      } satisfies VFrameNavigateEventDetail;
      const allowed = options.boundNavigation
        ? options.onShellNavigation(detail)
        : history instanceof VirtualHistory &&
          history.navigateNativeFragment(virtualURL.href);
      if (!allowed) {
        history.restoreMirroredURL();
      }
    };
    const trustedPopStateListener = (event: PopStateEvent) => {
      if (event.isTrusted) {
        // The hidden iframe history only mirrors the virtual history. Exposing
        // its native event would deliver a second popstate to the sub-app.
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("error", runtimeErrorListener, {
      signal: childListenerLifetime.signal,
    });
    window.addEventListener("unhandledrejection", rejectionListener, {
      signal: childListenerLifetime.signal,
    });
    window.addEventListener("popstate", trustedPopStateListener, {
      signal: childListenerLifetime.signal,
    });
    window.addEventListener("hashchange", trustedHashChangeListener, {
      signal: childListenerLifetime.signal,
    });
    const revealStagedMarkup = (): void => {
      if (markupRevealed || disposed || options.signal.aborted) {
        return;
      }
      markupRevealed = true;
      staged?.reveal();
      for (const node of options.markup.kind === "adopted"
        ? options.markup.previewNodes.splice(0)
        : []) {
        removeRenderedNode(node, hostView);
      }
    };

    const runtime: VFrameRealm = {
      window,
      navigation: history,
      get shadowRoot() {
        if (markupRevealed) return renderRoot;
        return options.shadowRoot;
      },
      async executeInitialScripts() {
        navigation.install();
        staged?.refreshParts();
        await scriptRunner?.executeInitial();
        await adoptionState?.settle(options.signal);
      },
      reveal() {
        if (disposed || options.signal.aborted) {
          throw abortError();
        }
        // The staged live tree is pixel-identical to the preview, so a
        // synchronous swap never repaints. Masking it with a scoped View
        // Transition would itself flicker: Chromium pixel-snaps transition
        // snapshots, visibly shifting fractionally positioned frames.
        if (adoptionState) adoptionState.reveal(revealStagedMarkup);
        else revealStagedMarkup();
        if (disposed || options.signal.aborted) return;
        if (options.stageMarkup || adoptionState) viewport.revealScroll();
        if (options.restoreScroll && history instanceof VirtualHistory) {
          history.restoreScroll();
        } else if (options.stageMarkup && !adoptionState && new URL(currentURL).hash) {
          scrollFragment(currentURL);
        }
        if (renderRoot.activeElement) focus?.dispose();
        else focus?.reveal();
        topLayer?.reveal();
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        options.signal.removeEventListener("abort", runtime.dispose);
        teardown();
        markup = null;
        facade = null;
        scriptRunner = null;
      },
    };
    options.signal.addEventListener("abort", runtime.dispose, { once: true });
    return runtime;
  } catch (error) {
    teardown();
    throw error;
  }
}
