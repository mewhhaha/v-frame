/** A rewritten stylesheet renders beside its inert, still-live authored link. */
export interface LinkedStyle {
  style: HTMLStyleElement;
  href: string;
  integrity: string;
  url: string;
  disabled: boolean;
}
