// Everything that turns a guest navigation attempt into a v-frame navigation:
// link clicks, form submissions, window.open, and the Navigation API events the
// realm iframe fires when a guest assigns to `location`.
//
// The interception is uniformly "suppress the native default, then re-run it as
// a virtual navigation on a task", so that guest listeners still get their turn
// to call preventDefault() before v-frame acts.

import type { DocumentFacade } from "../facade/index.js";
import {
  type BoundHistory,
  type DocumentHistoryMode,
  type NavigateDispatchOptions,
  VirtualHistory,
} from "../history.js";
import type {
  VFrameNavigateEventDetail,
  VFrameNavigationKind,
  VFrameWindow,
} from "../types.js";
import { isSameDocumentFragment } from "../url.js";
import type { NavigationWindow, RealmFailure } from "./connect.js";

export type NativeLocationNavigationMode = "push" | "replace" | "reload";

type NavigateInterceptOptions = Parameters<NavigateEvent["intercept"]>[0];

export interface RealmNavigationOptions {
  window: VFrameWindow;
  document: Document;
  host: HTMLElement;
  shadowRoot: ShadowRoot;
  boundNavigation: boolean;
  history: BoundHistory | VirtualHistory;
  hostListenerSignal: AbortSignal;
  childListenerSignal: AbortSignal;
  /** Captured before any patch lands, so a guest cannot reach the real one. */
  nativeWindowOpen: Window["open"];
  scheduleNavigationDefault: Window["setTimeout"];
  getCurrentURL(): string;
  getBaseURL(): string;
  getBaseTarget(): string;
  getFacade(): DocumentFacade | null;
  isDisposed(): boolean;
  onURLChange(url: string, kind: VFrameNavigationKind | null): void;
  onNavigate(
    detail: VFrameNavigateEventDetail,
    options?: NavigateDispatchOptions,
  ): boolean;
  onDocumentNavigation(
    detail: VFrameNavigateEventDetail,
    mode: DocumentHistoryMode,
  ): boolean;
  onShellNavigation(detail: VFrameNavigateEventDetail): boolean;
  onNativeLocationNavigation(
    detail: VFrameNavigateEventDetail,
    mode: NativeLocationNavigationMode,
  ): void;
  onError(failure: RealmFailure): void;
}

export interface RealmNavigation {
  /**
   * Interception starts only once the guest's initial scripts are about to run,
   * so markup-time DOM work cannot trip a navigation.
   */
  install(): void;
  dispose(): void;
}

export function installRealmNavigation(options: RealmNavigationOptions): RealmNavigation {
  const window = options.window;
  const document = options.document;
  let navigationInstalled = false;
  const nativeFormSubmit = window.HTMLFormElement.prototype.submit;
  const formSubmission = (form: HTMLFormElement, submitter: HTMLElement | null) => {
    const action =
      submitter !== null &&
      "formAction" in submitter &&
      submitter.hasAttribute("formaction")
        ? String(submitter.formAction)
        : form.action;
    const method = (
      submitter !== null &&
      "formMethod" in submitter &&
      submitter.hasAttribute("formmethod")
        ? String(submitter.formMethod)
        : form.method
    ).toLowerCase();
    const target = (
      submitter !== null &&
      "formTarget" in submitter &&
      submitter.hasAttribute("formtarget")
        ? String(submitter.formTarget)
        : form.hasAttribute("target")
          ? form.target
          : options.getBaseTarget()
    ).toLowerCase();
    const targetURL = new URL(action || options.getCurrentURL(), options.getCurrentURL());
    if (method === "get") {
      const parameters = new window.URLSearchParams();
      const entries = new window.FormData(form, submitter as HTMLButtonElement | null);
      for (const [name, value] of entries) {
        parameters.append(name, typeof value === "string" ? value : value.name);
      }
      targetURL.search = parameters.toString();
    }

    const detail: VFrameNavigateEventDetail = {
      from: options.getCurrentURL(),
      to: targetURL.href,
      kind: "form",
      state: null,
    };
    if (target === "_blank") {
      const allowed = options.onNavigate(detail);
      if (allowed && method === "get") {
        options.nativeWindowOpen(targetURL.href, "_blank", "noopener");
      } else if (allowed) {
        options.onError({
          phase: "navigation",
          url: targetURL.href,
          error: new window.DOMException(
            `v-frame cannot submit ${method.toUpperCase()} form ${targetURL.href} to a new browsing context`,
            "NotSupportedError",
          ),
        });
      }
      return;
    }

    if (
      (target !== "" && target !== "_self") ||
      (targetURL.protocol !== "http:" && targetURL.protocol !== "https:")
    ) {
      options.onNavigate(detail);
      return;
    }

    if (method === "get") {
      if (options.boundNavigation) {
        options.onShellNavigation(detail);
      } else {
        options.onDocumentNavigation(detail, "push");
      }
      return;
    }

    if (options.onNavigate(detail)) {
      options.onError({
        phase: "navigation",
        url: targetURL.href,
        error: new window.DOMException(
          `v-frame cannot submit ${method.toUpperCase()} form ${targetURL.href}; only same-context GET navigation is supported`,
          "NotSupportedError",
        ),
      });
    }
  };

  const anchorFromEvent = (event: Event) =>
    event
      .composedPath()
      .find(
        (candidate): candidate is HTMLAnchorElement | HTMLAreaElement | SVGAElement =>
          candidate instanceof window.Element &&
          (candidate.localName === "a" || candidate.localName === "area") &&
          (candidate.hasAttribute("href") ||
            candidate.hasAttributeNS("http://www.w3.org/1999/xlink", "href")),
      );

  const scrollToFragment = (targetURL: URL): void => {
    const encodedIdentifier = targetURL.hash.slice(1);
    let identifier = encodedIdentifier;
    try {
      identifier = decodeURIComponent(encodedIdentifier);
    } catch {
      // Malformed escapes remain literal, matching URL fragment storage.
    }
    if (identifier === "") {
      options.host.scrollTo(0, 0);
      return;
    }
    const target =
      document.getElementById(identifier) ??
      Array.from(document.anchors).find(
        (anchor) => anchor.getAttribute("name") === identifier,
      );
    target?.scrollIntoView();
  };

  const navigateFromLink = (
    event: MouseEvent,
    anchor: HTMLAnchorElement | HTMLAreaElement | SVGAElement,
  ) => {
    const href =
      anchor instanceof window.SVGAElement
        ? (anchor.getAttribute("href") ??
          anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
          "")
        : anchor.href;
    const targetURL = new URL(href || options.getCurrentURL(), options.getBaseURL());
    const target = anchor.hasAttribute("target")
      ? (anchor.getAttribute("target") ?? "").toLowerCase()
      : options.getBaseTarget();
    const opensNewContext =
      event.type === "auxclick" || event.ctrlKey || event.metaKey || event.shiftKey;
    if (opensNewContext || target === "_blank") {
      if (
        options.onNavigate({
          from: options.getCurrentURL(),
          to: targetURL.href,
          kind: "link",
          state: null,
        })
      ) {
        options.nativeWindowOpen(targetURL.href, "_blank", "noopener");
      }
      return;
    }

    if (
      (target !== "" && target !== "_self") ||
      (targetURL.protocol !== "http:" && targetURL.protocol !== "https:")
    ) {
      options.onNavigate({
        from: options.getCurrentURL(),
        to: targetURL.href,
        kind: "link",
        state: null,
      });
      return;
    }

    const fragment = isSameDocumentFragment(options.getCurrentURL(), targetURL.href);
    if (!fragment) {
      const detail = {
        from: options.getCurrentURL(),
        to: targetURL.href,
        kind: "link",
        state: null,
      } satisfies VFrameNavigateEventDetail;
      if (options.boundNavigation) {
        options.onShellNavigation(detail);
      } else {
        options.onDocumentNavigation(detail, "push");
      }
      return;
    }
    if (!options.history.navigateFragment(targetURL.href)) {
      return;
    }
    if (fragment) {
      scrollToFragment(targetURL);
    }
  };

  const scheduledNavigationEvents = new WeakSet<Event>();
  const suppressLinkDefault = (event: Event) => {
    const hostWindow = options.host.ownerDocument.defaultView;
    if (!(event instanceof hostWindow!.MouseEvent)) {
      return;
    }
    if (
      (event.type === "click" && event.button !== 0) ||
      (event.type === "auxclick" && event.button !== 1)
    ) {
      return;
    }

    const anchor = anchorFromEvent(event);
    if (anchor === undefined) {
      return;
    }

    options.getFacade()?.suppressEventDefault(event);
    if (scheduledNavigationEvents.has(event)) {
      return;
    }
    scheduledNavigationEvents.add(event);
    options.scheduleNavigationDefault(() => {
      if (
        options.isDisposed() ||
        options.getFacade()?.wasEventDefaultPrevented(event) === true
      ) {
        return;
      }
      navigateFromLink(event, anchor);
    }, 0);
  };
  const suppressSubmitDefault = (event: Event) => {
    const hostWindow = options.host.ownerDocument.defaultView;
    if (!(event instanceof hostWindow!.SubmitEvent)) {
      return;
    }

    const form = event.target as HTMLFormElement;
    const submitter = event.submitter as HTMLElement | null;
    const method = (
      submitter?.getAttribute("formmethod") ??
      form.getAttribute("method") ??
      ""
    ).toLowerCase();
    // A dialog submission navigates nowhere; its default action (closing
    // the dialog) must stay native.
    if (method === "dialog") {
      return;
    }

    options.getFacade()?.suppressEventDefault(event);
    if (scheduledNavigationEvents.has(event)) {
      return;
    }
    scheduledNavigationEvents.add(event);
    options.scheduleNavigationDefault(() => {
      if (
        options.isDisposed() ||
        options.getFacade()?.wasEventDefaultPrevented(event) === true
      ) {
        return;
      }
      formSubmission(form, submitter);
    }, 0);
  };

  const installNavigation = () => {
    if (navigationInstalled) {
      return;
    }
    navigationInstalled = true;
    const navigationListenerOptions = {
      capture: true,
      signal: options.hostListenerSignal,
    };
    options.shadowRoot.addEventListener(
      "click",
      suppressLinkDefault,
      navigationListenerOptions,
    );
    options.shadowRoot.addEventListener(
      "auxclick",
      suppressLinkDefault,
      navigationListenerOptions,
    );
    options.shadowRoot.addEventListener(
      "submit",
      suppressSubmitDefault,
      navigationListenerOptions,
    );
    window.HTMLFormElement.prototype.submit = function submit(): void {
      formSubmission(this, null);
    };

    const navigationWindow = window as NavigationWindow;
    const navigateEventPrototype = navigationWindow.NavigateEvent.prototype;
    const interceptDescriptor = Object.getOwnPropertyDescriptor(
      navigateEventPrototype,
      "intercept",
    );
    const nativeIntercept = navigateEventPrototype.intercept;
    const guestInterceptions = new WeakSet<NavigateEvent>();
    Object.defineProperty(navigateEventPrototype, "intercept", {
      ...interceptDescriptor,
      configurable: true,
      writable: true,
      value: function intercept(
        this: NavigateEvent,
        interceptOptions?: NavigateInterceptOptions,
      ): void {
        nativeIntercept.call(this, interceptOptions);
        guestInterceptions.add(this);
      },
    });
    navigationWindow.navigation.addEventListener(
      "navigate",
      (event) => {
        if (!event.isTrusted || event.destination.sameDocument) {
          return;
        }

        const detail = {
          from: options.getCurrentURL(),
          to: event.destination.url,
          kind: "window",
          state: null,
        } satisfies VFrameNavigateEventDetail;
        const mode =
          event.navigationType === "push" ||
          event.navigationType === "replace" ||
          event.navigationType === "reload"
            ? event.navigationType
            : "replace";
        if (!options.onNavigate(detail)) {
          event.preventDefault();
          return;
        }
        if (!event.canIntercept) {
          event.preventDefault();
          options.onNativeLocationNavigation(detail, mode);
          return;
        }

        nativeIntercept.call(event, {
          handler() {
            if (guestInterceptions.has(event)) {
              if (options.history instanceof VirtualHistory) {
                options.history.adoptNativeNavigation(detail.to, mode);
              } else {
                options.onURLChange(detail.to, mode === "reload" ? "replace" : mode);
              }
              return;
            }
            options.onNativeLocationNavigation(detail, mode);
          },
        });
      },
      { signal: options.childListenerSignal },
    );
  };

  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value(url?: string | URL, target = "_blank", features?: string): Window | null {
      const targetURL = new URL(String(url ?? "about:blank"), options.getBaseURL());
      const normalizedTarget = target.toLowerCase();
      const detail: VFrameNavigateEventDetail = {
        from: options.getCurrentURL(),
        to: targetURL.href,
        kind: "window",
        state: null,
      };
      if (normalizedTarget === "_blank") {
        return options.onNavigate(detail)
          ? options.nativeWindowOpen(targetURL.href, target, features)
          : null;
      }
      if (
        (normalizedTarget !== "" && normalizedTarget !== "_self") ||
        (targetURL.protocol !== "http:" && targetURL.protocol !== "https:")
      ) {
        options.onNavigate(detail);
        return null;
      }
      // A same-document _self open is a fragment navigation, with the same
      // events and scroll-to-anchor behavior as a link click.
      const fragment = isSameDocumentFragment(options.getCurrentURL(), targetURL.href);
      if (!fragment) {
        const allowed = options.boundNavigation
          ? options.onShellNavigation(detail)
          : options.onDocumentNavigation(detail, "push");
        return allowed ? window : null;
      }
      if (!options.history.navigateFragment(targetURL.href)) {
        return null;
      }
      if (fragment) {
        scrollToFragment(targetURL);
      }
      return window;
    },
  });

  return {
    install: installNavigation,
    dispose() {
      window.HTMLFormElement.prototype.submit = nativeFormSubmit;
    },
  };
}
