import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "v-frame": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        adopt?: boolean;
        src?: string;
      };
    }
  }
}
