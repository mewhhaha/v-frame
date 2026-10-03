# Navigation

A `v-frame` guest navigates like a top-level page: its links work, its `GET`
forms submit, its History and Navigation API calls change its own URL, and
`location.href` and `document.URL` report that URL back. What differs is _whose_
session the guest is moving through, and that is the `navigation` attribute.

## Guest-owned routing (the default)

```html
<v-frame src="/applications/orders/"></v-frame>
```

Links, `GET` forms, `window.open(…, "_self")`, History methods, and `location`
changes all stay inside the frame. The guest gets its own history session,
independent of the host page's; the host page's URL never changes. A guest SPA
uses the Navigation API exactly as it would standalone:

```ts
navigation.addEventListener("navigate", (event) => {
  if (!event.canIntercept) return;

  event.intercept({
    handler: () => renderRoute(event.destination.url),
  });
});
```

`GET` forms use native URL-encoded submission rules, including CRLF line endings
in field names, values, and filenames. A `method="dialog"` form does not navigate:
it retains the native dialog-closing action, including when called through
`form.submit()`.

Synthetic mouse clicks are routed regardless of which window constructed the
event. Synthetic `submit` events only notify listeners; use `requestSubmit()`
(which validates and emits a submit event) or `submit()` to submit a form.

Navigation to a different document — a link the guest's own router does not
intercept — refetches through `src`'s origin and swaps the guest's document
without touching the host page.

Fragment navigation updates the guest's `:target` state for stylesheets and DOM
selector APIs before its `popstate` and `hashchange` handlers run. Initial
document fragments and back/forward traversal select the target too; ordinary
`pushState` and `replaceState` calls leave the existing target unchanged, as in
a native document. IDs take precedence over named HTML anchors. A fragment of
`top`, case-insensitively, scrolls to the top only when no matching element exists.
Initial fragments in fetched documents and subsequent fragment navigations
scroll the rendered guest, not the host page. Scrolling occurs before
`hashchange`; back/forward keeps the saved per-entry scroll position instead.
SSR adoption preserves the preview's viewport rather than scrolling it at
activation; see [Server-rendered adoption](./ssr.md).

Same-origin HTTP download links keep their native browser action: an
`<a download>` saves the file without replacing the guest or adding a history
entry. Guest click listeners can cancel the download with `preventDefault()`.
Downloads are not route changes and do not emit `v-frame-navigate` or
`v-frame-navigated`. Cross-origin and non-HTTP links retain the restrictions
described in [Limitations](./limitations.md).

Guest history saves the frame's horizontal and vertical scroll positions per
entry. Back and forward restore them when that entry's
`history.scrollRestoration` is `"auto"`, the default. Setting it to `"manual"`
leaves scrolling to the guest router; new same-document entries inherit that
setting. A replacement document is restored before its first visible paint.

## Shell-owned routing

```html
<v-frame adopt navigation="host" src="/applications/orders/">
  <template shadowrootmode="open"><!-- materialized preview --></template>
</v-frame>
```

In host mode, the guest's history _is_ the shell's history. A guest navigation
is promoted to a host page navigation, so the address bar follows the guest, the
browser's own back button traverses it, and a deep link to the shell restores the
guest's route.

`v-frame` follows the shell by observing the host page's `navigation` object. It
never patches the host's `history.pushState` or `history.replaceState`, so a
shell router that wraps those itself keeps working, and both observers fire in
the order the shell installed them. That is asserted by
[`tests/imperative-navigation.spec.ts`](../tests/imperative-navigation.spec.ts),
which mounts a host-mode frame underneath a host that has already wrapped
`pushState`.

The Navigation API on the host page is therefore a hard requirement of the
runtime, not just of host mode.

## Watching the guest move

Two events, before and after. Both bubble and are composed.

`v-frame-navigate` fires **before** the guest moves and is cancelable:

```ts
frame.addEventListener("v-frame-navigate", (event) => {
  const destination = new URL(event.detail.to);
  if (destination.pathname.startsWith("/admin/")) {
    event.preventDefault();
  }
});
```

It carries `{ from, to, kind, state }`. It is cancelable for the default link,
form, fragment, and window actions, and for every navigation the host starts.
The single exception is traversal in host mode: the shell performs it and cannot
take it back.

`v-frame-navigated` fires **after** the guest URL has changed, and is not
cancelable:

```ts
frame.addEventListener("v-frame-navigated", (event) => {
  render({
    url: event.detail.to,
    canGoBack: frame.canGoBack,
    canGoForward: frame.canGoForward,
  });
});
```

It carries `{ from, to, kind }`. Because the URL is already the new one,
`currentURL`, `canGoBack`, and `canGoForward` are all readable from inside the
listener — which is what a host breadcrumb or back button needs. It covers every
way the URL can change, including ones the host did not start: guest
`pushState`, guest `replaceState`, fragment navigation, traversal, and document
navigation (fired once the replacement document is live).

What it reports is a move through the session, not a change of the URL string.
Pushing the route the guest is already on grows the session and flips
`canGoBack`, so it fires with `from === to`; replacing that same route moves
nothing and stays silent.

`kind` on both events is one of `"link"`, `"form"`, `"window"`, `"push"`,
`"replace"`, `"traverse"`, or `"fragment"`.

## Moving the guest from the host

```ts
await frame.navigate("/applications/orders/research");
await frame.navigate("/applications/orders/", { replace: true });

if (frame.canGoBack) {
  await frame.back();
}

await frame.forward();
await frame.go(-2);
```

`navigate()` is a **same-document** navigation. The guest's URL changes and it
receives a `popstate` — which is what a client-side router listens for — and its
document is not refetched. Use `src` or `reload()` when the document itself
should be replaced.
Changing only its fragment also scrolls the guest to the target, as a fragment
link would. Ordinary `pushState`/`replaceState` calls do not scroll.

Routes resolve against `currentURL` and must share the host origin. In host mode
these methods drive the shell's history and the guest follows it, so the host
page's URL changes too.

`back()`, `forward()`, and `go(delta)` traverse the guest session.
Non-integer deltas are truncated, and `go(0)` resolves without doing anything.
Traversal past either end of the session is a no-op, exactly as `history.go()`
is — read `canGoBack` and `canGoForward` first if you need to know.

They resolve once the traversal has been applied, so `currentURL`, `canGoBack`,
and `canGoForward` already report the new entry when the promise settles, and
`v-frame-navigated` has already fired. A cross-document traversal waits for the
replacement guest to load; it rejects with the load error on failure, or an
`AbortError` if disconnected or superseded before activation. That holds in host mode too, where the
shell performs the traversal asynchronously and the frame waits for it. The
session traversed there is the one the shell's `navigation.entries()` reports —
the same list `canGoBack` and `canGoForward` answer from — so a step that would
leave the shell's own entries does nothing.

### How they fail

Every one of these methods returns a `Promise<void>` and rejects rather than
throwing synchronously.

| Rejection           | When                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `AbortError`        | A `v-frame-navigate` listener called `preventDefault()`, or a cross-document traversal was superseded or disconnected. |
| `TypeError`         | The route is cross-origin, or its scheme is not `http:`/`https:`.                                                      |
| `InvalidStateError` | There is no live guest to move — the element is idle, disconnected, or still loading its first document.               |

```text
AbortError: v-frame navigation to https://host.example/documents/denied was canceled
TypeError: v-frame route https://elsewhere.example/route must share host origin https://host.example
TypeError: v-frame route "mailto:someone@example.com" must use http: or https:, received mailto:
InvalidStateError: v-frame cannot navigate without an active guest
```

A canceled traversal names the entry it was aiming at, not the one the guest is
still sitting on, so a host logging the message learns which route was blocked.

Traversal in host mode is the exception to the first row: the shell has already
performed it by the time `v-frame` sees it, so it cannot be canceled.

A freshly mounted frame has no guest until `v-frame-load` fires — its first
realm is still in flight — so these methods reject with `InvalidStateError`
until then. Wait for the event, or assign `src` and let the load carry the
route:

```ts
frame.addEventListener("v-frame-load", () => frame.navigate("/orders/open"), {
  once: true,
});
```

## Replacing the document

```ts
await frame.reload();
```

`reload()` refetches the current guest URL. The current content stays visible
until its replacement is ready; a failed reload restores the current guest,
emits a nonfatal `v-frame-error`, and rejects with the same error — see
[API](./api.md#element-methods) for how it settles in every case. Assigning
`src` does the same thing for a different URL, and discards the guest's history
session once the replacement activates. A failed assignment leaves the current
guest and its history intact and emits a nonfatal `v-frame-error`.

## What does not navigate

Link and form targets other than `_self` and `_blank`, and any scheme that is
not `http:` or `https:`, are reported through `v-frame-navigate` and then
dropped; non-`GET` navigation form submission is reported as a nonfatal
`v-frame-error`. Dialog forms close natively without navigation events or errors.
[Limitations](./limitations.md) explains why and what to do instead.
