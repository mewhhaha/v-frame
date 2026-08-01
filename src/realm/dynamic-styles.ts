// The dynamic style and link pipeline. Guest CSS cannot be handed to the
// browser as authored: selectors, url() references and @import all have to be
// rewritten against the guest's URL first, and rewriting is asynchronous. Each
// <style> and stylesheet <link> therefore carries a revision — a snapshot of
// the inputs that produced its current text — so that a rewrite which lands
// after the element moved on is dropped instead of applied.
//
// The module also owns the CSSOM patches, because a rule inserted through
// insertRule/addRule needs the same rewriting as one that arrived as text.

import {
  CSSOMImportRuleError,
  fetchStylesheetText,
  rewriteCSSOMAddRule,
  rewriteCSSOMInsertRule,
  rewriteCSSOMSelectorText,
  rewriteStyleAttribute,
  rewriteStylesheet,
  type StylesheetContext,
  type StylesheetImportFailure,
} from "../css.js";
import type { DocumentFacade } from "../facade/index.js";
import type { VFrameWindow } from "../types.js";
import type { RealmFailure } from "./connect.js";

interface DynamicStyleSnapshot {
  source: string;
  stylesheetURL: string;
  media: string;
  disabled: boolean;
}

interface DynamicStyleUpdate {
  revision: number;
  snapshot: DynamicStyleSnapshot;
  physicalText: string;
  status: "pending" | "committed" | "empty" | "failed";
}

interface DynamicLinkSnapshot {
  href: string;
  media: string;
  disabled: boolean;
  authoredRel: string;
}

interface DynamicLinkUpdate {
  revision: number;
  snapshot: DynamicLinkSnapshot | null;
  authoredRel: string | null;
}

function inheritedPropertyDescriptor(
  value: object,
  name: PropertyKey,
): PropertyDescriptor | undefined {
  let prototype: object | null = value;
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor !== undefined) {
      return descriptor;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

export interface DynamicStyleOptions {
  window: VFrameWindow;
  document: Document;
  stylesheetContext: StylesheetContext;
  signal: AbortSignal;
  getNonce(): string;
  getBaseURL(): string;
  /** The realm's own inline stylesheet, which the pipeline must never rewrite. */
  getInlineStyleSheet(): HTMLStyleElement | null;
  getFacade(): DocumentFacade | null;
  isConnectedToRealm(node: Node): boolean;
  isDisposed(): boolean;
  onError(failure: RealmFailure): void;
}

export interface DynamicStyles {
  applyNonce(style: HTMLStyleElement): void;
  virtualStylesFrom(nodes: readonly Node[]): HTMLStyleElement[];
  dynamicLinksFrom(nodes: readonly Node[]): HTMLLinkElement[];
  installCSSOMStyleSheets(nodes: readonly Node[]): void;
  observeConnectedNodes(nodes: readonly Node[]): void;
  scheduleDynamicStyle(
    style: HTMLStyleElement,
    source: string,
    forceRevision?: boolean,
  ): void;
  scheduleDynamicStyleContent(style: HTMLStyleElement): void;
  scheduleDynamicStyleAttributes(style: HTMLStyleElement): void;
  scheduleConnectedDynamicStyle(style: HTMLStyleElement): void;
  invalidateDynamicStyle(style: HTMLStyleElement): void;
  scheduleDynamicLink(
    link: HTMLLinkElement,
    forceRevision?: boolean,
    authoredRelOverride?: string | null,
  ): void;
  invalidateDynamicLink(link: HTMLLinkElement): void;
  /** Records markup whose text the pipeline already rewrote during preparation. */
  recordProcessedStyle(style: HTMLStyleElement, source: string): void;
  /** True while the pipeline itself is writing a style element's text. */
  isGeneratedStyleWrite(style: HTMLStyleElement): boolean;
  /**
   * True when the pipeline already scheduled this element as it was inserted,
   * so the mutation observer must not schedule it a second time.
   */
  claimAwaitedStyle(style: HTMLStyleElement): boolean;
  claimAwaitedLink(link: HTMLLinkElement): boolean;
}

export function createDynamicStyles(options: DynamicStyleOptions): DynamicStyles {
  const window = options.window;
  const document = options.document;
  const processedStyles = new WeakMap<HTMLStyleElement, string>();
  const dynamicStyleUpdates = new WeakMap<HTMLStyleElement, DynamicStyleUpdate>();
  const dynamicLinkUpdates = new WeakMap<HTMLLinkElement, DynamicLinkUpdate>();
  const generatedStyleWrites = new WeakSet<HTMLStyleElement>();
  const connectedStylesAwaitingObservation = new WeakSet<HTMLStyleElement>();
  const connectedLinksAwaitingObservation = new WeakSet<HTMLLinkElement>();

  const registeredStyleSheets = new WeakSet<CSSStyleSheet>();
  const registeredStyleRules = new WeakSet<CSSStyleRule>();
  const registeredStyleDeclarations = new WeakSet<CSSStyleDeclaration>();
  const installCSSOMRules = (sheet: CSSStyleSheet): void => {
    const installRule = (rule: CSSRule): void => {
      if (rule.type === window.CSSRule.STYLE_RULE) {
        const styleRule = rule as CSSStyleRule;
        if (!registeredStyleRules.has(styleRule)) {
          registeredStyleRules.add(styleRule);
          const selectorText = inheritedPropertyDescriptor(styleRule, "selectorText");
          if (selectorText?.get !== undefined && selectorText.set !== undefined) {
            try {
              Object.defineProperty(styleRule, "selectorText", {
                configurable: true,
                get: () => selectorText.get?.call(styleRule),
                set(value: string) {
                  selectorText.set?.call(
                    styleRule,
                    rewriteCSSOMSelectorText(String(value)),
                  );
                },
              });
            } catch {
              // Browser CSSOM objects may reject own property definitions.
            }
          }

          const declaration = styleRule.style;
          if (!registeredStyleDeclarations.has(declaration)) {
            registeredStyleDeclarations.add(declaration);
            const cssText = inheritedPropertyDescriptor(declaration, "cssText");
            if (cssText?.get !== undefined && cssText.set !== undefined) {
              try {
                Object.defineProperty(declaration, "cssText", {
                  configurable: true,
                  get: () => cssText.get?.call(declaration),
                  set(value: string) {
                    cssText.set?.call(
                      declaration,
                      rewriteStyleAttribute(String(value), options.getBaseURL()),
                    );
                  },
                });
              } catch {
                // Browser CSSOM objects may reject own property definitions.
              }
            }
          }
        }
      }

      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      if (nested.cssRules !== undefined) {
        for (const child of Array.from(nested.cssRules)) {
          installRule(child);
        }
      }
    };

    for (const rule of Array.from(sheet.cssRules)) {
      installRule(rule);
    }
  };
  const applyNonce = (style: HTMLStyleElement): void => {
    if (options.getNonce() === "") {
      style.removeAttribute("nonce");
    } else {
      style.nonce = options.getNonce();
    }
  };
  const installCSSOMStyleSheet = (style: HTMLStyleElement): void => {
    applyNonce(style);
    if ((style.textContent ?? "") === "") {
      processedStyles.set(style, "");
    }

    const sheet = style.sheet;
    if (sheet === null) {
      return;
    }
    if (registeredStyleSheets.has(sheet)) {
      installCSSOMRules(sheet);
      return;
    }
    registeredStyleSheets.add(sheet);

    const nativeInsertRule = sheet.insertRule;
    const legacySheet = sheet as CSSStyleSheet & {
      addRule?: (selector: string, declarations: string, index?: number) => number;
    };
    const nativeAddRule = legacySheet.addRule;
    Object.defineProperties(sheet, {
      insertRule: {
        configurable: true,
        writable: true,
        value(rule: string, index?: number): number {
          let rewritten: string;
          try {
            rewritten = rewriteCSSOMInsertRule(String(rule), options.getBaseURL());
          } catch (error) {
            if (error instanceof CSSOMImportRuleError) {
              throw new window.DOMException(
                "CSSOM @import rules are unsupported inside v-frame",
                "NotSupportedError",
              );
            }
            throw error;
          }

          const insertionIndex =
            index === undefined
              ? nativeInsertRule.call(sheet, rewritten)
              : nativeInsertRule.call(sheet, rewritten, index);
          installCSSOMRules(sheet);
          return insertionIndex;
        },
      },
      addRule: {
        configurable: true,
        writable: true,
        value(selector: string, declarations: string, index?: number): number {
          const rewritten = rewriteCSSOMAddRule(
            String(selector),
            String(declarations),
            options.getBaseURL(),
          );
          if (nativeAddRule !== undefined) {
            const result =
              index === undefined
                ? nativeAddRule.call(sheet, rewritten.selector, rewritten.declarations)
                : nativeAddRule.call(
                    sheet,
                    rewritten.selector,
                    rewritten.declarations,
                    index,
                  );
            installCSSOMRules(sheet);
            return result;
          }

          const insertionIndex = index ?? sheet.cssRules.length;
          const result = nativeInsertRule.call(
            sheet,
            `${rewritten.selector}{${rewritten.declarations}}`,
            insertionIndex,
          );
          installCSSOMRules(sheet);
          return result;
        },
      },
    });
    installCSSOMRules(sheet);
  };
  const virtualStylesFrom = (nodes: readonly Node[]): HTMLStyleElement[] => {
    const styles: HTMLStyleElement[] = [];
    for (const node of nodes) {
      if (
        node instanceof window.HTMLStyleElement &&
        node !== options.getInlineStyleSheet()
      ) {
        styles.push(node);
      }
      if (node instanceof window.Element || node instanceof window.DocumentFragment) {
        styles.push(
          ...Array.from(node.querySelectorAll("style")).filter(
            (style) => style !== options.getInlineStyleSheet(),
          ),
        );
      }
    }
    return styles;
  };
  const installCSSOMStyleSheets = (nodes: readonly Node[]): void => {
    for (const style of virtualStylesFrom(nodes)) {
      if (options.isConnectedToRealm(style)) {
        installCSSOMStyleSheet(style);
      }
    }
  };

  const dynamicLinksFrom = (nodes: readonly Node[]): HTMLLinkElement[] => {
    const links = new Set<HTMLLinkElement>();
    for (const node of nodes) {
      if (node instanceof window.HTMLLinkElement) {
        links.add(node);
      }
      if (node instanceof window.Element || node instanceof window.DocumentFragment) {
        for (const link of node.querySelectorAll<HTMLLinkElement>("link")) {
          links.add(link);
        }
      }
    }
    return [...links];
  };
  const createRevisionStylesheetContext = (
    importFailures: StylesheetImportFailure[],
  ): StylesheetContext => ({
    fetchText: options.stylesheetContext.fetchText,
    requests: options.stylesheetContext.requests,
    onImportFailure(failure) {
      importFailures.push(failure);
    },
  });
  const reportImportFailures = (
    failures: readonly StylesheetImportFailure[],
    revisionIsCurrent: () => boolean,
  ): void => {
    for (const failure of failures) {
      if (!revisionIsCurrent()) {
        return;
      }
      options.onError({ phase: "stylesheet", ...failure });
    }
  };
  const sameStyleSnapshot = (
    first: DynamicStyleSnapshot,
    second: DynamicStyleSnapshot,
  ): boolean =>
    first.source === second.source &&
    first.stylesheetURL === second.stylesheetURL &&
    first.media === second.media &&
    first.disabled === second.disabled;
  const setGeneratedStyleText = (
    style: HTMLStyleElement,
    update: DynamicStyleUpdate,
    text: string,
  ): void => {
    update.physicalText = text;
    if ((style.textContent ?? "") !== text) {
      generatedStyleWrites.add(style);
      try {
        style.textContent = text;
      } finally {
        generatedStyleWrites.delete(style);
      }
    }
  };
  const styleRevisionIsCurrent = (
    style: HTMLStyleElement,
    update: DynamicStyleUpdate,
    revision: number,
    snapshot: DynamicStyleSnapshot,
  ): boolean =>
    !options.isDisposed() &&
    !options.signal.aborted &&
    options.isConnectedToRealm(style) &&
    update.revision === revision &&
    update.snapshot === snapshot &&
    (style.textContent ?? "") === update.physicalText &&
    style.media === snapshot.media &&
    style.disabled === snapshot.disabled;
  const startDynamicStyleRevision = (
    style: HTMLStyleElement,
    snapshot: DynamicStyleSnapshot,
    update: DynamicStyleUpdate,
  ): void => {
    update.revision += 1;
    update.snapshot = snapshot;
    const revision = update.revision;

    if (snapshot.source === "") {
      update.status = "empty";
      setGeneratedStyleText(style, update, "");
      processedStyles.set(style, "");
      installCSSOMStyleSheet(style);
      return;
    }

    update.status = "pending";
    setGeneratedStyleText(style, update, "");
    processedStyles.set(style, "");
    installCSSOMStyleSheet(style);
    void (async () => {
      const importFailures: StylesheetImportFailure[] = [];
      try {
        const rewritten = await rewriteStylesheet(
          snapshot.source,
          snapshot.stylesheetURL,
          createRevisionStylesheetContext(importFailures),
        );
        if (!styleRevisionIsCurrent(style, update, revision, snapshot)) {
          return;
        }
        applyNonce(style);
        setGeneratedStyleText(style, update, rewritten);
        update.status = "committed";
        processedStyles.set(style, rewritten);
        installCSSOMStyleSheet(style);
        reportImportFailures(importFailures, () =>
          styleRevisionIsCurrent(style, update, revision, snapshot),
        );
      } catch (error) {
        if (!styleRevisionIsCurrent(style, update, revision, snapshot)) {
          return;
        }
        update.status = "failed";
        options.onError({
          phase: "stylesheet",
          url: snapshot.stylesheetURL,
          error,
        });
      }
    })();
  };
  const scheduleDynamicStyle = (
    style: HTMLStyleElement,
    source: string,
    forceRevision = false,
  ): void => {
    if (!options.isConnectedToRealm(style)) {
      const update = dynamicStyleUpdates.get(style);
      if (update !== undefined) {
        update.revision += 1;
      }
      return;
    }

    const snapshot: DynamicStyleSnapshot = {
      source,
      stylesheetURL: options.getBaseURL(),
      media: style.media,
      disabled: style.disabled,
    };
    let update = dynamicStyleUpdates.get(style);
    if (update === undefined) {
      update = {
        revision: 0,
        snapshot,
        physicalText: style.textContent ?? "",
        status: source === "" ? "empty" : "committed",
      };
      dynamicStyleUpdates.set(style, update);
    } else if (
      !forceRevision &&
      sameStyleSnapshot(update.snapshot, snapshot) &&
      update.physicalText === (style.textContent ?? "")
    ) {
      return;
    }

    startDynamicStyleRevision(style, snapshot, update);
  };
  const scheduleDynamicStyleContent = (style: HTMLStyleElement): void => {
    const source = style.textContent ?? "";
    const update = dynamicStyleUpdates.get(style);
    if (update?.physicalText === source) {
      return;
    }
    if (processedStyles.get(style) === source) {
      return;
    }
    scheduleDynamicStyle(style, source);
  };
  const scheduleDynamicStyleAttributes = (style: HTMLStyleElement): void => {
    const update = dynamicStyleUpdates.get(style);
    const physicalText = style.textContent ?? "";
    const source =
      update?.physicalText === physicalText ? update.snapshot.source : physicalText;
    scheduleDynamicStyle(style, source);
  };
  const scheduleConnectedDynamicStyle = (style: HTMLStyleElement): void => {
    const physicalText = style.textContent ?? "";
    const update = dynamicStyleUpdates.get(style);
    if (update === undefined && processedStyles.get(style) === physicalText) {
      dynamicStyleUpdates.set(style, {
        revision: 0,
        snapshot: {
          source: physicalText,
          stylesheetURL: options.getBaseURL(),
          media: style.media,
          disabled: style.disabled,
        },
        physicalText,
        status: physicalText === "" ? "empty" : "committed",
      });
      installCSSOMStyleSheet(style);
      return;
    }

    const source =
      update?.physicalText === physicalText ? update.snapshot.source : physicalText;
    if (
      update?.status === "committed" &&
      update.physicalText === physicalText &&
      processedStyles.get(style) === physicalText
    ) {
      update.revision += 1;
      installCSSOMStyleSheet(style);
      return;
    }
    scheduleDynamicStyle(style, source, true);
  };
  const invalidateDynamicStyle = (style: HTMLStyleElement): void => {
    const update = dynamicStyleUpdates.get(style);
    if (update !== undefined) {
      update.revision += 1;
    }
  };
  const sameLinkSnapshot = (
    first: DynamicLinkSnapshot,
    second: DynamicLinkSnapshot,
  ): boolean =>
    first.href === second.href &&
    first.media === second.media &&
    first.disabled === second.disabled &&
    first.authoredRel === second.authoredRel;
  const linkRevisionIsCurrent = (
    link: HTMLLinkElement,
    update: DynamicLinkUpdate,
    revision: number,
    snapshot: DynamicLinkSnapshot,
  ): boolean =>
    !options.isDisposed() &&
    !options.signal.aborted &&
    options.isConnectedToRealm(link) &&
    update.revision === revision &&
    update.snapshot === snapshot &&
    update.authoredRel === snapshot.authoredRel &&
    options.getFacade()?.native.getAttribute(link, "rel") === "v-frame-stylesheet" &&
    link.href === snapshot.href &&
    link.media === snapshot.media &&
    link.disabled === snapshot.disabled;
  const scheduleDynamicLink = (
    link: HTMLLinkElement,
    forceRevision = false,
    authoredRelOverride?: string | null,
  ): void => {
    let update = dynamicLinkUpdates.get(link);
    const authoredRel =
      authoredRelOverride !== undefined
        ? authoredRelOverride
        : (update?.authoredRel ?? link.getAttribute("rel"));
    const authoredRelValue = authoredRel ?? "";
    const isStylesheet = authoredRelValue
      .split(/[\t\n\f\r ]+/)
      .some((token) => token.toLowerCase() === "stylesheet");
    if (update === undefined) {
      update = { revision: 0, snapshot: null, authoredRel };
      dynamicLinkUpdates.set(link, update);
    } else {
      update.authoredRel = authoredRel;
    }
    if (
      !options.isConnectedToRealm(link) ||
      !isStylesheet ||
      !link.hasAttribute("href")
    ) {
      update.revision += 1;
      update.snapshot = null;
      return;
    }

    const snapshot: DynamicLinkSnapshot = {
      href: link.href,
      media: link.media,
      disabled: link.disabled,
      authoredRel: authoredRelValue,
    };
    if (
      !forceRevision &&
      update.snapshot !== null &&
      sameLinkSnapshot(update.snapshot, snapshot)
    ) {
      return;
    }

    update.revision += 1;
    update.snapshot = snapshot;
    update.authoredRel = authoredRel;
    const revision = update.revision;

    void (async () => {
      const importFailures: StylesheetImportFailure[] = [];
      try {
        const source = await fetchStylesheetText(
          snapshot.href,
          options.stylesheetContext,
        );
        const rewritten = await rewriteStylesheet(
          source,
          snapshot.href,
          createRevisionStylesheetContext(importFailures),
        );
        if (!linkRevisionIsCurrent(link, update, revision, snapshot)) {
          return;
        }
        const style = document.createElement("style");
        applyNonce(style);
        style.dataset.vFrameSource = snapshot.href;
        style.media = snapshot.media;
        style.textContent = rewritten;
        processedStyles.set(style, rewritten);
        link.replaceWith(style);
        // disabled only reaches a sheet once the style is connected; on a
        // detached element the assignment is a spec-mandated no-op.
        style.disabled = snapshot.disabled;
        installCSSOMStyleSheet(style);
        link.dispatchEvent(new window.Event("load"));
        reportImportFailures(
          importFailures,
          () =>
            !options.isDisposed() &&
            !options.signal.aborted &&
            options.isConnectedToRealm(style) &&
            processedStyles.get(style) === (style.textContent ?? ""),
        );
      } catch (error) {
        if (!linkRevisionIsCurrent(link, update, revision, snapshot)) {
          return;
        }
        update.revision += 1;
        update.snapshot = null;
        link.remove();
        link.dispatchEvent(new window.Event("error"));
        options.onError({ phase: "stylesheet", url: snapshot.href, error });
      }
    })();
  };
  const invalidateDynamicLink = (link: HTMLLinkElement): void => {
    const update = dynamicLinkUpdates.get(link);
    if (update !== undefined) {
      update.revision += 1;
      update.snapshot = null;
    }
  };
  const observeConnectedNodes = (nodes: readonly Node[]): void => {
    const styles = virtualStylesFrom(nodes);
    const links = dynamicLinksFrom(nodes);
    for (const style of styles) {
      connectedStylesAwaitingObservation.add(style);
      scheduleConnectedDynamicStyle(style);
    }
    for (const link of links) {
      connectedLinksAwaitingObservation.add(link);
      scheduleDynamicLink(link, true);
    }

    for (const node of nodes) {
      const parentStyle =
        node.parentNode instanceof window.HTMLStyleElement ? node.parentNode : null;
      if (parentStyle !== null && !styles.includes(parentStyle)) {
        scheduleDynamicStyleContent(parentStyle);
      }
    }
  };

  return {
    applyNonce,
    virtualStylesFrom,
    dynamicLinksFrom,
    installCSSOMStyleSheets,
    observeConnectedNodes,
    scheduleDynamicStyle,
    scheduleDynamicStyleContent,
    scheduleDynamicStyleAttributes,
    scheduleConnectedDynamicStyle,
    invalidateDynamicStyle,
    scheduleDynamicLink,
    invalidateDynamicLink,
    recordProcessedStyle(style, source) {
      processedStyles.set(style, source);
    },
    isGeneratedStyleWrite(style) {
      return generatedStyleWrites.has(style);
    },
    claimAwaitedStyle(style) {
      return connectedStylesAwaitingObservation.delete(style);
    },
    claimAwaitedLink(link) {
      return connectedLinksAwaitingObservation.delete(link);
    },
  };
}
