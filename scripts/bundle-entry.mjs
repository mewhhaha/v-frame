import { rolldown } from "rolldown";

// The CSS adapter only emits CSS text. css-tree's optional source-map backend
// otherwise brings its CommonJS generator into every standalone browser build.
export function bundleEntry(input, platform, external = []) {
  return rolldown({
    input,
    platform,
    external,
    transform: { target: "es2022" },
    plugins: [
      {
        name: "css-text-only",
        load(id) {
          if (id.endsWith("/css-tree/lib/generator/sourceMap.js")) {
            return 'export function generateSourceMap() { throw new Error("The v-frame CSS adapter emits CSS text only") }';
          }
        },
      },
    ],
  });
}
