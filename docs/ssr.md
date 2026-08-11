# Server-rendered adoption

The recommended production path. The host server renders the guest into its own
HTML response, inside Declarative Shadow DOM that a `<v-frame adopt>` activates
in place. The guest is visible in the first paint and its scripts start without
a second document request.

SSR has two participants and a clean boundary between them:

1. The guest server returns its ordinary HTML document.
2. The host server _materializes_ that document and places it inside an adopting
   `<v-frame>`.

The browser displays the Declarative Shadow DOM immediately. When
`@mewhhaha/v-frame/register` loads, the element starts the guest's scripts and replaces the
preview with the activated tree in one synchronous handoff. It does not refetch
the entry document.

## 1. Return a normal guest document

The guest does not need a `v-frame` response format. Render the same document it
serves when it runs standalone or loads through `src`:

```tsx
import { renderToString } from "react-dom/server";
import { OrdersApp } from "./OrdersApp.js";

export function renderOrdersDocument(): string {
  const applicationMarkup = renderToString(<OrdersApp />);

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <style>
          :root { color-scheme: light; }
          html, body { margin: 0; }
          .orders-app { color: #18181b; }
        </style>
      </head>
      <body>
        <div id="orders-root">${applicationMarkup}</div>
        <script type="module" src="/applications/orders/client.js"></script>
      </body>
    </html>
  `;
}
```

There is no separate preview contract: ordinary document selectors, executable
scripts, framework metadata, and document structure are all allowed.

## 2. Materialize at the host boundary

Before inserting the guest response into the host page, the host transforms the
trusted document:

- `html`, `head`, and `body` become `v-html`, `v-head`, and `v-body`.
- Inline stylesheet selectors, imports, and URLs are rewritten for the guest's
  public URL.
- Scripts become parser-inert while preserving their original type.
- The materialized document receives its required display rules.

`@mewhhaha/v-frame/server` ships this transformation. On Cloudflare Workers,
`materializeVFrameDocument` streams it through `HTMLRewriter`; it takes a normal
`Response` and the guest's public URL and returns a `Response`:

```ts
import { materializeVFrameDocument } from "@mewhhaha/v-frame/server";

const guestURL = new URL("/applications/orders/", request.url);
const guestResponse = await ordersService.fetch(
  new Request("https://orders.internal/document"),
);

if (!guestResponse.ok) {
  throw new Error(`orders SSR returned ${guestResponse.status} for ${guestURL.href}`);
}

const materializedResponse = materializeVFrameDocument(guestResponse, guestURL.href);
```

A third argument configures the stylesheet stage: `fetchText` overrides how an
`@import` target is fetched (useful when the imported sheet lives behind an
internal service binding), and `onImportFailure` observes imports that could not
be inlined, which are dropped from the output.

### On another runtime

Only the `HTMLRewriter` adapter is runtime-specific, because server HTML
transformation APIs differ. The decisions it drives are runtime-neutral and are
exported from the same entry, so a host on Node, Deno, or Bun points its own
streaming HTML parser at them:

| Export                                                 | Called with                                           | Returns                                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rewriteShellElement(tagName)`                         | Every element's tag name                              | `{ tagName, prependHTML }`, or `null` for elements that are not `html`/`head`/`body`. `prependHTML` is the display-rule `<style>` that must go first inside `v-head`. |
| `rewriteScriptElement(script)`                         | Every `<script>`, given `getAttribute`/`hasAttribute` | `{ removeAttributes, setAttributes }`, or `null` if the script is already materialized.                                                                               |
| `materializeStylesheet(source, documentURL, options?)` | The full text of every `<style>`                      | The rewritten, `</style`-escaped text to write back.                                                                                                                  |

`rewriteScriptElement` returning `null` for an already-materialized script
matters: materializing twice would record `application/vnd.v-frame` as the
script's authored type and leave the guest with a script the runtime could never
restore.

For a host that only needs the CSS half, `rewriteStylesheet` and
`createStylesheetContext` are exported too — they are the same pure functions the
browser runtime uses.

Do not transform HTML with regular expressions.

For first-paint fidelity, the adapter expects critical CSS to be inline and
markup asset URLs to be root-relative or absolute. Linked stylesheets and
relative markup URLs work after activation, but the adapter does not rebase
markup attributes, so they need additional host-side rebasing to be correct in
the inert server preview.

## 3. Compose the host response

Insert the transformed response into Declarative Shadow DOM. The HTML sent to
the browser has this shape:

```html
<v-frame adopt src="/applications/orders/" aria-label="Orders">
  <template shadowrootmode="open">
    <v-html lang="en">
      <v-head>
        <style>
          v-html,
          v-body {
            display: block;
          }
          v-head {
            display: none;
          }
          .orders-app {
            color: #18181b;
          }
        </style>
      </v-head>
      <v-body>
        <div id="orders-root"><!-- guest SSR output --></div>
        <script
          type="application/vnd.v-frame"
          data-v-frame-script
          data-v-frame-type="module"
          src="/applications/orders/client.js"
        ></script>
      </v-body>
    </v-html>
  </template>
</v-frame>
```

The host owns this wrapper; the guest does not produce it. Treat the transformed
document as executable application content and only compose responses from a
trusted guest service.

The host page also loads the registration entry:

```ts
import "@mewhhaha/v-frame/register";
```

Declarative Shadow DOM renders before that module finishes loading, so the server
preview remains useful even when the browser bundle is deferred.

## 4. Hydrate or resume normally

The guest browser bundle uses its framework's normal client entry. It can query
the guest document as if it were a regular page:

```tsx
import { hydrateRoot } from "react-dom/client";
import { OrdersApp } from "./OrdersApp.js";

const root = document.getElementById("orders-root");
if (root === null) {
  throw new Error("orders guest is missing #orders-root");
}

hydrateRoot(root, <OrdersApp />);
```

React can hydrate, Qwik can resume, and other frameworks can use their normal
browser startup as long as the client renders the same markup the guest server
placed in the preview.

## 5. Use the same document for `src`

Even adopted frames need `src`. It supplies the guest's URL and base URL during
activation, and it is used by later network loads.

The same ordinary document can serve both host composition and the public `src`
route. The initial adopted activation does not request `src`; reloads,
reconnection, source changes, and guest document navigation use it normally.

The public URL must be same-origin. The host may call the guest through an
internal service address for SSR, but it must give the materializer the public
`src` URL so CSS and assets resolve correctly.

## 6. Verify adoption

Listen for lifecycle events in the host:

```ts
frame.addEventListener("v-frame-load", (event) => {
  console.log("orders ready", event.detail.url);
});

frame.addEventListener("v-frame-error", (event) => {
  console.error("orders failed", event.detail);
});
```

In the browser's network panel, the first activation should not request the URL
in `src`. External guest scripts, stylesheets, images, and API calls still load
normally.

Adoption is consumed once. Calling `reload()`, reconnecting the element, or
changing `src` performs a normal network load.

When something does not line up, see [Troubleshooting](./troubleshooting.md).

## A complete example

[`examples/ssr`](../examples/ssr) is a working server-composed host with React
Router, Qwik, Angular, and SolidStart guests — hydration, resumption, nested
adopted frames, host-owned routing, and network reloads. It imports
`@mewhhaha/v-frame/server` like any other consumer.

```sh
pnpm install
pnpm --filter example-ssr dev
```
