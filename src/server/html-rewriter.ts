import {
  materializeStylesheet,
  rewriteScriptElement,
  rewriteShellElement,
  rewriteAssetAttributes,
  fetchStylesheetSource,
} from "./core.js";
import type { MaterializeStylesheetOptions } from "./core.js";
import { HTML_NAMESPACE, rewriteAssetAttribute } from "../asset-urls.js";
import type { StylesheetFetch, StylesheetSource } from "../css.js";
import {
  NEUTRALIZED_STYLESHEET_REL,
  SSR_LINK_REL,
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

const HTML_CONTENT_TYPE = /^\s*text\/html\s*(?:;|$)/i;

const CHARSET_LABEL = /^[\w.:-]+$/;

/** A `TextDecoder` for a charset label, or null when the label names no known encoding. */
function decoderFor(label: string | null | undefined): TextDecoder | null {
  if (!label || !CHARSET_LABEL.test(label.trim())) return null;
  try {
    return new TextDecoder(label.trim());
  } catch {
    return null;
  }
}

const META_TAG = /<meta(?=[\s/>])([^>]*)>/gi;
const META_ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
const CONTENT_CHARSET = /charset\s*=\s*["']?\s*([^\s"';]+)/i;

/**
 * The `<meta>` charset declaration in the first 1024 bytes, per the HTML
 * prescan: a `charset` attribute, or `http-equiv=content-type` with a charset
 * in its `content`. The bytes are read as Latin-1 because only ASCII markup
 * matters here.
 */
function prescanCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  for (const tag of head.matchAll(META_TAG)) {
    let charset: string | null = null;
    let httpEquiv: string | null = null;
    let content: string | null = null;
    for (const attribute of tag[1]!.matchAll(META_ATTRIBUTE)) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      switch (attribute[1]!.toLowerCase()) {
        case "charset":
          charset ??= value;
          break;
        case "http-equiv":
          httpEquiv ??= value;
          break;
        case "content":
          content ??= value;
          break;
      }
    }
    if (charset !== null) return charset;
    if (httpEquiv?.toLowerCase() === "content-type" && content !== null) {
      const declared = CONTENT_CHARSET.exec(content)?.[1];
      if (declared) return declared;
    }
  }
  return null;
}

/**
 * Decodes the guest's bytes by the HTML encoding sniffing rules this adapter
 * can honour: a byte order mark, then the `Content-Type` charset, then the
 * `<meta>` prescan, then UTF-8. The runtime's rewriter re-encodes in whatever
 * charset the response declares, so decoding once here keeps every later pass
 * on UTF-8.
 */
function decodeGuest(bytes: Uint8Array, contentType: string): string {
  let decoder: TextDecoder | null = null;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    decoder = new TextDecoder("utf-8");
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    decoder = new TextDecoder("utf-16le");
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    decoder = new TextDecoder("utf-16be");
  }
  decoder ??= decoderFor(CONTENT_CHARSET.exec(contentType)?.[1]);
  if (decoder === null) {
    const declared = decoderFor(prescanCharset(bytes));
    // A document that declares UTF-16 in an ASCII-compatible prefix is not
    // UTF-16 at all; the HTML standard reads such a declaration as UTF-8.
    decoder = declared?.encoding.startsWith("utf-16") ? null : declared;
  }
  return (decoder ?? new TextDecoder("utf-8")).decode(bytes);
}

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
  const Rewriter =
    options.HTMLRewriter ??
    (globalThis as { HTMLRewriter?: HTMLRewriterConstructor }).HTMLRewriter;
  if (typeof Rewriter !== "function") {
    throw new TypeError(
      "materializeVFrameDocument needs an HTMLRewriter: this runtime has no global one, so pass one as options.HTMLRewriter",
    );
  }
  if (
    !response.body ||
    response.status !== 200 ||
    !HTML_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")
  ) {
    return response;
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
  const guest = decodeGuest(
    new Uint8Array(await response.arrayBuffer()),
    response.headers.get("content-type") ?? "",
  );
  // Stylesheets are known only after the whole document has been read, since a
  // late `<base>` re-bases them all. The first parse gathers their sources so
  // the fetches can start together before the second parse reaches them.
  const styleSources: string[] = [];
  const linkHrefs: Array<{ href: string; stylesheet: boolean }> = [];
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
        });
      },
    })
    .transform(new Response(guest, { headers: UTF8_HTML }))
    .text();
  const abort = new AbortController();
  const requests = new Map<string, Promise<string | StylesheetSource>>();
  elementIndex = 0;
  templateDepth = 0;
  // An aborted materialization is discarded, so the fetches it cancelled
  // failing is the cancellation working; reporting them would make a client
  // disconnect look like a broken stylesheet.
  const onImportFailure: MaterializeStylesheetOptions["onImportFailure"] = (failure) => {
    if (!abort.signal.aborted) options.onImportFailure?.(failure);
  };
  const fetchText: StylesheetFetch = (url) => {
    let result = requests.get(url);
    if (!result) {
      result = (options.fetchText ?? fetchStylesheetSource)(url, {
        signal: abort.signal,
      });
      requests.set(url, result);
    }
    return result;
  };
  const settings: MaterializeStylesheetOptions = {
    ...options,
    fetchText,
    onImportFailure,
    signal: abort.signal,
  };
  // Font declarations are collected per sheet and handed over in document
  // order when the rewriter reaches the sheet, whatever order the fetches
  // finish in.
  const collecting = (fonts: string[]): MaterializeStylesheetOptions =>
    options.onFontFace
      ? { ...settings, onFontFace: (css) => fonts.push(css) }
      : { ...settings };
  const flushFonts = (fonts: string[]) => {
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
    async ({ href, stylesheet }): Promise<LinkResult | null> => {
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
        const result = await fetchText(url);
        const sheet = typeof result === "string" ? { text: result, url } : result;
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
        for (const assignment of rewriteAssetAttributes(
          element,
          element.namespaceURI === HTML_NAMESPACE && element.tagName === "base"
            ? documentURL
            : baseURL,
        )) {
          element.setAttribute(assignment.name, assignment.value);
        }
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
  const reader = transformed.body!.getReader();
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
