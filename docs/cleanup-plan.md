# v-frame — review and cleanup plan

Handoff document. Written 2026-08-01 against `main` @ `c52c920`.

## Decisions taken (2026-08-01)

Both open questions in §5 have been answered by the maintainer:

- **Task 2.1 — `credentials="omit"`: delete it.** Remove `src/credentialless-xhr.ts`
  entirely. `credentials` applies only to v-frame's own entry and stylesheet fetches, and
  the README must say so.
- **Task 5.3 — examples: trim.** Keep `examples/ssr` as the flagship. Reduce
  `examples/client` to a single guest framework. Promote
  `examples/client/tests/overlays.spec.ts` into `tests/` so CI runs it.

No task in this plan is blocked on further input.

---

## 1. What this project is

`v-frame` is a **same-origin micro-frontend runtime shipped as one custom element**.

It renders a *trusted* guest HTML document inside the host page's shadow tree, while
executing that guest's JavaScript inside a hidden `srcdoc` iframe whose `Document`,
`History`, `Location`, CSSOM and network APIs are virtualized so the guest believes it
is a top-level page at its own URL.

The two things it is trading against:

- **vs. an `<iframe>`** — no separate layout viewport. The guest participates in host
  layout, inherits sizing, and its overlays/popovers/dialogs are not clipped by a
  browsing-context boundary. Cost: no security boundary. The guest is same-origin and
  fully trusted; this is stated up front in the README and is a design axiom, not a gap.
- **vs. Module Federation / Web Fragments / single-spa** — the guest needs *zero*
  cooperation. It ships an ordinary HTML document with ordinary scripts and ordinary
  document selectors. No host SDK import, no special response format, no build coupling.
  Cost: the runtime must emulate a document, which is where essentially all of the
  complexity lives.

Two entry modes: fetch `src`, or adopt server-rendered Declarative Shadow DOM (`adopt`),
which is the documented recommended path.

**The architecture is coherent and the central trick is good.** Guest nodes are created
in the iframe realm (so they keep that realm's prototypes, which `document-facade.ts`
patches) and then inserted into the host shadow root (so they render in host layout).
The facade exists to paper over the resulting lies — `ownerDocument`, `getRootNode`,
`baseURI`, coordinates, selectors, collections. That is *inherent* complexity for this
design, not accidental. Nothing below proposes changing it.

---

## 2. Health snapshot (measured, not estimated)

| | |
| --- | --- |
| Source | 13,236 lines across 15 files in `src/` |
| Tests | 9,169 lines across 23 Playwright specs |
| Test result | **171 passed in 8.8s** (chromium), `tsc --noEmit` clean |
| Bundle | 97 KB gzip minified (341 KB min, 700 KB raw as shipped — `esbuild.mjs` does not minify) |
| Tracked lines | 117,533 — of which **73,538 (63%) are generated `worker-configuration.d.ts`** |
| CI | none |
| Lint/format | none |
| Published | no (`npm view v-frame` → 404), yet `version: 1.0.0` |
| Age | 3 weeks of very dense commits (2026-07-12 → 2026-07-21) |

The test suite is genuinely fast and genuinely broad. That is the strongest asset in the
repo and every change below should be gated on it.

---

## 3. Findings

Ordered by leverage, not by severity.

### A. Packaging and payload

**A1. css-tree is 55% of the bundle and 80 KB of it is dead weight.**
`css-tree` contributes ~185 KB of the 333 KB minified bundle; `css-tree/dist/data.js`
alone is 81 KB. That file is the *lexer's* syntax-definition tables — used for
`csstree.lexer` validation, which this codebase never calls. Only `parse`, `generate` and
`walk` are used (`src/css.ts:1`, `src/document-facade.ts:1`). css-tree 3.x publishes
`css-tree/parser`, `css-tree/generator`, `css-tree/walker` subpath exports that exclude
the lexer and its data. Expected saving: roughly half the gzip payload.

**A2. The build does not minify.** `esbuild.mjs` has no `minify: true`. Raw `dist/index.js`
is 700 KB / 137 KB gzip. Consumers with a bundler will minify it themselves, but anyone
loading `dist/index.js` directly (which the repo's own test fixture server does) pays full
price.

**A3. The SSR materializer — the hardest part of the recommended path — is not shipped.**
`examples/ssr/shared/materialize-v-frame.ts` reaches into `../../../src/css.js` to use
`createStylesheetContext` / `rewriteStylesheet`. Neither is a public export. The README
openly calls this "an example rather than a portable package export because server HTML
transformation APIs differ between runtimes" — but that argument only applies to the HTML
rewriting layer, not to the CSS rewriting, which is pure and runtime-neutral. Today every
adopter must copy 89 lines of subtle code (including the `</style` CSS-escape on line 39)
out of an example directory.

### B. Missing API surface

**B1. There is no imperative navigation API.** The element exposes `src`, `reload()`,
`status`, `currentURL`, `contentWindow` — and nothing to move the guest to a new route
without a full document load. The consequence is visible: `examples/ssr/shared/routing.ts`
invents an entire cross-frame routing protocol (BroadcastChannel + a `sessionStorage`
session id + a versioned message schema + UUID validation, 107 lines) plus corresponding
handling in the host worker, purely to tell a guest "go to /research". `VirtualHistory` /
`VirtualHistorySession` already model exactly this. Expose it:
`frame.navigate(url, { replace })`, `frame.back()`, `frame.forward()`, `frame.go(n)`.

**B2. Navigation observability is write-only.** `v-frame-navigate` is a *cancelable,
before-the-fact* event. There is no past-tense `v-frame-navigated`, and no way to read the
guest's history depth (`canGoBack`). A host router cannot render breadcrumbs or a back
button without polling `currentURL`.

### C. Correctness and risk

**C1. `navigation="host"` monkeypatches the *host page's* `history.pushState` /
`replaceState`** (`src/history.ts:26-88`), globally, via a module-level `WeakMap` of
observers. Every mainstream host router patches or wraps those same methods. This is the
single most likely source of a hard-to-diagnose integration bug. Prefer observing the host
`navigation` object (already a hard requirement — `connectRealmIframe` rejects without the
Navigation API) and keep the patch only as a fallback. At minimum, document it loudly.

**C2. Three hand-rolled listener registries with near-identical bookkeeping.**
`ListenerBridge` (`src/document-facade.ts:160`), `installWindowEventBridge`
(`src/realm.ts:470`), `patchNativeEventTarget` (`src/network.ts:118`). All three maintain
`{type, listener, capture, wrapper}` records, dedupe on `(type, listener, capture)`,
handle `once`, and unwind `signal`. They have already drifted (only the facade one models
`eventPhase`). One shared primitive, three thin adapters.

**C3. Per-node own-property installation may not scale.** `markVirtualNode`
(`src/document-facade.ts:1877`) walks every inserted subtree and installs own accessors
for `ownerDocument`, `baseURI` and `getRootNode` on **every node and every attribute
node**, plus URL-property marking, plus event-attribute compilation. This runs again on
every insertion via `finishInsertion` and the MutationObserver. There is no benchmark in
the repo. For a 10k-node guest app this is 30k+ own accessors and a guaranteed hidden-class
deopt on the hot DOM path. This needs measurement before it needs fixing — but it needs
measurement.

**C4. `credentials="omit"` costs 948 lines and buys nothing.**
`src/credentialless-xhr.ts` is a from-scratch reimplementation of XMLHttpRequest on top of
`fetch` — response types, charset decoding, upload progress, readystatechange ordering,
document parsing — and it exists solely because native XHR cannot suppress same-origin
cookies (`src/network.ts:298`). But the guest is same-origin and explicitly trusted; it
can call `fetch(url, {credentials:'omit'})`, or `document.cookie`, or anything else,
whenever it likes. `omit` is not a boundary, it is a costume. This is ~11 KB minified and a
permanent spec-fidelity liability (the file already documents three behaviours it cannot
match).

**C5. The unsupported-API list is enforced but undocumented.** In code:
`document.write/open/close/writeln`, `document.adoptedStyleSheets`, direct document child
mutation, CSSOM `@import`, non-GET form submission, form `target` other than `_self`/
`_blank`, sync XHR under `omit`, XHR username/password. None of these appear in the README.
`document.adoptedStyleSheets` throwing is the notable one — constructed stylesheets are how
a lot of modern component code ships CSS.

### D. Structure

**D1. `document-facade.ts` is 4,515 lines, of which ~3,900 are a single function.**
`installDocumentFacade` holds ~270 local declarations in one closure. The closure *is* the
design (everything shares `window`, `document`, `options`), so the fix is not to flatten it
but to split it into modules that each take an explicit context object:
`facade/{context,nodes,events,attributes,style,collections,selection,document}.ts`.

**D2. `realm.ts` is 2,130 lines mixing five concerns** — iframe bootstrap, the dynamic
style/link revision pipeline (~350 lines of its own), navigation interception, form
submission semantics, and window patches. Same treatment.

**D3. `history.ts` carries two parallel implementations** of one interface — `BoundHistory`
(258 lines) and `VirtualHistory` (407 lines) — selected by `boundNavigation`. Shared
behaviour is duplicated rather than factored.

### E. Tests

**E1. Test fixture servers are copy-pasted 10+ times.** `css-failure`, `css-host-isolation`,
`css-native-semantics`, `cssom`, `dynamic-stylesheet-races`, `module-style-csp`,
`script-concurrency`, `script-release-fidelity`, `script-safety`, `xhr-credentials` each
build their own `node:http` server with their own `reply` / `pathname` / `html` helpers.
`tests/support/fixture-server.ts` itself contains two near-identical servers
(`startFixtureServer` / `startContractFixtureServers`, with `html`/`contractHTML`,
`reply`/`contractReply`, `pathname`/`contractPathname`). A `mountFrame`-shaped helper is
duplicated across 18 spec files. Conservatively 1,000–2,000 lines of scaffolding.

**E2. Tests are not typechecked.** `tsconfig.json` sets `include: ["src/**/*.ts"]`.
Nothing type-checks `tests/` or `examples/*/shared/`.

**E3. There are no unit tests.** Every assertion goes through a browser. `src/url.ts`,
the rewriters in `src/css.ts`, `absolutizeSrcset` in `src/markup.ts`, and
`VirtualHistorySession` are pure and would be far better covered — and far better
*documented* — by fast table-driven unit tests.

### F. Repo hygiene

**F1. 63% of tracked lines are generated Cloudflare types.** Five
`examples/ssr/apps/*/worker-configuration.d.ts` files, 73,538 lines, each carrying a
`// Generated by Wrangler` header. They pin a workerd date-version and will conflict on
every wrangler bump.

**F2. No CI.** A 9-second cross-browser suite that nothing runs automatically.

**F3. No formatter or linter.** The house style is unusually consistent (2-space, named
helper functions over inline lambdas, comments that explain *why* not *what*) — that
consistency is worth freezing mechanically before more agents touch the code.

**F4. Working-tree debris.** `.claude/worktrees/` holds three full checkouts *including
`node_modules`*; `test-results/` is present. Both are gitignored, so this is disk hygiene
rather than repo hygiene, but the worktrees are stale branches from PRs #1–#6.

**F5. The examples are the largest maintenance surface in the repo.** Two example
workspaces, nine guest applications, spanning Angular 21, Qwik, SolidStart, React Router,
Radix, Angular Material, Kobalte, Qwik UI, Vite, Wrangler, and Cloudflare Workers. This
will rot faster than the library and it is not where the library's risk lives.

**F6. The README is doing four jobs** in 445 lines: pitch, SSR tutorial, API reference,
troubleshooting. And it documents only `examples/ssr` — `examples/client`, including the
overlay-compatibility matrix which is genuinely the most persuasive artifact in the repo,
is invisible from the root.

---

## 4. Plan

Phases are ordered so that each one is safe given the previous. Every task keeps
`pnpm test` (171 tests, chromium + firefox) green; that is the universal acceptance
criterion and is not repeated per task.

### Phase 0 — Freeze the baseline

*Goal: make regressions visible before changing anything.*

0.1 **Add CI** — `.github/workflows/ci.yml`: `pnpm typecheck`, `pnpm build`,
`playwright test` on chromium + firefox, on push and PR. Node from `.nvmrc`.
*Done when:* a PR shows a red/green check.

0.2 **Typecheck the tests** — add `tsconfig.test.json` (extends the root config,
`include: ["tests/**/*.ts", "examples/*/shared/**/*.ts"]`, `noEmit`), wire into the
`typecheck` script. Fix whatever it surfaces.

0.3 **Add a formatter** — `dprint` or Biome, configured to reproduce the current style as
closely as possible. Format everything in one isolated commit so it never mixes with
semantic diffs. Add a `format:check` CI step.

0.4 **Untrack generated worker types** — `git rm --cached examples/ssr/apps/*/worker-configuration.d.ts`,
add to `.gitignore`, add `wrangler types` to each app's `build` (or a root `postinstall`).
*Done when:* `git ls-files | xargs wc -l` drops to ~44k and `pnpm --filter example-ssr build` still passes.

0.5 **Add a bundle-size budget** — a script that builds minified, gzips, and fails above a
threshold. Set the initial threshold at today's 97 KB so Phase 1 can ratchet it down.

0.6 **Clean the working tree** — `git worktree remove` the three stale `.claude/worktrees/`
checkouts; delete `test-results/`.

### Phase 1 — Payload and packaging

1.1 **Switch to css-tree subpath imports** — replace `import * as cssTree from "css-tree"`
in `src/css.ts` and `src/document-facade.ts` with `css-tree/parser`, `css-tree/generator`,
`css-tree/walker`. Verify `data.js` and `lib/syntax/config/lexer.js` disappear from
`esbuild --analyze`.
*Done when:* gzip drops to roughly 45–55 KB; the css and cssom specs stay green.
*Risk:* the subpath parser may default to different `positions`/`parseValue` options —
check `parseStylesheet` in `src/css.ts:55` and the two `cssTree.parse` calls in
`document-facade.ts:68/92/105` still get the same AST shape.

1.2 **Minify the published bundle** — `minify: true` in both `esbuild.mjs` builds; keep
`sourcemap: true` and `legalComments: "external"`.

1.3 **Ship `v-frame/server`** — new `src/server/` entry exporting a runtime-neutral
materializer core plus a Cloudflare `HTMLRewriter` adapter. Move the logic out of
`examples/ssr/shared/materialize-v-frame.ts`; the example then imports `v-frame/server`,
which also proves the export works. Add to `package.json` `exports`. Publicly export
`rewriteStylesheet` / `createStylesheetContext` (either under `v-frame/server` or a
`v-frame/css` subpath) so a Node host can build its own adapter.
*Done when:* `examples/ssr` builds with no `../../../src/` import anywhere; a smoke test
asserts the materializer output shape.

1.4 **Decide the version story** — either publish `0.x` and drop the `1.0.0`, or publish
`1.0.0` and start a `CHANGELOG.md`. Given the open items below, `0.x` is the honest call.

### Phase 2 — Delete weight

2.1 **Remove the credentialless XHR transport.** Delete `src/credentialless-xhr.ts` and its
branch in `src/network.ts:298`. Redefine `credentials` as applying to v-frame's *own*
entry and stylesheet fetches only (which is all it can honestly mean for a trusted
same-origin guest), and say so in the README. Rewrite `tests/xhr-credentials.spec.ts`
(828 lines) down to what still applies.
*Saves:* ~948 source lines, ~11 KB minified, ~800 test lines.
*Risk:* this is a behaviour change. If the user wants `omit` to keep meaning "XHR sends no
cookies", skip this task — but then it should be documented as a convenience, not a
boundary.

2.2 **Extract one listener registry.** New `src/listener-registry.ts` holding the
record/dedupe/`once`/`signal` logic; adapt `ListenerBridge`, `installWindowEventBridge` and
`patchNativeEventTarget` onto it. Preserve the facade's `eventPhase` behaviour as an
adapter option — the differences are real, only the bookkeeping is shared.

2.3 **Collapse the test fixture servers.** One parameterized server in `tests/support/`
that takes a route table, plus a shared `mountFrame(page, {src})` helper. Migrate the 10
ad-hoc servers and the 18 duplicated mount helpers onto it. Do this file-by-file, one
commit per spec.
*Done when:* `grep -c createServer tests/*.spec.ts` reports only the support module.

### Phase 3 — Close the API gaps

3.1 **Add imperative navigation** — `navigate(url, {replace?})`, `back()`, `forward()`,
`go(n)`, `canGoBack`/`canGoForward` on `VFrameElement`, delegating to the existing
`VirtualHistory` / `VirtualHistorySession`. Must fire `v-frame-navigate` (cancelable) and
respect `navigation="host"`.

3.2 **Add `v-frame-navigated`** — past-tense, non-cancelable, `{from, to, kind}`, fired
after the guest URL actually changes (including guest-initiated pushState). This plus 3.1
is what the example's BroadcastChannel protocol was working around.

3.3 **Delete the example's routing protocol** — rewrite `examples/ssr` host and guests onto
3.1/3.2. Removing `examples/ssr/shared/routing.ts` is the acceptance test for whether the
new API is actually sufficient.

3.4 **Stop patching host `history`** — rework `observeHostHistory` (`src/history.ts:26`) to
observe the host's `navigation` object (already a hard requirement of the runtime), keeping
the patch only as a documented fallback. Add a regression test that mounts a
`navigation="host"` frame *underneath* a host that has itself wrapped `history.pushState`,
and asserts both observers still fire in order.

### Phase 4 — Structure

Do this **after** Phases 1–3, so the modules being extracted are the ones that survive.

4.1 **Split `document-facade.ts`** into `src/facade/` with an explicit shared context
object: `context.ts`, `nodes.ts`, `events.ts`, `attributes.ts`, `style.ts`,
`collections.ts`, `selection.ts`, `document.ts`, and an `index.ts` composing them into
today's `installDocumentFacade`. Pure mechanical moves, one module per commit, tests green
at every step. Target: no file over ~800 lines.

4.2 **Split `realm.ts`** into `src/realm/`: `connect.ts` (iframe bootstrap + Trusted Types),
`dynamic-styles.ts` (the style/link revision pipeline), `navigation.ts` (link/form/
Navigation-API interception), `window.ts` (viewport + window event bridge), `index.ts`.

4.3 **Factor the two histories** — pull the shared entry/state/URL handling out of
`BoundHistory` and `VirtualHistory` into a common base.

4.4 **Benchmark `markVirtualNode`** (finding C3). Add a bench page that mounts a
5k/20k/50k-node guest and measures insertion time and heap. *Only then* decide whether to
move `ownerDocument`/`baseURI`/`getRootNode` from per-node descriptors to prototype-level
patches gated on a `WeakSet` membership check. Do not optimize before the number exists.

4.5 **Add unit tests** — a fast non-browser runner (`node --test` is enough) over
`src/url.ts`, the `src/css.ts` rewriters, `absolutizeSrcset`, and `VirtualHistorySession`.
These become the executable spec for the trickiest pure logic in the repo.

### Phase 5 — Docs and examples

5.1 **Split the README.** Keep: what it is, the iframe/federation tradeoff, install,
30-line quickstart, and a **Limitations** section listing every API that throws (finding
C5) plus the browser requirements. Move the rest to `docs/ssr.md`, `docs/api.md`,
`docs/navigation.md`, `docs/troubleshooting.md`. Link `examples/client` from the root.

5.2 **Write `docs/limitations.md` from the code, not from memory** — grep for
`NotSupportedError` and every `unsupported*` helper in `src/document-facade.ts:4364-4383`
and enumerate them with the reason and the workaround.

5.3 **Shrink the examples.** Recommended: keep `examples/ssr` as the flagship (it
demonstrates the recommended path and exercises four real frameworks). Reduce
`examples/client` to a single guest framework, and **promote the overlay-compatibility lab
into the test suite** — `examples/client/tests/overlays.spec.ts` is testing library
behaviour (top-layer coordinate translation, focus, portals), not demonstrating usage. It
belongs in `tests/`, where CI runs it.
*This is the discretionary one.* If the examples are the marketing, keep them and accept
the maintenance. But they should not be the place where library behaviour is verified.

---

## 5. Suggested order for a single agent

```
Phase 0  (0.1 → 0.6)    independent, do all of it first
Phase 1  (1.1 → 1.4)    1.1 is the single highest-value change in this document
Phase 2  (2.1 → 2.3)    2.1 needs a yes/no from the maintainer first
Phase 3  (3.1 → 3.4)    3.3 validates 3.1/3.2; do not skip it
Phase 4  (4.1 → 4.5)    mechanical, low-risk, high-volume; one module per commit
Phase 5  (5.1 → 5.3)    5.3 needs a product decision
```

Two tasks need a decision from the maintainer before an agent starts them:

- **2.1** — is `credentials="omit"` a promise you want to keep making?
- **5.3** — are the examples marketing, or are they maintenance?

Everything else is unambiguous.

---

## 6. What is deliberately *not* in this plan

- Changing the shadow-root + hidden-realm architecture. It works, the tests prove it, and
  the facade size is a consequence of the design's ambition rather than of poor execution.
- Adding a security boundary. The README is explicit that there isn't one; adding a
  half-boundary would be worse than none.
- Broadening browser support. Requiring the Navigation API and Declarative Shadow DOM is a
  defensible line for a 2026 library.
