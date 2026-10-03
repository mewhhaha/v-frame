import generateCSS from "css-tree/generator";
import { FRAGMENT_TARGET_ATTRIBUTE } from "./fragment.js";
import parseCSS from "css-tree/parser";
import walkCSS from "css-tree/walker";
import { ident } from "css-tree/utils";
import type {
  Atrule,
  CssNode,
  List,
  ListItem,
  Selector,
  StyleSheet,
  Url,
} from "css-tree";

const SHELL_ELEMENT_NAMES = new Map([
  ["html", "v-html"],
  ["head", "v-head"],
  ["body", "v-body"],
]);

const SHADOW_ONLY_PSEUDO_CLASSES = new Set(["host", "host-context"]);

export class CSSOMImportRuleError extends Error {
  constructor() {
    super("CSSOM @import rules are unsupported inside v-frame");
    this.name = "CSSOMImportRuleError";
  }
}

export interface StylesheetSource {
  text: string;
  /** Final response URL, including redirects. */
  url: string;
}

export interface StylesheetFetch {
  (url: string): Promise<string | StylesheetSource>;
}

export interface StylesheetImportFailure {
  url: string;
  error: unknown;
}

export interface StylesheetContext {
  fetchText: StylesheetFetch;
  requests: Map<string, Promise<StylesheetSource>>;
  onImportFailure?(failure: StylesheetImportFailure): void;
}

export function createStylesheetContext(
  fetchText: StylesheetFetch,
  onImportFailure?: StylesheetContext["onImportFailure"],
): StylesheetContext {
  const context: StylesheetContext = {
    fetchText,
    requests: new Map(),
  };
  if (onImportFailure !== undefined) {
    context.onImportFailure = onImportFailure;
  }
  return context;
}

function parseStylesheet(source: string, stylesheetURL: string): StyleSheet {
  try {
    return parseCSS(source, {
      context: "stylesheet",
      filename: stylesheetURL,
      parseCustomProperty: true,
      positions: true,
    }) as StyleSheet;
  } catch (cause) {
    throw new SyntaxError(`Stylesheet ${stylesheetURL} could not be parsed`, {
      cause,
    });
  }
}

function rewriteShellSelectors(
  ast: CssNode,
  suppressShadowOnlyPseudoClasses = false,
  shellNames = true,
): void {
  walkCSS(ast, {
    enter(node: CssNode, item: ListItem<CssNode>, list: List<CssNode>) {
      if (node.type === "TypeSelector" && shellNames) {
        const replacement = SHELL_ELEMENT_NAMES.get(
          ident.decode(node.name).toLowerCase(),
        );
        if (replacement !== undefined) {
          node.name = replacement;
        }
        return;
      }

      if (node.type === "PseudoClassSelector") {
        const pseudoClassName = ident.decode(node.name).toLowerCase();
        if (
          suppressShadowOnlyPseudoClasses &&
          SHADOW_ONLY_PSEUDO_CLASSES.has(pseudoClassName)
        ) {
          const replacement = parseCSS(":not(*)", {
            context: "selector",
          }) as Selector;
          list.replace(item, replacement.children.copy());
          return;
        }

        if (pseudoClassName === "target" && node.children === null) {
          const replacement = parseCSS(`[${FRAGMENT_TARGET_ATTRIBUTE}]`, {
            context: "selector",
          }) as Selector;
          list.replace(item, replacement.children.copy());
        } else if (shellNames && pseudoClassName === "root") {
          const replacement = parseCSS(":where(v-html):nth-child(n)", {
            context: "selector",
          }) as Selector;
          list.replace(item, replacement.children.copy());
        }
      }
    },
  });
}

function absolutizeCssURLs(ast: CssNode, stylesheetURL: string): void {
  walkCSS(ast, {
    visit: "Url",
    enter(node: Url) {
      // An empty url() is an invalid resource that must never be fetched, so
      // rebasing it against the stylesheet would invent a request.
      if (node.value === "" || node.value.startsWith("#")) {
        return;
      }

      try {
        node.value = new URL(node.value, stylesheetURL).href;
      } catch {
        // Browsers keep a rule whose url() cannot be resolved and simply fail
        // to load the resource; discarding the stylesheet would lose the rest.
      }
    },
  });
}

interface ImportParts {
  url: string;
  layer: string | null;
  supports: string | null;
  media: string | null;
}

function importParts(rule: Atrule, stylesheetURL: string): ImportParts | null {
  if (rule.prelude === null || rule.prelude.type !== "AtrulePrelude") {
    return null;
  }

  const children = rule.prelude.children.toArray();
  const reference = children[0];
  if (reference?.type !== "Url" && reference?.type !== "String") {
    return null;
  }

  let layer: string | null = null;
  let supports: string | null = null;
  let media: string | null = null;
  for (const qualifier of children.slice(1)) {
    if (qualifier.type === "Identifier" && qualifier.name.toLowerCase() === "layer") {
      layer = "";
    } else if (
      qualifier.type === "Function" &&
      qualifier.name.toLowerCase() === "layer"
    ) {
      layer = qualifier.children
        .toArray()
        .map((child) => generateCSS(child))
        .join("");
    } else if (
      qualifier.type === "Function" &&
      qualifier.name.toLowerCase() === "supports"
    ) {
      supports = qualifier.children
        .toArray()
        .map((child) => generateCSS(child))
        .join("");
    } else if (qualifier.type === "MediaQueryList") {
      media = generateCSS(qualifier);
    }
  }

  let url: string;
  try {
    url = new URL(reference.value, stylesheetURL).href;
  } catch {
    // An unresolvable @import stays in place uninlined; the browser ignores
    // it, matching native handling of a bad import URL.
    return null;
  }

  return {
    url,
    layer,
    supports,
    media,
  };
}

function wrapImportedStylesheet(source: string, parts: ImportParts): string {
  let wrapped = source;
  if (parts.media !== null) {
    wrapped = `@media ${parts.media}{${wrapped}}`;
  }
  if (parts.supports !== null) {
    const condition =
      parts.supports.includes(":") && !parts.supports.trim().startsWith("(")
        ? `(${parts.supports})`
        : parts.supports;
    wrapped = `@supports ${condition}{${wrapped}}`;
  }
  if (parts.layer !== null) {
    wrapped =
      parts.layer === "" ? `@layer{${wrapped}}` : `@layer ${parts.layer}{${wrapped}}`;
  }
  return wrapped;
}

export function fetchStylesheet(
  url: string,
  context: StylesheetContext,
): Promise<StylesheetSource> {
  const existing = context.requests.get(url);
  if (existing !== undefined) {
    return existing;
  }

  const request = context
    .fetchText(url)
    .then((source) =>
      typeof source === "string"
        ? { text: source, url }
        : { text: source.text, url: new URL(source.url, url).href },
    );
  context.requests.set(url, request);
  // A rejected fetch is evicted so a later insertion can retry the network
  // instead of replaying the cached failure for the realm's lifetime.
  request.catch(() => {
    if (context.requests.get(url) === request) {
      context.requests.delete(url);
    }
  });
  return request;
}

async function inlineImports(
  ast: StyleSheet,
  stylesheetURL: string,
  context: StylesheetContext,
  ancestors: ReadonlySet<string>,
): Promise<void> {
  const imports: Array<{
    rule: Atrule;
    item: ListItem<CssNode>;
    list: List<CssNode>;
  }> = [];
  let importsAllowed = true;
  let foundImport = false;

  ast.children.forEach((node, item, list) => {
    if (!importsAllowed) {
      return;
    }

    if (node.type !== "Atrule") {
      importsAllowed = false;
      return;
    }

    const name = node.name.toLowerCase();
    if (name === "import") {
      imports.push({ rule: node, item, list });
      foundImport = true;
      return;
    }

    if (name === "charset") {
      return;
    }

    if (name === "layer" && node.block === null) {
      if (foundImport) {
        importsAllowed = false;
      }
      return;
    }

    importsAllowed = false;
  });

  for (const entry of imports) {
    const parts = importParts(entry.rule, stylesheetURL);
    if (parts === null) {
      continue;
    }

    if (ancestors.has(parts.url)) {
      entry.list.remove(entry.item);
      continue;
    }

    try {
      const source = await fetchStylesheet(parts.url, context);
      if (ancestors.has(source.url)) {
        entry.list.remove(entry.item);
        continue;
      }
      const importedAncestors = new Set(ancestors);
      importedAncestors.add(parts.url);
      importedAncestors.add(source.url);
      const transformed = await transformStylesheet(
        source.text,
        source.url,
        context,
        importedAncestors,
      );
      const replacement = parseStylesheet(
        wrapImportedStylesheet(transformed, parts),
        parts.url,
      );
      entry.list.replace(entry.item, replacement.children.copy());
    } catch (error) {
      entry.list.remove(entry.item);
      context.onImportFailure?.({ url: parts.url, error });
    }
  }
}

async function transformStylesheet(
  source: string,
  stylesheetURL: string,
  context: StylesheetContext,
  ancestors: ReadonlySet<string>,
): Promise<string> {
  const ast = parseStylesheet(source, stylesheetURL);
  await inlineImports(ast, stylesheetURL, context, ancestors);
  rewriteShellSelectors(ast, true);
  absolutizeCssURLs(ast, stylesheetURL);
  return generateCSS(ast);
}

export async function rewriteStylesheet(
  source: string,
  stylesheetURL: string,
  context: StylesheetContext,
): Promise<string> {
  return transformStylesheet(source, stylesheetURL, context, new Set([stylesheetURL]));
}

/** Font definitions must be placed in the host stylesheet for shadow-tree interoperability. */
export function extractFontFaces(source: string, stylesheetURL: string): string {
  const sheet = parseStylesheet(source, stylesheetURL);
  let faces = 0;
  walkCSS(sheet, {
    enter(node: CssNode, item: ListItem<CssNode>, list: List<CssNode>) {
      if (node.type === "Rule" && item && list) {
        list.remove(item);
        return walkCSS.skip;
      }
      if (node.type !== "Atrule") return;
      const name = node.name.toLowerCase();
      if (name === "font-face") {
        faces++;
        return walkCSS.skip;
      }
      if (!["media", "supports", "layer"].includes(name) && item && list) {
        list.remove(item);
        return walkCSS.skip;
      }
    },
  });
  return faces ? generateCSS(sheet) : "";
}

export function rewriteStyleAttribute(source: string, baseURL: string): string {
  const ast = parseCSS(source, {
    context: "declarationList",
    parseCustomProperty: true,
  });
  absolutizeCssURLs(ast, baseURL);
  return generateCSS(ast);
}

export function rewriteCSSOMInsertRule(source: string, baseURL: string): string {
  const ast = parseStylesheet(source, baseURL);
  let containsImport = false;
  walkCSS(ast, {
    visit: "Atrule",
    enter(node: Atrule) {
      if (node.name.toLowerCase() === "import") {
        containsImport = true;
      }
    },
  });
  if (containsImport) {
    throw new CSSOMImportRuleError();
  }
  rewriteShellSelectors(ast, true);
  absolutizeCssURLs(ast, baseURL);
  return generateCSS(ast);
}

export function rewriteCSSOMAddRule(
  selector: string,
  declarations: string,
  baseURL: string,
): { selector: string; declarations: string } {
  return {
    selector: rewriteCSSOMSelectorText(selector),
    declarations: rewriteStyleAttribute(declarations, baseURL),
  };
}

export function rewriteCSSOMSelectorText(source: string): string {
  const ast = parseCSS(source, { context: "selectorList" }) as Selector;
  rewriteShellSelectors(ast, true);
  return generateCSS(ast);
}

/** Restrict only the subject of each selector, without changing specificity. */
export function scopeCSSOMSelectorText(source: string, scope: string): string {
  const selectors = parseCSS(source, { context: "selectorList" });
  const guard = parseCSS(`:where(${scope},${scope} *)`, {
    context: "selector",
  }) as Selector;
  if (selectors.type !== "SelectorList") return source;
  for (const selector of selectors.children) {
    if (selector.type !== "Selector") continue;
    let pseudoElement: ListItem<CssNode> | undefined;
    selector.children.forEach((node, item) => {
      if (node.type === "Combinator") pseudoElement = undefined;
      else if (node.type === "PseudoElementSelector" && pseudoElement === undefined)
        pseudoElement = item;
    });
    if (pseudoElement === undefined) selector.children.appendList(guard.children.copy());
    else selector.children.insertList(guard.children.copy(), pseudoElement);
  }
  return generateCSS(selectors);
}

/** Hide the temporary subject guard while preserving native CSSOM serialization. */
export function unScopeCSSOMRuleText(source: string, scope: string): string {
  const ast = parseCSS(source, { context: "stylesheet", positions: true });
  const guard = generateCSS(
    parseCSS(`:where(${scope},${scope} *)`, { context: "selector" }),
  );
  const ranges: Array<{ start: number; end: number }> = [];
  walkCSS(ast, {
    enter(node: CssNode) {
      if (
        node.type === "PseudoClassSelector" &&
        node.name === "where" &&
        node.loc &&
        generateCSS(node) === guard
      ) {
        ranges.push({ start: node.loc.start.offset, end: node.loc.end.offset });
        return walkCSS.skip;
      }
    },
  });
  for (const range of ranges.sort((a, b) => b.start - a.start))
    source = source.slice(0, range.start) + source.slice(range.end);
  return source;
}

export function translateShellSelector(selector: string): string {
  const ast = parseCSS(selector, { context: "selectorList" });
  rewriteShellSelectors(ast);
  return generateCSS(ast);
}

/** Rewrite target state on the unaliased branch of a DOM selector lookup too. */
export function translateTargetSelector(selector: string): string {
  if (!selector.includes(":")) return selector;
  const ast = parseCSS(selector, { context: "selectorList" });
  rewriteShellSelectors(ast, false, false);
  return generateCSS(ast);
}
