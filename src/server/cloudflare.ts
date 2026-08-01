import {
  materializeStylesheet,
  rewriteScriptElement,
  rewriteShellElement,
} from "./core.js";
import type { MaterializeStylesheetOptions } from "./core.js";

/**
 * Cloudflare Workers adapter over the materializer core. The Workers types are
 * generated per application and are not visible to this package, so the sliver
 * of `HTMLRewriter` the adapter drives is declared structurally here.
 */

interface RewriterContentOptions {
  html?: boolean;
}

interface RewriterElement {
  tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
  prepend(content: string, options?: RewriterContentOptions): void;
}

interface RewriterText {
  readonly text: string;
  readonly lastInTextNode: boolean;
  remove(): void;
  replace(content: string, options?: RewriterContentOptions): void;
}

interface RewriterHandlers {
  element?(element: RewriterElement): void | Promise<void>;
  text?(chunk: RewriterText): void | Promise<void>;
}

interface Rewriter {
  on(selector: string, handlers: RewriterHandlers): Rewriter;
  transform(response: Response): Response;
}

declare const HTMLRewriter: new () => Rewriter;

class StylesheetText {
  readonly #documentURL: string;
  readonly #options: MaterializeStylesheetOptions;
  #source = "";

  constructor(documentURL: string, options: MaterializeStylesheetOptions) {
    this.#documentURL = documentURL;
    this.#options = options;
  }

  async text(chunk: RewriterText): Promise<void> {
    this.#source += chunk.text;
    // A stylesheet only parses as a whole, so the chunks are collected and the
    // rewritten text replaces the last one.
    if (!chunk.lastInTextNode) {
      chunk.remove();
      return;
    }

    const source = this.#source;
    this.#source = "";
    const materialized = await materializeStylesheet(
      source,
      this.#documentURL,
      this.#options,
    );
    chunk.replace(materialized, { html: true });
  }
}

const shellHandlers: RewriterHandlers = {
  element(element) {
    const rewrite = rewriteShellElement(element.tagName);
    if (rewrite === null) {
      return;
    }

    element.tagName = rewrite.tagName;
    if (rewrite.prependHTML !== null) {
      element.prepend(rewrite.prependHTML, { html: true });
    }
  },
};

const scriptHandlers: RewriterHandlers = {
  element(element) {
    const rewrite = rewriteScriptElement(element);
    if (rewrite === null) {
      return;
    }

    for (const name of rewrite.removeAttributes) {
      element.removeAttribute(name);
    }
    for (const assignment of rewrite.setAttributes) {
      element.setAttribute(assignment.name, assignment.value);
    }
  },
};

/**
 * Transforms a trusted guest document response into markup a `v-frame` element
 * can adopt, for the guest's public `documentURL`.
 */
export function materializeVFrameDocument(
  response: Response,
  documentURL: string,
  options: MaterializeStylesheetOptions = {},
): Response {
  return new HTMLRewriter()
    .on("html", shellHandlers)
    .on("head", shellHandlers)
    .on("body", shellHandlers)
    .on("style", new StylesheetText(documentURL, options))
    .on("script", scriptHandlers)
    .transform(response);
}
