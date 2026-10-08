// @ts-self-types="./css-tree-subpaths.d.ts"

// css-tree 3.x publishes lexer-free subpath entries, but @types/css-tree only
// declares the package root. Keep the lexer and its syntax-definition table out
// of the runtime bundle while borrowing the root types in the sibling .d.ts.
export { default as generate } from "css-tree/generator";
export { default as parse } from "css-tree/parser";
export { clone, ident } from "css-tree/utils";
export { default as walk } from "css-tree/walker";
