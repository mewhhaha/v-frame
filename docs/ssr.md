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
are restored without scrolling the host page. Control restoration follows the
original connected control, or an unambiguous matching ID/name if the framework
replaces it; it never assigns a removed control's state to a shifted neighbour.
Buttons and other focusable elements follow the same original-element identity;
replacing an unkeyed element never transfers focus to an unrelated sibling.
Selected options follow their original elements, or an unambiguous matching
ID/value after replacement. Reordered options keep their selections, while
removed or ambiguous choices are not assigned to neighbouring options.
A handoff waits for an observed IME composition to finish rather than replacing
its focused control mid-edit.
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
  Fragment-only SVG resource references such as `<use href="#icon">` stay local
  to the rendered shadow tree, including after attribute changes and navigation.
- Scripts become parser-inert while preserving their original type.
- The initial fragment target is marked so `:target` styling is present in the
  preview and remains unchanged at activation. The guest's public document URL
  must include the intended fragment; HTTP requests do not carry browser fragments.
- The materialized document receives the same frame containment and shell display
  rules used at activation, preventing margin-collapse shifts at handoff.

Fragment target styling does not position the SSR viewport. The host owns the
preview's initial scroll position; activation preserves it, including any
scrolling before registration. Automatically scrolling to a deep fragment at
handoff would visibly jump an already-painted preview. Subsequent guest
fragment navigations scroll normally.

`@mewhhaha/v-frame/server` ships this transformation. `materializeVFrameDocument`
drives an `HTMLRewriter` (Cloudflare Workers, Bun, or any port that transforms a
`Response`): it takes a normal `Response` and the guest's public URL and resolves
to a `Response`. Where the runtime has no global `HTMLRewriter`, pass one as
`options.HTMLRewriter`; without either it throws a `TypeError` naming that option.

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
const materializedResponse = await materializeVFrameDocument(
  guestResponse,
  guestURL.href,
  {
    onFontFace: (css) => {
      fonts.add(css);
    },
  },
);
// Consume the response before reading fonts: materialization is asynchronous.
const guestMarkup = await materializedResponse.text();
const fontStyle = fonts.size ? `<style>${[...fonts].join("\n")}</style>` : "";
// Put fontStyle in the host head, then guestMarkup inside the frame's DSD template.
```

Only a `200` response whose `content-type` is `text/html` is transformed. Any
other response (a redirect, `204`, `206`, `304`, an error page, JSON) is returned
as it came, so check `response.ok` first as above rather than embedding it. A
transformed response keeps its status and headers except those that describe the
guest's bytes: `content-length`, `content-encoding`, `content-range`,
`accept-ranges`, `etag`, `last-modified`, `content-md5`, `digest`,
`content-digest` and `repr-digest` are removed, and `content-type` becomes
`text/html; charset=utf-8`.

The guest may be in any encoding the platform's `TextDecoder` knows. The bytes
are decoded once, by the HTML sniffing order this adapter supports: a byte order
mark, then the `charset` of the `content-type` header, then a `<meta charset>` or
`<meta http-equiv="content-type">` in the first 1024 bytes, then UTF-8 (a
`<meta>` that names UTF-16 is read as UTF-8, as the HTML standard does). The
output is always UTF-8, so a `<meta charset>` or `http-equiv` declaration in the
guest is rewritten to say so rather than contradict the bytes.

What is buffered and what streams: the guest document is read in full before
anything is returned, because a `<base>` applies to the whole document and the
fragment target is chosen across all of it. The rewritten output then streams:
the returned body is pulled on demand, so a slow reader slows the rewriter.

Stylesheet work starts as soon as the document has been read, before the first
byte is returned: every `<link rel~=stylesheet>` and every `<style>` is
materialized concurrently, and so are the `@import`s of one sheet. The output
then waits on each sheet only where it reaches it, so the slowest sheet, not the
sum of all of them, delays the bytes after it. Duplicate URLs are fetched once.

Cancelling the response aborts the work in flight. The default `fetch` is
aborted, and a custom `fetchText` receives the same signal as its second
argument, `fetchText(url, { signal })`; honour it to stop your own request. An
aborted materialization reports nothing to `onImportFailure`, since the failures
are the cancellation itself.

A third argument configures the stylesheet stage: `fetchText` overrides how a
linked stylesheet or `@import` target is fetched (useful when the sheet lives behind an
internal service binding). It can return CSS text, or `{ text, url }` to retain
the final response URL after redirects so nested imports and assets resolve
relative to that stylesheet. `onFontFace(css)` receives rewritten, HTML-safe font
declarations. Put the collected CSS in a host `<style>` before the frame: browsers
do not consistently register `@font-face` rules inside shadow trees. Use
application-specific font-family names to avoid conflicts between guests. This
host step is required for webfont fidelity before JavaScript; it is not necessary
for system fonts.

`onImportFailure` observes every stylesheet the preview could not materialize,
and recovery is the same for each: a failed `@import` is dropped from its sheet;
a linked sheet that cannot be fetched or parsed stays neutralized with no preview
style beside it, and the runtime fetches it at activation; an inline `<style>`
that cannot be materialized stays as authored and, because the server marks only
the styles it did materialize (`data-v-frame-materialized`), the runtime rewrites
every unmarked one at activation. A failure never errors the stream.

An alternate stylesheet (`rel="alternate stylesheet"`) is previewed with
`media="not all"`, like a `disabled` link, because a browser does not apply it
until the guest selects it.

The `<base>` is the first `base[href]` outside template contents in the HTML
namespace, wherever the parser would put it, so a guest without explicit `<html>`
or `<head>` tags is read the same way the runtime reads it. A late base therefore
cannot change URLs at handoff.

### On another runtime

The `HTMLRewriter` adapter needs a lol-html style `Response` transformer. A host
without one (Node, Deno) points its own streaming HTML parser at the
runtime-neutral decisions exported from the same entry:

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

The complete export list, which [the API reference](./api.md#server-entry) defers
to, is:

| Export                                                                                                                                                                                                                                                                                                                                                        | Kind      | Purpose                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `materializeVFrameDocument(response, documentURL, options?)`                                                                                                                                                                                                                                                                                                  | adapter   | The `HTMLRewriter` transform above. Options: the stylesheet options plus `HTMLRewriter`. |
| `fragmentIdentifiers(documentURL)`, `fragmentTargetRank(element, identifiers)`                                                                                                                                                                                                                                                                                | fragment  | Select the initial `:target` element for a custom materializer.                          |
| `FRAGMENT_TARGET_ATTRIBUTE`                                                                                                                                                                                                                                                                                                                                   | constant  | The reserved marker set on that element.                                                 |
| `escapeStylesheetText(source)`                                                                                                                                                                                                                                                                                                                                | core      | The `</style` escape on its own.                                                         |
| `INERT_SCRIPT_TYPE`, `SCRIPT_MARKER_ATTRIBUTE`, `SCRIPT_TYPE_ATTRIBUTE`, `SSR_LINK_REL`, `SSR_LINK_STYLE`, `SSR_LINK_SOURCE`, `SSR_STYLE`, `NEUTRALIZED_STYLESHEET_REL`, `SHELL_DISPLAY_STYLE`                                                                                                                                                                | constants | The wire format between materializer and runtime.                                        |
| `createStylesheetContext(fetchText, onImportFailure?, signal?)`, `rewriteStylesheet(source, url, ctx)`                                                                                                                                                                                                                                                        | CSS       | The pure stylesheet rewriter the browser runtime also uses.                              |
| Types: `HTMLRewriterConstructor`, `MaterializeDocumentOptions`, `MaterializeStylesheetOptions`, `AttributeAssignment`, `AssetElementAttributes`, `ScriptElementAttributes`, `ScriptElementRewrite`, `ShellElementRewrite`, `FragmentElement`, `StylesheetContext`, `StylesheetFetch`, `StylesheetFetchOptions`, `StylesheetImportFailure`, `StylesheetSource` | types     | Shapes of the above.                                                                     |

#### Linked stylesheets on the wire

A host with its own parser must produce the same markup the adapter does for a
`<link rel~=stylesheet href>`, or the runtime cannot adopt it. For each such link,
after rebasing its `href` and fetching and materializing the sheet:

1. Set `SSR_LINK_REL` (`data-v-frame-rel`) on the link to its authored `rel`, then
   set `rel` to `NEUTRALIZED_STYLESHEET_REL` (`v-frame-stylesheet`). Do this even
   when the fetch fails: a live link would load against the host page. The
   runtime restores `rel`, and fetches the sheet itself if no preview follows.
2. On success, insert immediately after the link a
   `<style data-v-frame-source="FINAL_URL" data-v-frame-linked="" media="MEDIA">CSS</style>`:
   `SSR_LINK_SOURCE` carries the response URL after redirects (nested URLs
   already resolve against it), `SSR_LINK_STYLE` marks the preview, `media` is the
   link's (use `not all` when the link has `disabled` or is an alternate sheet),
   and `nonce` and `title` are copied across. The CSS is `materializeStylesheet`
   output, which is already `</style`-escaped. Attribute values must be
   HTML-escaped.
3. Every other `<style>` the host materialized gets the `SSR_STYLE`
   (`data-v-frame-materialized`) attribute, including the `SHELL_DISPLAY_STYLE`
   element, which already carries it. A `<style>` that failed to materialize is
   left unmarked, and a guest-authored marker must be removed first, so the
   runtime rewrites it at activation.

For a host that only needs the CSS half, `rewriteStylesheet` and
`createStylesheetContext` are exported too — they are the same pure functions the
browser runtime uses.

Custom materializers also use `fragmentIdentifiers(documentURL)` and
`fragmentTargetRank(element, identifiers)` to select the first lowest-ranked
target outside template contents, then set `FRAGMENT_TARGET_ATTRIBUTE` to an
empty string on that element. Other elements must not carry that reserved
runtime marker. The element reader provides `localName`, `namespaceURI`, and
`getAttribute`; the rank is `Infinity` for a non-target. This keeps rewritten
`:target` rules correct before JavaScript runs.

Do not transform HTML with regular expressions.

The runtime reuses server-materialized linked CSS rather than refetching it at
activation. Images and fonts still obey normal browser loading and `font-display`
rules: reserve image dimensions and choose an appropriate font fallback or preload
when late network assets must not shift the layout. An asset that has not arrived
cannot be guaranteed visible in the first paint. Activation preserves the painted
preview while eager, already-loading, or visible images and fonts settle, with a
maximum resource wait of ten seconds. Unloaded off-screen lazy images do not block
activation and keep their lazy-loading behavior after handoff. Failed or stalled
assets do not indefinitely block the guest.

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
