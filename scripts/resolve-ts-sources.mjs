import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// src/ imports itself with the ".js" specifiers the emitted declarations need, but
// node's type stripping resolves specifiers literally and never rewrites them. This
// hook lets `node --test` and the bench driver load the TypeScript sources directly
// instead of forcing a build step or a second copy of every import path.
function resolveTypeScriptSource(specifier, context, nextResolve) {
  if (
    context.parentURL !== undefined &&
    specifier.startsWith(".") &&
    specifier.endsWith(".js")
  ) {
    const target = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(target))) {
      const source = new URL(
        `${specifier.slice(0, -".js".length)}.ts`,
        context.parentURL,
      );
      if (existsSync(fileURLToPath(source))) {
        return { url: source.href, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}

registerHooks({ resolve: resolveTypeScriptSource });
