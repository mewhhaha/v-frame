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
import { captureNativeDOM } from "./native-dom.js";

export type NativeLocationNavigationMode = "push" | "replace" | "reload";

type NavigateInterceptOptions = Parameters<NavigateEvent["intercept"]>[0];

// Retired markup can still be the source of a queued browser default action.
// Weak membership survives realm replacement without retaining removed trees.
const guestMarkupRoots = new WeakSet<Node>();

function normalizeFormLineEndings(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n");
}

interface RealmNavigationOptions {
  window: VFrameWindow;
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
  guestRoot: Element;
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

interface RealmNavigation {
  /**
   * Interception starts only once the guest's initial scripts are about to run,
   * so markup-time DOM work cannot trip a navigation.
   */
  install(): void;
  dispose(): void;
}

export function installRealmNavigation(options: RealmNavigationOptions): RealmNavigation {
  const window = options.window;
  const nativeDOM = captureNativeDOM(window);
  guestMarkupRoots.add(options.guestRoot);
  let navigationInstalled = false;
  const nativeFormSubmit = window.HTMLFormElement.prototype.submit;
  const nativeOpenDescriptor = Object.getOwnPropertyDescriptor(window, "open");
  const mouseButton = Object.getOwnPropertyDescriptor(
    window.MouseEvent.prototype,
    "button",
  )!.get!;
  const submitterGetter = Object.getOwnPropertyDescriptor(
    window.SubmitEvent.prototype,
    "submitter",
  )!.get!;
  let restoreIntercept: () => void = () => undefined;
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
        parameters.append(
          normalizeFormLineEndings(name),
          normalizeFormLineEndings(typeof value === "string" ? value : value.name),
        );
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

  const navigateFromLink = (
    event: MouseEvent,
    anchor: HTMLAnchorElement | HTMLAreaElement | SVGAElement,
  ) => {
    const href =
      anchor instanceof window.SVGAElement
        ? (nativeDOM.getAttribute(anchor, "href") ??
          anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
          "")
        : anchor.href;
    const targetURL = new URL(href || options.getCurrentURL(), options.getBaseURL());
    const target = nativeDOM.hasAttribute(anchor, "target")
      ? (nativeDOM.getAttribute(anchor, "target") ?? "").toLowerCase()
      : options.getBaseTarget();
    const opensNewContext =
      event.type === "auxclick" || event.ctrlKey || event.metaKey || event.shiftKey;
    // Resolve download intent after guest listeners finish, just like the
    // other default actions. A guest may have changed href or download.
    if (
      !opensNewContext &&
      !(anchor instanceof window.SVGAElement) &&
      nativeDOM.hasAttribute(anchor, "download") &&
      (targetURL.protocol === "http:" || targetURL.protocol === "https:") &&
      targetURL.origin === window.location.origin
    ) {
      const download = options.host.ownerDocument.createElement("a");
      download.href = targetURL.href;
      download.download = nativeDOM.getAttribute(anchor, "download") ?? "";
      for (const name of ["referrerpolicy", "rel"]) {
        const value = nativeDOM.getAttribute(anchor, name);
        if (value !== null) download.setAttribute(name, value);
      }
      download.click();
      return;
    }
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
    options.history.navigateFragment(targetURL.href);
  };

  const scheduledNavigationEvents = new WeakSet<Event>();
  const suppressLinkDefault = (event: Event) => {
    const anchor = anchorFromEvent(event);
    if (anchor === undefined) return;
    let button: number;
    try {
      // Native getters brand-check across realms; instanceof only recognizes
      // events constructed by one window, not guest or third-window events.
      button = mouseButton.call(event) as number;
    } catch {
      options.getFacade()?.suppressEventDefault(event);
      options.getFacade()?.suppressNativeLinkDefault(event, anchor);
      return;
    }
    if (
      (event.type === "click" && button !== 0) ||
      (event.type === "auxclick" && button !== 1)
    ) {
      return;
    }

    options.getFacade()?.suppressEventDefault(event);
    options.getFacade()?.suppressNativeLinkDefault(event, anchor);
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
      navigateFromLink(event as MouseEvent, anchor);
    }, 0);
  };
  const suppressSubmitDefault = (event: Event) => {
    const form = event.target;
    if (!(form instanceof window.HTMLFormElement)) {
      return;
    }
    let submitter: HTMLElement | null;
    try {
      submitter = submitterGetter.call(event) as HTMLElement | null;
    } catch {
      // Platform fallback: the native getter brand-checks, so a submit event
      // from another realm has no readable submitter.
      submitter = null;
    }
    const method = (
      (submitter ? nativeDOM.getAttribute(submitter, "formmethod") : null) ??
      nativeDOM.getAttribute(form, "method") ??
      ""
    ).toLowerCase();
    // A dialog submission navigates nowhere; its default action (closing
    // the dialog) must stay native.
    if (method === "dialog") {
      return;
    }

    options.getFacade()?.suppressEventDefault(event);
    // dispatchEvent is a notification, not a form submission. Firefox otherwise
    // performs a native submit here; requestSubmit/button activation are trusted.
    if (!event.isTrusted) return;
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
    const hostWindow = options.host.ownerDocument.defaultView! as NavigationWindow;
    const nativeParent = Object.getOwnPropertyDescriptor(
      hostWindow.Node.prototype,
      "parentNode",
    )!.get!;
    hostWindow.navigation.addEventListener(
      "navigate",
      (event) => {
        // preventDefault cannot cancel a non-cancelable synthetic click/submit.
        // Stop its native host navigation here; the queued virtual action, if
        // any, still runs. Preview links and intentional shell navigations are
        // not live guest elements and must retain their normal behavior.
        for (
          let node: Node | null = event.sourceElement;
          node !== null;
          node = nativeParent.call(node) as Node | null
        ) {
          if (guestMarkupRoots.has(node)) {
            event.preventDefault();
            break;
          }
        }
      },
      { capture: true, signal: options.hostListenerSignal },
    );
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
      if (this.method === "dialog") {
        nativeFormSubmit.call(this);
        return;
      }
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
    restoreIntercept = () => {
      if (interceptDescriptor) {
        Object.defineProperty(navigateEventPrototype, "intercept", interceptDescriptor);
      } else
        delete (navigateEventPrototype as unknown as Record<string, unknown>).intercept;
    };
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
    value(url?: unknown, target?: unknown, features?: unknown): Window | null {
      // Arguments are coerced as the WebIDL signature does: only `undefined` takes
      // the default, so `null` is the string "null" (a named target, a relative URL).
      const requestedURL = url === undefined ? "" : `${url}`.toWellFormed();
      const targetName = target === undefined ? "_blank" : `${target}`;
      const windowFeatures = features === undefined ? "" : `${features}`;
      const targetURL = window.URL.parse(
        requestedURL === "" ? "about:blank" : requestedURL,
        options.getBaseURL(),
      );
      if (targetURL === null) {
        throw new window.DOMException(
          `Failed to execute 'open' on 'Window': Unable to open a window with invalid URL '${requestedURL}'.`,
          "SyntaxError",
        );
      }
      const normalizedTarget = targetName.toLowerCase();
      const detail: VFrameNavigateEventDetail = {
        from: options.getCurrentURL(),
        to: targetURL.href,
        kind: "window",
        state: null,
      };
      if (normalizedTarget === "_blank") {
        return options.onNavigate(detail)
          ? // The popup never gets an opener: it would be the hidden realm window.
            options.nativeWindowOpen(
              targetURL.href,
              targetName,
              windowFeatures === "" ? "noopener" : `${windowFeatures},noopener`,
            )
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
      return window;
    },
  });

  return {
    install: installNavigation,
    dispose() {
      window.HTMLFormElement.prototype.submit = nativeFormSubmit;
      restoreIntercept();
      if (nativeOpenDescriptor)
        Object.defineProperty(window, "open", nativeOpenDescriptor);
      else delete (window as unknown as Record<string, unknown>).open;
    },
  };
}
