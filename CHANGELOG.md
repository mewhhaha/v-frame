# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

The package has never been published. Its version was corrected from `1.0.0` to
`0.1.0`, because the behaviour changes planned in
[`docs/cleanup-plan.md`](./docs/cleanup-plan.md) still come before a stable
release.

### Added

- `v-frame/server`, the server-side materializer for the adopted (SSR) path. It
  exports a runtime-neutral core — shell tag renaming, the injected display
  rules, script neutralization, and stylesheet rewriting — that a host drives
  from its own streaming HTML parser, plus `materializeVFrameDocument`, a
  Cloudflare `HTMLRewriter` adapter over that core. `createStylesheetContext`
  and `rewriteStylesheet` are exported from the same entry so a Node host can
  write its own adapter without copying CSS logic.
- Continuous integration: typecheck, build, and the Playwright suite on chromium
  and firefox for every push and pull request.
- Typechecking for `tests/` and `examples/*/shared/` through
  `tsconfig.test.json`.
- A gzip bundle-size budget (`pnpm size`) that fails the build above its
  threshold.

### Changed

- The published bundles are minified, and `css-tree` is imported through its
  `parser`, `generator`, and `walker` subpaths so the unused lexer tables are no
  longer shipped: 97 KB to 63 KB gzip.
- Biome formats the repository, freezing the existing house style.
- `examples/ssr` imports `v-frame/server` instead of reaching into `src/`.

### Removed

- The generated Cloudflare `worker-configuration.d.ts` files are no longer
  tracked; each example application regenerates them with `wrangler types`.
