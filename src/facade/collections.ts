// A guest selector names html, head and body, but those elements are really the
// shell elements v-html, v-head and v-body, and the shell root is not reachable
// from inside the tree it roots. Every lookup therefore runs twice — once as
// authored and once translated — and the results are merged back into document
// order. The live collections are proxies so they keep answering from the
// current tree instead of from a snapshot.

import { translateShellSelector, translateTargetSelector } from "../css.js";
import { WeakValueMap } from "../enumerable-weak.js";
import { type FacadeContext, HTML_NAMESPACE } from "./context.js";
import {
  type IndexedValues,
  liveIndexedCollection,
  propertyIndex,
} from "./indexed-collection.js";
import { toDOMString, toNullableDOMString } from "./webidl.js";

function translateSelector(selector: string): string {
  try {
    return translateShellSelector(selector);
  } catch {
    return selector;
  }
}

function targetSelector(selector: string): string {
  try {
    return translateTargetSelector(selector);
  } catch {
    return selector;
  }
}

export interface CollectionFacade {
  staticNodeList<T extends Node>(nodes: readonly T[]): NodeListOf<T>;
  staticCollection<T extends Element>(elements: readonly T[]): HTMLCollectionOf<T>;
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
  dispose(): void;
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
    virtualNodes,
    documentFragmentPrototype,
    patch,
  } = context;

  // Filtered/shell collections cannot use a single native live collection.
  // Each caches its snapshot against a mutation version instead of registering
  // an invalidator: a collection the guest drops then costs the observer
  // nothing, where a registered invalidator would run on every mutation for as
  // long as the frame lives. Records still queued are drained on every read so
  // changes are visible synchronously, before observer delivery. Observation
  // starts with the first read, since a snapshot taken after that is all any
  // collection ever needs to be current against.
  let mutationVersion = 0;
  const collectionObserver = new context.NativeMutationObserver(() => {
    mutationVersion += 1;
  });
  let observing = false;
  const currentMutationVersion = (): number => {
    if (!observing) {
      observing = true;
      collectionObserver.observe(options.html, {
        subtree: true,
        childList: true,
        attributes: true,
      });
    } else if (collectionObserver.takeRecords().length > 0) {
      mutationVersion += 1;
    }
    return mutationVersion;
  };
  const cachedValues = <T>(read: () => IndexedValues<T>): (() => IndexedValues<T>) => {
    let values: IndexedValues<T> | undefined;
    let snapshotVersion = -1;
    return () => {
      const version = currentMutationVersion();
      if (values === undefined || snapshotVersion !== version) {
        values = read();
        snapshotVersion = version;
      }
      return values;
    };
  };

  const staticNodeList = <T extends Node>(nodes: readonly T[]): NodeListOf<T> =>
    liveIndexedCollection(
      window.NodeList.prototype,
      () => nodes as unknown as IndexedValues<T>,
    ) as unknown as NodeListOf<T>;

  const sortElementsInDocumentOrder = (elements: Element[]): Element[] =>
    elements.sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left.compareDocumentPosition(right) & window.Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    });

  // The browser's own list is returned whenever no selector translation was
  // needed; only a merged result has to be built, and it is a NodeList too.
  const querySelectorAllWithShell = (
    root: Element,
    selectors: string,
  ): NodeListOf<Element> => {
    selectors = targetSelector(toDOMString(selectors));
    const translated = translateSelector(selectors);
    const nativeList = nativeQuerySelectorAll.call(root, selectors);
    if (translated === selectors) {
      return nativeList;
    }
    const matches = Array.from(nativeList);
    const seen = new Set(matches);
    for (const match of Array.from(nativeQuerySelectorAll.call(root, translated))) {
      if (!seen.has(match)) {
        seen.add(match);
        matches.push(match);
      }
    }
    return staticNodeList(sortElementsInDocumentOrder(matches));
  };

  const querySelectorWithShell = (root: Element, selectors: string): Element | null => {
    selectors = targetSelector(toDOMString(selectors));
    const match = nativeQuerySelector.call(root, selectors);
    const translated = translateSelector(selectors);
    if (translated === selectors) {
      return match;
    }
    const shellMatch = nativeQuerySelector.call(root, translated);
    if (match === null || shellMatch === null || match === shellMatch) {
      return match ?? shellMatch;
    }
    return match.compareDocumentPosition(shellMatch) &
      window.Node.DOCUMENT_POSITION_FOLLOWING
      ? match
      : shellMatch;
  };

  const querySelector = (selectors: string): Element | null => {
    selectors = targetSelector(toDOMString(selectors));
    const translated = translateSelector(selectors);
    if (
      nativeMatches.call(options.html, selectors) ||
      nativeMatches.call(options.html, translated)
    ) {
      return options.html;
    }
    return querySelectorWithShell(options.html, selectors);
  };
  const querySelectorAll = (selectors: string): NodeListOf<Element> => {
    selectors = targetSelector(toDOMString(selectors));
    const translated = translateSelector(selectors);
    const matches = querySelectorAllWithShell(options.html, selectors);
    if (
      nativeMatches.call(options.html, selectors) ||
      nativeMatches.call(options.html, translated)
    ) {
      return staticNodeList([options.html, ...Array.from(matches)]);
    }
    return matches;
  };
  const staticCollection = <T extends Element>(
    elements: readonly T[],
  ): HTMLCollectionOf<T> =>
    createLiveHTMLCollection(
      () => elements as unknown as IndexedValues<T>,
    ) as HTMLCollectionOf<T>;
  const createLiveHTMLCollection = <T extends Element>(
    currentElements: () => IndexedValues<T>,
  ): HTMLCollectionOf<T> => {
    const values = cachedValues(currentElements);
    return liveIndexedCollection(window.HTMLCollection.prototype, values, (name) => {
      if (name === "") {
        return null;
      }
      for (const element of values()) {
        if (
          nativeGetAttribute.call(element, "id") === name ||
          nativeGetAttribute.call(element, "name") === name
        ) {
          return element;
        }
      }
      return null;
    }) as unknown as HTMLCollectionOf<T>;
  };

  const withRoot = (
    values: HTMLCollectionOf<Element>,
    includeRoot: () => boolean,
  ): IndexedValues<Element> =>
    new Proxy(values, {
      get(target, property) {
        const offset = includeRoot() ? 1 : 0;
        if (property === "length") {
          return target.length + offset;
        }
        const index = propertyIndex(property);
        if (index !== null) {
          return offset === 1 && index === 0 ? options.html : target[index - offset];
        }
        if (property === Symbol.iterator) {
          return function* () {
            if (includeRoot()) {
              yield options.html;
            }
            yield* target;
          };
        }
        return Reflect.get(target, property, target);
      },
    });
  // Weakly held so that a guest asking for arbitrary names does not pin a
  // collection per name; see WeakValueMap.
  const tagCollections = new WeakValueMap<string, HTMLCollectionOf<Element>>();
  const getElementsByTagName = (qualifiedName: string): HTMLCollectionOf<Element> => {
    const requestedName = toDOMString(qualifiedName);
    const existing = tagCollections.get(requestedName);
    if (existing !== undefined) {
      return existing;
    }

    // The native lookup lowercases HTML-namespace names itself while matching
    // foreign elements (SVG, MathML) case-sensitively; only the shell
    // translation below wants the lowercase form.
    const collectionName = requestedName.toLowerCase();
    const nativeCollection = nativeGetElementsByTagName.call(options.html, requestedName);
    if (collectionName === "*") {
      const values = withRoot(nativeCollection, () => true);
      const collection = createLiveHTMLCollection(() => values);
      tagCollections.set(requestedName, collection);
      return collection;
    }
    if (!["html", "head", "body", options.html.localName].includes(collectionName)) {
      tagCollections.set(requestedName, nativeCollection);
      return nativeCollection;
    }
    const collection = createLiveHTMLCollection(() => {
      const translated = translateSelector(collectionName);
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
      if (collectionName === "html" || options.html.localName === collectionName) {
        matches.unshift(options.html);
      }
      return matches;
    });
    tagCollections.set(requestedName, collection);
    return collection;
  };
  const namespaceTagCollections = new WeakValueMap<string, HTMLCollectionOf<Element>>();
  const getElementsByTagNameNS = (
    namespaceURI: string | null,
    localName: string,
  ): HTMLCollectionOf<Element> => {
    const namespace = toNullableDOMString(namespaceURI);
    const requestedName = toDOMString(localName);
    const collectionKey = `${namespace ?? "null"}\u0000${requestedName}`;
    const existing = namespaceTagCollections.get(collectionKey);
    if (existing !== undefined) {
      return existing;
    }

    const nativeCollection = nativeGetElementsByTagNameNS.call(
      options.html,
      namespace,
      requestedName,
    );
    const includesShell = namespace === "*" || namespace === HTML_NAMESPACE;
    if (
      requestedName === "*" ||
      !includesShell ||
      !["html", "head", "body"].includes(requestedName)
    ) {
      const values = withRoot(
        nativeCollection,
        () => includesShell && requestedName === "*",
      );
      const collection = createLiveHTMLCollection(() => values);
      namespaceTagCollections.set(collectionKey, collection);
      return collection;
    }

    const collection = createLiveHTMLCollection(() => {
      const matches = Array.from(
        nativeGetElementsByTagNameNS.call(options.html, namespace, requestedName),
      );
      // Only html, head and body in a namespace that includes the shell get
      // here: any other lookup returned above.
      const shellName =
        requestedName === "html"
          ? "v-html"
          : requestedName === "head"
            ? "v-head"
            : "v-body";
      const seen = new Set(matches);
      for (const match of Array.from(
        nativeGetElementsByTagNameNS.call(options.html, HTML_NAMESPACE, shellName),
      )) {
        if (!seen.has(match)) {
          matches.push(match);
        }
      }
      sortElementsInDocumentOrder(matches);
      if (requestedName === "html") {
        matches.unshift(options.html);
      }
      return matches;
    });
    namespaceTagCollections.set(collectionKey, collection);
    return collection;
  };
  const classCollections = new WeakValueMap<string, HTMLCollectionOf<Element>>();
  const getElementsByClassName = (names: string): HTMLCollectionOf<Element> => {
    const classNames = toDOMString(names);
    const existing = classCollections.get(classNames);
    if (existing !== undefined) {
      return existing;
    }

    const requiredClasses = classNames
      .split(/[\t\n\f\r ]+/)
      .filter((className) => className !== "");
    const values = withRoot(
      options.html.getElementsByClassName(classNames),
      () =>
        requiredClasses.length > 0 &&
        requiredClasses.every((className) => options.html.classList.contains(className)),
    );
    const collection = createLiveHTMLCollection(() => values);
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
  const formCollection = nativeGetElementsByTagName.call(
    options.html,
    "form",
  ) as HTMLCollectionOf<HTMLFormElement>;
  const imageCollection = nativeGetElementsByTagName.call(
    options.html,
    "img",
  ) as HTMLCollectionOf<HTMLImageElement>;
  const scriptCollection = nativeGetElementsByTagNameNS.call(
    options.html,
    HTML_NAMESPACE,
    "script",
  ) as HTMLCollectionOf<HTMLScriptElement>;
  const linkCollection = createLiveHTMLCollection(
    () =>
      Array.from(nativeQuerySelectorAll.call(options.html, "a[href], area[href]")).filter(
        (element) => element.namespaceURI === HTML_NAMESPACE,
      ) as Array<HTMLAnchorElement | HTMLAreaElement>,
  );
  const anchorCollection = createLiveHTMLCollection(
    () =>
      Array.from(nativeQuerySelectorAll.call(options.html, "a[name]")).filter(
        (element) => element.namespaceURI === HTML_NAMESPACE,
      ) as HTMLAnchorElement[],
  );
  const embedCollection = nativeGetElementsByTagName.call(
    options.html,
    "embed",
  ) as HTMLCollectionOf<HTMLEmbedElement>;
  const namedNodeLists = new WeakValueMap<string, NodeListOf<HTMLElement>>();
  const getElementsByName = (name: string): NodeListOf<HTMLElement> => {
    const requestedName = toDOMString(name);
    const existing = namedNodeLists.get(requestedName);
    if (existing !== undefined) {
      return existing;
    }
    const selector = `[name="${window.CSS.escape(requestedName)}"]`;
    const list = liveIndexedCollection(
      window.NodeList.prototype,
      cachedValues(
        () =>
          Array.from(
            nativeQuerySelectorAll.call(options.html, selector),
          ) as HTMLElement[],
      ),
    ) as unknown as NodeListOf<HTMLElement>;
    namedNodeLists.set(requestedName, list);
    return list;
  };

  const installPatches = (): void => {
    patch(elementPrototype, "matches", {
      writable: true,
      value(this: Element, selectors: string): boolean {
        if (!isInVirtualDocumentTree(this)) {
          return nativeMatches.call(
            this,
            virtualNodes.has(this) ? targetSelector(selectors) : selectors,
          );
        }
        selectors = targetSelector(selectors);
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
          return nativeClosest.call(
            this,
            virtualNodes.has(this) ? targetSelector(selectors) : selectors,
          );
        }
        selectors = targetSelector(selectors);
        const translated = translateSelector(selectors);
        const matchesSelector = (candidate: Element): boolean =>
          nativeMatches.call(candidate, selectors) ||
          nativeMatches.call(candidate, translated);
        if (matchesSelector(this)) {
          return this;
        }
        for (
          let ancestor = this.parentElement;
          ancestor !== null;
          ancestor = ancestor.parentElement
        ) {
          if (matchesSelector(ancestor)) {
            return ancestor;
          }
        }
        return null;
      },
    });
    patch(elementPrototype, "querySelector", {
      writable: true,
      value(this: Element, selectors: string): Element | null {
        return isInVirtualDocumentTree(this)
          ? querySelectorWithShell(this, selectors)
          : nativeQuerySelector.call(
              this,
              virtualNodes.has(this) ? targetSelector(selectors) : selectors,
            );
      },
    });
    patch(elementPrototype, "querySelectorAll", {
      writable: true,
      value(this: Element, selectors: string): NodeListOf<Element> {
        return isInVirtualDocumentTree(this)
          ? querySelectorAllWithShell(this, toDOMString(selectors))
          : nativeQuerySelectorAll.call(
              this,
              virtualNodes.has(this) ? targetSelector(selectors) : selectors,
            );
      },
    });
    for (const method of ["querySelector", "querySelectorAll"] as const) {
      const nativeQuery = documentFragmentPrototype[method];
      patch(documentFragmentPrototype, method, {
        writable: true,
        value(this: DocumentFragment, selectors: string) {
          return Reflect.apply(nativeQuery, this, [
            virtualNodes.has(this) ? targetSelector(selectors) : selectors,
          ]);
        },
      });
    }
  };

  return {
    staticNodeList,
    staticCollection,
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
    dispose() {
      collectionObserver.disconnect();
    },
  };
}
