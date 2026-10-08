import type {
  VFrameCredentials,
  VFrameElement,
  VFrameNavigation,
} from "@mewhhaha/v-frame";

// v-frame's own types do not augment any global map (JSR forbids global
// augmentation in a published package), and React's JSX types know nothing about
// custom elements, so the custom element needs its own JSX.IntrinsicElements
// entry here. React 19's types stopped shipping a global `JSX` namespace in favor of
// one exported from the "react" module itself, so the augmentation target is
// this module, not `declare global`.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "v-frame": DetailedHTMLProps<HTMLAttributes<VFrameElement>, VFrameElement> & {
        src?: string;
        credentials?: VFrameCredentials;
        navigation?: VFrameNavigation;
        nonce?: string;
        "trusted-types-policy"?: string;
      };
    }
  }
}
