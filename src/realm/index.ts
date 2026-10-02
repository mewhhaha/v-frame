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
  connectRealmIframe,
  type ConnectedRealmIframe,
  type RealmFailure,
  type RealmTrustedTypes,
} from "./connect.js";

export interface CreateRealmOptions {
  host: HTMLElement;
  shadowRoot: ShadowRoot;
  iframe: HTMLIFrameElement;
  trustedTypes: RealmTrustedTypes;
  markup:
    | { kind: "document"; source: string }
    | { kind: "adopted"; source: string; previewNodes: readonly Node[] };
  pageURL: string;
  historySession: VirtualHistorySession;
  boundNavigation: boolean;
  stageMarkup: boolean;
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
  const internalStyles = installInternalStyles(options.shadowRoot);
  const bootstrapDisposers: Array<() => void> = [];
  let restoreStagingStyles: () => void = () => undefined;
  let iframe: HTMLIFrameElement | null = options.iframe;
  let markup: PreparedMarkup | null = null;

  try {
    const window = iframe.contentWindow as VFrameWindow | null;
    const document = iframe.contentDocument;
    if (window === null || document === null) {
      throw new Error("The connected iframe has no same-origin execution realm");
    }
    const hostListenerLifetime = new AbortController();
    const childListenerLifetime = new window.AbortController();
    bootstrapDisposers.push(() => hostListenerLifetime.abort());
    bootstrapDisposers.push(() => childListenerLifetime.abort());

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
    const isConnectedToRealm = (node: Node): boolean =>
      markup?.html.contains(node) ?? false;

    const getDocumentBaseURL = (): string => {
      for (const base of markup?.html.querySelectorAll("base[href]") ?? []) {
        const authoredHref =
          markup?.authoredURLAttributes.get(base)?.get("href") ??
          base.getAttribute("href") ??
          "";
        const resolvedBase = window.URL.parse(authoredHref, currentURL);
        if (resolvedBase !== null) {
          return resolvedBase.href;
        }
      }
      return currentURL;
    };
    const getDocumentBaseTarget = (): string => {
      for (const base of markup?.html.querySelectorAll("base[target]") ?? []) {
        const target = base.getAttribute("target") ?? "";
        const normalizedTarget = target.toLowerCase();
        const isKeyword =
          normalizedTarget === "_blank" ||
          normalizedTarget === "_self" ||
          normalizedTarget === "_parent" ||
          normalizedTarget === "_top";
        if (
          target === "" ||
          /[\t\n\r<]/.test(target) ||
          (target.startsWith("_") && !isKeyword)
        ) {
          continue;
        }
        return normalizedTarget;
      }
      return "_self";
    };
    let previousBaseURL = markup.baseURL;
    const updateDocumentBaseURL = (): void => {
      const baseURL = getDocumentBaseURL();
      if (baseURL === previousBaseURL) {
        return;
      }
      previousBaseURL = baseURL;
      privateBase.href = baseURL;
      facade?.rebaseURLs();
    };

    const historyURLChanged = (url: string, kind: VFrameNavigationKind | null) => {
      currentURL = url;
      updateDocumentBaseURL();
      options.onURLChange(url, kind);
    };
    const history = options.boundNavigation
      ? new BoundHistory({
          window,
          hostWindow: options.host.ownerDocument.defaultView!,
          onNavigate: options.onNavigate,
          onURLChange: historyURLChanged,
        })
      : new VirtualHistory({
          window,
          session: options.historySession,
          getBaseURL: getDocumentBaseURL,
          onNavigate: options.onNavigate,
          onURLChange: historyURLChanged,
          onDocumentTraversal: options.onDocumentTraversal,
        });
    history.install();
    bootstrapDisposers.push(() => history.dispose());

    const networkDispose = installNetworkPatches({
      window,
      signal: options.signal,
      credentials: options.credentials,
      getBaseURL: getDocumentBaseURL,
    });
    bootstrapDisposers.push(networkDispose);
    const viewport = installViewportPatches(
      options.host,
      window,
      () => facade?.getSelection() ?? null,
      () => {
        facade?.dispatchDocumentEvent("scroll", { bubbles: true });
      },
    );
    bootstrapDisposers.push(() => viewport.dispose());

    const styles = createDynamicStyles({
      window,
      document,
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
        styles.installCSSOMStyleSheets(nodes);
        styles.observeConnectedNodes(nodes);
      },
    });
    bootstrapDisposers.push(() => facade?.dispose());
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
    }
    if (options.signal.aborted) {
      throw abortError();
    }

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
    );
    bootstrapDisposers.push(windowEventDispose);

    const mutationObserver = new globalThis.MutationObserver((records) => {
      const stylesWithContentChanges = new Set<HTMLStyleElement>();
      const stylesWithAttributeChanges = new Set<HTMLStyleElement>();
      const linksWithAttributeChanges = new Set<HTMLLinkElement>();
      const stylesConnectedWithoutFacade = new Set<HTMLStyleElement>();
      const linksConnectedWithoutFacade = new Set<HTMLLinkElement>();
      const removedStyles = new Set<HTMLStyleElement>();
      const removedLinks = new Set<HTMLLinkElement>();
      let baseElementsChanged = false;
      // Only HTML-namespace base elements affect the document base URL;
      // querySelector's unprefixed type selector also matches foreign ones.
      const isHTMLBase = (element: Element): boolean =>
        element.localName === "base" &&
        element.namespaceURI === "http://www.w3.org/1999/xhtml";
      const subtreeHasBaseElement = (node: Node): boolean =>
        (node instanceof window.Element && isHTMLBase(node)) ||
        ("querySelectorAll" in node &&
          Array.from((node as ParentNode).querySelectorAll("base")).some(isHTMLBase));
      for (const record of records) {
        if (record.type === "childList") {
          if (
            record.target instanceof window.HTMLStyleElement &&
            record.target !== markup?.inlineStyleSheet
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
            record.target !== markup?.inlineStyleSheet
          ) {
            stylesWithAttributeChanges.add(record.target);
          } else if (record.target instanceof window.HTMLLinkElement) {
            linksWithAttributeChanges.add(record.target);
          }
        }
      }
      if (baseElementsChanged) {
        updateDocumentBaseURL();
      }
      for (const style of removedStyles) {
        if (!isConnectedToRealm(style)) {
          styles.invalidateDynamicStyle(style);
        }
      }
      for (const link of removedLinks) {
        if (!isConnectedToRealm(link)) {
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
    mutationObserver.observe(markup.html, {
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
    bootstrapDisposers.push(() => mutationObserver.disconnect());

    const navigation = installRealmNavigation({
      window,
      document,
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
      isDisposed: () => disposed,
      onURLChange: historyURLChanged,
      onNavigate: options.onNavigate,
      onDocumentNavigation: options.onDocumentNavigation,
      onShellNavigation: options.onShellNavigation,
      onNativeLocationNavigation: options.onNativeLocationNavigation,
      onError: options.onError,
    });

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
    let adoptedMarkupRevealed = options.markup.kind !== "adopted";
    const revealAdoptedMarkup = (): void => {
      if (adoptedMarkupRevealed || disposed || options.signal.aborted) {
        return;
      }
      adoptedMarkupRevealed = true;
      for (const node of options.markup.kind === "adopted"
        ? options.markup.previewNodes
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
      },
      reveal() {
        if (disposed || options.signal.aborted) {
          throw abortError();
        }
        // The staged live tree is pixel-identical to the preview, so a
        // synchronous swap never repaints. Masking it with a scoped View
        // Transition would itself flicker: Chromium pixel-snaps transition
        // snapshots, visibly shifting fractionally positioned frames.
        revealAdoptedMarkup();
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        options.signal.removeEventListener("abort", runtime.dispose);
        hostListenerLifetime.abort();
        childListenerLifetime.abort();
        mutationObserver.disconnect();
        navigation.dispose();
        history.dispose();
        viewport.dispose();
        windowEventDispose();
        networkDispose();
        iframe?.remove();
        facade?.dispose();
        markup?.html.remove();
        markup?.inlineStyleSheet.remove();
        restoreStagingStyles();
        internalStyles.dispose();
      },
    };
    options.signal.addEventListener("abort", runtime.dispose, { once: true });
    return runtime;
  } catch (error) {
    for (const disposeBootstrapResource of bootstrapDisposers.reverse()) {
      disposeBootstrapResource();
    }
    markup?.html.remove();
    markup?.inlineStyleSheet.remove();
    iframe?.remove();
    restoreStagingStyles();
    internalStyles.dispose();
    throw error;
  }
}
