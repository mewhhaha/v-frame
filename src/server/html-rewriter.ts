import { isHTMLDocumentResponse, readHTMLDocument } from "../html-response.js";
import {
  materializeStylesheet,
  rewriteScriptElement,
  rewriteShellElement,
  rewriteAssetAttributes,
  rewritePreviewAttributes,
  readStylesheetSource,
  fetchStylesheetSource,
} from "./core.js";
import type { MaterializeStylesheetOptions } from "./core.js";
import { HTML_NAMESPACE, rewriteAssetAttribute } from "../asset-urls.js";
import type { StylesheetFetchOptions, StylesheetSource } from "../css.js";
import {
  NEUTRALIZED_STYLESHEET_REL,
  SSR_LINK_REL,
  SSR_LINK_INTEGRITY,
  SSR_LINK_SOURCE,
  SSR_LINK_STYLE,
  SSR_STYLE,
  FRAGMENT_TARGET_ATTRIBUTE,
} from "../wire-format.js";
import { fragmentIdentifiers, fragmentTargetRank } from "../fragment.js";

/**
 * Adapter over the materializer core for any runtime whose `HTMLRewriter`
 * (lol-html: Cloudflare Workers, Bun, or a port) transforms a `Response`. The
 * runtime's types are not visible to this package, so the sliver of
 * `HTMLRewriter` the adapter drives is declared structurally here.
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
  onEndTag(handler: () => void): void;
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

/** A constructor for a rewriter that transforms a `Response`, like `HTMLRewriter`. */
export type HTMLRewriterConstructor = new () => Rewriter;

export interface MaterializeDocumentOptions extends MaterializeStylesheetOptions {
  /** The rewriter to drive. Defaults to the runtime's global `HTMLRewriter`. */
  HTMLRewriter?: HTMLRewriterConstructor;
  /** Reject responses that cannot be transformed before embedding them as HTML. */
  requireDocument?: boolean;
}

// Validators and range metadata describe the guest's bytes, which this
// transform replaces. Keeping them would let a cache revalidate or slice the
// rewritten body against the original's identity. `content-encoding` goes too:
// the runtime hands over a decoded body, and the output is a fresh stream the
// server encodes itself.
const STALE_HEADERS = [
  "content-length",
  "content-encoding",
  "content-range",
  "accept-ranges",
  "content-md5",
  "content-digest",
  "repr-digest",
  "digest",
  "etag",
  "last-modified",
];

const UTF8_HTML = { "content-type": "text/html; charset=utf-8" };

const charsetDeclarationHandlers: RewriterHandlers = {
  element(element) {
    // The output is UTF-8 whatever the guest authored; a stale declaration
    // would make a reader decode it as the guest's original encoding.
    if (element.hasAttribute("charset")) element.setAttribute("charset", "utf-8");
    if (
      element.getAttribute("http-equiv")?.toLowerCase() === "content-type" &&
      element.hasAttribute("content")
    ) {
      element.setAttribute("content", "text/html; charset=utf-8");
    }
  },
};

interface StyleResult {
  css: string;
  fonts: string[];
}

type LinkResult =
  | { ok: true; sheet: StylesheetSource; css: string; fonts: string[] }
  | { ok: false; error: unknown };

const isStylesheetRel = (rel: string, token = "stylesheet") =>
  rel.split(/\s+/).some((part) => part.toLowerCase() === token);

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

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
 *
 * Only a 200 `text/html` response is transformed; any other response is
 * returned as it came. The guest body is buffered once, because a `<base>`
 * applies to the whole document and the fragment target is chosen across all of
 * it. The rewritten output then streams with backpressure, and cancelling it
 * aborts the work still in flight.
 */
export async function materializeVFrameDocument(
  response: Response,
  documentURL: string,
  options: MaterializeDocumentOptions = {},
): Promise<Response> {
  if (!isHTMLDocumentResponse(response)) {
    if (options.requireDocument) {
      throw new TypeError(
        `v-frame expected a 200 text/html response from ${documentURL}, received ${response.status} ${response.headers.get("content-type") ?? "without a Content-Type"}`,
      );
    }
    return response;
  }
  const Rewriter =
    options.HTMLRewriter ??
    (globalThis as { HTMLRewriter?: HTMLRewriterConstructor }).HTMLRewriter;
  if (typeof Rewriter !== "function") {
    throw new TypeError(
      "materializeVFrameDocument needs an HTMLRewriter: this runtime has no global one, so pass one as options.HTMLRewriter",
    );
  }

  let baseURL = documentURL;
  let hasBase = false;
  const identifiers = fragmentIdentifiers(documentURL);
  let elementIndex = 0;
  let templateDepth = 0;
  let foreignDepth = 0;
  let targetIndex = -1;
  let targetRank = Infinity;
  const enterTemplate = (element: RewriterElement) => {
    if (element.namespaceURI === HTML_NAMESPACE && element.tagName === "template") {
      templateDepth++;
      element.onEndTag(() => templateDepth--);
    }
  };
  // Decoded once: the runtime re-encodes rewriter output in the charset the
  // response declares, so feeding it the guest's own bytes would hand `.text()`
  // Latin-1 (or worse) to misread as UTF-8.
  const guest = await readHTMLDocument(response, options.signal);
  // Stylesheets are known only after the whole document has been read, since a
  // late `<base>` re-bases them all. The first parse gathers their sources so
  // the fetches can start together before the second parse reaches them.
  const styleSources: string[] = [];
  const linkHrefs: Array<{ href: string; stylesheet: boolean; integrity: string }> = [];
  // A base applies to the entire document, even to resources preceding it. The
  // first parse is deliberately side-effect free.
  const source = await new Rewriter()
    .on("*", {
      element(element) {
        const index = elementIndex++;
        if (templateDepth === 0) {
          const rank = fragmentTargetRank(
            {
              localName: element.tagName,
              namespaceURI: element.namespaceURI,
              getAttribute: (name) => element.getAttribute(name),
            },
            identifiers,
          );
          if (rank < targetRank) {
            targetIndex = index;
            targetRank = rank;
          }
          // The runtime takes the first valid `base[href]` in the parsed tree
          // outside template contents, wherever the parser put it, so tags the
          // source omits (`<html>`, `<head>`) must not matter here either.
          if (
            !hasBase &&
            foreignDepth === 0 &&
            element.namespaceURI === HTML_NAMESPACE &&
            element.tagName === "base"
          ) {
            const href = element.getAttribute("href");
            const url = href === null ? null : URL.parse(href, documentURL);
            if (url) {
              baseURL = url.href;
              hasBase = true;
            }
          }
        }
        enterTemplate(element);
        // lol-html reports a `<base>` that a foreign `<head>` breaks out of as
        // HTML, but the runtime does not treat anything inside an `<svg>` or
        // `<math>` as the document's base.
        if (
          element.namespaceURI !== HTML_NAMESPACE &&
          (element.tagName === "svg" || element.tagName === "math")
        ) {
          foreignDepth++;
          element.onEndTag(() => foreignDepth--);
        }
      },
    })
    .on("style", {
      element() {
        styleSources.push("");
      },
      text(chunk) {
        styleSources[styleSources.length - 1] += chunk.text;
      },
    })
    .on("link[href]", {
      element(element) {
        linkHrefs.push({
          href: element.getAttribute("href")!,
          stylesheet: isStylesheetRel(element.getAttribute("rel") ?? ""),
          integrity: element.getAttribute("integrity")?.trim() ?? "",
        });
      },
    })
    .transform(new Response(guest, { headers: UTF8_HTML }))
    .text();
  const abort = new AbortController();
  let signal = abort.signal;
  if (options.signal !== undefined) signal = AbortSignal.any([signal, options.signal]);
  signal.throwIfAborted();
  const requests = new Map<string, Promise<StylesheetSource>>();
  elementIndex = 0;
  templateDepth = 0;
  // An aborted materialization is discarded, so the fetches it cancelled
  // failing is the cancellation working; reporting them would make a client
  // disconnect look like a broken stylesheet.
  const onImportFailure: MaterializeStylesheetOptions["onImportFailure"] = (failure) => {
    if (!signal.aborted) options.onImportFailure?.(failure);
  };
  const fetchText = (url: string, { integrity = "" }: StylesheetFetchOptions = {}) => {
    let key = url;
    if (integrity !== "") key = JSON.stringify([url, integrity]);
    let result = requests.get(key);
    if (!result) {
      result = (options.fetchText ?? fetchStylesheetSource)(url, {
        signal,
        integrity,
      }).then((source) => readStylesheetSource(source, url, integrity));
      requests.set(key, result);
    }
    return result;
  };
  const settings: MaterializeStylesheetOptions = {
    ...options,
    fetchText,
    onImportFailure,
    signal,
  };
  // Font declarations are collected per sheet and handed over in document
  // order when the rewriter reaches the sheet, whatever order the fetches
  // finish in.
  const collecting = (fonts: string[]): MaterializeStylesheetOptions =>
    options.onFontFace
      ? { ...settings, onFontFace: (css) => fonts.push(css) }
      : { ...settings };
  const flushFonts = (fonts: string[]) => {
    if (signal.aborted) return;
    for (const css of fonts) options.onFontFace!(css);
  };
  const styleJobs = styleSources.map(async (css): Promise<StyleResult | null> => {
    const fonts: string[] = [];
    try {
      return { css: await materializeStylesheet(css, baseURL, collecting(fonts)), fonts };
    } catch (error) {
      onImportFailure({ url: baseURL, error });
      return null;
    }
  });
  const linkJobs = linkHrefs.map(
    async ({ href, stylesheet, integrity }): Promise<LinkResult | null> => {
      if (!stylesheet) return null;
      const url =
        rewriteAssetAttribute(
          { localName: "link", namespaceURI: HTML_NAMESPACE },
          "href",
          null,
          href,
          baseURL,
        ) ?? href;
      try {
        const sheet = await fetchText(url, { integrity });
        const fonts: string[] = [];
        const css = await materializeStylesheet(sheet.text, sheet.url, collecting(fonts));
        return { ok: true, sheet, css, fonts };
      } catch (error) {
        return { ok: false, error };
      }
    },
  );
  // Each style settles once, in document order: the element handler learns
  // whether it was materialized, then the text handler takes the result.
  const settledStyles: Array<Promise<string | null>> = [];
  const settleStyle = (index: number) =>
    (settledStyles[index] ??= (async () => {
      const job = await styleJobs[index];
      if (!job) return null;
      try {
        if (options.onFontFace) flushFonts(job.fonts);
        return job.css;
      } catch (error) {
        onImportFailure({ url: baseURL, error });
        return null;
      }
    })());
  let styleIndex = -1;
  let linkIndex = 0;
  const transformed = new Rewriter()
    .on("*", {
      element(element) {
        const index = elementIndex++;
        if (templateDepth === 0) {
          element.removeAttribute(FRAGMENT_TARGET_ATTRIBUTE);
          if (index === targetIndex) element.setAttribute(FRAGMENT_TARGET_ATTRIBUTE, "");
        }
        enterTemplate(element);
        const preview = rewritePreviewAttributes(element);
        for (const assignment of rewriteAssetAttributes(
          element,
          element.namespaceURI === HTML_NAMESPACE && element.tagName === "base"
            ? documentURL
            : baseURL,
        )) {
          element.setAttribute(assignment.name, assignment.value);
        }
        for (const name of preview.removeAttributes) element.removeAttribute(name);
        for (const { name, value } of preview.setAttributes)
          element.setAttribute(name, value);
      },
    })
    .on("html", shellHandlers)
    .on("head", shellHandlers)
    .on("body", shellHandlers)
    .on("meta", charsetDeclarationHandlers)
    .on("style", {
      async element(element) {
        // Only the server's own success vouches for a style; a guest-authored
        // marker must not exempt its sheet from the runtime's rewrite.
        element.removeAttribute(SSR_STYLE);
        if ((await settleStyle(++styleIndex)) !== null) {
          element.setAttribute(SSR_STYLE, "");
        }
      },
      async text(chunk) {
        // A stylesheet only parses as a whole, so the chunks are dropped and
        // the rewritten text replaces the last one.
        if (!chunk.lastInTextNode) {
          chunk.remove();
          return;
        }
        // On failure the style stays as authored, unmarked, and the runtime
        // rewrites it at activation.
        const css = await settleStyle(styleIndex);
        chunk.replace(css ?? styleSources[styleIndex]!, { html: true });
      },
    })
    .on("script", scriptHandlers)
    .on("link[href]", {
      async element(element) {
        const job = linkJobs[linkIndex++];
        const result = await job;
        if (!result) return;
        const rel = element.getAttribute("rel") ?? "";
        const href = element.getAttribute("href")!;
        // Neutralized even when the fetch fails: left live, the browser would
        // load it against the host page. The runtime restores `rel` and, with no
        // materialized style beside the link, fetches the sheet itself.
        element.setAttribute(SSR_LINK_REL, rel);
        element.setAttribute("rel", NEUTRALIZED_STYLESHEET_REL);
        try {
          if (!result.ok) throw result.error;
          if (options.onFontFace) flushFonts(result.fonts);
          // An alternate sheet is not applied until the guest selects it, so
          // its preview starts disabled like the link itself.
          const disabled =
            element.hasAttribute("disabled") || isStylesheetRel(rel, "alternate");
          const attrs = [
            `${SSR_LINK_SOURCE}="${escapeAttribute(result.sheet.url)}"`,
            `${SSR_LINK_STYLE}=""`,
            `media="${disabled ? "not all" : escapeAttribute(element.getAttribute("media") ?? "")}"`,
          ];
          const integrity = element.getAttribute("integrity")?.trim();
          if (integrity) {
            attrs.push(`${SSR_LINK_INTEGRITY}="${escapeAttribute(integrity)}"`);
          }
          for (const name of ["nonce", "title"]) {
            const value = element.getAttribute(name);
            if (value !== null) attrs.push(`${name}="${escapeAttribute(value)}"`);
          }
          element.after(`<style ${attrs.join(" ")}>${result.css}</style>`, {
            html: true,
          });
        } catch (error) {
          onImportFailure({ url: href, error });
        }
      },
    })
    // The buffered source is a UTF-8 string, whatever charset the guest declared.
    .transform(new Response(source, { headers: UTF8_HTML }));

  const headers = new Headers(response.headers);
  for (const name of STALE_HEADERS) headers.delete(name);
  headers.set("content-type", "text/html; charset=utf-8");
  const reader = transformed
    .body!.pipeThrough(new TransformStream(), { signal })
    .getReader();
  // Pulling one chunk per demand carries the client's backpressure to the
  // rewriter, and `cancel` reaches it and the stylesheet fetches it started.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        abort.abort(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      abort.abort(reason);
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
