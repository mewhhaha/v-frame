import { fragmentIdentifiers } from "../fragment.js";

/** Native scrolling honors nested scrollports and CSS scroll margins/padding. */
export function scrollToFragment(
  host: HTMLElement,
  target: Element | null,
  url: string,
): void {
  if (!target) {
    const identifiers = fragmentIdentifiers(url);
    if (identifiers.length === 0 || identifiers.at(-1)!.toLowerCase() === "top") {
      host.scrollTo({ left: 0, top: 0, behavior: "instant" });
    }
    return;
  }

  // scrollIntoView also scrolls ancestors outside the frame. Preserve those
  // synchronously so only the guest's scrollports move, without an outer-page
  // jump or a smooth-scroll animation continuing after the restore.
  const ancestors: Array<{ element: Element; left: number; top: number }> = [];
  for (let node: Node | null = host.parentNode; node !== null;) {
    if (node.nodeType === 1) {
      const element = node as Element;
      ancestors.push({ element, left: element.scrollLeft, top: element.scrollTop });
    }
    node = node.parentNode ?? (node.nodeType === 11 ? (node as ShadowRoot).host : null);
  }
  target.scrollIntoView({ behavior: "instant", block: "start", inline: "nearest" });
  for (const { element, left, top } of ancestors) {
    if (element.scrollLeft !== left || element.scrollTop !== top) {
      element.scrollTo({ left, top, behavior: "instant" });
    }
  }
}
