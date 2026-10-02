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

Edits to preview form controls are preserved before guest scripts start and
again at handoff, including changes made while those scripts are delayed.
Edited controls receive synthetic input/change notifications so client-side
form state can catch up. Focus, control text selection, and scroll positions
are restored without scrolling the host page. A handoff waits for an observed
IME composition to finish rather than replacing its focused control mid-edit.
These notifications preserve the latest edit; they do not replay arbitrary
button clicks, submissions, or trusted user activation.

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
- Inline and linked stylesheet selectors, imports, and URLs are rewritten for
  the guest's public URL. Linked sheets are fetched on the server and rendered
  beside their inert original links, preserving stylesheet order and media.
- Markup URLs, `srcset` candidates, and inline-style URLs are rebased for the
  preview. Authored attribute values remain available to guest code at activation.
- Scripts become parser-inert while preserving their original type.
- The materialized document receives the same frame containment and shell display
  rules used at activation, preventing margin-collapse shifts at handoff.

`@mewhhaha/v-frame/server` ships this transformation. On Cloudflare Workers,
`materializeVFrameDocument` parses it through `HTMLRewriter`; it takes a normal
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

const fonts = new Set<string>();
const materializedResponse = materializeVFrameDocument(guestResponse, guestURL.href, {
  onFontFace: (css) => {
    fonts.add(css);
  },
});
// Consume the response before reading fonts: materialization is asynchronous.
const guestMarkup = await materializedResponse.text();
const fontStyle = fonts.size ? `<style>${[...fonts].join("\n")}</style>` : "";
// Put fontStyle in the host head, then guestMarkup inside the frame's DSD template.
```

A third argument configures the stylesheet stage: `fetchText` overrides how a
linked stylesheet or `@import` target is fetched (useful when the sheet lives behind an
internal service binding). It can return CSS text, or `{ text, url }` to retain
the final response URL after redirects so nested imports and assets resolve
relative to that stylesheet. `onImportFailure` observes sheets that could not
be inlined, which are dropped from the preview and retried at activation.
`onFontFace(css)` receives rewritten, HTML-safe font declarations. Put the collected
CSS in a host `<style>` before the frame: browsers do not consistently register
`@font-face` rules inside shadow trees. Use application-specific font-family names
to avoid conflicts between guests. This host step is required for webfont fidelity
before JavaScript; it is not necessary for system fonts.
The adapter buffers the guest document to resolve its first valid head `base[href]`
before transforming any assets; a late base therefore cannot change URLs at handoff.

### On another runtime

Only the `HTMLRewriter` adapter is runtime-specific, because server HTML
transformation APIs differ. The decisions it drives are runtime-neutral and are
exported from the same entry, so a host on Node, Deno, or Bun points its own
streaming HTML parser at them:

| Export                                                 | Called with                                                | Returns                                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rewriteShellElement(tagName)`                         | Every element's tag name                                   | `{ tagName, prependHTML }`, or `null` for elements that are not `html`/`head`/`body`. `prependHTML` is the display-rule `<style>` that must go first inside `v-head`. |
| `rewriteScriptElement(script)`                         | Every `<script>`, given `getAttribute`/`hasAttribute`      | `{ removeAttributes, setAttributes }`, or `null` if the script is already materialized.                                                                               |
| `rewriteAssetAttributes(element, baseURL)`             | Every element, with its namespace, tag name and attributes | URL/style/srcset assignments plus provenance preserving the authored values. Apply assignments through the HTML parser's attribute API.                               |
| `materializeStylesheet(source, documentURL, options?)` | The full text of every `<style>`                           | The rewritten, `</style`-escaped text to write back.                                                                                                                  |

`rewriteScriptElement` returning `null` for an already-materialized script
matters: materializing twice would record `application/vnd.v-frame` as the
script's authored type and leave the guest with a script the runtime could never
restore.

For a host that only needs the CSS half, `rewriteStylesheet` and
`createStylesheetContext` are exported too — they are the same pure functions the
browser runtime uses.

Do not transform HTML with regular expressions.

The runtime reuses server-materialized linked CSS rather than refetching it at
activation. Images and fonts still obey normal browser loading and `font-display`
rules: reserve image dimensions and choose an appropriate font fallback or preload
when late network assets must not shift the layout. An asset that has not arrived
cannot be guaranteed visible in the first paint. Activation preserves the painted
preview while its corresponding images and fonts settle, with a maximum resource
wait of ten seconds. Failed or stalled assets do not indefinitely block the guest.

## 3. Compose the host response

Insert the transformed response into Declarative Shadow DOM. The HTML sent to
the browser has this shape:

```html
<v-frame adopt src="/applications/orders/" aria-label="Orders">
  <template shadowrootmode="open">
    <v-html lang="en">
      <v-head>
        <style>
          :host {
            contain: layout;
            display: block;
            position: relative;
            overflow: auto;
          }
          v-html,
          v-body {
            display: block;
          }
          v-head {
            display: none !important;
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

If the host uses a nonce-based `style-src` policy, apply its nonce to every
materialized `<style>` before sending the response, including the injected shell
rules and any host font style. Set the same nonce on `<v-frame>` for styles and
scripts generated at activation; it does not retroactively authorize the SSR
preview's styles.

The host page also loads the registration entry:

```ts
import "@mewhhaha/v-frame/register";
```

The registration entry is also safe to import during server rendering: without
a browser custom-element registry it performs no registration. The server
materializer remains available separately from `@mewhhaha/v-frame/server`.

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
