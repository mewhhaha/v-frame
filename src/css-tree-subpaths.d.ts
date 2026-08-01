// css-tree 3.x publishes lexer-free subpath entries, but @types/css-tree only
// declares the package root. Importing the subpaths keeps the lexer and its
// 81 KB syntax-definition table (css-tree/dist/data.js) out of the bundle; this
// file borrows the root declarations so the call sites stay fully typed.
declare module "css-tree/parser" {
  import type { parse } from "css-tree";

  const parser: typeof parse;
  export default parser;
}

declare module "css-tree/generator" {
  import type { generate } from "css-tree";

  const generator: typeof generate;
  export default generator;
}

declare module "css-tree/walker" {
  import type { walk } from "css-tree";

  const walker: typeof walk;
  export default walker;
}
