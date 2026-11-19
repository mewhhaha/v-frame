// Scope the upstream types to our adapter; JSR rejects ambient module declarations.
import type { CssNode } from "css-tree";
export { clone, ident, parse, walk } from "css-tree";
export function generate(node: CssNode): string;
