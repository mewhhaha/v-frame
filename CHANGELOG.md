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
- Typechecking for `tests/`, `bench/`, `examples/*/tests/` and the client
  example's React host through `tsconfig.test.json`. The host is the only example
  source no build typechecks — the `example-ssr` job's build does the framework
  applications as a side effect — and it resolves `v-frame` by package name, so
  the project maps that name to `src/` rather than to declarations `dist/` does
  not have until after `typecheck` has run.
- A gzip bundle-size budget (`pnpm size`) that fails the build above its
  threshold, currently 68,000 bytes. The measured size is not repeated here: the
  command prints it, and a figure copied into prose is stale by the next commit
  — this one was, three revisions running.
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
  now records the before and after of both optimizations it motivated. Its
  `re-parent` row moves a settled subtree rather than growing the tree, which is
  the only measurement that distinguishes marking a node from re-marking one. It
  times both engines the suite runs on, one after the other; the two heap
  measurements stay chromium-only, because a collected heap size needs CDP and
  `performance.measureUserAgentSpecificMemory` is chromium-only as well, so on
  firefox the run says the heap is not measurable and skips the churn.
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
- Firefox numbers behind that ceiling, so it no longer rests on one engine.
  Activation is about a fifth dearer than chromium's (1.24x and 1.17x on the two
  runs taken) and insertion close to double, while re-parenting is within the
  spread. Retained heap is still unmeasured on firefox and `limitations.md` now
  says so where the figure appears, instead of leaving a chromium number reading
  as a cross-engine one.

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
  longer shipped. Together they take about a third off the gzipped payload.
  `pnpm size`, which minifies and gzips `src/index.ts` in memory, prints what
  that payload is now, and it is the only place that number is kept; no bundle
  byte count is copied into this entry, because every copy of it so far has gone
  stale within a commit or two of being written down. The heap and timing
  figures below are a different matter — they come from `pnpm bench` against a
  named machine and browser, and are stated as measurements of that run.
- A guest node no longer carries the facade on itself. `ownerDocument` and
  `baseURI` are answered by accessors on the realm's `Node.prototype`, gated on
  the same virtual-node set `getRootNode` was already gated on, instead of three
  own accessors installed on every node and every attribute node. Measured by
  `pnpm bench` on a 50,000-element guest, activation drops from 994 ms to 702 ms
  and retained JS heap from 52 MB to 7.5 MB; the marginal cost per element falls
  from 19.3 µs to 13.6 µs. Nodes that do not inherit from the realm's prototypes
  — Gecko binds a `ShadowRoot` to its node document's global, so an adopted
  guest's shadow roots do not — keep the per-node accessors.
- Marking no longer re-walks a subtree that is re-parented. Everything
  `markVirtualNode` does is a statement about the node itself — the virtual-node
  set the realm's identity accessors read, the authored style, `rel` and URL
  attributes, the defused scripts and inline handlers — and none of it depends on
  where the node hangs; the one input that is not per-node, the document base
  URL, already rebases the whole tree when it changes. So a node that is already
  marked and still inside the virtual tree is left alone, and one that is
  detached is walked in full, because nothing observes a detached subtree while
  the realm's `MutationObserver` hands every node added to a connected one back
  to marking on its own. That observer is a microtask where the walk was
  synchronous, so a node an unintercepted write put inside a connected marked
  element — the `textContent` setter's text node, `insertAdjacentText`,
  `setHTMLUnsafe` — is now marked a microtask after the write rather than by the
  next re-parent of an ancestor. [`docs/limitations.md`](./docs/limitations.md)
  records that as a limitation, with the list of APIs it affects. Measured by
  `pnpm bench`, which now has a `re-parent` row, moving a settled hundred-node
  subtree 1,000 times drops from 254–297 ms to 59–78 ms — from 48–59x plain host
  DOM to 12–13x. Activation and insertion do not change; the earlier note's guess
  that insertion was bound by this was wrong, and
  [`docs/node-marking-benchmark.md`](./docs/node-marking-benchmark.md) now
  records what a profile says it is bound by instead.
- The facade no longer retains every node it ever marked. The descriptors it
  records so `dispose()` can put a node back the way it found it were held in a
  strong `Map` keyed by node, so a guest that churned rows grew for the lifetime
  of the frame; they are now a `WeakMap` behind a `FinalizationRegistry`-pruned
  list of weak references. Nodes the guest still holds are still restored, and
  `tests/node-retention.spec.ts` holds both halves — 2,000 churned rows survive a
  forced collection zero times, and a removed node the guest still references
  gets its native `ownerDocument` and `getRootNode` back when the frame goes
  away.
- Nor does any of the facade's other per-element registries. The authored style
  and URL attributes (`src/markup.ts`) and the handler and listener targets
  (`src/facade/events.ts`) were strong `Map`s and `Set`s because each is
  enumerated — the inline stylesheet is rebuilt from one, a base-URL change
  rebases through another, and `dispose()` walks the last two — so a guest that
  churned elements carrying a `style` attribute, a URL attribute or an `onclick`
  still grew for the lifetime of the frame after the descriptor leak was closed.
  All five now share one primitive with the descriptors
  (`src/enumerable-weak.ts`): a `WeakMap` for the values behind an
  insertion-ordered set of `WeakRef`s that a `FinalizationRegistry` prunes, so
  enumeration walks the survivors. Measured by `pnpm bench`, which gained a
  retention measurement for this, 2,000 rows created, removed and dropped in a
  settled guest retain 1,331 KB instead of 3,012 KB; churning the same 2,000
  again costs 59 KB more instead of 2,421 KB more, which is the point — the cost
  is now a high-water mark rather than a per-row charge.
- `tests/node-retention.spec.ts` runs on firefox as well as chromium, and churns
  rows carrying one of everything a registry admits an element for. Forcing a
  collection no longer needs a CDP session: `page.requestGC()` is
  `HeapProfiler.collectGarbage` on chromium and the juggler `Heap.collectGarbage`
  on firefox. Reading how many *bytes* survive is still chromium-only, which is
  why `pnpm bench` keeps its CDP session.
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
- No Playwright test leaves an ordering it asserts to browser scheduling. The
  dynamic-script insertion-order test used a 50 ms fixture delay, which failed
  roughly one full-suite run in five on firefox; the first script's response is
  now parked until the second's body has reached the socket, so the order the
  test claims is the order it gets under any load. `parkRoute` and `gateRoute` in
  `tests/support/http-fixture.ts` generalize that pair, and the four remaining
  timer-raced orderings use them: the fragment insertion-order scripts in
  `tests/script-safety.spec.ts`, `/assets/async-order.js` behind the deferred
  script in `tests/advanced.spec.ts`, the post-ready script that must not have
  settled when the frame reports load, and the deferred classic that a module's
  flush — not a 50 ms timer — now releases. Response delays that are themselves
  the behaviour under test, such as the 75 ms and 125 ms bootstrap blockers,
  are unchanged.

### Removed

- The credentialless XHR transport (`src/credentialless-xhr.ts`, 1,031 lines): a
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
- [`docs/api.md`](./docs/api.md) described `reload()` wrongly, twice over. It
  claimed the method cannot run before `v-frame-load` — it can; only `navigate`,
  `back`, `forward` and `go` need a live guest — and the correction to that
  claimed it never rejects, which is worse. `reload()` settles with the load it
  starts, so it rejects with a non-HTTP or cross-origin `src`, and with the
  entry fetch's error whenever the response is not `ok`: a frame whose route
  404s rejects. It resolves only when it starts no load, because the element is
  disconnected or has no `src`, or when a later load supersedes the one it
  started. `tests/contract.spec.ts` now pins all five outcomes on both engines.
