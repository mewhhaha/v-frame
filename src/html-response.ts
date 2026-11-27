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

// Consume complete tags, including quoted attributes, so a meta-looking string
// inside another tag or an HTML comment cannot declare the byte encoding.
const HTML_TAG =
  /<!--(?:>|->|[\s\S]*?(?:--!?>|$))|<([a-z][^\s/>]*)((?:[^"'>]|"[^"]*"|'[^']*')*)>/gi;
const META_ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
const CONTENT_CHARSET = /(?:^|;)\s*charset\s*=\s*["']?\s*([^\s"';]+)/i;

/**
 * The `<meta>` charset declaration in the first 1024 bytes, per the HTML
 * prescan: a `charset` attribute, or `http-equiv=content-type` with a charset
 * in its `content`. The bytes are read as Latin-1 because only ASCII markup
 * matters here.
 */
function prescanCharset(bytes: Uint8Array): TextDecoder | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  for (const tag of head.matchAll(HTML_TAG)) {
    if (tag[1]?.toLowerCase() !== "meta") continue;
    let charset: string | null = null;
    let httpEquiv: string | null = null;
    let content: string | null = null;
    for (const attribute of tag[2]!.matchAll(META_ATTRIBUTE)) {
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
    if (
      charset === null &&
      httpEquiv?.toLowerCase() === "content-type" &&
      content !== null
    ) {
      charset = CONTENT_CHARSET.exec(content)?.[1] ?? null;
    }
    const decoder = decoderFor(charset);
    if (decoder !== null) return decoder;
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
    const declared = prescanCharset(bytes);
    // A document that declares UTF-16 in an ASCII-compatible prefix is not
    // UTF-16 at all; the HTML standard reads such a declaration as UTF-8.
    decoder = declared?.encoding.startsWith("utf-16") ? null : declared;
  }
  return (decoder ?? new TextDecoder("utf-8")).decode(bytes);
}

export function isHTMLDocumentResponse(response: Response): boolean {
  return (
    response.status === 200 &&
    response.body !== null &&
    HTML_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")
  );
}

export async function readHTMLDocument(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  let source = response;
  if (signal && response.body) {
    source = new Response(response.body.pipeThrough(new TransformStream(), { signal }));
  }
  return decodeGuest(
    new Uint8Array(await source.arrayBuffer()),
    response.headers.get("content-type") ?? "",
  );
}
