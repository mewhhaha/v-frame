import { decodeHTMLAttribute } from "entities/decode";
import { isHTMLDocumentResponse, readHTMLDocument } from "../html-response.js";
import {
  charsetDeclarationHandlers,
  escapeAttribute,
  getHTMLRewriter,
  type HTMLRewriterConstructor,
  type RewriterElement,
  materializeVFrameDocument,
  observeHTMLBase,
  rewrittenHTMLResponse,
  UTF8_HTML,
} from "./html-rewriter.js";

export interface ComposeFramesOptions {
  /** The incoming request supplies the public URL and cancellation signal. */
  request: Request;
  /** Route public guest and stylesheet URLs to the services the host trusts. */
  fetchGuest(request: Request): Promise<Response> | Response;
  /** Defaults to the runtime's global HTMLRewriter. */
  HTMLRewriter?: HTMLRewriterConstructor;
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
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const source = await readHTMLDocument(shell, signal);
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
    const url = new URL(slot.src, baseURL);
    const load = async (target: URL, accept: string, signal: AbortSignal) => {
      if (
        target.origin !== shellURL.origin ||
        !["http:", "https:"].includes(target.protocol) ||
        target.username ||
        target.password
      )
        throw new TypeError("Guest URL must share the public shell origin");
      const result = await fetchGuest(
        new Request(target, {
          headers: { Accept: accept },
          credentials: slot.credentials,
          redirect: "manual",
          signal,
        }),
      );
      if (result.redirected || result.status !== 200) {
        void result.body?.cancel().catch(() => {});
        throw new TypeError(`Unexpected guest response (${result.status})`);
      }
      return result;
    };
    const guest = await load(url, "text/html", signal);
    if (!isHTMLDocumentResponse(guest)) {
      void guest.body?.cancel().catch(() => {});
      return null;
    }
    const fonts = new Set<string>();
    let materialized = await materializeVFrameDocument(guest, url.href, {
      HTMLRewriter: Rewriter,
      requireDocument: true,
      signal,
      onFontFace: (css) => fonts.add(css),
      async fetchText(href, init) {
        const sheet = await load(new URL(href), "text/css", init?.signal ?? signal);
        return { bytes: await sheet.arrayBuffer(), url: href };
      },
    });
    if (slot.nonce) {
      materialized = new Rewriter()
        .on("style, v-frame", {
          element(el) {
            el.setAttribute("nonce", slot.nonce);
          },
        })
        .transform(materialized);
    }
    const markup = await materialized.text();
    return { markup, fonts, nonce: slot.nonce };
  };
  // Start siblings together. A failed guest keeps its client-loadable src;
  // its diagnostic response must never become part of the host page.
  const results = slots.map((slot) => slot && preview(slot).catch(() => null));
  let index = 0;
  const composed = new Rewriter()
    .on("meta", charsetDeclarationHandlers)
    .on("v-frame", {
      async element(el) {
        const result = await results[index++];
        signal.throwIfAborted();
        if (!result) return;
        el.setAttribute("adopt", "");
        el.prepend(
          `<template shadowrootmode="open" shadowrootserializable>${result.markup}</template>`,
          { html: true },
        );
        if (result.fonts.size) {
          let nonce = "";
          if (result.nonce) nonce = ` nonce="${escapeAttribute(result.nonce)}"`;
          el.after(
            `<style data-v-frame-fonts${nonce}>${[...result.fonts].join("\n")}</style>`,
            { html: true },
          );
        }
      },
    })
    .transform(html());
  return rewrittenHTMLResponse(shell, composed, abort, signal);
}
