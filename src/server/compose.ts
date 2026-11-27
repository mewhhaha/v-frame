import { decodeHTMLAttribute } from "entities/decode";
import { isHTMLDocumentResponse, readHTMLDocument } from "../html-response.js";
import {
  createFetchBudget,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_SLOTS,
  DEFAULT_MAX_STYLESHEET_BYTES,
  DEFAULT_MAX_TOTAL_FETCHES,
  limitResponseBytes,
  raceWithAbort,
  readBoundedBytes,
} from "./core.js";
import {
  charsetDeclarationHandlers,
  encodeRewriterAttribute,
  escapeAttribute,
  getHTMLRewriter,
  type HTMLRewriterConstructor,
  type RewriterElement,
  materializeVFrameDocument,
  observeHTMLBase,
  rewrittenHTMLResponse,
  UTF8_HTML,
} from "./html-rewriter.js";
import { SSR_LINK_STYLE, SSR_STYLE } from "../wire-format.js";

const DEFAULT_SLOT_TIMEOUT_MS = 10_000;

export interface ComposeSlotFailure {
  /** The slot's authored `src` attribute. */
  src: string;
  /** The error that caused this slot to fall back to client loading. */
  error: unknown;
}

export interface ComposeFramesOptions {
  /** The incoming request supplies the public URL and cancellation signal. */
  request: Request;
  /** Route public guest and stylesheet URLs to the services the host trusts. */
  fetchGuest(request: Request): Promise<Response> | Response;
  /** Defaults to the runtime's global HTMLRewriter. */
  HTMLRewriter?: HTMLRewriterConstructor;
  /** Per-slot materialization timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /** Called when a slot fails to compose and falls back to client loading. Not called once the request is aborted. */
  onSlotError?(failure: ComposeSlotFailure): void;
  /** Maximum number of `<v-frame>` slots composed per shell response. Defaults to 32. */
  maxSlots?: number;
  /** Maximum total upstream guest + stylesheet fetches across the whole composition. Defaults to 256. */
  maxTotalFetches?: number;
  /**
   * Preserve already-materialized nested same-origin `<v-frame adopt src="...">`
   * shadow roots returned by inner composing services. Set `false` for leaf-only
   * composition to strip every incoming `data-v-frame-*` marker, or pass a
   * predicate to allow nested provenance only for specific trusted upstreams.
   * Defaults to `true`.
   */
  allowNestedComposition?: boolean | ((slot: { src: string; url: URL }) => boolean);
  /** Maximum byte length accepted for the shell or a guest HTML document. Defaults to 10 MiB. */
  maxDocumentBytes?: number;
  /** Maximum byte length accepted for a single stylesheet. Defaults to 2 MiB. */
  maxStylesheetBytes?: number;
  /** Maximum distinct stylesheet fetches per slot. Defaults to 64. */
  maxStylesheets?: number;
  /** Maximum nested `@import` depth per slot. Defaults to 8. */
  maxImportDepth?: number;
  /** Maximum concurrent upstream fetches across the whole composition. Defaults to 8. */
  maxConcurrency?: number;
}

interface FrameSlot {
  src: string;
  nonce: string;
  credentials: RequestCredentials;
}

/** Render the shell's own frame declarations before they reach the browser. */
export async function composeFrames(
  shell: Response,
  options: ComposeFramesOptions,
): Promise<Response> {
  if (!isHTMLDocumentResponse(shell)) return shell;
  const { request, fetchGuest } = options;
  const Rewriter = getHTMLRewriter(options.HTMLRewriter);
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const maxStylesheetBytes = options.maxStylesheetBytes ?? DEFAULT_MAX_STYLESHEET_BYTES;
  const maxSlots = options.maxSlots ?? DEFAULT_MAX_SLOTS;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxTotalFetches = options.maxTotalFetches ?? DEFAULT_MAX_TOTAL_FETCHES;
  const allowNestedComposition = options.allowNestedComposition ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SLOT_TIMEOUT_MS;
  const compositionBudget = createFetchBudget({
    maxRequests: maxTotalFetches,
    maxConcurrency,
    label: "v-frame composition",
  });
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const source = await readHTMLDocument(
    limitResponseBytes(shell, maxDocumentBytes, `v-frame shell ${request.url}`),
    signal,
  );
  const shellURL = new URL(request.url);
  // Keep positions for *all* v-frame tags so the second pass cannot apply
  // another frame's result to an inert, nested or pre-composed slot.
  const slots: Array<FrameSlot | null> = [];
  const html = () => new Response(source, { headers: UTF8_HTML });
  const scan = new Rewriter();
  const readBase = observeHTMLBase(scan, request.url);
  // lol-html can report the previous namespace after a self-closing SVG.
  // Its ancestor selectors track the actual tree and need no synthetic end tag.
  function onSlot(
    selector: string,
    visit: (el: RewriterElement, owned: boolean) => void,
  ) {
    let owned = true;
    const excluded = ["template", "v-frame", "svg", "math"]
      .map((ancestor) => ancestor + " " + selector)
      .join(", ");
    scan
      .on(excluded, {
        element() {
          owned = false;
        },
      })
      .on(selector, {
        element(el) {
          visit(el, owned);
          owned = true;
        },
      });
  }
  let owner = -1;
  onSlot("v-frame", (el, owned) => {
    const index = slots.length;
    slots.push(null);
    if (!owned) return;
    owner = index;
    const src = el.getAttribute("src");
    if (!src?.trim()) return;
    const rawCredentials = el.getAttribute("credentials");
    let credentials: RequestCredentials = "same-origin";
    if (rawCredentials === "omit" || rawCredentials === "include")
      credentials = rawCredentials;
    slots[index] = {
      src: decodeHTMLAttribute(src),
      nonce: decodeHTMLAttribute(el.getAttribute("nonce") ?? ""),
      credentials,
    };
  });
  onSlot("v-frame > template[shadowrootmode]", (el, owned) => {
    const mode = el.getAttribute("shadowrootmode")?.toLowerCase();
    if (owned && owner >= 0 && (mode === "open" || mode === "closed"))
      slots[owner] = null;
  });
  await scan.transform(html()).body!.pipeTo(new WritableStream(), { signal });
  signal.throwIfAborted();
  const baseURL = readBase();

  const preview = async (slot: FrameSlot) => {
    const slotAbort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(
        () =>
          slotAbort.abort(
            new DOMException(
              `v-frame slot ${slot.src} timed out after ${timeoutMs}ms`,
              "TimeoutError",
            ),
          ),
        timeoutMs,
      );
    }
    const slotSignal = AbortSignal.any([signal, slotAbort.signal]);
    try {
      const url = new URL(slot.src, baseURL);
      const load = async (target: URL, accept: string, requestSignal: AbortSignal) => {
        if (
          target.origin !== shellURL.origin ||
          !["http:", "https:"].includes(target.protocol) ||
          target.username ||
          target.password
        )
          throw new TypeError("Guest URL must share the public shell origin");
        // Keep non-cooperative upstreams accounted for in the concurrency
        // budget while enforcing the slot deadline at this await boundary.
        const upstreamPromise = compositionBudget(requestSignal, async () => {
          const response = await fetchGuest(
            new Request(target, {
              headers: { Accept: accept },
              credentials: slot.credentials,
              redirect: "manual",
              signal: requestSignal,
            }),
          );
          if (requestSignal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw requestSignal.reason;
          }
          return response;
        });
        const result = await raceWithAbort(upstreamPromise, requestSignal);
        if (result.redirected || result.status !== 200) {
          void result.body?.cancel().catch(() => {});
          throw new TypeError(`Unexpected guest response (${result.status})`);
        }
        return result;
      };
      const guest = await load(url, "text/html", slotSignal);
      if (!isHTMLDocumentResponse(guest)) {
        void guest.body?.cancel().catch(() => {});
        throw new TypeError(`Expected a 200 text/html guest response for ${url.href}`);
      }
      const fonts = new Set<string>();
      const preserveNestedFrames =
        typeof allowNestedComposition === "function"
          ? allowNestedComposition({ src: slot.src, url })
          : allowNestedComposition;
      let materialized = await raceWithAbort(
        materializeVFrameDocument(guest, url.href, {
          HTMLRewriter: Rewriter,
          requireDocument: true,
          preserveNestedFrames,
          signal: slotSignal,
          maxDocumentBytes,
          maxStylesheetBytes,
          ...(options.maxStylesheets !== undefined
            ? { maxStylesheets: options.maxStylesheets }
            : {}),
          ...(options.maxImportDepth !== undefined
            ? { maxImportDepth: options.maxImportDepth }
            : {}),
          maxConcurrency,
          onFontFace: (css) => fonts.add(css),
          async fetchText(href, init) {
            const fetchSignal = init?.signal ?? slotSignal;
            const sheet = await load(new URL(href), "text/css", fetchSignal);
            return {
              bytes: await readBoundedBytes(
                sheet,
                maxStylesheetBytes,
                `v-frame SSR stylesheet ${href}`,
                fetchSignal,
              ),
              url: href,
            };
          },
        }),
        slotSignal,
      );
      if (slot.nonce) {
        const encodedNonce = encodeRewriterAttribute(slot.nonce);
        materialized = new Rewriter()
          .on(`style[${SSR_STYLE}], style[${SSR_LINK_STYLE}], v-frame`, {
            element(el) {
              el.setAttribute("nonce", encodedNonce);
            },
          })
          .transform(materialized);
      }
      const markup = await raceWithAbort(materialized.text(), slotSignal);
      return { markup, fonts, nonce: slot.nonce };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  // Start eligible siblings together up to the composition-wide slot and
  // request budgets. Failed or overflow slots keep their client-loadable src.
  let eligibleCount = 0;
  const results = slots.map((slot) => {
    if (!slot) return null;
    if (eligibleCount >= maxSlots) {
      if (!signal.aborted) {
        options.onSlotError?.({
          src: slot.src,
          error: new RangeError(
            `v-frame composition exceeded maximum of ${maxSlots} slots`,
          ),
        });
      }
      return null;
    }
    eligibleCount += 1;
    return preview(slot).catch((error) => {
      if (!signal.aborted) options.onSlotError?.({ src: slot.src, error });
      return null;
    });
  });
  const emittedFonts = new Set<string>();
  let emittedFontChars = 0;
  let index = 0;
  const composed = new Rewriter()
    .on("meta", charsetDeclarationHandlers)
    .on("v-frame", {
      async element(el) {
        const result = await results[index++];
        signal.throwIfAborted();
        if (!result) return;
        if (!el.hasAttribute("adopt")) {
          el.setAttribute("adopt", "");
        }
        el.prepend(
          `<template shadowrootmode="open" shadowrootserializable>${result.markup}</template>`,
          { html: true },
        );
        const freshFonts: string[] = [];
        for (const css of result.fonts) {
          if (
            !emittedFonts.has(css) &&
            emittedFontChars + css.length <= maxStylesheetBytes
          ) {
            emittedFonts.add(css);
            emittedFontChars += css.length;
            freshFonts.push(css);
          }
        }
        if (freshFonts.length) {
          let nonce = "";
          if (result.nonce) nonce = ` nonce="${escapeAttribute(result.nonce)}"`;
          el.after(`<style data-v-frame-fonts${nonce}>${freshFonts.join("\n")}</style>`, {
            html: true,
          });
        }
      },
    })
    .transform(html());
  return rewrittenHTMLResponse(shell, composed, abort, signal);
}
