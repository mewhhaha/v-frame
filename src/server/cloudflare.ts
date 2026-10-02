import {
  materializeStylesheet,
  rewriteScriptElement,
  rewriteShellElement,
  rewriteAssetAttributes,
  fetchStylesheetSource,
} from "./core.js";
import type { MaterializeStylesheetOptions } from "./core.js";
import { SSR_LINK_REL, SSR_LINK_STYLE } from "../asset-urls.js";
import type { StylesheetSource } from "../css.js";

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
  readonly namespaceURI: string;
  readonly attributes: Iterable<[string, string]>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
  prepend(content: string, options?: RewriterContentOptions): void;
  after(content: string, options?: RewriterContentOptions): void;
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
  if (!response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let baseURL = documentURL;
        let hasBase = false;
        // A base applies to the entire document, even to resources preceding
        // it. The first parse is deliberately side-effect free.
        const source = await new HTMLRewriter()
          .on("head base[href]", {
            element(element) {
              if (hasBase) return;
              const url = URL.parse(element.getAttribute("href")!, documentURL);
              if (url) {
                baseURL = url.href;
                hasBase = true;
              }
            },
          })
          .transform(response)
          .text();
        const requests = new Map<string, Promise<string | StylesheetSource>>();
        const settings: MaterializeStylesheetOptions = {
          ...options,
          fetchText(url) {
            let result = requests.get(url);
            if (!result) {
              result = (options.fetchText ?? fetchStylesheetSource)(url);
              requests.set(url, result);
            }
            return result;
          },
        };
        const transformed = new HTMLRewriter()
          .on("*", {
            element(element) {
              for (const assignment of rewriteAssetAttributes(
                element,
                element.tagName === "base" ? documentURL : baseURL,
              )) {
                element.setAttribute(assignment.name, assignment.value);
              }
            },
          })
          .on("html", shellHandlers)
          .on("head", shellHandlers)
          .on("body", shellHandlers)
          .on("style", new StylesheetText(baseURL, settings))
          .on("script", scriptHandlers)
          .on("link[href]", {
            async element(element) {
              const rel = element.getAttribute("rel") ?? "";
              if (!rel.split(/\s+/).some((token) => token.toLowerCase() === "stylesheet"))
                return;
              const href = element.getAttribute("href")!;
              element.setAttribute(SSR_LINK_REL, rel);
              element.setAttribute("rel", "v-frame-stylesheet");
              try {
                const result = await settings.fetchText!(href);
                const sheet =
                  typeof result === "string" ? { text: result, url: href } : result;
                const css = await materializeStylesheet(sheet.text, sheet.url, settings);
                const escape = (value: string) =>
                  value
                    .replaceAll("&", "&amp;")
                    .replaceAll('"', "&quot;")
                    .replaceAll("<", "&lt;");
                const attrs = [
                  `data-v-frame-source="${escape(sheet.url)}"`,
                  `${SSR_LINK_STYLE}=""`,
                  `media="${escape(element.hasAttribute("disabled") ? "not all" : (element.getAttribute("media") ?? ""))}"`,
                ];
                for (const name of ["nonce", "title"]) {
                  const value = element.getAttribute(name);
                  if (value !== null) attrs.push(`${name}="${escape(value)}"`);
                }
                element.after(`<style ${attrs.join(" ")}>${css}</style>`, { html: true });
              } catch (error) {
                options.onImportFailure?.({ url: href, error });
              }
            },
          })
          .transform(new Response(source));
        const reader = transformed.body!.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          controller.enqueue(chunk.value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
