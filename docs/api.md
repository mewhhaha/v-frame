# API reference

Everything `v-frame` exposes to a host page. For the routing story behind the
navigation members, see [Navigation](./navigation.md); for the server-side
materializer, see [SSR](./ssr.md).

## Entries

| Import                       | Contents                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `@mewhhaha/v-frame/register` | Defines `<v-frame>` in a browser custom element registry; safe no-op during SSR.               |
| `@mewhhaha/v-frame`          | `VFrameElement`, `defineVFrame()`, `VFrameStatus`, and the event and option types.             |
| `@mewhhaha/v-frame/server`   | The SSR materializer core, its Cloudflare `HTMLRewriter` adapter, and the stylesheet rewriter. |

```ts
import "@mewhhaha/v-frame/register";
```

```ts
import { defineVFrame, VFrameElement, VFrameStatus } from "@mewhhaha/v-frame";

// Defining explicitly is the same registration, without the import side effect.
defineVFrame();
```

`VFrameElement` carries typed event overloads. Pass it to the DOM query when the
host needs the concrete element API:

```ts
const frame = document.querySelector<VFrameElement>("v-frame");
frame?.addEventListener("v-frame-load", (event) => console.log(event.detail.url));
```

## Guest geometry and outside interactions

Guest rectangles and hit-test coordinates are frame-local. Window viewport sizes
and media queries follow the host page; there is no separate layout viewport.
`document.scrollingElement` is the virtual HTML element and mirrors frame
scrolling. The virtual body keeps its own native scroll and client metrics.

Document listeners receive outside pointer, click, and focus interactions as
synthetic events targeted at the virtual body. This lets guest dismiss layers
close when the user interacts with the host or another frame without exposing
foreign nodes as guest targets. Canceling or stopping these notifications does
not cancel or stop the host's original event. Notifications do not cross the
physical shadow boundary. Guest-origin events retain their ordinary logical
path and remain confined to their frame.

## Configuration

Observed attributes, each with a matching property. Changing `src`,
`credentials`, `navigation`, or `trusted-types-policy` on a connected element
restarts the guest with a fresh network load; changing `nonce` applies to the
next load instead of forcing one.

| Attribute              | Property             | Default         | Purpose                                                                                                                      |
| ---------------------- | -------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src`                  | `src`                | `""`            | Same-origin `http:`/`https:` guest document URL. An empty or missing value keeps the frame idle.                             |
| `adopt`                | `adopt`              | `false`         | Activates the initial Declarative Shadow DOM instead of fetching `src`. Not observed — it is read on connection.             |
| `navigation`           | `navigation`         | `"guest"`       | `"host"` when the shell owns the guest's route.                                                                              |
| `credentials`          | `credentials`        | `"same-origin"` | `"omit"`, `"same-origin"`, or `"include"`. See below.                                                                        |
| `nonce`                | `nonce`              | `""`            | CSP nonce applied to executed scripts and generated styles.                                                                  |
| `trusted-types-policy` | `trustedTypesPolicy` | none            | Name of an identity Trusted Types policy allowed by the host CSP, or a full policy definition assigned through the property. |

Assigning `credentials` a value other than the three above throws a `TypeError`,
as does assigning an empty `trustedTypesPolicy` string.

### What `credentials` means

`credentials` covers the requests **`v-frame` itself makes** — the entry
document and the stylesheets it resolves — and supplies the default mode for
guest requests that do not choose one.

It is **not a security boundary** and does not constrain the guest's own network
calls. The guest shares the host origin, so it can pass any `credentials` to
`fetch()`, set `withCredentials` on an `XMLHttpRequest`, or read
`document.cookie` whenever it likes. Setting `credentials="omit"` on a frame
whose guest you do not trust buys you nothing; do not use it as one.

The one place the setting reaches into guest requests is
`credentials="include"`, which defaults `XMLHttpRequest.withCredentials` to
`true` for requests that never assign it themselves.

## Element properties

Readonly:

| Property        | Value                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------- |
| `status`        | `"idle"`, `"loading"`, `"ready"`, or `"error"`.                                               |
| `currentURL`    | Current guest URL, or `null` without an active guest.                                         |
| `contentWindow` | Guest `Window`, or `null` before creation and after teardown.                                 |
| `canGoBack`     | Whether the guest session has an earlier entry. In host mode, the shell's. `false` when idle. |
| `canGoForward`  | Whether the guest session has a later entry. In host mode, the shell's. `false` when idle.    |

`VFrameStatus` is exported as a value as well, so a host can compare against
`VFrameStatus.Ready` rather than a string literal.

Teardown restores the document and node facades, including on retained documents.
Retained history methods stay inert; an old window does not keep the replaced
guest active. Drop references to old nodes and realms when they are no longer
needed so the browser can collect them.

Each status is also a custom-element state:

```css
v-frame:state(loading) {
  cursor: progress;
}

v-frame:state(error) {
  outline: 2px solid firebrick;
}
```

## Element methods

| Method                             | Effect                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| `navigate(url, { replace })`       | Same-document navigation to another same-origin route.    |
| `back()`, `forward()`, `go(delta)` | Traverses the guest session, resolving once it has moved. |
| `reload()`                         | Reloads the current guest document over the network.      |

All four return a `Promise<void>`. The navigation methods are described in
[Navigation](./navigation.md), including exactly which errors they reject with.
None of those three can run before `v-frame-load`, because the first guest is
not live until then. `reload()` can: on a connected frame with a `src` it starts
a fresh load whether or not a guest is live yet.

`reload()` settles with the load it starts. It resolves when that load succeeds,
and rejects with the same error the frame reports through `v-frame-error` when it
fails: a `TypeError` for a `src` that is not an `http:` or `https:` URL, a
`TypeError` for a cross-origin one, a `TypeError` naming the status for a
response that is not `ok`, and the fetch's own error when the request fails at
the network layer. Reloading a frame whose route 404s therefore rejects.

Two cases resolve without starting a load at all: a disconnected element, and one
with no `src`. Both return the element to `status === "idle"`. A load that a
later one supersedes before it finishes also resolves.

```ts
try {
  await frame.reload();
} catch (error) {
  // The failure the frame reports through `v-frame-error` as well.
}
```

The current content stays visible until its replacement is ready. A reload that
fails with a live guest to fall back on restores it and emits a nonfatal
`v-frame-error`; one that fails without a guest to restore — a frame already in
`status === "error"`, or one reloading before its first guest went live — emits
a fatal `v-frame-error` and leaves the element in `status === "error"`.
`tests/contract.spec.ts` pins how `reload()` itself settles; the fatal and
nonfatal error paths are covered by the lifecycle tests in `tests/v-frame.spec.ts`.

## Events

All events bubble through the host DOM and are composed, so a host can listen on
an ancestor rather than on each frame.

| Event               | Cancelable | Detail                                              |
| ------------------- | ---------- | --------------------------------------------------- |
| `v-frame-loadstart` | no         | `{ url }` for the selected entry URL.               |
| `v-frame-load`      | no         | `{ url }` when the guest is ready.                  |
| `v-frame-error`     | no         | `{ phase, url, error, fatal }`.                     |
| `v-frame-navigate`  | yes        | `{ from, to, kind, state }` before the guest moves. |
| `v-frame-navigated` | no         | `{ from, to, kind }` after the guest URL changed.   |

`kind` is one of `"link"`, `"form"`, `"window"`, `"push"`, `"replace"`,
`"traverse"`, or `"fragment"`.

`v-frame-navigate` is cancelable for the default link, form, fragment, and
window actions, and for every navigation the host starts — the one exception is
traversal in host mode, which the shell performs and cannot take back.

`v-frame-navigated` is the past-tense counterpart: the guest URL is already the
new one when it fires, so `currentURL`, `canGoBack`, and `canGoForward` can be
read directly from the listener. It covers guest-initiated `pushState` and
`replaceState`, fragment navigation, traversal, and document navigation. It
reports a move through the session rather than a change of the URL string, so a
push of the route the guest is already on fires with `from === to`.

Error `phase` is one of `entry`, `bootstrap`, `stylesheet`, `script`, `runtime`,
`navigation`, or `network`. A fatal error ends the current load and moves the
element to `status === "error"`. Nonfatal script, stylesheet, runtime, network,
or replacement-load errors are reported without discarding a working guest —
[Limitations](./limitations.md) lists the cases that deliberately arrive this
way.

## CSP and Trusted Types

Guest execution inherits the host page's Content Security Policy. The fetched
guest document's own CSP and framing headers are not applied as a separate
policy — the guest is not in a separate browsing context, so there is nothing
for them to apply to.

Set `nonce` when the host requires one:

```html
<v-frame nonce="server-generated-nonce" src="/applications/orders/"></v-frame>
```

When the host enforces Trusted Types, allow a policy name in its CSP and put
that name on the frame:

```html
<v-frame trusted-types-policy="orders-frame" src="/applications/orders/"></v-frame>
```

```text
trusted-types orders-frame; require-trusted-types-for 'script'
```

The named policy is an identity policy, intended for a guest that is already
trusted to execute. A host that needs validation or transformation can assign a
full policy definition through the property instead:

```ts
frame.trustedTypesPolicy = {
  name: "orders-frame",
  createHTML: (source) => sanitize(source),
  createScript: (source) => source,
  createScriptURL: (source) => source,
};
```

## Server entry

`@mewhhaha/v-frame/server` is documented in [SSR](./ssr.md). Its exports:

| Export                                                                                            | Kind               | Purpose                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `materializeVFrameDocument(response, documentURL, options?)`                                      | Cloudflare adapter | Streams a guest `Response` through `HTMLRewriter` into adoptable markup.                                         |
| `rewriteShellElement(tagName)`                                                                    | core               | Maps `html`/`head`/`body` to `v-html`/`v-head`/`v-body`, and returns the display rules to prepend into `v-head`. |
| `rewriteScriptElement(script)`                                                                    | core               | Returns the attribute edits that make a guest script parser-inert, or `null` if it already is.                   |
| `materializeStylesheet(source, documentURL, options?)`                                            | core               | Rewrites one inline stylesheet for the guest's public URL and escapes it for a `<style>` element.                |
| `escapeStylesheetText(source)`                                                                    | core               | The `</style` escape on its own.                                                                                 |
| `rewriteStylesheet(source, url, context)`, `createStylesheetContext(fetchText, onImportFailure?)` | CSS                | The runtime-neutral stylesheet rewriter, for a host building its own adapter.                                    |
| `INERT_SCRIPT_TYPE`, `SCRIPT_MARKER_ATTRIBUTE`, `SCRIPT_TYPE_ATTRIBUTE`, `SHELL_DISPLAY_STYLE`    | constants          | The wire format between materializer and runtime.                                                                |
