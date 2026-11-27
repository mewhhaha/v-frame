import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "v-frame": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        adopt?: boolean | "eager" | "visible" | "idle" | "interaction";
        src?: string;
        credentials?: "omit" | "same-origin" | "include";
        navigation?: "guest" | "host";
        nonce?: string;
        "trusted-types-policy"?: string;
        "form-action"?: string;
        "lazy-attributes"?: boolean;
        "lazy-events"?: boolean;
        "preload-scripts"?: boolean | string;
        "content-visibility"?: string;
      };
    }
  }
}
