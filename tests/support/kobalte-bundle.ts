import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

/**
 * Kobalte is already pinned by examples/client's Solid microfrontend, so the suite
 * resolves it from that workspace instead of pinning a second copy that could drift.
 * Bundling the guest entry here — rather than depending on the example's own build, or
 * committing its output — keeps the root suite hermetic: no network, no framework
 * toolchain, and no build artifact that can go stale against the source next to it.
 * esbuild is already a dependency and the bundle takes about 30 ms.
 */
const kobalteModules = resolve(
  process.cwd(),
  "examples/client/microfrontends/solid-app/node_modules",
);
const labEntry = resolve(process.cwd(), "tests/support/kobalte-overlay-lab.js");

/** The guest module text, ready to be served as a route by the fixture server. */
export async function bundleKobalteLab(): Promise<string> {
  if (!existsSync(kobalteModules)) {
    throw new Error(
      `Kobalte is missing from ${kobalteModules}. The overlay suite takes it from examples/client's Solid microfrontend, which a workspace-wide "pnpm install" provides.`,
    );
  }
  const bundled = await build({
    entryPoints: [labEntry],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    // The entry lives outside the workspace that owns Kobalte, so node resolution needs
    // to be pointed at it explicitly.
    nodePaths: [kobalteModules],
  });
  const output = bundled.outputFiles[0];
  if (output === undefined) {
    throw new Error("esbuild produced no output for the Kobalte overlay lab");
  }
  return output.text;
}
