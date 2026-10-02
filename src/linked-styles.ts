/** A rewritten stylesheet renders beside its inert, still-live authored link. */
export interface LinkedStyle {
  style: HTMLStyleElement;
  href: string;
  url: string;
  disabled: boolean;
}
