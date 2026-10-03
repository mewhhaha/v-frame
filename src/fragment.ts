import { HTML_NAMESPACE } from "./asset-urls.js";

export const FRAGMENT_TARGET_ATTRIBUTE = "data-v-frame-target";

export interface FragmentElement {
  readonly localName: string;
  readonly namespaceURI: string | null;
  getAttribute(name: string): string | null;
}

export function fragmentIdentifiers(url: string): string[] {
  const encoded = new URL(url).hash.slice(1);
  if (encoded === "") return [];
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded === encoded ? [encoded] : [encoded, decoded];
  } catch {
    return [encoded];
  }
}

/** Raw fragments precede decoded ones; IDs precede named HTML anchors. */
export function fragmentTargetRank(
  element: FragmentElement,
  identifiers: readonly string[],
): number {
  for (let index = 0; index < identifiers.length; index++) {
    if (element.getAttribute("id") === identifiers[index]) return index * 2;
    if (
      element.namespaceURI === HTML_NAMESPACE &&
      element.localName === "a" &&
      element.getAttribute("name") === identifiers[index]
    )
      return index * 2 + 1;
  }
  return Infinity;
}

export function findFragmentTarget<T extends FragmentElement>(
  elements: Iterable<T>,
  url: string,
): T | null {
  const identifiers = fragmentIdentifiers(url);
  let target: T | null = null;
  let bestRank = Infinity;
  for (const element of elements) {
    const rank = fragmentTargetRank(element, identifiers);
    if (rank < bestRank) {
      target = element;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  return target;
}
