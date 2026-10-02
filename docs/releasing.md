# Release checks

A push runs CI but does not publish. A published GitHub release triggers JSR
publication. npm publication is not configured.

Publication requires these checks for the exact tagged commit:

1. The tag is `v` followed by the identical `package.json` and `jsr.json` version.
2. The shared CI workflow passes format, lint, types, build, size, unit tests,
   package-install smoke checks, Chromium/Firefox/WebKit browser tests, touch-device
   emulation, and the real-framework SSR suite.
3. A maintainer records manual browser and assistive-technology verification in
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

Run `pnpm check`, `pnpm exec playwright test`, `pnpm test:package`, and
`pnpm --filter example-ssr test:routing` on the candidate. `pnpm release:check`
checks manifest consistency; passing it alone does not approve a release.
The package smoke check packs and installs the built npm artifact in a temporary
consumer outside the workspace and checks its public imports, declarations and
browser behavior. The JSR CLI separately validates its source publication with
`pnpm exec jsr publish --dry-run`.

CI uploads traces, screenshots and test results on failure. Fix a failure and
create a new verified release candidate; do not bypass a failing browser project.

The lifecycle suite exercises twenty document replacements and checks released
nodes and listeners, plus timed-out, stalled and retried navigation. Its Chromium
performance guard uses a realistic table of roughly 2,500 elements under 4× CPU
throttling: activation must finish within five seconds and appending 100 rows
within one second. These are regression ceilings, not device latency promises;
attached measurements retain the observed times for each run.
