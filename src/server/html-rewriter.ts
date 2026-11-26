import { decodeHTMLAttribute } from "entities/decode";
import { isHTMLDocumentResponse, readHTMLDocument } from "../html-response.js";
import {
  balanceTemplateTags,
  createBoundedStylesheetFetch,
  createDefaultStylesheetFetch,
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_IMPORT_DEPTH,
  DEFAULT_MAX_STYLESHEET_BYTES,
  limitResponseBytes,
  materializeStylesheet,
  rewriteScriptElement,
  rewriteShellElement,
  rewriteAssetAttributes,
  rewritePreviewAttributes,
  readStylesheetSource,
} from "./core.js";
import type { MaterializeStylesheetOptions } from "./core.js";
import { HTML_NAMESPACE, rewriteAssetAttribute } from "../asset-urls.js";
import type { StylesheetFetchOptions, StylesheetSource } from "../css.js";
import {
  isReservedSSRAttribute,
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

export interface RewriterElement {
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
  /** Maximum byte length accepted for the guest HTML document. Defaults to 10 MiB. */
  maxDocumentBytes?: number;
  /**
   * Preserve already-materialized SSR markers inside nested same-origin
   * `<v-frame adopt src="..."><template shadowrootmode="open">` elements
   * produced by an inner trusted composer. Defaults to `false`, stripping all
   * incoming `data-v-frame-*` markers across the guest document.
   */
  preserveNestedFrames?: boolean;
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

export const UTF8_HTML = { "content-type": "text/html; charset=utf-8" };

// Register on the same parse that discovers resources. Ancestor selectors also
// work for self-closing SVG/MathML nodes, which have no end-tag callback.
export function observeHTMLBase(parser: Rewriter, publicURL: string): () => string {
  const candidates: string[] = [];
  parser
    .on("base[href]", {
      element(el) {
        candidates.push(el.getAttribute("href")!);
      },
    })
    .on("template base[href], svg base[href], math base[href]", {
      element() {
        candidates.pop();
      },
    });
  return () => {
    for (const href of candidates) {
      const url = URL.parse(decodeHTMLAttribute(href), publicURL);
      if (url) return url.href;
    }
    return publicURL;
  };
}

export const charsetDeclarationHandlers: RewriterHandlers = {
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

export const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

// lol-html's setAttribute escapes `"` but preserves `&`, so decoded strings
// written back via setAttribute must escape `&` to avoid HTML entity re-parsing.
export const encodeRewriterAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;");

function decodedAttribute(element: RewriterElement, name: string): string | null {
  const value = element.getAttribute(name);
  return value === null ? null : decodeHTMLAttribute(value);
}

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
  const Rewriter = getHTMLRewriter(options.HTMLRewriter);

  const identifiers = fragmentIdentifiers(documentURL);
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const maxStylesheetBytes = options.maxStylesheetBytes ?? DEFAULT_MAX_STYLESHEET_BYTES;
  const maxImportDepth = options.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH;
  let elementIndex = 0;
  let templateDepth = 0;
  let targetIndex = -1;
  let targetRank = Infinity;
  // Decoded once: the runtime re-encodes rewriter output in the charset the
  // response declares, so feeding it the guest's own bytes would hand `.text()`
  // Latin-1 (or worse) to misread as UTF-8. Balancing `<template>` tags here
  // guarantees the output cannot break out of a Declarative Shadow DOM wrapper.
  const guest = balanceTemplateTags(
    await readHTMLDocument(
      limitResponseBytes(response, maxDocumentBytes, `v-frame guest ${documentURL}`),
      options.signal,
    ),
  );
  // Stylesheets are known only after the whole document has been read, since a
  // late `<base>` re-bases them all. The first parse gathers their sources so
  // the fetches can start together before the second parse reaches them.
  const styleSources: string[] = [];
  const linkHrefs: Array<{ href: string; stylesheet: boolean; integrity: string }> = [];
  let collectingStyle = false;
  // A base applies to the entire document, even to resources preceding it. The
  // first parse is deliberately side-effect free.
  const scan = new Rewriter();
  const readBase = observeHTMLBase(scan, documentURL);
  const source = await scan
    .on("*", {
      element(element) {
        const index = elementIndex++;
        if (templateDepth === 0) {
          const rank = fragmentTargetRank(
            {
              localName: element.tagName,
              namespaceURI: element.namespaceURI,
              getAttribute: (name) => decodedAttribute(element, name),
            },
            identifiers,
          );
          if (rank < targetRank) {
            targetIndex = index;
            targetRank = rank;
          }
        }
        if (element.namespaceURI === HTML_NAMESPACE && element.tagName === "template") {
          templateDepth++;
          element.onEndTag(() => {
            templateDepth--;
          });
        }
      },
    })
    .on("style", {
      element() {
        collectingStyle = templateDepth === 0;
        if (collectingStyle) {
          styleSources.push("");
        }
      },
      text(chunk) {
        if (collectingStyle) {
          styleSources[styleSources.length - 1] += chunk.text;
        }
      },
    })
    .on("link[href]", {
      element(element) {
        if (templateDepth > 0) return;
        linkHrefs.push({
          href: decodeHTMLAttribute(element.getAttribute("href")!),
          stylesheet: isStylesheetRel(decodedAttribute(element, "rel") ?? ""),
          integrity: (decodedAttribute(element, "integrity") ?? "").trim(),
        });
      },
    })
    .transform(new Response(guest, { headers: UTF8_HTML }))
    .text();
  const baseURL = readBase();
  const abort = new AbortController();
  let signal = abort.signal;
  if (options.signal !== undefined) signal = AbortSignal.any([signal, options.signal]);
  signal.throwIfAborted();
  const requests = new Map<string, Promise<StylesheetSource>>();
  elementIndex = 0;
  templateDepth = 0;
  let nestedShadowDepth = 0;
  let pendingNestedShadow = false;
  // An aborted materialization is discarded, so the fetches it cancelled
  // failing is the cancellation working; reporting them would make a client
  // disconnect look like a broken stylesheet.
  const onImportFailure: MaterializeStylesheetOptions["onImportFailure"] = (failure) => {
    if (!signal.aborted) options.onImportFailure?.(failure);
  };
  const baseFetch =
    options.fetchText ?? createDefaultStylesheetFetch(documentURL, maxStylesheetBytes);
  const boundedFetch = createBoundedStylesheetFetch(baseFetch, {
    maxStylesheetBytes,
    ...(options.maxStylesheets !== undefined
      ? { maxStylesheets: options.maxStylesheets }
      : {}),
    ...(options.maxConcurrency !== undefined
      ? { maxConcurrency: options.maxConcurrency }
      : {}),
  });
  const fetchText = (url: string, { integrity = "" }: StylesheetFetchOptions = {}) => {
    let key = url;
    if (integrity !== "") key = JSON.stringify([url, integrity]);
    let result = requests.get(key);
    if (!result) {
      result = boundedFetch(url, {
        signal,
        integrity,
      }).then((source) => readStylesheetSource(source, url, integrity));
      requests.set(key, result);
    }
    return result;
  };
  // Document-level fetch budget, byte cap, and concurrency are enforced once
  // on `boundedFetch` above; disable duplicate wrappers inside `materializeStylesheet`.
  const settings: MaterializeStylesheetOptions = {
    ...options,
    fetchText,
    onImportFailure,
    signal,
    maxImportDepth,
    maxStylesheets: Infinity,
    maxConcurrency: Infinity,
    maxStylesheetBytes: Infinity,
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
      if (new TextEncoder().encode(css).byteLength > maxStylesheetBytes) {
        throw new RangeError(
          `v-frame SSR inline stylesheet exceeded maximum size of ${maxStylesheetBytes} bytes`,
        );
      }
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
  let activeStyle = false;
  let linkIndex = 0;
  const shellHandlers: RewriterHandlers = {
    element(element) {
      if (nestedShadowDepth > 0) return;
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
  const assetOptions = {
    decode: decodeHTMLAttribute,
    encode: encodeRewriterAttribute,
  };
  const preserveNestedFrames = options.preserveNestedFrames === true;
  const documentOrigin = URL.parse(documentURL)?.origin ?? null;
  let eligibleNestedHost = false;
  const transformedRewriter = new Rewriter();
  if (preserveNestedFrames) {
    transformedRewriter
      .on("v-frame", {
        element(element) {
          eligibleNestedHost = false;
          if (templateDepth > 0 || !element.hasAttribute("adopt")) return;
          const rawSrc = decodedAttribute(element, "src")?.trim() ?? "";
          if (rawSrc === "") return;
          const resolved = URL.parse(rawSrc, baseURL);
          if (
            resolved !== null &&
            (resolved.protocol === "http:" || resolved.protocol === "https:") &&
            (documentOrigin === null || resolved.origin === documentOrigin)
          ) {
            eligibleNestedHost = true;
          }
        },
      })
      .on("v-frame[adopt][src] > template[shadowrootmode]", {
        element(element) {
          if (
            eligibleNestedHost &&
            templateDepth === 0 &&
            element.getAttribute("shadowrootmode")?.toLowerCase() === "open"
          ) {
            pendingNestedShadow = true;
          }
        },
      });
  }
  const transformed = transformedRewriter
    .on("*", {
      element(element) {
        const isNestedShadow = pendingNestedShadow;
        pendingNestedShadow = false;
        if (element.tagName !== "v-frame") eligibleNestedHost = false;
        const index = elementIndex++;
        const insideTemplate = templateDepth > 0;
        const insideNestedShadow = nestedShadowDepth > 0;
        if (element.namespaceURI === HTML_NAMESPACE && element.tagName === "template") {
          templateDepth++;
          if (isNestedShadow) nestedShadowDepth++;
          element.onEndTag(() => {
            templateDepth--;
            if (isNestedShadow) nestedShadowDepth--;
          });
        }
        if (isNestedShadow) {
          return;
        }
        if (insideNestedShadow) {
          // Preserve pre-composed nested frame provenance, while still
          // neutralizing any unmaterialized inline event handlers or links.
          const preview = rewritePreviewAttributes(element);
          for (const name of preview.removeAttributes) element.removeAttribute(name);
          for (const { name, value } of preview.setAttributes)
            element.setAttribute(name, value);
          return;
        }
        // SSR wire-format markers are server-owned: strip any guest-authored
        // copies before recording this materialization's own provenance.
        const forged: string[] = [];
        for (const [name] of element.attributes) {
          if (isReservedSSRAttribute(name)) forged.push(name);
        }
        for (const name of forged) element.removeAttribute(name);
        if (!insideTemplate && index === targetIndex) {
          element.setAttribute(FRAGMENT_TARGET_ATTRIBUTE, "");
        }
        const preview = rewritePreviewAttributes(element);
        for (const assignment of rewriteAssetAttributes(
          element,
          element.namespaceURI === HTML_NAMESPACE && element.tagName === "base"
            ? documentURL
            : baseURL,
          assetOptions,
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
    .on("meta", {
      element(element) {
        if (nestedShadowDepth > 0) return;
        charsetDeclarationHandlers.element!(element);
      },
    })
    .on("style", {
      async element(element) {
        activeStyle = templateDepth === 0;
        if (!activeStyle) return;
        // Only the server's own success vouches for a style; a guest-authored
        // marker must not exempt its sheet from the runtime's rewrite.
        element.removeAttribute(SSR_STYLE);
        if ((await settleStyle(++styleIndex)) !== null) {
          element.setAttribute(SSR_STYLE, "");
        }
      },
      async text(chunk) {
        if (!activeStyle) return;
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
        if (templateDepth > 0) return;
        const job = linkJobs[linkIndex++];
        const result = await job;
        if (!result) return;
        const rawRel = element.getAttribute("rel") ?? "";
        const rel = decodeHTMLAttribute(rawRel);
        const href = decodedAttribute(element, "href")!;
        // Neutralized even when the fetch fails: left live, the browser would
        // load it against the host page. The runtime restores `rel` and, with no
        // materialized style beside the link, fetches the sheet itself.
        element.setAttribute(SSR_LINK_REL, rawRel);
        element.setAttribute("rel", NEUTRALIZED_STYLESHEET_REL);
        try {
          if (!result.ok) throw result.error;
          if (options.onFontFace) flushFonts(result.fonts);
          // An alternate sheet is not applied until the guest selects it, so
          // its preview starts disabled like the link itself.
          const disabled =
            element.hasAttribute("disabled") || isStylesheetRel(rel, "alternate");
          const media = decodedAttribute(element, "media") ?? "";
          const attrs = [
            `${SSR_LINK_SOURCE}="${escapeAttribute(result.sheet.url)}"`,
            `${SSR_LINK_STYLE}=""`,
            `media="${disabled ? "not all" : escapeAttribute(media)}"`,
          ];
          const integrity = (decodedAttribute(element, "integrity") ?? "").trim();
          if (integrity) {
            attrs.push(`${SSR_LINK_INTEGRITY}="${escapeAttribute(integrity)}"`);
          }
          for (const name of ["nonce", "title"]) {
            const value = decodedAttribute(element, name);
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

  return rewrittenHTMLResponse(response, transformed, abort, signal);
}

export function getHTMLRewriter(
  override?: HTMLRewriterConstructor,
): HTMLRewriterConstructor {
  const Rewriter =
    override ?? (globalThis as { HTMLRewriter?: HTMLRewriterConstructor }).HTMLRewriter;
  if (typeof Rewriter !== "function") {
    throw new TypeError(
      "No global HTMLRewriter is available; pass one as options.HTMLRewriter",
    );
  }
  return Rewriter;
}

export function rewrittenHTMLResponse(
  response: Response,
  transformed: Response,
  abort: AbortController,
  signal: AbortSignal,
): Response {
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
