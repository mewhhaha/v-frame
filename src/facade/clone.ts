// A clone of a virtual node has to carry what marking recorded about the
// original — authored URLs and style, the link's real rel, defused handlers and
// the state of a script that has not run yet — because the clone's own
// attributes only hold the rewritten, physical form.

import { FRAGMENT_TARGET_ATTRIBUTE } from "../wire-format.js";
import type { FacadeContext } from "./context.js";
import type { EventFacade } from "./events.js";
import type { NodeInsertion } from "./insertion.js";
import type { NodeMarking } from "./marking.js";
import type { ScriptExecution } from "./script-execution.js";
import type { StyleFacade } from "./style.js";

export interface NodeCloning {
  finishVirtualClone<T extends Node>(source: Node, clone: T): T;
  /**
   * Carries one node's recorded state onto its clone, and a template's whole
   * content. For clones the browser made by itself, such as a range's, whose
   * children cannot be matched to the original's by position.
   */
  copyNodeMetadata(source: Node, clone: Node): void;
  /** What finishVirtualClone does once the metadata is in place. */
  activateVirtualClone<T extends Node>(clone: T): T;
}

export function createNodeCloning(
  context: FacadeContext,
  style: StyleFacade,
  events: EventFacade,
  marking: NodeMarking,
  insertion: NodeInsertion,
  scripts: ScriptExecution,
): NodeCloning {
  const options = context.options;
  const {
    nativeRemoveAttribute,
    isElementNode,
    isHTMLTemplateElement,
    isHTMLLinkElement,
    isHTMLScriptElement,
    createdScripts,
    protectedScriptAttributes,
    eventAttributeValues,
    cssomMutatedStyleElements,
    authoredLinkRelValues,
  } = context;
  const {
    updateInlineStyle,
    removeStyleSelector,
    ensureStyleSelector,
    synchronizePhysicalLinkRel,
  } = style;
  const { compileEventAttribute } = events;
  const { markVirtualNode } = marking;
  const { collectElements } = insertion;
  const { dynamicScriptExecution, executedScripts } = scripts;

  const copyElementMetadata = (source: Node, clone: Node): void => {
    if (isElementNode(source) && isElementNode(clone)) {
      // Target state belongs to the selected element, not to its attributes.
      nativeRemoveAttribute.call(clone, FRAGMENT_TARGET_ATTRIBUTE);
      const authoredAttributes = options.authoredURLAttributes.get(source);
      if (authoredAttributes !== undefined) {
        options.authoredURLAttributes.set(clone, new Map(authoredAttributes));
      }
      const authoredStyle = options.authoredStyleAttributes.get(source);
      if (authoredStyle !== undefined) {
        options.authoredStyleAttributes.set(clone, authoredStyle);
        if (cssomMutatedStyleElements.has(source)) {
          cssomMutatedStyleElements.add(clone);
        }
        removeStyleSelector(clone);
        ensureStyleSelector(clone);
      }
      if (isHTMLLinkElement(source) && isHTMLLinkElement(clone)) {
        authoredLinkRelValues.set(clone, authoredLinkRelValues.get(source) ?? null);
        synchronizePhysicalLinkRel(clone);
      }
      const eventAttributes = eventAttributeValues.get(source);
      if (eventAttributes !== undefined) {
        eventAttributeValues.set(clone, new Map(eventAttributes));
      }
      if (isHTMLScriptElement(source) && isHTMLScriptElement(clone)) {
        const scriptAttributes = protectedScriptAttributes.get(source);
        if (scriptAttributes !== undefined) {
          protectedScriptAttributes.set(clone, new Map(scriptAttributes));
        }
        if (createdScripts.has(source) && !executedScripts.has(source)) {
          createdScripts.add(clone);
          const execution = dynamicScriptExecution.get(source);
          if (execution !== undefined) {
            dynamicScriptExecution.set(clone, execution);
          }
        }
      }
    }
  };

  const copyVirtualMetadata = (source: Node, clone: Node): void => {
    copyElementMetadata(source, clone);
    const sourceChildren = Array.from(source.childNodes);
    const cloneChildren = Array.from(clone.childNodes);
    for (let index = 0; index < sourceChildren.length; index += 1) {
      const sourceChild = sourceChildren[index];
      const cloneChild = cloneChildren[index];
      if (sourceChild !== undefined && cloneChild !== undefined) {
        copyVirtualMetadata(sourceChild, cloneChild);
      }
    }
    if (
      isElementNode(source) &&
      isElementNode(clone) &&
      isHTMLTemplateElement(source) &&
      isHTMLTemplateElement(clone)
    ) {
      copyVirtualMetadata(source.content, clone.content);
    }
  };

  const copyNodeMetadata = (source: Node, clone: Node): void => {
    copyElementMetadata(source, clone);
    if (
      isElementNode(source) &&
      isElementNode(clone) &&
      isHTMLTemplateElement(source) &&
      isHTMLTemplateElement(clone)
    ) {
      copyVirtualMetadata(source.content, clone.content);
    }
  };

  const activateVirtualClone = <T extends Node>(clone: T): T => {
    markVirtualNode(clone);
    for (const element of collectElements(clone)) {
      updateInlineStyle(element);
      const eventAttributes = eventAttributeValues.get(element);
      if (eventAttributes === undefined) {
        continue;
      }
      for (const [attributeName, value] of eventAttributes) {
        compileEventAttribute(element, attributeName, value);
      }
    }
    return clone;
  };

  const finishVirtualClone = <T extends Node>(source: Node, clone: T): T => {
    copyVirtualMetadata(source, clone);
    return activateVirtualClone(clone);
  };

  return { finishVirtualClone, copyNodeMetadata, activateVirtualClone };
}
