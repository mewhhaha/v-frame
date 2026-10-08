// Markup is parsed in an inert document and moved into the realm, so that the
// parser's context rules (table modes, foreign content, raw text) apply without
// the guest's custom elements, scripts or handlers running early. These are the
// entry points that take markup — innerHTML, outerHTML, insertAdjacentHTML —
// plus insertAdjacentElement, which shares their position handling. Their
// getters live here too: marking rewrites the physical tree (inline style
// becomes a selector, handlers and the inert script's src and type are held
// aside, URLs are absolutized), so serializing it as it stands would not give
// back what the guest authored.

import type { AttributeFacade } from "./attributes.js";
import type { FacadeContext } from "./context.js";
import type { NodeMarking } from "./marking.js";
import type { NodeArguments } from "./node-arguments.js";
import { toDOMString, toLegacyNullToEmptyString } from "./webidl.js";

export interface MarkupFacade {
  installPatches(): void;
}

export function installMarkupFacade(
  context: FacadeContext,
  marking: NodeMarking,
  nodeArguments: NodeArguments,
  attributes: AttributeFacade,
): MarkupFacade {
  const options = context.options;
  const {
    window,
    document,
    elementPrototype,
    nativeCreateElement,
    nativeAppendChild,
    nativeReplaceChild,
    nativeImportNode,
    nativeSetAttributeNS,
    nativeInnerHTML,
    nativeOuterHTML,
    nativeSetAttribute,
    isElementNode,
    isHTMLTemplateElement,
    virtualNodes,
    patch,
    nativeFragmentQuerySelectorAll,
  } = context;
  const { markVirtualNode, adoptAndMark } = marking;
  const { isNodeValue } = nodeArguments;
  const { getVirtualAttribute, getVirtualAttributeNames } = attributes;

  // Parse in an inert document, but use the destination's context: a template
  // alone loses table insertion modes, foreign namespaces and raw-text parsing.
  const fragmentDocument = new window.DOMParser().parseFromString(
    options.createHTML("<!doctype html><html><body></body></html>"),
    "text/html",
  );
  const parseFragment = (
    markup: string,
    destination: Element | null,
  ): DocumentFragment => {
    const shellName =
      destination === options.html
        ? "html"
        : destination === options.head
          ? "head"
          : destination === options.body
            ? "body"
            : null;
    const parserContext =
      destination === null || shellName !== null
        ? fragmentDocument.createElement(shellName ?? "body")
        : (nativeImportNode.call(fragmentDocument, destination, false) as Element);
    nativeInnerHTML.set?.call(parserContext, options.createHTML(markup));
    const fragment = fragmentDocument.createDocumentFragment();
    const parsedRoot = isHTMLTemplateElement(parserContext)
      ? parserContext.content
      : parserContext;
    while (parsedRoot.firstChild !== null) {
      nativeAppendChild.call(fragment, parsedRoot.firstChild);
    }
    const parsedElements = Array.from(
      nativeFragmentQuerySelectorAll.call(fragment, "*"),
    ).reverse();
    for (const parsedElement of parsedElements) {
      const customizedName = parsedElement.getAttribute("is");
      const customName =
        customizedName !== null && window.customElements.get(customizedName) !== undefined
          ? customizedName
          : parsedElement.localName;
      if (window.customElements.get(customName) === undefined) {
        continue;
      }
      const creationOptions =
        customName === customizedName ? { is: customName } : undefined;
      const customElement = nativeCreateElement.call(
        document,
        parsedElement.localName,
        creationOptions,
      );
      for (const attribute of Array.from(parsedElement.attributes)) {
        nativeSetAttributeNS.call(
          customElement,
          attribute.namespaceURI,
          attribute.name,
          attribute.value,
        );
      }
      while (parsedElement.firstChild !== null) {
        nativeAppendChild.call(customElement, parsedElement.firstChild);
      }
      nativeReplaceChild.call(parsedElement.parentNode, customElement, parsedElement);
    }
    return adoptAndMark(fragment);
  };

  // An element's attributes as the guest authored them, written onto a copy of
  // it. The copy is left alone when nothing differs, which is the common case.
  const restoreAuthoredAttributes = (source: Element, copy: Element): void => {
    const names = getVirtualAttributeNames(source);
    const physical: Attr[] = Array.from(copy.attributes);
    if (
      names.length === physical.length &&
      names.every(
        (name, index) =>
          physical[index]?.name === name &&
          physical[index]?.value === getVirtualAttribute(source, name),
      )
    ) {
      return;
    }
    // Rebuilt in the logical order. Attributes the facade does not manage go
    // back as the very nodes they were, so names the parser accepted but
    // setAttribute would reject survive.
    const byName = new Map(physical.map((attribute) => [attribute.name, attribute]));
    for (const attribute of physical) {
      copy.removeAttributeNode(attribute);
    }
    for (const name of names) {
      const value = getVirtualAttribute(source, name) ?? "";
      const attribute = byName.get(name);
      if (attribute === undefined) {
        nativeSetAttribute.call(copy, name, value);
      } else {
        attribute.value = value;
        copy.setAttributeNode(attribute);
      }
    }
  };

  // A copy made in the inert document, so no custom element of the guest is
  // constructed and nothing loads, with the authored attributes restored on every
  // virtual element. The native serializer then produces what a browser would for
  // the guest's own tree. Proportional to the subtree, like serializing it.
  function authoredCopy(source: Element): Element;
  function authoredCopy(source: Node): Node;
  function authoredCopy(source: Node): Node {
    // Documents and shadow roots cannot be imported. Build a serializable root
    // from their visible children instead; the guest document's children are
    // its doctype and shell, not the hidden execution document's physical tree.
    let copy: Node;
    if (source === document || source.nodeType === 11) {
      copy =
        source === document
          ? fragmentDocument.implementation.createDocument(null, "")
          : fragmentDocument.createDocumentFragment();
      for (const child of Array.from(source.childNodes)) {
        // WebKit also rejects importing doctypes, though it can create them.
        const childCopy =
          child.nodeType === 10
            ? fragmentDocument.implementation.createDocumentType(
                (child as DocumentType).name,
                (child as DocumentType).publicId,
                (child as DocumentType).systemId,
              )
            : nativeImportNode.call(fragmentDocument, child, true);
        nativeAppendChild.call(copy, childCopy);
      }
    } else {
      copy = nativeImportNode.call(fragmentDocument, source, true);
    }
    const pending: Array<[Node, Node]> = [[source, copy]];
    for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
      const [from] = pair;
      let [, to] = pair;
      if (isElementNode(from) && isElementNode(to)) {
        let elementCopy = to;
        const shellName =
          from === options.html
            ? "html"
            : from === options.head
              ? "head"
              : from === options.body
                ? "body"
                : null;
        if (shellName !== null) {
          const shell = nativeCreateElement.call(fragmentDocument, shellName);
          for (const attribute of Array.from(to.attributes)) {
            to.removeAttributeNode(attribute);
            shell.setAttributeNodeNS(attribute);
          }
          while (to.firstChild !== null) nativeAppendChild.call(shell, to.firstChild);
          if (to.parentNode !== null) nativeReplaceChild.call(to.parentNode, shell, to);
          if (to === copy) copy = shell;
          to = shell;
          elementCopy = shell;
        }
        if (virtualNodes.has(from)) {
          restoreAuthoredAttributes(from, elementCopy);
        }
        if (isHTMLTemplateElement(from) && isHTMLTemplateElement(elementCopy)) {
          pending.push([from.content, elementCopy.content]);
        }
      }
      let fromChild = from.firstChild;
      let toChild = to.firstChild;
      while (fromChild !== null && toChild !== null) {
        pending.push([fromChild, toChild]);
        fromChild = fromChild.nextSibling;
        toChild = toChild.nextSibling;
      }
    }
    return copy;
  }

  const installPatches = (): void => {
    const insertionPositions = ["beforebegin", "afterbegin", "beforeend", "afterend"];
    const insertionPosition = (position: unknown): InsertPosition => {
      const normalized = toDOMString(position).toLowerCase();
      if (!insertionPositions.includes(normalized)) {
        throw new window.DOMException(
          `Invalid insertion position ${toDOMString(position)}`,
          "SyntaxError",
        );
      }
      return normalized as InsertPosition;
    };

    patch(elementPrototype, "insertAdjacentHTML", {
      writable: true,
      value(this: Element, position: InsertPosition, text: string) {
        // Both arguments convert, and the position is checked, before any
        // markup is parsed: parsing runs custom element constructors.
        const markup = toDOMString(text);
        const where = insertionPosition(position);
        const outside = where === "beforebegin" || where === "afterend";
        if (
          outside &&
          (this.parentNode === null ||
            this.parentNode.nodeType === window.Node.DOCUMENT_NODE)
        ) {
          throw new window.DOMException(
            "The element has no insertion parent",
            "NoModificationAllowedError",
          );
        }
        const destination = outside ? this.parentElement : this;
        const fragment = parseFragment(
          markup,
          destination === options.html ? null : destination,
        );
        switch (where) {
          case "beforebegin":
            this.parentNode?.insertBefore(fragment, this);
            return;
          case "afterbegin":
            this.insertBefore(fragment, this.firstChild);
            return;
          case "beforeend":
            this.appendChild(fragment);
            return;
          case "afterend":
            this.parentNode?.insertBefore(fragment, this.nextSibling);
            return;
        }
      },
    });

    patch(elementPrototype, "insertAdjacentElement", {
      writable: true,
      value(this: Element, position: InsertPosition, element: Element): Element | null {
        if (!isNodeValue(element) || element.nodeType !== 1) {
          throw new window.TypeError(
            "Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.",
          );
        }
        switch (insertionPosition(position)) {
          case "beforebegin":
            if (this.parentNode === null) {
              return null;
            }
            this.parentNode.insertBefore(element, this);
            return element;
          case "afterbegin":
            this.insertBefore(element, this.firstChild);
            return element;
          case "beforeend":
            this.appendChild(element);
            return element;
          case "afterend":
            if (this.parentNode === null) {
              return null;
            }
            this.parentNode.insertBefore(element, this.nextSibling);
            return element;
        }
      },
    });

    patch(elementPrototype, "innerHTML", {
      get(this: Element) {
        const getter = nativeInnerHTML.get;
        if (getter === undefined) {
          return "";
        }
        return getter.call(virtualNodes.has(this) ? authoredCopy(this) : this) as string;
      },
      set(this: Element, value: string | null) {
        // [LegacyNullToEmptyString]: null clears, and must not reach
        // createHTML as the text "null".
        const markup = toLegacyNullToEmptyString(value);
        if (!virtualNodes.has(this)) {
          nativeInnerHTML.set?.call(this, options.createHTML(markup));
          return;
        }
        if (isHTMLTemplateElement(this)) {
          nativeInnerHTML.set?.call(this, options.createHTML(markup));
          markVirtualNode(this.content);
          return;
        }
        const fragment = parseFragment(markup, this);
        this.replaceChildren(fragment);
      },
    });

    if (nativeOuterHTML?.get !== undefined && nativeOuterHTML.set !== undefined) {
      patch(elementPrototype, "outerHTML", {
        get(this: Element) {
          return nativeOuterHTML.get!.call(
            virtualNodes.has(this) ? authoredCopy(this) : this,
          ) as string;
        },
        set(this: Element, value: string | null) {
          const markup = toLegacyNullToEmptyString(value);
          if (!virtualNodes.has(this)) {
            nativeOuterHTML.set?.call(this, options.createHTML(markup));
            return;
          }
          if (this.parentNode === null) {
            return;
          }
          const parent = this.parentNode;
          if (parent.nodeType === window.Node.DOCUMENT_NODE) {
            throw new window.DOMException(
              "Cannot replace the document element",
              "NoModificationAllowedError",
            );
          }
          // One replacement, as natively: observers see a single record.
          parent.replaceChild(parseFragment(markup, this.parentElement), this);
        },
      });
    }

    const nativeGetHTML = (
      elementPrototype as { getHTML?: (this: Element, init?: GetHTMLOptions) => string }
    ).getHTML;
    if (nativeGetHTML !== undefined) {
      patch(elementPrototype, "getHTML", {
        writable: true,
        value(this: Element, init?: GetHTMLOptions) {
          return nativeGetHTML.call(
            virtualNodes.has(this) ? authoredCopy(this) : this,
            init,
          );
        },
      });
    }

    // The serializer reads the physical tree too.
    const serializerPrototype = window.XMLSerializer?.prototype;
    const nativeSerialize = serializerPrototype?.serializeToString;
    if (serializerPrototype !== undefined && nativeSerialize !== undefined) {
      patch(serializerPrototype, "serializeToString", {
        writable: true,
        value(this: XMLSerializer, node: Node) {
          const authored =
            node === document ||
            (isNodeValue(node) &&
              virtualNodes.has(node) &&
              (node.nodeType === 1 || node.nodeType === 11));
          return nativeSerialize.call(this, authored ? authoredCopy(node) : node);
        },
      });
    }
  };

  return { installPatches };
}
