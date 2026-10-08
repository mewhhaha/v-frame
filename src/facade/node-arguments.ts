// Argument checks shared by the patched tree-mutation methods and the markup
// patches. They answer for nodes of any realm, which is why they do not use
// instanceof.

import type { FacadeContext } from "./context.js";
import { toDOMString } from "./webidl.js";

export interface NodeArguments {
  isNodeValue(value: unknown): value is Node;
  requireNode(value: unknown, method: string, argument: number): void;
  toNodes(values: readonly unknown[]): Node[];
}

export function createNodeArguments(context: FacadeContext): NodeArguments {
  const { window, document, nodePrototype } = context;

  // The Node branding check, borrowed from the realm so that it also answers for
  // nodes of any other realm. Reading the argument's own properties instead is
  // what turns a mistake like appendChild(null) into an unrelated TypeError.
  const nativeNodeType = Object.getOwnPropertyDescriptor(nodePrototype, "nodeType")!.get!;
  const isNodeValue = (value: unknown): value is Node => {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    try {
      nativeNodeType.call(value);
      return true;
    } catch {
      return false;
    }
  };
  const requireNode = (value: unknown, method: string, argument: number): void => {
    if (!isNodeValue(value)) {
      throw new window.TypeError(
        `Failed to execute '${method}' on 'Node': parameter ${argument} is not of type 'Node'.`,
      );
    }
  };
  // `(Node or DOMString)` arguments: anything that is not a node becomes text.
  const toNodes = (values: readonly unknown[]): Node[] =>
    values.map((value) =>
      isNodeValue(value) ? value : (document.createTextNode(toDOMString(value)) as Node),
    );

  return { isNodeValue, requireNode, toNodes };
}
