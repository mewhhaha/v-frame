// Markup is parsed in an inert document and moved into the realm, so that the
// parser's context rules (table modes, foreign content, raw text) apply without
// the guest's custom elements, scripts or handlers running early. These are the
// entry points that take markup — innerHTML, outerHTML, insertAdjacentHTML —
// plus insertAdjacentElement, which shares their position handling. Their
// getters live here too: marking rewrites the physical tree (inline style
// becomes a selector, handlers and the inert script's src and type are held
// aside, URLs are absolutized), so serializing it as it stands would not give
// back what the guest authored.

import { FRAGMENT_TARGET_ATTRIBUTE } from "../wire-format.js";
import type { AttributeFacade } from "./attributes.js";
import { HTML_NAMESPACE, type FacadeContext } from "./context.js";
import type { NodeInsertion } from "./insertion.js";
import type { NodeMarking } from "./marking.js";
import type { NodeArguments } from "./node-arguments.js";
import { toDOMString } from "./webidl.js";

export interface MarkupFacade {
  installPatches(): void;
}

export function installMarkupFacade(
  context: FacadeContext,
  marking: NodeMarking,
  insertion: NodeInsertion,
  nodeArguments: NodeArguments,
  attributes: AttributeFacade,
): MarkupFacade {
  const options = context.options;
  const {
    window,
    document,
    hostDocument,
    elementPrototype,
    nativeCreateElement,
    nativeCreateDocumentFragment,
    nativeAppendChild,
    nativeReplaceChild,
    nativeImportNode,
    nativeSetAttributeNS,
    nativeHasAttributes,
    nativeHasAttribute,
    nativeInnerHTML,
    nativeOuterHTML,
    nativeSetAttribute,
    nativeFirstChild,
    nativeLocalName,
    nativeNamespaceURI,
    getInertDocument,
    isElementNode,
    isHTMLTemplateElement,
    virtualNodes,
    fragmentNodes,
    protectedScriptAttributes,
    eventAttributeValues,
    authoredLinkRelValues,
    patch,
    nativeFragmentQuerySelectorAll,
  } = context;
  const { markVirtualNode, adoptAndMark } = marking;
  const { insertDirect, replaceElementChildren, replaceNodeWith } = insertion;
  const { isNodeValue } = nodeArguments;
  const { getVirtualAttribute, getVirtualAttributeNames } = attributes;

  const markFragmentElements = (root: DocumentFragment): void => {
    for (const element of nativeFragmentQuerySelectorAll.call(root, "*")) {
      fragmentNodes.add(element);
      if (element.shadowRoot !== null) {
        markFragmentElements(element.shadowRoot);
      }
      if (isHTMLTemplateElement(element)) {
        markFragmentElements(element.content);
      }
    }
  };

  const nativeSetHTMLUnsafe = (
    elementPrototype as {
      setHTMLUnsafe?: (this: Element, html: string) => void;
    }
  ).setHTMLUnsafe;
  const readFirstChild = (node: Node): ChildNode | null =>
    nativeFirstChild !== undefined
      ? (nativeFirstChild.call(node) as ChildNode | null)
      : node.firstChild;
  const readLocalName = (element: Element): string =>
    nativeLocalName !== undefined
      ? (nativeLocalName.call(element) as string)
      : element.localName;
  const readNamespaceURI = (element: Element): string | null =>
    nativeNamespaceURI !== undefined
      ? (nativeNamespaceURI.call(element) as string | null)
      : element.namespaceURI;

  // Reentrancy-safe pool of empty inert HTML context elements for parseFragment.
  const parserContextPool = new Map<string, Element>();

  function parseFragment(
    markup: string,
    destination: Element | null,
    unsafe?: boolean,
    markImmediately?: boolean,
    allowSingleChild?: false,
  ): DocumentFragment;
  function parseFragment(
    markup: string,
    destination: Element | null,
    unsafe: boolean,
    markImmediately: boolean,
    allowSingleChild: true,
  ): Node | null;
  function parseFragment(
    markup: string,
    destination: Element | null,
    unsafe = false,
    markImmediately = true,
    allowSingleChild = false,
  ): Node | null {
    const fragmentDocument = getInertDocument();
    const shellName =
      destination === options.html
        ? "html"
        : destination === options.head
          ? "head"
          : destination === options.body
            ? "body"
            : null;
    let poolKey: string | null = null;
    let parserContext: Element;
    if (destination === null || shellName !== null) {
      poolKey = shellName ?? "body";
    } else {
      const destLocalName = readLocalName(destination);
      if (
        readNamespaceURI(destination) === HTML_NAMESPACE &&
        !destLocalName.includes("-") &&
        destLocalName === destLocalName.toLowerCase()
      ) {
        if (destLocalName !== "template") {
          poolKey = destLocalName;
        } else {
          parserContext = nativeCreateElement.call(fragmentDocument, destLocalName);
        }
      } else {
        parserContext = nativeImportNode.call(
          fragmentDocument,
          destination,
          false,
        ) as Element;
      }
    }
    if (poolKey !== null) {
      const pooled = parserContextPool.get(poolKey);
      if (pooled !== undefined) {
        parserContextPool.delete(poolKey);
        parserContext = pooled;
      } else {
        parserContext = nativeCreateElement.call(fragmentDocument, poolKey);
      }
    }
    try {
      if (unsafe && nativeSetHTMLUnsafe !== undefined) {
        nativeSetHTMLUnsafe.call(parserContext!, markup);
      } else {
        nativeInnerHTML.set?.call(parserContext!, markup);
      }
      const parsedRoot: Node =
        poolKey === null && isHTMLTemplateElement(parserContext!)
          ? (parserContext! as HTMLTemplateElement).content
          : parserContext!;
      if (allowSingleChild && readFirstChild(parsedRoot) === null) {
        return null;
      }
      // Single pass marks fragment provenance and collects custom-element upgrades
      // only for tags with a hyphen or an `is` attribute (spec requirement).
      let customCandidates: Element[] | undefined;
      const scanFragment = (root: Node, inTemplate: boolean): void => {
        for (
          let child = readFirstChild(root);
          child !== null;
          child = child.nextSibling
        ) {
          if (child.nodeType !== 1) continue;
          const element = child as Element;
          fragmentNodes.add(element);
          if (
            !inTemplate &&
            readNamespaceURI(element) === HTML_NAMESPACE &&
            (readLocalName(element).includes("-") ||
              nativeHasAttribute.call(element, "is"))
          ) {
            (customCandidates ??= []).push(element);
          }
          if (readFirstChild(element) !== null) {
            scanFragment(element, inTemplate);
          }
          if (element.shadowRoot !== null) {
            scanFragment(element.shadowRoot, inTemplate);
          }
          if (readLocalName(element) === "template" && isHTMLTemplateElement(element)) {
            scanFragment(element.content, true);
          }
        }
      };
      scanFragment(parsedRoot, false);
      let upgradedCustom = false;
      if (customCandidates !== undefined) {
        for (let i = customCandidates.length - 1; i >= 0; i -= 1) {
          const parsedElement = customCandidates[i]!;
          const parsedLocalName = readLocalName(parsedElement);
          const customizedName = parsedElement.getAttribute("is");
          const customName =
            customizedName !== null &&
            window.customElements.get(customizedName) !== undefined
              ? customizedName
              : parsedLocalName;
          if (window.customElements.get(customName) === undefined) {
            continue;
          }
          upgradedCustom = true;
          const creationOptions =
            customName === customizedName ? { is: customName } : undefined;
          const customElement = nativeCreateElement.call(
            document,
            parsedLocalName,
            creationOptions,
          );
          fragmentNodes.add(customElement);
          for (const attribute of Array.from(parsedElement.attributes)) {
            nativeSetAttributeNS.call(
              customElement,
              attribute.namespaceURI,
              attribute.name,
              attribute.value,
            );
          }
          for (
            let child = readFirstChild(parsedElement);
            child !== null;
            child = readFirstChild(parsedElement)
          ) {
            nativeAppendChild.call(customElement, child);
          }
          nativeReplaceChild.call(parsedElement.parentNode, customElement, parsedElement);
        }
      }
      if (allowSingleChild) {
        const first = readFirstChild(parsedRoot);
        if (first === null) {
          return null;
        }
        if (first.nextSibling === null) {
          if (markImmediately || upgradedCustom) {
            return adoptAndMark(first);
          }
          hostDocument.adoptNode(first);
          return first;
        }
      }
      const fragment = nativeCreateDocumentFragment.call(fragmentDocument);
      for (
        let child = readFirstChild(parsedRoot);
        child !== null;
        child = readFirstChild(parsedRoot)
      ) {
        nativeAppendChild.call(fragment, child);
      }
      if (markImmediately || upgradedCustom) {
        return adoptAndMark(fragment);
      }
      hostDocument.adoptNode(fragment);
      return fragment;
    } finally {
      if (
        poolKey !== null &&
        parserContextPool.size < 16 &&
        readFirstChild(parserContext!) === null &&
        !nativeHasAttributes.call(parserContext!)
      ) {
        parserContextPool.set(poolKey, parserContext!);
      }
    }
  }

  const elementHasVirtualOverride = (element: Element): boolean =>
    element === options.html ||
    element === options.head ||
    element === options.body ||
    (virtualNodes.has(element) &&
      (options.authoredURLAttributes.has(element) ||
        options.authoredStyleAttributes.has(element) ||
        protectedScriptAttributes.has(element as HTMLScriptElement) ||
        eventAttributeValues.has(element) ||
        authoredLinkRelValues.has(element as HTMLLinkElement) ||
        nativeHasAttribute.call(element, "style") ||
        nativeHasAttribute.call(element, FRAGMENT_TARGET_ATTRIBUTE) ||
        nativeHasAttribute.call(element, options.inlineStyleSelectorAttribute)));

  const subtreeNeedsAuthoredCopy = (root: Node, includeSelf: boolean): boolean => {
    const stack: Node[] = [];
    if (includeSelf && root.nodeType === 1) {
      const el = root as Element;
      if (elementHasVirtualOverride(el)) return true;
      if (isHTMLTemplateElement(el)) stack.push(el.content);
    }
    stack.push(root);
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (
        let child = readFirstChild(current);
        child !== null;
        child = child.nextSibling
      ) {
        if (child.nodeType !== 1) continue;
        const el = child as Element;
        if (elementHasVirtualOverride(el)) return true;
        if (readFirstChild(el) !== null) stack.push(el);
        if (isHTMLTemplateElement(el)) stack.push(el.content);
      }
    }
    return false;
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
    const fragmentDocument = getInertDocument();
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
        const where = insertionPosition(position);
        const markup = options.createGuestHTML(text, false);
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
        const initialParent = outside ? this.parentNode : this;
        const initialParentVirtual =
          initialParent !== null && virtualNodes.has(initialParent);
        const fragment = parseFragment(
          markup,
          destination === options.html ? null : destination,
          false,
          !initialParentVirtual,
        );
        // Custom element constructors during parseFragment may relocate `this`,
        // so re-read parentNode afterwards just like the native algorithm.
        switch (where) {
          case "beforebegin": {
            const parent = this.parentNode;
            if (parent !== null) {
              insertDirect(
                parent,
                fragment,
                "insertBefore",
                this,
                virtualNodes.has(parent),
                true,
              );
            }
            return;
          }
          case "afterbegin":
            insertDirect(
              this,
              fragment,
              "insertBefore",
              this.firstChild,
              virtualNodes.has(this),
              true,
            );
            return;
          case "beforeend":
            insertDirect(
              this,
              fragment,
              "appendChild",
              undefined,
              virtualNodes.has(this),
              true,
            );
            return;
          case "afterend": {
            const parent = this.parentNode;
            if (parent !== null) {
              insertDirect(
                parent,
                fragment,
                "insertBefore",
                this.nextSibling,
                virtualNodes.has(parent),
                true,
              );
            }
            return;
          }
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

    const nativeInsertAdjacentText = elementPrototype.insertAdjacentText;
    patch(elementPrototype, "insertAdjacentText", {
      writable: true,
      value(this: Element, position: InsertPosition, data: string): void {
        const where = insertionPosition(position);
        const text = toDOMString(data);
        nativeInsertAdjacentText.call(this, where, text);
        if (!virtualNodes.has(this)) {
          return;
        }
        const inserted =
          where === "beforebegin"
            ? this.previousSibling
            : where === "afterbegin"
              ? this.firstChild
              : where === "beforeend"
                ? this.lastChild
                : this.nextSibling;
        if (inserted !== null) {
          markVirtualNode(inserted);
        }
      },
    });

    if (nativeSetHTMLUnsafe !== undefined) {
      patch(elementPrototype, "setHTMLUnsafe", {
        writable: true,
        value(this: Element, html: string): void {
          const markup = options.createGuestHTML(html, false);
          if (!virtualNodes.has(this)) {
            nativeSetHTMLUnsafe.call(this, markup);
            return;
          }
          if (readLocalName(this) === "template" && isHTMLTemplateElement(this)) {
            nativeSetHTMLUnsafe.call(this, markup);
            markFragmentElements(this.content);
            markVirtualNode(this.content);
            return;
          }
          replaceElementChildren(
            this,
            markup === "" ? null : parseFragment(markup, this, true, false, true),
          );
        },
      });
    }

    const shadowRootPrototype = window.ShadowRoot?.prototype as
      | (ShadowRoot & { setHTMLUnsafe?: (this: ShadowRoot, html: string) => void })
      | undefined;
    const nativeShadowSetHTMLUnsafe = shadowRootPrototype?.setHTMLUnsafe;
    if (shadowRootPrototype !== undefined && nativeShadowSetHTMLUnsafe !== undefined) {
      patch(shadowRootPrototype, "setHTMLUnsafe", {
        writable: true,
        value(this: ShadowRoot, html: string): void {
          const markup = options.createGuestHTML(html, false);
          nativeShadowSetHTMLUnsafe.call(this, markup);
          if (virtualNodes.has(this)) {
            markFragmentElements(this);
            for (let child = this.firstChild; child !== null; child = child.nextSibling) {
              markVirtualNode(child);
            }
          }
        },
      });
    }
    const nativeShadowInnerHTML =
      shadowRootPrototype !== undefined
        ? Object.getOwnPropertyDescriptor(shadowRootPrototype, "innerHTML")
        : undefined;
    if (
      shadowRootPrototype !== undefined &&
      nativeShadowInnerHTML?.get !== undefined &&
      nativeShadowInnerHTML.set !== undefined
    ) {
      patch(shadowRootPrototype, "innerHTML", {
        get: nativeShadowInnerHTML.get,
        set(this: ShadowRoot, value: string | null) {
          const markup = options.createGuestHTML(value, true);
          nativeShadowInnerHTML.set!.call(this, markup);
          if (virtualNodes.has(this)) {
            markFragmentElements(this);
            for (let child = this.firstChild; child !== null; child = child.nextSibling) {
              markVirtualNode(child);
            }
          }
        },
      });
    }

    patch(elementPrototype, "innerHTML", {
      get(this: Element) {
        const getter = nativeInnerHTML.get;
        if (getter === undefined) {
          return "";
        }
        if (!virtualNodes.has(this)) {
          return getter.call(this) as string;
        }
        const root: ParentNode =
          readLocalName(this) === "template" && isHTMLTemplateElement(this)
            ? this.content
            : this;
        if (root.firstChild === null) {
          return "";
        }
        if (root.firstElementChild === null || !subtreeNeedsAuthoredCopy(root, false)) {
          return getter.call(this) as string;
        }
        return getter.call(authoredCopy(this)) as string;
      },
      set(this: Element, value: string | null) {
        // [LegacyNullToEmptyString]: null clears, and must not reach
        // createHTML as the text "null".
        const markup = options.createGuestHTML(value, true);
        if (!virtualNodes.has(this)) {
          nativeInnerHTML.set?.call(this, markup);
          return;
        }
        if (readLocalName(this) === "template" && isHTMLTemplateElement(this)) {
          nativeInnerHTML.set?.call(this, markup);
          markFragmentElements(this.content);
          markVirtualNode(this.content);
          return;
        }
        replaceElementChildren(
          this,
          markup === "" ? null : parseFragment(markup, this, false, false, true),
        );
      },
    });

    if (nativeOuterHTML?.get !== undefined && nativeOuterHTML.set !== undefined) {
      patch(elementPrototype, "outerHTML", {
        get(this: Element) {
          if (!virtualNodes.has(this) || !subtreeNeedsAuthoredCopy(this, true)) {
            return nativeOuterHTML.get!.call(this) as string;
          }
          return nativeOuterHTML.get!.call(authoredCopy(this)) as string;
        },
        set(this: Element, value: string | null) {
          const markup = options.createGuestHTML(value, true);
          if (!virtualNodes.has(this)) {
            nativeOuterHTML.set?.call(this, markup);
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
          replaceNodeWith(
            parent,
            parseFragment(markup, this.parentElement, false, false),
            this,
          );
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
