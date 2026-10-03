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

const SVG_EXTERNAL_RESOURCE_ELEMENTS = new Set(["feImage", "image", "use"]);

/** Authored asset values retained while the server preview uses absolute URLs. */
export const SSR_ATTRIBUTES = "data-v-frame-attributes";
export const SSR_LINK_REL = "data-v-frame-rel";
export const SSR_LINK_STYLE = "data-v-frame-linked";

export interface AssetElement {
  localName: string;
  namespaceURI: string | null;
}

/** SVG fragment resources belong to the rendered tree, not the guest URL. */
export function resolveAssetURL(
  element: AssetElement,
  value: string,
  baseURL: string,
): string {
  if (element.namespaceURI === SVG_NAMESPACE && value.trimStart().startsWith("#"))
    return value;
  return URL.parse(value, baseURL)?.href ?? value;
}

function isASCIIWhitespace(character: string | undefined): boolean {
  return (
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r" ||
    character === " "
  );
}

export function absolutizeSrcset(source: string, baseURL: string): string {
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
    (element.localName === "img" || element.localName === "source") &&
    attributeName.toLowerCase() === "srcset"
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
