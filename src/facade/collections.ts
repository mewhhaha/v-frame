// A guest selector names html, head and body, but those elements are really the
// shell elements v-html, v-head and v-body, and the shell root is not reachable
// from inside the tree it roots. Every lookup therefore runs twice — once as
// authored and once translated — and the results are merged back into document
// order. The live collections are proxies so they keep answering from the
// current tree instead of from a snapshot.

import { translateShellSelector } from "../css.js";
import { type FacadeContext, HTML_NAMESPACE } from "./context.js";

function translateSelector(selector: string): string {
  try {
    return translateShellSelector(selector);
  } catch {
    return selector;
  }
}

export function staticCollection<T extends Element>(elements: T[]): HTMLCollectionOf<T> {
  const collection = elements as unknown as HTMLCollectionOf<T> & {
    item(index: number): T | null;
    namedItem(name: string): T | null;
  };
  Object.defineProperties(collection, {
    item: {
      value(index: number) {
        return elements[index] ?? null;
      },
    },
    namedItem: {
      value(name: string) {
        return (
          elements.find(
            (element) => element.id === name || element.getAttribute("name") === name,
          ) ?? null
        );
      },
    },
  });
  return collection;
}

export function staticNodeList<T extends Node>(nodes: T[]): NodeListOf<T> {
  const list = nodes as unknown as NodeListOf<T> & { item(index: number): T | null };
  Object.defineProperty(list, "item", {
    value(index: number) {
      return nodes[index] ?? null;
    },
  });
  return list;
}

interface LiveIndexedCollection<T extends object> {
  readonly length: number;
  item(index: number): T | null;
  readonly [index: number]: T;
}

function propertyIndex(property: PropertyKey): number | null {
  if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) {
    return null;
  }
  const index = Number(property);
  return Number.isSafeInteger(index) ? index : null;
}

function liveIndexedCollection<T extends object>(
  prototype: object,
  currentValues: () => T[],
  currentNamedValue?: (name: string) => T | null,
): LiveIndexedCollection<T> {
  const target = Object.create(prototype) as object;
  const itemAt = (index: number): T | null => currentValues()[index] ?? null;
  const namedItem = (name: string): T | null => currentNamedValue?.(String(name)) ?? null;
  const iterator = (): ArrayIterator<T> => currentValues()[Symbol.iterator]();

  const proxy = new Proxy(target, {
    get(proxyTarget, property, receiver) {
      if (property === "length") {
        return currentValues().length;
      }
      if (property === "item") {
        return itemAt;
      }
      if (property === "namedItem" && currentNamedValue !== undefined) {
        return namedItem;
      }
      if (property === Symbol.iterator) {
        return iterator;
      }

      const index = propertyIndex(property);
      if (index !== null) {
        return currentValues()[index];
      }
      if (Reflect.has(proxyTarget, property)) {
        // Prototype iteration helpers brand-check their receiver, which the
        // proxy fails; reimplement them over the live values instead.
        switch (property) {
          case "forEach":
            return (
              callback: (value: T, index: number, list: unknown) => void,
              thisArg?: unknown,
            ) => {
              currentValues().forEach((value, valueIndex) =>
                callback.call(thisArg, value, valueIndex, proxy),
              );
            };
          case "entries":
            return () => currentValues().entries();
          case "keys":
            return () => currentValues().keys();
          case "values":
            return () => currentValues().values();
        }
        return Reflect.get(proxyTarget, property, receiver);
      }
      if (typeof property === "string" && currentNamedValue !== undefined) {
        return currentNamedValue(property) ?? undefined;
      }
      return undefined;
    },
    has(proxyTarget, property) {
      const index = propertyIndex(property);
      if (index !== null) {
        return index < currentValues().length;
      }
      if (typeof property === "string" && currentNamedValue !== undefined) {
        const namedValue = currentNamedValue(property);
        if (namedValue !== null) {
          return true;
        }
      }
      return Reflect.has(proxyTarget, property);
    },
    ownKeys(proxyTarget) {
      return [
        ...currentValues().map((_value, index) => String(index)),
        ...Reflect.ownKeys(proxyTarget),
      ];
    },
    getOwnPropertyDescriptor(proxyTarget, property) {
      const index = propertyIndex(property);
      const value = index === null ? undefined : currentValues()[index];
      if (value !== undefined) {
        return {
          configurable: true,
          enumerable: true,
          value,
          writable: false,
        };
      }
      return Reflect.getOwnPropertyDescriptor(proxyTarget, property);
    },
  });
  return proxy as LiveIndexedCollection<T>;
}

export interface CollectionFacade {
  querySelector(selectors: string): Element | null;
  querySelectorAll(selectors: string): NodeListOf<Element>;
  getElementsByTagName(qualifiedName: string): HTMLCollectionOf<Element>;
  getElementsByTagNameNS(
    namespaceURI: string | null,
    localName: string,
  ): HTMLCollectionOf<Element>;
  getElementsByClassName(names: string): HTMLCollectionOf<Element>;
  getElementsByName(name: string): NodeListOf<HTMLElement>;
  styleSheetCollection: StyleSheetList;
  formCollection: HTMLCollectionOf<HTMLFormElement>;
  imageCollection: HTMLCollectionOf<HTMLImageElement>;
  scriptCollection: HTMLCollectionOf<HTMLScriptElement>;
  linkCollection: HTMLCollectionOf<HTMLAnchorElement | HTMLAreaElement>;
  anchorCollection: HTMLCollectionOf<HTMLAnchorElement>;
  embedCollection: HTMLCollectionOf<HTMLEmbedElement>;
  installPatches(): void;
}

export function installCollectionFacade(context: FacadeContext): CollectionFacade {
  const options = context.options;
  const {
    window,
    elementPrototype,
    nativeGetAttribute,
    nativeMatches,
    nativeClosest,
    nativeQuerySelector,
    nativeQuerySelectorAll,
    nativeGetElementsByTagName,
    nativeGetElementsByTagNameNS,
    isInVirtualDocumentTree,
    patch,
  } = context;

  const sortElementsInDocumentOrder = (elements: Element[]): Element[] =>
    elements.sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left.compareDocumentPosition(right) & window.Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    });

  const querySelectorAllWithShell = (root: Element, selectors: string): Element[] => {
    const translated = translateSelector(selectors);
    const matches = Array.from(nativeQuerySelectorAll.call(root, selectors));
    if (translated === selectors) {
      return matches;
    }
    const seen = new Set(matches);
    for (const match of Array.from(nativeQuerySelectorAll.call(root, translated))) {
      if (!seen.has(match)) {
        seen.add(match);
        matches.push(match);
      }
    }
    return sortElementsInDocumentOrder(matches);
  };

  const querySelector = (selectors: string): Element | null => {
    const translated = translateSelector(selectors);
    if (
      nativeMatches.call(options.html, selectors) ||
      nativeMatches.call(options.html, translated)
    ) {
      return options.html;
    }
    return querySelectorAllWithShell(options.html, selectors)[0] ?? null;
  };
  const querySelectorAll = (selectors: string): NodeListOf<Element> => {
    const translated = translateSelector(selectors);
    const matches = querySelectorAllWithShell(options.html, selectors);
    if (
      nativeMatches.call(options.html, selectors) ||
      nativeMatches.call(options.html, translated)
    ) {
      matches.unshift(options.html);
    }
    return staticNodeList(matches);
  };
  const createLiveHTMLCollection = <T extends Element>(
    currentElements: () => T[],
  ): HTMLCollectionOf<T> =>
    liveIndexedCollection(window.HTMLCollection.prototype, currentElements, (name) => {
      if (name === "") {
        return null;
      }
      return (
        currentElements().find(
          (element) =>
            nativeGetAttribute.call(element, "id") === name ||
            nativeGetAttribute.call(element, "name") === name,
        ) ?? null
      );
    }) as unknown as HTMLCollectionOf<T>;
  const tagCollections = new Map<string, HTMLCollectionOf<Element>>();
  const getElementsByTagName = (qualifiedName: string): HTMLCollectionOf<Element> => {
    const requestedName = String(qualifiedName);
    const existing = tagCollections.get(requestedName);
    if (existing !== undefined) {
      return existing;
    }

    // The native lookup lowercases HTML-namespace names itself while matching
    // foreign elements (SVG, MathML) case-sensitively; only the shell
    // translation below wants the lowercase form.
    const collectionName = requestedName.toLowerCase();
    const collection = createLiveHTMLCollection(() => {
      const translated = collectionName === "*" ? "*" : translateSelector(collectionName);
      const matches = Array.from(
        nativeGetElementsByTagName.call(options.html, requestedName),
      );
      if (translated !== collectionName) {
        const seen = new Set(matches);
        for (const match of Array.from(
          nativeGetElementsByTagName.call(options.html, translated),
        )) {
          if (!seen.has(match)) {
            matches.push(match);
          }
        }
      }
      sortElementsInDocumentOrder(matches);
      if (
        collectionName === "*" ||
        collectionName === "html" ||
        options.html.localName === collectionName
      ) {
        matches.unshift(options.html);
      }
      return matches;
    });
    tagCollections.set(requestedName, collection);
    return collection;
  };
  const namespaceTagCollections = new Map<string, HTMLCollectionOf<Element>>();
  const getElementsByTagNameNS = (
    namespaceURI: string | null,
    localName: string,
  ): HTMLCollectionOf<Element> => {
    const namespace = namespaceURI === null ? null : String(namespaceURI);
    const requestedName = String(localName);
    const collectionKey = `${namespace ?? "null"}\u0000${requestedName}`;
    const existing = namespaceTagCollections.get(collectionKey);
    if (existing !== undefined) {
      return existing;
    }

    const collection = createLiveHTMLCollection(() => {
      const matches = Array.from(
        nativeGetElementsByTagNameNS.call(options.html, namespace, requestedName),
      );
      const shellName =
        requestedName === "html"
          ? "v-html"
          : requestedName === "head"
            ? "v-head"
            : requestedName === "body"
              ? "v-body"
              : requestedName;
      if (
        (namespace === "*" || namespace === HTML_NAMESPACE) &&
        shellName !== requestedName
      ) {
        const seen = new Set(matches);
        for (const match of Array.from(
          nativeGetElementsByTagNameNS.call(options.html, HTML_NAMESPACE, shellName),
        )) {
          if (!seen.has(match)) {
            matches.push(match);
          }
        }
      }
      sortElementsInDocumentOrder(matches);
      if (
        (namespace === "*" || namespace === HTML_NAMESPACE) &&
        (requestedName === "*" || requestedName === "html")
      ) {
        matches.unshift(options.html);
      }
      return matches;
    });
    namespaceTagCollections.set(collectionKey, collection);
    return collection;
  };
  const classCollections = new Map<string, HTMLCollectionOf<Element>>();
  const getElementsByClassName = (names: string): HTMLCollectionOf<Element> => {
    const classNames = String(names);
    const existing = classCollections.get(classNames);
    if (existing !== undefined) {
      return existing;
    }

    const collection = createLiveHTMLCollection(() => {
      const matches = Array.from(options.html.getElementsByClassName(classNames));
      const requiredClasses = classNames
        .split(/[\t\n\f\r ]+/)
        .filter((className) => className !== "");
      if (
        requiredClasses.length > 0 &&
        requiredClasses.every((className) => options.html.classList.contains(className))
      ) {
        matches.unshift(options.html);
      }
      return matches;
    });
    classCollections.set(classNames, collection);
    return collection;
  };
  const styleSheetCollection = liveIndexedCollection(
    window.StyleSheetList.prototype,
    () =>
      Array.from(nativeQuerySelectorAll.call(options.html, "style"))
        .map((style) => (style as HTMLStyleElement).sheet)
        .filter((sheet): sheet is CSSStyleSheet => sheet !== null),
  ) as unknown as StyleSheetList;
  const formCollection = createLiveHTMLCollection(
    () =>
      Array.from(nativeQuerySelectorAll.call(options.html, "form")) as HTMLFormElement[],
  );
  const imageCollection = createLiveHTMLCollection(
    () =>
      Array.from(nativeQuerySelectorAll.call(options.html, "img")) as HTMLImageElement[],
  );
  const scriptCollection = createLiveHTMLCollection(
    () =>
      Array.from(
        nativeQuerySelectorAll.call(options.html, "script"),
      ) as HTMLScriptElement[],
  );
  const linkCollection = createLiveHTMLCollection(
    () =>
      Array.from(
        nativeQuerySelectorAll.call(options.html, "a[href], area[href]"),
      ) as Array<HTMLAnchorElement | HTMLAreaElement>,
  );
  const anchorCollection = createLiveHTMLCollection(
    () =>
      Array.from(
        nativeQuerySelectorAll.call(options.html, "a[name]"),
      ) as HTMLAnchorElement[],
  );
  const embedCollection = createLiveHTMLCollection(
    () =>
      Array.from(
        nativeQuerySelectorAll.call(options.html, "embed"),
      ) as HTMLEmbedElement[],
  );
  const namedNodeLists = new Map<string, NodeListOf<HTMLElement>>();
  const getElementsByName = (name: string): NodeListOf<HTMLElement> => {
    const requestedName = String(name);
    const existing = namedNodeLists.get(requestedName);
    if (existing !== undefined) {
      return existing;
    }
    const selector = `[name="${window.CSS.escape(requestedName)}"]`;
    const list = liveIndexedCollection(
      window.NodeList.prototype,
      () =>
        Array.from(nativeQuerySelectorAll.call(options.html, selector)) as HTMLElement[],
    ) as unknown as NodeListOf<HTMLElement>;
    namedNodeLists.set(requestedName, list);
    return list;
  };

  const installPatches = (): void => {
    patch(elementPrototype, "matches", {
      writable: true,
      value(this: Element, selectors: string): boolean {
        if (!isInVirtualDocumentTree(this)) {
          return nativeMatches.call(this, selectors);
        }
        return (
          nativeMatches.call(this, selectors) ||
          nativeMatches.call(this, translateSelector(selectors))
        );
      },
    });
    patch(elementPrototype, "closest", {
      writable: true,
      value(this: Element, selectors: string): Element | null {
        if (!isInVirtualDocumentTree(this)) {
          return nativeClosest.call(this, selectors);
        }
        const translated = translateSelector(selectors);
        let candidate: Element | null = this;
        while (candidate !== null) {
          if (
            nativeMatches.call(candidate, selectors) ||
            nativeMatches.call(candidate, translated)
          ) {
            return candidate;
          }
          candidate = candidate.parentElement;
        }
        return null;
      },
    });
    patch(elementPrototype, "querySelector", {
      writable: true,
      value(this: Element, selectors: string): Element | null {
        return isInVirtualDocumentTree(this)
          ? (querySelectorAllWithShell(this, selectors)[0] ?? null)
          : nativeQuerySelector.call(this, selectors);
      },
    });
    patch(elementPrototype, "querySelectorAll", {
      writable: true,
      value(this: Element, selectors: string): NodeListOf<Element> {
        return isInVirtualDocumentTree(this)
          ? staticNodeList(querySelectorAllWithShell(this, selectors))
          : nativeQuerySelectorAll.call(this, selectors);
      },
    });
  };

  return {
    querySelector,
    querySelectorAll,
    getElementsByTagName,
    getElementsByTagNameNS,
    getElementsByClassName,
    getElementsByName,
    styleSheetCollection,
    formCollection,
    imageCollection,
    scriptCollection,
    linkCollection,
    anchorCollection,
    embedCollection,
    installPatches,
  };
}
