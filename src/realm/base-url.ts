// The document's base URL and target, derived from the guest's own <base>
// elements. Both are read lazily because the markup, the current URL and the
// facade all change over the realm's life.

import { HTML_NAMESPACE } from "../asset-urls.js";
import type { PreparedMarkup } from "../markup.js";
import type { VFrameWindow } from "../types.js";
import { captureNativeDOM } from "./native-dom.js";

interface DocumentBaseOptions {
  window: VFrameWindow;
  /** The hidden document's own <base>, which the network and parser resolve against. */
  privateBase: HTMLBaseElement;
  getMarkup(): PreparedMarkup | null;
  getCurrentURL(): string;
  /** Called after the private base moved, so URL-bearing attributes can be rebased. */
  onRebase(): void;
}

export interface DocumentBase {
  getBaseURL(): string;
  getBaseTarget(): string;
  /** Recomputes the base URL and, only if it changed, rebases dependents. */
  update(): void;
}

export function createDocumentBase(options: DocumentBaseOptions): DocumentBase {
  const nativeDOM = captureNativeDOM(options.window);
  const getBaseURL = (): string => {
    const markup = options.getMarkup();
    for (const base of markup
      ? nativeDOM.querySelectorAll(markup.html, "base[href]")
      : []) {
      if (base.namespaceURI !== HTML_NAMESPACE) continue;
      const authoredHref =
        markup?.authoredURLAttributes.get(base)?.get("href") ??
        nativeDOM.getAttribute(base, "href") ??
        "";
      const resolvedBase = options.window.URL.parse(
        authoredHref,
        options.getCurrentURL(),
      );
      if (resolvedBase !== null) {
        return resolvedBase.href;
      }
    }
    return options.getCurrentURL();
  };

  const getBaseTarget = (): string => {
    const markup = options.getMarkup();
    for (const base of markup
      ? nativeDOM.querySelectorAll(markup.html, "base[target]")
      : []) {
      if (base.namespaceURI !== HTML_NAMESPACE) continue;
      const target = nativeDOM.getAttribute(base, "target") ?? "";
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

  let previousBaseURL = options.getMarkup()?.baseURL ?? options.getCurrentURL();
  return {
    getBaseURL,
    getBaseTarget,
    update() {
      const baseURL = getBaseURL();
      if (baseURL === previousBaseURL) {
        return;
      }
      previousBaseURL = baseURL;
      options.privateBase.href = baseURL;
      options.onRebase();
    },
  };
}
