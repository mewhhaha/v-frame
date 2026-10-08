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
import { createFragmentTargets, scrollToFragment } from "./fragment-scroll.js";
import { observeRealmMutations } from "./mutation-observer.js";
import { ScriptRunner } from "../scripts.js";
import { abortError, type RealmFailure, type RealmTrustedTypes } from "./connect.js";
import { createDynamicStyles } from "./dynamic-styles.js";
import {
  installRealmNavigation,
  type NativeLocationNavigationMode,
} from "./navigation.js";
import {
  installInternalStyles,
  installStagingStyles,
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
  executeInitialScripts(): Promise<void>;
  reveal(): void;
  dispose(): void;
}

export async function createRealm(options: CreateRealmOptions): Promise<VFrameRealm> {
  // One stack unwinds the realm, whether bootstrap fails halfway or dispose()
  // runs on a finished one. Each resource registers as it comes into being, so
  // teardown is its reverse and no resource has to be listed a second time.
  const disposers: Array<() => void> = [];
  const teardown = (): void => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
  const adoptionState = options.markup.kind === "adopted" ? options.markup.state : null;
  let restoreStagingStyles: () => void = () => undefined;
  let markup: PreparedMarkup | null = null;

  try {
    const internalStyles = installInternalStyles(options.shadowRoot);
    disposers.push(() => internalStyles.dispose());
    if (adoptionState) disposers.push(() => adoptionState.dispose());
    disposers.push(() => options.iframe.remove());
    disposers.push(() => restoreStagingStyles());
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
    disposers.push(() => {
      preparedMarkup.html.remove();
      preparedMarkup.inlineStyleSheet.remove();
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
    let markupRevealed = !options.stageMarkup && options.markup.kind !== "adopted";
    const fragmentTargets = createFragmentTargets({
      window,
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
    const viewport = installViewportPatches(
      options.host,
      window,
      () => facade?.getSelection() ?? null,
      () => {
        facade?.dispatchDocumentEvent("scroll", { bubbles: true });
      },
    );
    disposers.push(() => viewport.dispose());

    const styles = createDynamicStyles({
      window,
      document,
      stylesheetContext: markup.stylesheetContext,
      linkedStyles: markup.linkedStyles,
      signal: options.signal,
      getNonce: options.getNonce,
      getBaseURL: getDocumentBaseURL,
      // Nested shadow sheets are already isolated. The staged document stays
      // last even as the old tree is removed, so its layout never collapses
      // between disposal and reveal (including manual scroll restoration).
      getScopeSelector: (sheet) =>
        markupRevealed ||
        (sheet.ownerNode !== markup?.inlineStyleSheet &&
          !markup?.html.contains(sheet.ownerNode))
          ? null
          : ":host > v-html:last-of-type",
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

    facade = installDocumentFacade({
      host: options.host,
      shadowRoot: options.shadowRoot,
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
      createHTML: options.trustedTypes.createHTML,
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
      onConnectedNodes(nodes) {
        fragmentTargets.clearClones(nodes);
        styles.installCSSOMStyleSheets(nodes);
        styles.observeConnectedNodes(nodes);
      },
    });
    disposers.push(() => facade?.dispose());
    if (!markupRevealed) styles.installCSSOMStyleSheet(markup.inlineStyleSheet);
    const liveMarkup = markup.html;
    if (options.markup.kind === "adopted" || options.stageMarkup) {
      restoreStagingStyles = installStagingStyles(options.shadowRoot);
    }
    if (!options.signal.aborted) {
      options.shadowRoot.append(liveMarkup);
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
      styles.installCSSOMStyleSheets([liveMarkup]);
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
      options.shadowRoot,
      facade.eventForListener,
      facade.finishEventListener,
    );
    disposers.push(windowEventDispose);

    disposers.push(
      observeRealmMutations({
        window,
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
      shadowRoot: options.shadowRoot,
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
      styles.restoreScopedSelectors();
      for (const node of options.markup.kind === "adopted"
        ? options.markup.previewNodes.splice(0)
        : []) {
        node.parentNode?.removeChild(node);
      }
      restoreStagingStyles();
    };

    const runtime: VFrameRealm = {
      window,
      navigation: history,
      async executeInitialScripts() {
        navigation.install();
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
        if (options.restoreScroll && history instanceof VirtualHistory) {
          history.restoreScroll();
        } else if (options.stageMarkup && !adoptionState && new URL(currentURL).hash) {
          scrollFragment(currentURL);
        }
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
