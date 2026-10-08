import { rewriteStyleAttribute } from "./css.js";

export const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

const URL_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  area: ["href"],
  audio: ["src"],
  base: ["href"],
  blockquote: ["cite"],
  button: ["formaction"],
  del: ["cite"],
  embed: ["src"],
  form: ["action"],
  iframe: ["src"],
  img: ["src"],
  input: ["src", "formaction"],
  ins: ["cite"],
  link: ["href"],
  object: ["data"],
  q: ["cite"],
  script: ["src"],
  source: ["src"],
  track: ["src"],
  video: ["src", "poster"],
};

// `a` is here for the browser's own link affordances (open in new tab, drag, copy
// link address), which read the physical href against the host document's base.
const SVG_EXTERNAL_RESOURCE_ELEMENTS = new Set(["a", "feImage", "image", "use"]);

export interface AssetElement {
  localName: string;
  namespaceURI: string | null;
}

/** SVG fragment resources belong to the rendered tree, not the guest URL. */
function resolveAssetURL(element: AssetElement, value: string, baseURL: string): string {
  if (
    element.namespaceURI === SVG_NAMESPACE &&
    element.localName !== "a" &&
    value.trimStart().startsWith("#")
  )
    return value;
  return URL.parse(value, baseURL)?.href ?? value;
}

export function isASCIIWhitespace(character: string | undefined): boolean {
  return (
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r" ||
    character === " "
  );
}

/**
 * The one decision for how an authored attribute becomes a rebased asset
 * reference: `style` values, srcset candidates and URL attributes. Returns null
 * when the attribute must stay as authored. Rebasing `style` can throw on input
 * the CSS parser rejects; each caller decides what that costs the attribute.
 */
export function rewriteAssetAttribute(
  element: AssetElement,
  attributeName: string,
  attributeNamespace: string | null,
  value: string,
  baseURL: string,
): string | null {
  let rewritten: string;
  if (attributeNamespace === null && attributeName.toLowerCase() === "style") {
    rewritten = rewriteStyleAttribute(value, baseURL);
  } else if (isSrcsetAttribute(element, attributeName, attributeNamespace)) {
    rewritten = absolutizeSrcset(value, baseURL);
  } else if (isURLAttribute(element, attributeName, attributeNamespace)) {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.toLowerCase().startsWith("javascript:")) {
      return null;
    }
    rewritten = resolveAssetURL(element, value, baseURL);
  } else {
    return null;
  }
  return rewritten === value ? null : rewritten;
}

function absolutizeSrcset(source: string, baseURL: string): string {
  const candidates: string[] = [];
  let position = 0;

  while (position < source.length) {
    while (
      position < source.length &&
      (source[position] === "," || isASCIIWhitespace(source[position]))
    ) {
      position += 1;
    }
    if (position >= source.length) {
      break;
    }

    const referenceStart = position;
    while (position < source.length && !isASCIIWhitespace(source[position])) {
      position += 1;
    }
    let reference = source.slice(referenceStart, position);
    let descriptor = "";

    const trailingCommas = reference.match(/,+$/)?.[0].length ?? 0;
    if (trailingCommas > 0) {
      reference = reference.slice(0, -trailingCommas);
    } else {
      while (position < source.length && isASCIIWhitespace(source[position])) {
        position += 1;
      }
      const descriptorStart = position;
      let parentheses = 0;
      while (position < source.length) {
        const character = source[position];
        if (character === "(") {
          parentheses += 1;
        } else if (character === ")" && parentheses > 0) {
          parentheses -= 1;
        } else if (character === "," && parentheses === 0) {
          break;
        }
        position += 1;
      }
      descriptor = source.slice(descriptorStart, position).trim();
    }

    if (position < source.length && source[position] === ",") {
      position += 1;
    }
    if (reference === "") {
      continue;
    }

    const resolvedReference = URL.parse(reference, baseURL);
    if (resolvedReference !== null) {
      reference = resolvedReference.href;
    }
    candidates.push(descriptor === "" ? reference : `${reference} ${descriptor}`);
  }

  return candidates.join(", ");
}

export function isSrcsetAttribute(
  element: AssetElement,
  attributeName: string,
  namespaceURI: string | null = null,
): boolean {
  return (
    element.namespaceURI === HTML_NAMESPACE &&
    namespaceURI === null &&
    (((element.localName === "img" || element.localName === "source") &&
      attributeName.toLowerCase() === "srcset") ||
      // <link rel=preload as=image> carries its candidates in imagesrcset.
      (element.localName === "link" && attributeName.toLowerCase() === "imagesrcset"))
  );
}

export function isURLAttribute(
  element: AssetElement,
  attributeName: string,
  namespaceURI: string | null = null,
): boolean {
  if (element.namespaceURI === HTML_NAMESPACE && namespaceURI === null) {
    const names = URL_ATTRIBUTES[element.localName];
    return names?.includes(attributeName.toLowerCase()) ?? false;
  }

  if (
    element.namespaceURI !== SVG_NAMESPACE ||
    !SVG_EXTERNAL_RESOURCE_ELEMENTS.has(element.localName)
  ) {
    return false;
  }

  if (namespaceURI === XLINK_NAMESPACE) {
    return attributeName.toLowerCase() === "href";
  }

  return namespaceURI === null && attributeName.toLowerCase() === "href";
}
