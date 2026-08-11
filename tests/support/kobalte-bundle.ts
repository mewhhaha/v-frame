import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { rolldown } from "rolldown";

/**
 * Kobalte is already pinned by examples/client's Solid microfrontend, so the suite
 * resolves it from that workspace instead of pinning a second copy that could drift.
 * Bundling the guest entry here — rather than depending on the example's own build, or
 * committing its output — keeps the root suite hermetic: no network, no framework
 * toolchain, and no build artifact that can go stale against the source next to it.
 * Rolldown is already a dependency and keeps this fixture on the same bundler as the
 * published package.
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
  const bundle = await rolldown({
    input: labEntry,
    platform: "browser",
    // The entry lives outside the workspace that owns Kobalte, so node resolution needs
    // to be pointed at it explicitly.
    resolve: { modules: [kobalteModules, "node_modules"] },
  });
  try {
    const generated = await bundle.generate({ format: "es" });
    const output = generated.output.find((entry) => entry.type === "chunk");
    if (output === undefined) {
      throw new Error("Rolldown produced no output for the Kobalte overlay lab");
    }
    return output.code;
  } finally {
    await bundle.close();
  }
}
