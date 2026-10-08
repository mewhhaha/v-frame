# Release checks

CI runs on pull requests and on pushes to `main`, and a newer push to a pull
request cancels the run in flight; it never publishes. A published GitHub release
triggers JSR publication. npm publication is not configured.

Publication requires these checks for the exact tagged commit:

1. The tag is `v` followed by the identical `package.json` and `jsr.json` version.
2. `CHANGELOG.md` has a non-empty `## <version>` section for that version (see
   [Changelog](#changelog)).
3. The shared CI workflow passes format, lint, types, build, size, unit tests,
   the JSR dry run, package-install smoke checks, Chromium/Firefox/WebKit browser
   tests, touch-device emulation, and the real-framework SSR suite.
4. A maintainer records manual browser and assistive-technology verification in
   the release notes, bound to that commit's full SHA.

Use these lines in the release notes only after performing the checks:

```text
Manual verification commit: <full 40-character commit SHA>
- [x] macOS Safari + VoiceOver
- [x] iOS Safari + VoiceOver
- [x] Windows Firefox + NVDA
```

Also record the tester, date, device/OS/browser versions, screen-reader version,
and observed results. This is a maintainer attestation, not an automated
screen-reader test. Playwright WebKit is not real Safari or a real iPhone.
Unchecked or missing entries, or a SHA different from the release commit, block
publication; do not tick the boxes on the strength of automated scans.

## Changelog

Record changes in `CHANGELOG.md` as they land, under a `## Unreleased` heading at
the top. To release, bump the version in `package.json` and `jsr.json` and rename
that heading to `## <version> - <date>`. `scripts/release-check.ts` enforces this:

- On every CI run (`pnpm release:check`), the manifest version must have a
  `## <version>` section or the changelog must have a `## Unreleased` section, so a
  version bump cannot skip the changelog.
- On a release (`--release`, run by the publish workflow before anything else),
  the manifest version must have a `## <version>` section with notes in it. An
  `## Unreleased` heading alone, a missing heading or an empty section blocks
  publication.

A bracketed heading such as `## [0.2.0] - 2026-10-20` is also accepted.

## Manual verification

Use the SSR example with a cold cache and a throttled network. For each platform:

- Confirm useful styled guest content before JavaScript, with no blank or doubled
  guest at activation. Edit a field while startup is delayed; verify its value,
  caret and focus survive. On iOS, include the software keyboard and IME input.
- Navigate landmarks, headings, labels and live announcements with the reader.
  The hidden execution iframe must not appear as an extra interactive document.
- Traverse host and guest controls in both directions. Open native dialog and
  popover surfaces, use Escape/outside dismissal, and verify focus restoration.
- Exercise the Solid account menu and its modal focus trap, including touch,
  scrolling and orientation changes. Check content stays inside the viewport.
- Check zoom/text enlargement, reduced motion, and contrast settings without
  clipped controls or inaccessible dismissal paths.
- Navigate between SSR routes, reload, retry a failed guest, and remove/remount
  frames. Confirm no stale announcement, input, listener or painted old page.

The browser baseline requires Declarative Shadow DOM and the Navigation API's
`NavigateEvent.intercept`. Old Safari/iOS versions without those APIs are not
supported. Feature tests verify unsupported engines fail explicitly.

## Local checks

Node 22.18.0 or newer runs every development script (`devEngines.runtime` in
`package.json`; pnpm refuses to run on an older Node). 22.18 is where native type
stripping, which `release:check`, `test:unit` and `bench` depend on, is on by
default; `scripts/release-check.ts` also uses `import.meta.main`. `.nvmrc` is the
version CI runs, not the minimum. The published package is browser and Worker
code with no Node requirement. The Angular app in the SSR example is stricter,
and its CLI reports the Node versions it accepts.

For the inner loop, run `pnpm check:fast`. It runs `format:check`, `lint`,
`typecheck` (`tsc --noEmit` over `src/`, then `tsconfig.test.json`), `test:unit`
and `size`, takes a few seconds, and needs neither `dist/` nor a browser. When a
change needs a browser, `pnpm test:e2e:chromium` runs `build` and then Playwright
in Chromium only; append spec files or `-g` to narrow it, for example
`pnpm test:e2e:chromium tests/selection.spec.ts`. Firefox and WebKit differences
only surface in the full run below.

Before a release candidate, run `pnpm check` and `pnpm --filter example-ssr test:routing`.
`pnpm check` is exactly what the CI `check` job runs, in this order, stopping at
the first failure (the browsers it needs come from
`pnpm exec playwright install --with-deps chromium firefox webkit`):

1. `format:check` and `lint`.
2. `build` bundles `dist/` with Rolldown and emits declarations with
   `tsc --emitDeclarationOnly`. The declaration emit also typechecks `src/`
   against `tsconfig.json`, so the pipeline does not run a separate pass over it.
3. `typecheck:tests` typechecks `tsconfig.test.json`: the specs, benchmarks, the
   client example and the SSR example's browser entries (`client.ts` and
   `host-config.ts`). `pnpm typecheck` runs both projects without building. The SSR
   example's Worker entries, including `apps/host/src/index.ts`, and its other apps
   need wrangler's generated Worker types, so they are checked by the CI
   `example-ssr` job with `pnpm build`, then `pnpm --filter example-ssr run types`
   (offline) and `pnpm --filter example-ssr run typecheck`, before `test:routing`.
4. `size`, `release:check` and `test:unit`.
5. `publish:dry-run` validates the JSR publication (`jsr publish --dry-run`). It
   allows a dirty tree so it can run before committing; the publish workflow does not.
6. `test:package` packs `dist/` and installs the tarball in a temporary consumer
   outside the workspace, then checks its public imports, declarations and browser
   behavior. This is the same `exports` map the workspace examples resolve.
7. `test:e2e` runs Playwright against `dist/`, so it needs the `build` step first;
   run `pnpm build` before it on its own, or use `test:e2e:chromium`, which does.

`pnpm release:check` checks manifest and changelog consistency; passing it alone
does not approve a release.

CI uploads traces, screenshots and test results on failure. Fix a failure and
create a new verified release candidate; do not bypass a failing browser project.

The lifecycle suite exercises twenty document replacements and checks released
nodes and listeners, plus timed-out, stalled and retried navigation. Its Chromium
performance guard uses a realistic table of roughly 2,500 elements under 4× CPU
throttling: activation must finish within five seconds and appending 100 rows
within one second. These are regression ceilings, not device latency promises;
attached measurements retain the observed times for each run.
