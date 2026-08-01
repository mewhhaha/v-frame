# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

The package has never been published. Its version was corrected from `1.0.0` to
`0.1.0`, because the behaviour changes in this entry still come before a stable
release. Everything here works through
[`docs/cleanup-plan.md`](./docs/cleanup-plan.md), the review this branch was cut
from.

### Added

- Imperative guest navigation on the element: `navigate(url, { replace })`,
  `back()`, `forward()`, `go(delta)`, and the `canGoBack` / `canGoForward`
  properties. They delegate to the same history session guest-initiated
  navigation uses, fire the cancelable `v-frame-navigate`, and drive the shell's
  history under `navigation="host"`. Traversal resolves once the guest has
  actually moved in both navigation modes — under `navigation="host"` the shell
  performs it asynchronously, and the frame waits for the shell to report it —
  so `currentURL`, `canGoBack`, and `canGoForward` are already the post-traversal
  values when the promise settles. Host-mode traversal is bounded by the entries
  the shell's `navigation` object reports, which is the list `canGoBack` and
  `canGoForward` already answer from. A traversal the host cancels rejects
  naming the entry it aimed at, not the one the guest is still on.
- `v-frame-navigated`, the past-tense counterpart of `v-frame-navigate`. It is
  not cancelable, carries `{ from, to, kind }`, and fires after the guest has
  moved through its session — including guest `pushState`, fragment navigation,
  traversal, and document navigation — so a host router can read `currentURL`,
  `canGoBack`, and `canGoForward` from the listener instead of polling. It
  reports the move rather than the URL string, so a push of the route the guest
  is already on fires with `from === to`, while a replace of that route does
  not fire at all.
- `v-frame/server`, the server-side materializer for the adopted (SSR) path. It
  exports a runtime-neutral core — shell tag renaming, the injected display
  rules, script neutralization, and stylesheet rewriting — that a host drives
  from its own streaming HTML parser, plus `materializeVFrameDocument`, a
  Cloudflare `HTMLRewriter` adapter over that core. `createStylesheetContext`
  and `rewriteStylesheet` are exported from the same entry so a Node host can
  write its own adapter without copying CSS logic.
- Continuous integration on every push and pull request: one fast job running
  `format:check`, `typecheck`, `build`, `size`, the unit tests and the root
  Playwright suite on chromium and firefox, and a second job — gated on the
  first — running `examples/ssr`'s routing suite, which is the only place the
  navigation API is exercised against four real frameworks.
- Typechecking for `tests/`, `bench/` and `examples/*/tests/` through
  `tsconfig.test.json`.
- A gzip bundle-size budget (`pnpm size`) that fails the build above its
  threshold, currently 68,000 bytes against a measured 65,755.
- Unit tests (`pnpm test:unit`, `node --test`) over the pure logic: `src/url.ts`,
  the `src/css.ts` rewriters, `absolutizeSrcset`, `VirtualHistorySession`, and
  the facade's prototype-patch registry. 183 tests that run in about a tenth of a
  second, without a browser.
- A Kobalte-backed case in `tests/overlays.spec.ts`. The lab's own surfaces are
  positioned from the rects the facade reports, which is the repository checking
  its own arithmetic; this case hands that job to Kobalte's popover, and through
  it to `@floating-ui/dom` — third-party code written without any knowledge of
  v-frame — with the anchor 14 px clear of a clipped frame's bottom edge. It
  asserts the content's position on the host's screen and that the only
  difference between the facade's coordinate space and that screen is the
  frame's own origin. The guest module (`tests/support/kobalte-overlay-lab.js`)
  is bundled by esbuild when the spec starts, resolving Kobalte from the copy
  `examples/client` already pins, so the root suite keeps its single pinned
  version, needs no framework build step, and gains about 30 ms.
- A benchmark for per-node marking (`pnpm bench`) and its findings note,
  [`docs/node-marking-benchmark.md`](./docs/node-marking-benchmark.md), which
  now records the before and after of the optimization it motivated.
- `docs/`: the README was split into
  [`limitations.md`](./docs/limitations.md), [`api.md`](./docs/api.md),
  [`navigation.md`](./docs/navigation.md), [`ssr.md`](./docs/ssr.md), and
  [`troubleshooting.md`](./docs/troubleshooting.md). `limitations.md` enumerates,
  for the first time, every API the runtime deliberately refuses — most
  significantly `document.adoptedStyleSheets` and constructed stylesheets.
- A stated guest-size ceiling. `limitations.md` now carries the measured
  activation cost at four tree sizes, what the same markup costs inserted
  straight into the host document, the retained heap, and the machine and browser
  the numbers were taken on. The README's tradeoff section says which size of
  guest the design suits and which is better served by an `<iframe>`, citing
  those numbers instead of describing them. This was previously discoverable only
  by building something large and being disappointed.

### Changed

- `credentials` is redefined. It applies to the entry document and stylesheet
  requests `v-frame` itself issues, and supplies a default for guest requests
  that do not choose one. It is explicitly not a security boundary: the guest is
  same-origin and can set any credentials mode it likes.
- `navigation="host"` no longer patches the host page's `history.pushState` or
  `history.replaceState`. It observes the host's `navigation` object instead,
  which the runtime already requires, so a shell router that wraps those methods
  itself keeps working.
- The published bundles are minified, and `css-tree` is imported through its
  `parser`, `generator`, and `walker` subpaths so the unused lexer tables are no
  longer shipped. Measured by `pnpm size`, which minifies and gzips
  `src/index.ts` in memory, that is 97,514 bytes down to 65,755 — a third of the
  payload. Every byte count in this entry comes from that command, so it is
  reproducible rather than remembered.
- A guest node no longer carries the facade on itself. `ownerDocument` and
  `baseURI` are answered by accessors on the realm's `Node.prototype`, gated on
  the same virtual-node set `getRootNode` was already gated on, instead of three
  own accessors installed on every node and every attribute node. Measured by
  `pnpm bench` on a 50,000-element guest, activation drops from 994 ms to 702 ms
  and retained JS heap from 52 MB to 7.5 MB; the marginal cost per element falls
  from 19.3 µs to 13.6 µs. Nodes that do not inherit from the realm's prototypes
  — Gecko binds a `ShadowRoot` to its node document's global, so an adopted
  guest's shadow roots do not — keep the per-node accessors.
- The facade no longer retains every node it ever marked. The descriptors it
  records so `dispose()` can put a node back the way it found it were held in a
  strong `Map` keyed by node, so a guest that churned rows grew for the lifetime
  of the frame; they are now a `WeakMap` behind a `FinalizationRegistry`-pruned
  list of weak references. Nodes the guest still holds are still restored, and
  `tests/node-retention.spec.ts` holds both halves — 2,000 churned rows survive a
  forced collection zero times, and a removed node the guest still references
  gets its native `ownerDocument` and `getRootNode` back when the frame goes
  away.
- Biome formats the repository, freezing the existing house style.
- `examples/ssr` imports `v-frame/server` instead of reaching into `src/`, and
  routes host-driven navigation through the element's own API.
- `src/document-facade.ts` (4,515 lines) is now `src/facade/` — `context`,
  `nodes`, `events`, `attributes`, `style`, `collections`, `selection`,
  `document`, composed by `index.ts`. `src/realm.ts` (2,130 lines) is now
  `src/realm/` — `connect`, `dynamic-styles`, `navigation`, `window-patches`,
  composed by `index.ts`. Behaviour is unchanged; the moves were mechanical and
  the suite stayed green at every step.
- `BoundHistory` and `VirtualHistory` share one base controller instead of
  duplicating entry, state, and URL handling.
- One listener registry backs the facade's `ListenerBridge`, the realm's window
  event bridge, and the network facade's `EventTarget` patch, which had drifted
  apart.
- Every Playwright fixture server is one parameterized route table in
  `tests/support/`, and every spec mounts frames through one shared
  `mountFrame` helper.
- The dynamic-script insertion-order test no longer leaves the arrival order it
  exercises to browser scheduling. It used a 50 ms fixture delay, which failed
  roughly one full-suite run in five on firefox; the first script's response is
  now parked until the second's body has reached the socket, so the order the
  test claims is the order it gets under any load.

### Removed

- The credentialless XHR transport (`src/credentialless-xhr.ts`, 948 lines): a
  from-scratch reimplementation of `XMLHttpRequest` over `fetch`, whose only
  purpose was to suppress same-origin cookies for a guest that could send them
  itself through any other API. `XMLHttpRequest` is now always the native one, so
  its `username` and `password` arguments and synchronous mode work under every
  `credentials` value.
- `examples/ssr/shared/routing.ts`, the BroadcastChannel-plus-session-id protocol
  the example used to tell a guest where to navigate. The imperative navigation
  API above replaces it, and deleting it was the acceptance test for whether that
  API is sufficient.
- `examples/client` is down to a single guest framework, and its overlay
  compatibility lab moved to `tests/overlays.spec.ts` — it was asserting library
  behaviour (top-layer coordinate translation, focus, portal containment) rather
  than demonstrating usage, so it now runs in CI on chromium and firefox.
- The generated Cloudflare `worker-configuration.d.ts` files are no longer
  tracked; each example application regenerates them with `wrangler types`.

### Fixed

- An attribute written to an element that is already in the virtual tree now
  produces a marked `Attr` node. Marking only ever walked an element's
  attributes while marking the element itself, so an attribute set afterwards
  answered `baseURI` with the host page's URL on both engines, and on Gecko
  answered `ownerDocument` with the host document — Gecko binds the `Attr` to
  the node document the element was adopted into, so the realm's `Attr.prototype`
  is not on its chain.
- `dispose()` no longer leaves the nodes it restored registered with the
  facade's `FinalizationRegistry`. The registration held one dead cell per
  marked node for as long as the host kept the disposed element around.
- Unwinding the facade's prototype patches twice no longer reinstalls them. The
  record was reversed in place rather than drained, so a second run replayed it
  oldest-first and left the first patch of any twice-patched key installed. The
  realm's `dispose()` guards against running twice, so this was latent rather
  than observed; `tests/unit/facade-patches.test.ts` now pins it directly.
- [`docs/api.md`](./docs/api.md) claimed `reload()` cannot run before
  `v-frame-load`. It can, and it never rejects; only `navigate`, `back`,
  `forward` and `go` need a live guest.
