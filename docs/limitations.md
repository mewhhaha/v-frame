# Limitations

`v-frame` emulates a document. Emulation is never total, and the places where it
stops are deliberate: the runtime throws rather than silently doing something
other than what the guest asked for.

Everything on this page was read out of the current source and is covered by the
test suite. Each entry says what throws, why it has to, and what to do instead.

| API | Result |
| --- | --- |
| [`document.write` / `writeln` / `open` / `close`](#documentwrite-writeln-open-and-close) | `NotSupportedError` |
| [`document.adoptedStyleSheets`](#documentadoptedstylesheets-and-constructed-stylesheets) | `NotSupportedError` |
| [Direct child mutation of `document`](#direct-child-mutation-of-document) | `NotSupportedError` |
| [CSSOM `@import` rules](#cssom-import-rules) | `NotSupportedError` |
| [Non-`GET` form submission](#non-get-form-submission) | `v-frame-error`, navigation dropped |
| [`target` other than `_self` and `_blank`](#form-and-link-targets-other-than-_self-and-_blank) | Navigation dropped |
| [Non-HTTP link and form schemes](#non-http-link-and-form-schemes) | Navigation dropped |

Beyond the list, three whole-runtime constraints apply: the browser must support
the Navigation API, Declarative Shadow DOM, and custom elements; every guest URL
must be same-origin `http:` or `https:`; and the guest is trusted code, not
sandboxed code. See [the README](../README.md#requirements).

## `document.write`, `writeln`, `open` and `close`

**Throws** a `NotSupportedError` `DOMException` from the guest realm, for all
four methods.

**Why.** The document the guest sees is the realm's own `Document` object with
every tree-shaped property answered from the shell elements — `documentElement`
is `v-html`, `body` is `v-body` — while the nodes themselves are rendered in the
host page's shadow root. `document.write()` is defined in terms of the HTML
parser's insertion point in a real parsed document. There is no such insertion
point here, and `document.open()` would have to discard a tree the host owns.
Implementing them approximately would corrupt the tree in ways that surface much
later than the call.

**Instead.** Use the ordinary node APIs, which are fully supported:
`element.insertAdjacentHTML()`, `element.innerHTML`, `document.createElement()`
plus `append()`. Scripts inserted this way are executed by the runtime with the
same ordering rules a real document applies.

Third-party snippets that still call `document.write` (older ad and analytics
tags) cannot run inside a guest.

## `document.adoptedStyleSheets` and constructed stylesheets

**Throws** a `NotSupportedError` `DOMException` on both read and write.

This is the limitation most likely to bite, because constructed stylesheets are
how a large amount of modern component code ships CSS — `new CSSStyleSheet()`
plus `replaceSync()` is the default output of several component compilers and
the standard pattern in hand-written web components.

**Why.** `adoptedStyleSheets` is a property of a *document or shadow root*, and
the guest has neither of the ones it appears to have. Sheets adopted onto the
realm's `Document` would style the hidden execution realm, which renders
nothing. Forwarding them to the host shadow root that actually renders the guest
is not equivalent either: that shadow root is owned by `v-frame`, which uses its
own `adoptedStyleSheets` slot for the internal top-layer and staging rules
(`src/realm/window-patches.ts`), and — more importantly — a forwarded sheet
would bypass the rewriting every other guest stylesheet goes through, so its
`html`, `body`, and `:root` selectors would never match `v-html` and `v-body`,
and its relative `url()` references would resolve against the host document
instead of the guest's URL.

Constructed stylesheets do not work on shadow roots the *guest itself* creates
either, and that failure comes from the browser rather than from `v-frame`:

```text
NotAllowedError: Failed to set the 'adoptedStyleSheets' property on 'ShadowRoot':
Sharing constructed stylesheets in multiple documents is not allowed
```

A guest node is created in the execution realm but rendered in the host
document, so a `CSSStyleSheet` built from the guest's own `CSSStyleSheet`
constructor belongs to a different document than the shadow root it is being
adopted into.

**Instead.** Ship guest CSS as `<style>` elements, or as `<link
rel="stylesheet">`. Both go through the runtime's stylesheet pipeline, which
rewrites shell selectors and rebases URLs, and both are live: mutating
`style.textContent`, `link.href`, `link.media`, or `link.disabled` re-runs the
pipeline, and `sheet.insertRule()` / `rule.selectorText` / `style.cssText`
through the CSSOM are rewritten in place.

```ts
const style = document.createElement("style");
style.textContent = ":host-ish { color: rebeccapurple; }";
document.head.append(style);
```

For a component library, this usually means selecting its `<style>`-tag CSS
delivery mode rather than its constructed-stylesheet mode.

## Direct child mutation of `document`

**Throws** a `NotSupportedError` `DOMException` from `document.appendChild`,
`insertBefore`, `replaceChild`, `removeChild`, `append`, `prepend`, and
`replaceChildren`.

**Why.** The virtual document's child list is synthesized — a doctype plus the
shell element — and is not the realm document's real child list. Accepting a
mutation would either edit the invisible realm document or desynchronize the
synthesized list from the tree the host renders.

**Instead.** Mutate the elements, which is what real code does anyway:
`document.documentElement`, `document.head`, and `document.body` are all live
and fully mutable.

```ts
document.documentElement.setAttribute("lang", "en");
document.head.append(meta);
document.body.append(root);
```

## CSSOM `@import` rules

**Throws** a `NotSupportedError` `DOMException` from `CSSStyleSheet.insertRule()`
and the legacy `addRule()` when the inserted text is an `@import` rule.

**Why.** Guest CSS is rewritten before the browser ever parses it, and `@import`
is resolved by *fetching and inlining* the imported sheet so the imported rules
get the same selector rewriting and URL rebasing. That fetch is asynchronous;
`insertRule()` is synchronous and must return an index. There is no way to
honour both, so the rule is refused instead of being inserted unrewritten.

**Instead.** `@import` in the source text of a `<style>` element or a linked
stylesheet is fully supported and is inlined for you — this limitation is only
about inserting an `@import` rule through the CSSOM at runtime. If a sheet must
be added dynamically, append another `<style>` or `<link rel="stylesheet">`
element rather than importing from an existing sheet.

## Non-`GET` form submission

**Does not throw in the guest.** The submission is dropped and the host receives
a non-fatal `v-frame-error` whose `phase` is `"navigation"` and whose `error` is
a `NotSupportedError` `DOMException`. The guest stays on its current document
with `status` still `"ready"`. `v-frame-navigate` fires first, so a host that
cancels the navigation suppresses the error too.

**Why.** A guest navigation is a `v-frame` document load, and a document load is
a `fetch()` of the target URL whose result is materialized into the shadow tree.
Reproducing a `POST` navigation faithfully would mean reproducing the whole
navigate algorithm — the request body, resubmission on reload and traversal, the
`beforeunload` interaction, and the browser's own resubmission prompt — on top
of an API that has none of that state.

**Instead.** Submit with `fetch()` from the guest's own script and update the
DOM, which is what a client-rendered application does regardless of `v-frame`.
`GET` forms navigate normally, including through `<base target>`.

## Form and link targets other than `_self` and `_blank`

**Does not throw.** `_self` (or no target) navigates the frame. `_blank` opens a
real new browsing context through `window.open(url, "_blank", "noopener")`, and
for a non-`GET` form reports the `NotSupportedError` above. Every other target —
`_parent`, `_top`, and any named target — reports the destination through the
cancelable `v-frame-navigate` event and is then dropped.

**Why.** `_parent` and `_top` name browsing contexts, and a `v-frame` guest is
not in one: the frame is a subtree of the host page, so honouring `_top` would
mean navigating the host away, which is the shell's decision and not the guest's.
Named targets require a window name registry that does not exist for a guest.

**Instead.** A host that wants those targets to mean something can implement
them itself from the `v-frame-navigate` event, which carries `from`, `to`,
`kind`, and `state`:

```ts
frame.addEventListener("v-frame-navigate", (event) => {
  // Treat what the guest asked for as a request, and route the shell.
  router.navigate(event.detail.to);
});
```

Use `navigation="host"` when the shell should own guest routing outright. See
[Navigation](./navigation.md).

## Non-HTTP link and form schemes

**Does not throw.** A link or form action whose scheme is not `http:` or
`https:` — `mailto:`, `tel:`, `blob:`, a custom protocol handler — reports the
destination through `v-frame-navigate` and is then dropped. The imperative
`frame.navigate()` rejects instead, with a `TypeError`:

```text
TypeError: v-frame route "mailto:someone@example.com" must use http: or https:, received mailto:
```

`frame.navigate()` rejects with a `TypeError` for a cross-origin route as well;
guest URLs must share the host origin.

**Why.** Everything the runtime does with a URL — resolving it against the guest
base, fetching the document, rebasing assets — assumes a fetchable same-origin
HTTP URL. External schemes are not fetchable and their handling belongs to the
host page, which is where the user's window actually is.

**Instead.** Handle them from `v-frame-navigate` in the host:

```ts
frame.addEventListener("v-frame-navigate", (event) => {
  const destination = new URL(event.detail.to);
  if (destination.protocol === "mailto:") {
    location.href = destination.href;
  }
});
```

## What is *not* a limitation

These come up often enough to be worth stating explicitly, because earlier
versions of this runtime did restrict some of them:

- **`XMLHttpRequest` username and password.** `open(method, url, async, user,
  password)` forwards all five arguments to the native implementation. Synchronous
  XHR works too.
- **`credentials`.** The `credentials` attribute applies to the entry document
  and stylesheet requests `v-frame` itself issues, and supplies a default for
  guest requests that do not pick one. It never blocks the guest, which is
  same-origin and can pass any credentials mode it likes. It is not a security
  boundary. See [the API reference](./api.md#configuration).
- **`@import` in stylesheet source.** Supported and inlined; only the CSSOM path
  above is refused.
- **`<link rel="stylesheet">`.** Supported, including `media`, `disabled`, and
  `href` changes at runtime.
- **Guest-created shadow roots.** `attachShadow()` works and the shadow tree is
  tracked by the facade; only *constructed* stylesheets on it are unavailable.
- **Dialogs, popovers, and the top layer.** Supported, including coordinate
  translation back into frame-local space; this is the main thing `v-frame` buys
  over an `<iframe>`. See [`tests/overlays.spec.ts`](../tests/overlays.spec.ts).
- **The Navigation API, History, and `location`.** Fully virtualized. See
  [Navigation](./navigation.md).
