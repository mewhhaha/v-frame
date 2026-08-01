# API reference

Everything `v-frame` exposes to a host page. For the routing story behind the
navigation members, see [Navigation](./navigation.md); for the server-side
materializer, see [SSR](./ssr.md).

## Entries

| Import | Contents |
| --- | --- |
| `v-frame/register` | Side-effecting. Defines `<v-frame>` in the custom element registry. |
| `v-frame` | `VFrameElement`, `defineVFrame()`, `VFrameStatus`, and the event and option types. |
| `v-frame/server` | The SSR materializer core, its Cloudflare `HTMLRewriter` adapter, and the stylesheet rewriter. |

```ts
import "v-frame/register";
```

```ts
import { defineVFrame, VFrameElement, VFrameStatus } from "v-frame";

// Defining explicitly is the same registration, without the import side effect.
defineVFrame();
```

`VFrameElement` augments `HTMLElementTagNameMap` and `HTMLElementEventMap`, so
`document.querySelector("v-frame")` and `addEventListener("v-frame-load", …)`
are typed without a cast once the package is imported anywhere in the program.

## Configuration

Observed attributes, each with a matching property. Changing `src`,
`credentials`, `navigation`, or `trusted-types-policy` on a connected element
restarts the guest with a fresh network load; changing `nonce` applies to the
next load instead of forcing one.

| Attribute | Property | Default | Purpose |
| --- | --- | --- | --- |
| `src` | `src` | `""` | Same-origin `http:`/`https:` guest document URL. An empty or missing value keeps the frame idle. |
| `adopt` | `adopt` | `false` | Activates the initial Declarative Shadow DOM instead of fetching `src`. Not observed — it is read on connection. |
| `navigation` | `navigation` | `"guest"` | `"host"` when the shell owns the guest's route. |
| `credentials` | `credentials` | `"same-origin"` | `"omit"`, `"same-origin"`, or `"include"`. See below. |
| `nonce` | `nonce` | `""` | CSP nonce applied to executed scripts and generated styles. |
| `trusted-types-policy` | `trustedTypesPolicy` | none | Name of an identity Trusted Types policy allowed by the host CSP, or a full policy definition assigned through the property. |

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

| Property | Value |
| --- | --- |
| `status` | `"idle"`, `"loading"`, `"ready"`, or `"error"`. |
| `currentURL` | Current guest URL, or `null` without an active guest. |
| `contentWindow` | Guest `Window`, or `null` before creation and after teardown. |
| `canGoBack` | Whether the guest session has an earlier entry. In host mode, the shell's. `false` when idle. |
| `canGoForward` | Whether the guest session has a later entry. In host mode, the shell's. `false` when idle. |

`VFrameStatus` is exported as a value as well, so a host can compare against
`VFrameStatus.Ready` rather than a string literal.

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

| Method | Effect |
| --- | --- |
| `navigate(url, { replace })` | Same-document navigation to another same-origin route. |
| `back()`, `forward()`, `go(delta)` | Traverses the guest session. |
| `reload()` | Reloads the current guest document over the network. |

All four return a `Promise<void>`. The navigation methods are described in
[Navigation](./navigation.md), including exactly which errors they reject with.

```ts
await frame.reload();
```

The current content stays visible until its replacement is ready. A failed
reload restores the current guest and emits a nonfatal `v-frame-error`.

## Events

All events bubble through the host DOM and are composed, so a host can listen on
an ancestor rather than on each frame.

| Event | Cancelable | Detail |
| --- | --- | --- |
| `v-frame-loadstart` | no | `{ url }` for the selected entry URL. |
| `v-frame-load` | no | `{ url }` when the guest is ready. |
| `v-frame-error` | no | `{ phase, url, error, fatal }`. |
| `v-frame-navigate` | yes | `{ from, to, kind, state }` before the guest moves. |
| `v-frame-navigated` | no | `{ from, to, kind }` after the guest URL changed. |

`kind` is one of `"link"`, `"form"`, `"window"`, `"push"`, `"replace"`,
`"traverse"`, or `"fragment"`.

`v-frame-navigate` is cancelable for the default link, form, fragment, and
window actions, and for every navigation the host starts — the one exception is
traversal in host mode, which the shell performs and cannot take back.

`v-frame-navigated` is the past-tense counterpart: the guest URL is already the
new one when it fires, so `currentURL`, `canGoBack`, and `canGoForward` can be
read directly from the listener. It covers guest-initiated `pushState` and
`replaceState`, fragment navigation, traversal, and document navigation.

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
<v-frame
  trusted-types-policy="orders-frame"
  src="/applications/orders/"
></v-frame>
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

`v-frame/server` is documented in [SSR](./ssr.md). Its exports:

| Export | Kind | Purpose |
| --- | --- | --- |
| `materializeVFrameDocument(response, documentURL, options?)` | Cloudflare adapter | Streams a guest `Response` through `HTMLRewriter` into adoptable markup. |
| `rewriteShellElement(tagName)` | core | Maps `html`/`head`/`body` to `v-html`/`v-head`/`v-body`, and returns the display rules to prepend into `v-head`. |
| `rewriteScriptElement(script)` | core | Returns the attribute edits that make a guest script parser-inert, or `null` if it already is. |
| `materializeStylesheet(source, documentURL, options?)` | core | Rewrites one inline stylesheet for the guest's public URL and escapes it for a `<style>` element. |
| `escapeStylesheetText(source)` | core | The `</style` escape on its own. |
| `rewriteStylesheet(source, url, context)`, `createStylesheetContext(fetchText, onImportFailure?)` | CSS | The runtime-neutral stylesheet rewriter, for a host building its own adapter. |
| `INERT_SCRIPT_TYPE`, `SCRIPT_MARKER_ATTRIBUTE`, `SCRIPT_TYPE_ATTRIBUTE`, `SHELL_DISPLAY_STYLE` | constants | The wire format between materializer and runtime. |
