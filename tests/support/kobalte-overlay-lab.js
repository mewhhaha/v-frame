// The guest module for the Kobalte case in tests/overlays.spec.ts. Components are built
// with Solid's own `createComponent` and lazy `children` getters — which is what Solid's
// JSX compiler emits — so that Rolldown alone can bundle this file. Compiling JSX would
// need Solid's Babel plugin, and that would put a framework build step in front of the
// root suite. Kobalte is the compiled package from npm either way, so the positioning
// engine under test (@floating-ui/dom, through Kobalte's popper) is the real one.
import { Popover } from "@kobalte/core/popover";
import { createComponent, render } from "solid-js/web";

/** Kept in sync with KOBALTE_GUTTER in tests/overlays.spec.ts. */
const GUTTER = 8;

function OverlayLab() {
  return createComponent(Popover, {
    placement: root.dataset.placement ?? "bottom-start",
    gutter: GUTTER,
    // Flipping and sliding would let the middleware move the content away from the
    // anchor, which is the one thing this case has to be able to attribute to v-frame.
    flip: root.dataset.collisions === "true",
    slide: root.dataset.collisions === "true",
    overlap: false,
    modal: root.dataset.modal === "true",
    get children() {
      return [
        createComponent(Popover.Trigger, {
          class: "lab-button",
          "data-testid": "kobalte-trigger",
          children: "Popover",
        }),
        createComponent(Popover.Portal, {
          get children() {
            return createComponent(Popover.Content, {
              class: "overlay-content",
              "data-testid": "kobalte-content",
              get children() {
                const title = createComponent(Popover.Title, {
                  as: "span",
                  children: "Kobalte popover",
                });
                if (root.dataset.interactive !== "true") return title;
                const label = document.createElement("label");
                label.textContent = "Delivery name";
                const input = document.createElement("input");
                label.append(input);
                return [
                  title,
                  label,
                  createComponent(Popover.CloseButton, {
                    "aria-label": "Close popover",
                    children: "Close popover",
                  }),
                ];
              },
            });
          },
        }),
      ];
    },
  });
}

const root = document.querySelector("#kobalte-root");
if (root === null) throw new Error("The Kobalte lab is missing its mount point");
render(() => createComponent(OverlayLab, {}), root);
