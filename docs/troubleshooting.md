# Troubleshooting

Symptoms first. If an API is throwing at you deliberately, it is on the
[Limitations](./limitations.md) page instead.

## Nothing happens at all

The element never leaves `status === "idle"`. Either `src` is empty, or
`@mewhhaha/v-frame/register` was never imported so the tag is still an unknown element.
Check `customElements.get("v-frame")` in the host page.

If the element reaches `status === "error"` immediately, listen for
`v-frame-error` and read `detail.phase`. `entry` means the `src` request failed
or returned a non-OK response; `bootstrap` means the execution realm could not be
created, which on an older browser is the missing Navigation API.

## The guest renders but its scripts never run

The host inserted an unmaterialized guest response into Declarative Shadow DOM.
Run it through `@mewhhaha/v-frame/server` before composition — the runtime activates
scripts that carry `data-v-frame-script` and a parser-time type of
`application/vnd.v-frame`, and ignores everything else.

## The guest script ran in the host page

Same cause, opposite symptom: an ordinary `<script>` in Declarative Shadow DOM
is not executed by the parser, but one composed anywhere else in the host
document is. Materialize the guest response; it should keep returning its normal
executable scripts.

## Adoption falls back to a network request

The frame must have the `adopt` attribute, and the materialized Declarative
Shadow DOM must contain exactly one `v-html` with direct `v-head` and `v-body`
children. Adoption is available only on the element's first connection — reloads,
reconnection, and `src` changes always load over the network.

## The guest restarts when the element moves

Removing a `v-frame` and inserting it again disconnects it, which tears the guest
down; the insertion loads `src` from scratch (and never adopts, see above). Move
it with `parent.moveBefore(frame, reference)` to keep the guest alive. Browsers
without `moveBefore` have no state-preserving move.

## Changing an attribute does not reload

Only a change in the _effective_ value reloads. `credentials="bogus"` falls back
to `"same-origin"`, `navigation="bogus"` to `"guest"`, and a blank
`trusted-types-policy` means none, so switching between two spellings of the same
setting is a no-op. See [API](./api.md#configuration).

## Reload returns 404

`src` still needs to serve an ordinary guest document, even though the initial
SSR activation does not request it. Adoption borrows the URL; it does not
replace the route.

## Styles differ after activation

Confirm that the host materializer rewrote document selectors, and that server
and client rendering produce the same application markup. The guest stylesheet
should keep using normal document selectors — `html`, `body`, `:root` — and both
the materializer and the browser runtime rewrite them to the shell elements.

If a component's styles are missing entirely and its code calls
`new CSSStyleSheet()`, see
[constructed stylesheets](./limitations.md#documentadoptedstylesheets-and-constructed-stylesheets).

## Relative assets resolve against the wrong application

Pass the public `src` URL — not an internal service URL — to the materializer. It
uses that URL when rebasing stylesheet resources. The adapter does not rebase
markup attributes, so use root-relative or absolute asset URLs in the server
preview.

## Form input, focus, or scroll changes disappear during activation

The live guest is prepared separately and then swapped with the preview. Changes
a user makes to the inert server preview before activation are not preserved.
Load the registration bundle early when that interval matters.

## The frame is zero pixels tall

`v-frame` is an unknown element to the browser's default stylesheet, so it has no
intrinsic size and no default `display`. Give it one:

```css
v-frame {
  display: block;
  width: 100%;
  min-height: 30rem;
}
```

## An overlay is clipped by the frame

Portals into `document.body` remain descendants of `v-body` and therefore obey
the frame's clipping boundary — this is correct, and matches what the guest would
do standalone inside a clipped container. Content promoted to the browser's top
layer (`<dialog>` with `showModal()`, `popover`) escapes it and is positioned
back into frame-local coordinates by the runtime. A component that needs to
escape the frame must use a native popover or dialog, or a host-owned overlay
bridge.

## Scripts or styles are blocked by CSP

Guest execution inherits the host page's Content Security Policy; the guest
document's own CSP headers are not applied as a separate policy. Set `nonce` on
the element so generated scripts and styles carry the host's nonce, and if the
host enforces Trusted Types, set `trusted-types-policy` to a name its CSP allows.
See [the API reference](./api.md#csp-and-trusted-types).

## A host router and the frame fight over history

Only in `navigation="host"`. `v-frame` observes the host page's `navigation`
object and never patches `history.pushState` or `history.replaceState`, so a
shell router is free to wrap those itself. If the guest's route and the address
bar disagree, check that the shell is not restoring a URL from its own state on
every render, and follow `v-frame-navigated` rather than polling `currentURL`.

## `navigate()` rejects

Read the error name. `AbortError` means a `v-frame-navigate` listener canceled
it, `TypeError` means the route is cross-origin or not `http:`/`https:`, and
`InvalidStateError` means the frame has no active guest. See
[Navigation](./navigation.md#how-they-fail).
