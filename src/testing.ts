import {
  VFrameStatus,
  type VFrameCredentials,
  type VFrameErrorEventDetail,
  type VFrameLoadEventDetail,
  type VFrameNavigatedEventDetail,
  type VFrameNavigateEventDetail,
  type VFrameNavigateOptions,
  type VFrameNavigation,
  type VFrameNavigationKind,
} from "./types.js";

/** A matcher accepted by Testing Library–style queries. */
export type TextMatch =
  | string
  | RegExp
  | ((content: string, element: Element | null) => boolean);

/** Text normalization and exactness options shared across matchers. */
export interface MatcherOptions {
  /** Match the full normalized value when true (default); match case-insensitive substrings when false. */
  exact?: boolean;
  /** Normalize text before matching. Defaults to collapsing whitespace and trimming. */
  normalizer?: (text: string) => string;
}

/** Matcher options that also filter candidate elements with a CSS selector. */
export interface SelectorMatcherOptions extends MatcherOptions {
  /** Only consider elements matching this CSS selector (default `"*"`). */
  selector?: string;
}

/** Options for `*ByRole` queries. */
export interface ByRoleOptions extends MatcherOptions {
  /** Match the element's accessible name. */
  name?: TextMatch;
  /** Include elements hidden from the accessibility tree (default `false`). */
  hidden?: boolean;
  /** Match heading level (`aria-level` or `<h1>`–`<h6>`). */
  level?: number;
  /** Match checkable state (`aria-checked` or native `checked`/`indeterminate`). */
  checked?: boolean | "mixed";
  /** Match toggle button state (`aria-pressed`). */
  pressed?: boolean | "mixed";
  /** Match selectable state (`aria-selected` or `option.selected`). */
  selected?: boolean;
  /** Match expandable state (`aria-expanded` or `<details>` open state for `<summary>`). */
  expanded?: boolean;
  /** Match `aria-current` state. */
  current?: boolean | string;
  /** Match the element's accessible description (`aria-describedby` / `aria-description`). */
  description?: TextMatch;
  /** Match `aria-busy` state. */
  busy?: boolean;
}

/** Timing configuration for `waitFor` and `findBy*` / `findAllBy*` queries. */
export interface WaitForOptions {
  /** Maximum wait duration in milliseconds (default `1000`). */
  timeout?: number;
  /** Polling fallback interval in milliseconds (default `50`). */
  interval?: number;
}

/** Configuration for `withinShadow` and `withinFrame`. */
export interface ShadowQueryOptions {
  /** Attribute checked by `*ByTestId` queries (default `"data-testid"`). */
  testIdAttribute?: string;
  /** Default timing options for `findBy*` and `findAllBy*`. */
  waitFor?: WaitForOptions;
}

/** Either a concrete root node or a lazy resolver evaluated on every query. */
export type ShadowQueryRoot = ParentNode | (() => ParentNode | null);

/** Structural subset of `VFrameElement` needed by `withinFrame`. */
export interface VFrameLike extends Element {
  readonly shadowRoot: ShadowRoot | null;
  readonly status?: string;
  whenReady?(): Promise<void>;
}

/** Testing Library–style queries that pierce open shadow roots (including `<v-frame>`). */
export interface ShadowQueries {
  queryShadow<T extends Element = Element>(selector: string): T | null;
  queryAllShadow<T extends Element = Element>(selector: string): T[];

  queryByRole<T extends HTMLElement = HTMLElement>(
    role: TextMatch,
    options?: ByRoleOptions,
  ): T | null;
  queryAllByRole<T extends HTMLElement = HTMLElement>(
    role: TextMatch,
    options?: ByRoleOptions,
  ): T[];
  getByRole<T extends HTMLElement = HTMLElement>(
    role: TextMatch,
    options?: ByRoleOptions,
  ): T;
  getAllByRole<T extends HTMLElement = HTMLElement>(
    role: TextMatch,
    options?: ByRoleOptions,
  ): T[];
  findByRole<T extends HTMLElement = HTMLElement>(
    role: TextMatch,
    options?: ByRoleOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T>;
  findAllByRole<T extends HTMLElement = HTMLElement>(
    role: TextMatch,
    options?: ByRoleOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T[]>;

  queryByLabelText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T | null;
  queryAllByLabelText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T[];
  getByLabelText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T;
  getAllByLabelText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T[];
  findByLabelText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T>;
  findAllByLabelText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T[]>;

  queryByPlaceholderText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T | null;
  queryAllByPlaceholderText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T[];
  getByPlaceholderText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T;
  getAllByPlaceholderText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T[];
  findByPlaceholderText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T>;
  findAllByPlaceholderText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T[]>;

  queryByText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T | null;
  queryAllByText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T[];
  getByText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T;
  getAllByText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T[];
  findByText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T>;
  findAllByText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T[]>;

  queryByDisplayValue<T extends HTMLElement = HTMLElement>(
    value: TextMatch,
    options?: MatcherOptions,
  ): T | null;
  queryAllByDisplayValue<T extends HTMLElement = HTMLElement>(
    value: TextMatch,
    options?: MatcherOptions,
  ): T[];
  getByDisplayValue<T extends HTMLElement = HTMLElement>(
    value: TextMatch,
    options?: MatcherOptions,
  ): T;
  getAllByDisplayValue<T extends HTMLElement = HTMLElement>(
    value: TextMatch,
    options?: MatcherOptions,
  ): T[];
  findByDisplayValue<T extends HTMLElement = HTMLElement>(
    value: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T>;
  findAllByDisplayValue<T extends HTMLElement = HTMLElement>(
    value: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T[]>;

  queryByAltText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T | null;
  queryAllByAltText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T[];
  getByAltText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T;
  getAllByAltText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T[];
  findByAltText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T>;
  findAllByAltText<T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T[]>;

  queryByTitle<T extends HTMLElement = HTMLElement>(
    title: TextMatch,
    options?: MatcherOptions,
  ): T | null;
  queryAllByTitle<T extends HTMLElement = HTMLElement>(
    title: TextMatch,
    options?: MatcherOptions,
  ): T[];
  getByTitle<T extends HTMLElement = HTMLElement>(
    title: TextMatch,
    options?: MatcherOptions,
  ): T;
  getAllByTitle<T extends HTMLElement = HTMLElement>(
    title: TextMatch,
    options?: MatcherOptions,
  ): T[];
  findByTitle<T extends HTMLElement = HTMLElement>(
    title: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T>;
  findAllByTitle<T extends HTMLElement = HTMLElement>(
    title: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T[]>;

  queryByTestId<T extends HTMLElement = HTMLElement>(
    id: TextMatch,
    options?: MatcherOptions,
  ): T | null;
  queryAllByTestId<T extends HTMLElement = HTMLElement>(
    id: TextMatch,
    options?: MatcherOptions,
  ): T[];
  getByTestId<T extends HTMLElement = HTMLElement>(
    id: TextMatch,
    options?: MatcherOptions,
  ): T;
  getAllByTestId<T extends HTMLElement = HTMLElement>(
    id: TextMatch,
    options?: MatcherOptions,
  ): T[];
  findByTestId<T extends HTMLElement = HTMLElement>(
    id: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T>;
  findAllByTestId<T extends HTMLElement = HTMLElement>(
    id: TextMatch,
    options?: MatcherOptions,
    waitForOptions?: WaitForOptions,
  ): Promise<T[]>;
}

/** Queries scoped to a `<v-frame>` element, re-resolving its active shadow root across navigations. */
export interface FrameQueries extends ShadowQueries {
  /** Wait until the frame finishes loading (delegates to `frame.whenReady()` when available). */
  ready(): Promise<void>;
}

/** Options for `resetChannels`. */
export interface ResetChannelsOptions {
  /** Target document hosting the channel hub (defaults to `globalThis.document`). */
  document?: Document;
  /**
   * When true, detaches the existing hub from the document so leaked subscribers from earlier
   * tests no longer receive publications on subsequent channel calls.
   */
  disconnectSubscribers?: boolean;
}

/** Request object passed to a `defineMockVFrame` route handler. */
export interface MockVFrameRequest {
  readonly url: URL;
  readonly pathname: string;
  readonly frame: HTMLElement;
}

/** Value returned by a `defineMockVFrame` route entry or handler. */
export type MockVFrameRouteResult =
  | string
  | { html: string; url?: string; status?: number }
  | Response;

/** Dynamic route resolver for `defineMockVFrame`. */
export type MockVFrameRouteHandler = (
  request: MockVFrameRequest,
) => MockVFrameRouteResult | Promise<MockVFrameRouteResult>;

/** Route table (keyed by full URL, pathname+search, pathname, or `"*"`) or handler function. */
export type MockVFrameRoutes =
  | Record<string, MockVFrameRouteResult | MockVFrameRouteHandler>
  | MockVFrameRouteHandler;

/** Configuration for `defineMockVFrame`. */
export interface MockVFrameOptions {
  /** Render into an open shadow root (default `"shadow"`) or directly into light DOM (`"light"`). */
  renderMode?: "shadow" | "light";
  /** Base URL used to resolve relative `src` values. */
  baseURL?: string;
  /** Custom element tag name to define (default `"v-frame"`). */
  tagName?: string;
}

/** Controller returned by `defineMockVFrame` for updating routes, inspecting requests, and restoring state. */
export interface MockVFrameController {
  /** Replace the active route table or handler. */
  setRoutes(routes: MockVFrameRoutes): void;
  /** URLs requested since creation or the last `clearRequests()`. */
  readonly requests: readonly string[];
  /** Clear recorded request URLs. */
  clearRequests(): void;
  /** Restore the previous mock configuration (call in `afterEach`). */
  restore(): void;
}

const CHANNEL_HUB_KEY = Symbol.for("@mewhhaha/v-frame/channel-hub/1");
const STAGED_ATTR = "data-v-frame-staged";

const NON_CONTENT_TAGS = new Set([
  "HEAD",
  "V-HEAD",
  "STYLE",
  "SCRIPT",
  "NOSCRIPT",
  "TEMPLATE",
  "TITLE",
  "META",
  "LINK",
]);

const LABELABLE_TAGS = new Set([
  "BUTTON",
  "INPUT",
  "METER",
  "OUTPUT",
  "PROGRESS",
  "SELECT",
  "TEXTAREA",
]);

const SECTIONING_ANCESTOR_TAGS = new Set(["ARTICLE", "ASIDE", "MAIN", "NAV", "SECTION"]);

const NAME_FROM_CONTENT_ROLES = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);

function defaultNormalizer(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function matchText(
  actual: string,
  matcher: TextMatch,
  element: Element | null,
  options?: MatcherOptions,
): boolean {
  const normalizer = options?.normalizer ?? defaultNormalizer;
  const normalized = normalizer(actual);
  if (typeof matcher === "function") {
    return matcher(normalized, element);
  }
  if (matcher instanceof RegExp) {
    if (matcher.global || matcher.sticky) {
      matcher.lastIndex = 0;
    }
    return matcher.test(normalized);
  }
  const exact = options?.exact ?? true;
  if (exact) {
    return normalized === normalizer(matcher);
  }
  return normalized.toLowerCase().includes(normalizer(matcher).toLowerCase());
}

function isElementNode(node: Node | null | undefined): node is Element {
  return node !== null && node !== undefined && node.nodeType === 1;
}

function isShadowRootNode(node: Node | null | undefined): node is ShadowRoot {
  return (
    node !== null &&
    node !== undefined &&
    node.nodeType === 11 &&
    "host" in node &&
    isElementNode((node as ShadowRoot).host)
  );
}

function isStagedContainer(element: Element): boolean {
  return element.hasAttribute(STAGED_ATTR);
}

function isInternalRealmIframe(element: Element): boolean {
  return (
    element.tagName === "IFRAME" &&
    element.getAttribute("aria-hidden") === "true" &&
    element.getAttribute("tabindex") === "-1"
  );
}

function collectShadowElements(
  root: ParentNode,
  options?: { skipNonContent?: boolean },
): Element[] {
  const elements: Element[] = [];
  const visited = new Set<Node>();
  const skipNonContent = options?.skipNonContent ?? false;

  const visitChildren = (parent: ParentNode): void => {
    if (visited.has(parent)) return;
    visited.add(parent);
    const children = parent.children;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child || visited.has(child)) continue;
      if (isStagedContainer(child)) continue;
      if (skipNonContent && NON_CONTENT_TAGS.has(child.tagName)) continue;
      elements.push(child);
      const shadow = child.shadowRoot;
      if (shadow) {
        visitChildren(shadow);
      }
      visitChildren(child);
    }
  };

  if (isElementNode(root)) {
    if (isStagedContainer(root)) return elements;
    const shadow = root.shadowRoot;
    if (shadow) {
      visitChildren(shadow);
    }
  }
  visitChildren(root);
  return elements;
}

function getNativeParentNode(node: Node): Node | null {
  if (typeof Node !== "undefined") {
    const getter = Object.getOwnPropertyDescriptor(Node.prototype, "parentNode")?.get;
    if (getter) {
      try {
        return getter.call(node) as Node | null;
      } catch {
        // Fall back for stubs or environments without cross-realm brand compatibility.
      }
    }
  }
  return node.parentNode;
}

function getNativeGetRootNode(node: Node): Node {
  if (typeof Node !== "undefined" && typeof Node.prototype.getRootNode === "function") {
    try {
      return Node.prototype.getRootNode.call(node);
    } catch {
      // Fall back for stubs or non-standard nodes.
    }
  }
  return node.getRootNode();
}

function getNativeOwnerDocument(node: Node): Document | null {
  if (typeof Node !== "undefined") {
    const getter = Object.getOwnPropertyDescriptor(Node.prototype, "ownerDocument")?.get;
    if (getter) {
      try {
        return getter.call(node) as Document | null;
      } catch {
        // Fall back for stubs.
      }
    }
  }
  return node.ownerDocument;
}

function getParentAcrossShadow(node: Node): Element | null {
  const parent = getNativeParentNode(node);
  if (isElementNode(parent)) return parent;
  if (isShadowRootNode(parent)) return parent.host;
  return null;
}

function isPrimaryDetailsSummary(details: Element, candidate: Element): boolean {
  if (candidate.tagName !== "SUMMARY") return false;
  for (let index = 0; index < details.children.length; index += 1) {
    const child = details.children[index];
    if (child?.tagName === "SUMMARY") {
      return child === candidate;
    }
  }
  return false;
}

function matchesNativeModal(element: Element): boolean {
  if (element.tagName !== "DIALOG" || !element.hasAttribute("open")) return false;
  try {
    return element.matches(":modal");
  } catch {
    return false;
  }
}

function findActiveModal(root: ParentNode): Element | null {
  if (!("isConnected" in root) || !root.isConnected) return null;
  const doc = root.nodeType === 9 ? (root as Document) : getNativeOwnerDocument(root);
  if (!doc) return null;
  const all = collectShadowElements(doc, { skipNonContent: true });
  let activeModal: Element | null = null;
  for (let index = 0; index < all.length; index += 1) {
    const candidate = all[index];
    if (candidate && matchesNativeModal(candidate)) {
      activeModal = candidate;
    }
  }
  return activeModal;
}

function isElementInaccessible(element: Element): boolean {
  const view = getNativeOwnerDocument(element)?.defaultView ?? null;
  const hasComputedStyle =
    view !== null && typeof view.getComputedStyle === "function" && element.isConnected;

  if (hasComputedStyle) {
    const style = view.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      return true;
    }
  }

  let current: Element | null = element;
  while (current !== null) {
    if (
      NON_CONTENT_TAGS.has(current.tagName) ||
      isStagedContainer(current) ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true" ||
      (current.tagName === "DIALOG" && !current.hasAttribute("open"))
    ) {
      return true;
    }
    if (
      current.hasAttribute("hidden") &&
      current.getAttribute("hidden") !== "until-found"
    ) {
      return true;
    }
    if (hasComputedStyle && current !== element) {
      const style = view.getComputedStyle(current);
      if (style.display === "none") {
        return true;
      }
    }
    const parent = getParentAcrossShadow(current);
    if (
      parent !== null &&
      parent.tagName === "DETAILS" &&
      !parent.hasAttribute("open") &&
      !isPrimaryDetailsSummary(parent, current)
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function findElementByIdInRoot(root: Node, id: string): Element | null {
  if (id === "") return null;
  if ("getElementById" in root && typeof root.getElementById === "function") {
    return (root as Document | ShadowRoot).getElementById(id);
  }
  if ("querySelector" in root && typeof root.querySelector === "function") {
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(id)
        : id.replace(/([^\w-])/g, "\\$1");
    try {
      return (root as ParentNode).querySelector(`#${escaped}`);
    } catch {
      return null;
    }
  }
  return null;
}

function resolveIdListText(
  element: Element,
  attrName: string,
  visited: Set<Element>,
): string {
  const raw = element.getAttribute(attrName)?.trim();
  if (!raw) return "";
  const root = getNativeGetRootNode(element);
  const parts: string[] = [];
  for (const id of raw.split(/\s+/)) {
    const target = findElementByIdInRoot(root, id);
    if (!target || visited.has(target)) continue;
    visited.add(target);
    const label = computeElementTextForAccName(target, visited, true);
    if (label) parts.push(label);
  }
  return parts.join(" ");
}

function getAssociatedLabels(element: Element): HTMLLabelElement[] {
  if (!LABELABLE_TAGS.has(element.tagName)) return [];
  const results: HTMLLabelElement[] = [];
  const seen = new Set<HTMLLabelElement>();

  const add = (label: HTMLLabelElement): void => {
    if (!seen.has(label)) {
      seen.add(label);
      results.push(label);
    }
  };

  const nativeLabels = (element as HTMLInputElement).labels;
  if (nativeLabels && nativeLabels.length > 0) {
    for (let index = 0; index < nativeLabels.length; index += 1) {
      const label = nativeLabels[index];
      if (label) add(label);
    }
    return results;
  }

  const root = getNativeGetRootNode(element);
  const id = element.getAttribute("id");
  if (id && "querySelectorAll" in root) {
    const labels = (root as ParentNode).querySelectorAll("label[for]");
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      if (label && label.getAttribute("for") === id) {
        add(label as HTMLLabelElement);
      }
    }
  }

  let ancestor = element.parentElement;
  while (ancestor !== null) {
    if (ancestor.tagName === "LABEL") {
      const forAttr = ancestor.getAttribute("for");
      if (!forAttr || forAttr === id) {
        add(ancestor as HTMLLabelElement);
      }
    }
    ancestor = ancestor.parentElement;
  }

  return results;
}

function getLabelTextExcludingControl(
  label: Element,
  targetControl: Element | null,
  visited: Set<Element>,
): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      if (text) parts.push(text);
      return;
    }
    if (!isElementNode(node)) return;
    if (node === targetControl) return;
    if (NON_CONTENT_TAGS.has(node.tagName) || isStagedContainer(node)) return;
    if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden"))
      return;
    if (node.tagName === "IMG") {
      const alt = node.getAttribute("alt");
      if (alt) parts.push(alt);
      return;
    }
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") {
      const value = (node as HTMLInputElement | HTMLTextAreaElement).value;
      if (value) parts.push(value);
      return;
    }
    if (node.tagName === "SELECT") {
      const select = node as HTMLSelectElement;
      const selected = select.selectedOptions
        ? Array.from(select.selectedOptions)
            .map((option) => option.textContent ?? "")
            .join(" ")
        : "";
      if (selected) parts.push(selected);
      return;
    }
    const ariaLabel = node.getAttribute("aria-label")?.trim();
    if (ariaLabel && !visited.has(node)) {
      parts.push(ariaLabel);
      return;
    }
    if (node.shadowRoot) {
      for (let index = 0; index < node.shadowRoot.childNodes.length; index += 1) {
        const child = node.shadowRoot.childNodes[index];
        if (child) walk(child);
      }
    }
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const child = node.childNodes[index];
      if (child) walk(child);
    }
  };
  walk(label);
  return defaultNormalizer(parts.join(" "));
}

function computeElementTextForAccName(
  element: Element,
  visited: Set<Element>,
  includeHiddenSelf = false,
): string {
  if (
    !includeHiddenSelf &&
    (NON_CONTENT_TAGS.has(element.tagName) ||
      isStagedContainer(element) ||
      element.getAttribute("aria-hidden") === "true" ||
      element.hasAttribute("hidden"))
  ) {
    return "";
  }

  const ariaLabelledBy = resolveIdListText(element, "aria-labelledby", visited);
  if (ariaLabelledBy) return ariaLabelledBy;

  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  if (element.tagName === "IMG" || element.tagName === "AREA") {
    return element.getAttribute("alt") ?? "";
  }
  if (element.tagName === "INPUT") {
    const input = element as HTMLInputElement;
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (type === "image") {
      return input.getAttribute("alt") ?? input.getAttribute("value") ?? "Submit";
    }
    if (type === "button" || type === "submit" || type === "reset") {
      const value = input.value;
      if (value) return value;
      if (type === "submit") return "Submit";
      if (type === "reset") return "Reset";
      return "";
    }
    return input.value ?? "";
  }

  const parts: string[] = [];
  const walk = (parent: Node): void => {
    for (let index = 0; index < parent.childNodes.length; index += 1) {
      const child = parent.childNodes[index];
      if (!child) continue;
      if (child.nodeType === 3) {
        const text = child.textContent ?? "";
        if (text) parts.push(text);
        continue;
      }
      if (!isElementNode(child) || visited.has(child)) continue;
      if (
        NON_CONTENT_TAGS.has(child.tagName) ||
        isStagedContainer(child) ||
        child.getAttribute("aria-hidden") === "true" ||
        child.hasAttribute("hidden")
      ) {
        continue;
      }
      visited.add(child);
      const piece = computeElementTextForAccName(child, visited, false);
      if (piece) parts.push(piece);
    }
  };

  if (element.shadowRoot) {
    walk(element.shadowRoot);
  }
  walk(element);
  return defaultNormalizer(parts.join(" "));
}

function getExplicitRole(element: Element): string | null {
  const attr = element.getAttribute("role")?.trim();
  if (!attr) return null;
  const token = attr.split(/\s+/)[0]?.toLowerCase() ?? "";
  return token || null;
}

function hasSectioningAncestor(element: Element): boolean {
  let current = getParentAcrossShadow(element);
  while (current !== null) {
    if (SECTIONING_ANCESTOR_TAGS.has(current.tagName)) return true;
    current = getParentAcrossShadow(current);
  }
  return false;
}

function computeNativeName(element: Element, visited: Set<Element>): string {
  const tag = element.tagName;
  if (tag === "IMG" || tag === "AREA") {
    return element.getAttribute("alt") ?? "";
  }
  if (tag === "INPUT") {
    const input = element as HTMLInputElement;
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (type === "image") {
      return input.getAttribute("alt") ?? input.getAttribute("value") ?? "Submit";
    }
    if (type === "button" || type === "submit" || type === "reset") {
      const value = input.getAttribute("value");
      if (value !== null) return value;
      if (type === "submit") return "Submit";
      if (type === "reset") return "Reset";
      return "";
    }
  }
  if (LABELABLE_TAGS.has(tag)) {
    const labels = getAssociatedLabels(element);
    if (labels.length > 0) {
      const labelText = labels
        .map((label) => getLabelTextExcludingControl(label, element, visited))
        .filter(Boolean)
        .join(" ");
      if (labelText) return labelText;
    }
  }
  if (tag === "FIELDSET") {
    for (let index = 0; index < element.children.length; index += 1) {
      const child = element.children[index];
      if (child?.tagName === "LEGEND") {
        return computeElementTextForAccName(child, visited, false);
      }
    }
  }
  if (tag === "FIGURE") {
    for (let index = 0; index < element.children.length; index += 1) {
      const child = element.children[index];
      if (child?.tagName === "FIGCAPTION") {
        return computeElementTextForAccName(child, visited, false);
      }
    }
  }
  if (tag === "TABLE") {
    for (let index = 0; index < element.children.length; index += 1) {
      const child = element.children[index];
      if (child?.tagName === "CAPTION") {
        return computeElementTextForAccName(child, visited, false);
      }
    }
  }
  if (tag === "SVG") {
    for (let index = 0; index < element.children.length; index += 1) {
      const child = element.children[index];
      if (child?.tagName.toLowerCase() === "title") {
        return defaultNormalizer(child.textContent ?? "");
      }
    }
  }
  return "";
}

function getElementRole(element: Element): string | null {
  const explicit = getExplicitRole(element);
  if (explicit !== null) {
    if (explicit === "none" || explicit === "presentation") return null;
    return explicit;
  }

  const tag = element.tagName;
  switch (tag) {
    case "A":
    case "AREA":
      return element.hasAttribute("href") ? "link" : null;
    case "ARTICLE":
      return "article";
    case "ASIDE":
      return "complementary";
    case "BUTTON":
      return "button";
    case "DATALIST":
      return "listbox";
    case "DD":
      return "definition";
    case "DIALOG":
      return "dialog";
    case "DT":
      return "term";
    case "FIELDSET":
      return "group";
    case "FIGURE":
      return "figure";
    case "FOOTER":
      return hasSectioningAncestor(element) ? null : "contentinfo";
    case "FORM":
      return computeAccessibleName(element, "form") ? "form" : null;
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return "heading";
    case "HEADER":
      return hasSectioningAncestor(element) ? null : "banner";
    case "HR":
      return "separator";
    case "IMG": {
      const alt = element.getAttribute("alt");
      if (
        alt === "" &&
        !element.getAttribute("aria-label")?.trim() &&
        !element.getAttribute("aria-labelledby")?.trim() &&
        !element.getAttribute("title")?.trim()
      ) {
        return null;
      }
      return "img";
    }
    case "INPUT": {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return null;
      if (
        type === "button" ||
        type === "image" ||
        type === "reset" ||
        type === "submit"
      ) {
        return "button";
      }
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search")
        return element.hasAttribute("list") ? "combobox" : "searchbox";
      if (
        type === "color" ||
        type === "date" ||
        type === "datetime-local" ||
        type === "file" ||
        type === "month" ||
        type === "password" ||
        type === "time" ||
        type === "week"
      ) {
        return null;
      }
      return element.hasAttribute("list") ? "combobox" : "textbox";
    }
    case "LI": {
      const parentTag = element.parentElement?.tagName;
      return parentTag === "UL" || parentTag === "OL" || parentTag === "MENU"
        ? "listitem"
        : null;
    }
    case "MAIN":
      return "main";
    case "MATH":
      return "math";
    case "MENU":
    case "OL":
    case "UL":
      return "list";
    case "METER":
      return "meter";
    case "NAV":
      return "navigation";
    case "OPTGROUP":
      return "group";
    case "OPTION":
      return "option";
    case "OUTPUT":
      return "status";
    case "PROGRESS":
      return "progressbar";
    case "SEARCH":
      return "search";
    case "SECTION":
      return computeAccessibleName(element, "region") ? "region" : null;
    case "SELECT": {
      const size = Number(element.getAttribute("size") ?? "0");
      return element.hasAttribute("multiple") || size > 1 ? "listbox" : "combobox";
    }
    case "SUMMARY":
      return element.parentElement?.tagName === "DETAILS" ? "button" : null;
    case "TABLE":
      return "table";
    case "TBODY":
    case "TFOOT":
    case "THEAD":
      return "rowgroup";
    case "TD":
      return "cell";
    case "TEXTAREA":
      return "textbox";
    case "TH":
      return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
    case "TR":
      return "row";
    default:
      return null;
  }
}

function computeAccessibleName(element: Element, role: string | null): string {
  const visited = new Set<Element>([element]);

  const labelledBy = resolveIdListText(element, "aria-labelledby", visited);
  if (labelledBy) return defaultNormalizer(labelledBy);

  const ariaLabel = element.getAttribute("aria-label")?.trim();
  if (ariaLabel) return defaultNormalizer(ariaLabel);

  const nativeName = computeNativeName(element, visited);
  if (nativeName) return defaultNormalizer(nativeName);

  if (role !== null && NAME_FROM_CONTENT_ROLES.has(role)) {
    const contentName = computeElementTextForAccName(
      element,
      new Set<Element>([element]),
      true,
    );
    if (contentName) return contentName;
  }

  const title = element.getAttribute("title")?.trim();
  if (title) return defaultNormalizer(title);

  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    const placeholder = element.getAttribute("placeholder")?.trim();
    if (placeholder) return defaultNormalizer(placeholder);
  }

  return "";
}

function computeAccessibleDescription(element: Element): string {
  const visited = new Set<Element>([element]);
  const describedBy = resolveIdListText(element, "aria-describedby", visited);
  if (describedBy) return defaultNormalizer(describedBy);

  const ariaDescription = element.getAttribute("aria-description")?.trim();
  if (ariaDescription) return defaultNormalizer(ariaDescription);

  const title = element.getAttribute("title")?.trim();
  if (title) return defaultNormalizer(title);

  return "";
}

function getHeadingLevel(element: Element): number | null {
  const ariaLevel = element.getAttribute("aria-level");
  if (ariaLevel !== null) {
    const parsed = Number.parseInt(ariaLevel, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const match = /^H([1-6])$/.exec(element.tagName);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function getTriState(
  element: Element,
  attrName: string,
  nativeValue?: boolean | "mixed" | null,
): boolean | "mixed" | null {
  const raw = element.getAttribute(attrName);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "mixed") return "mixed";
  return nativeValue ?? null;
}

function getCheckedState(element: Element): boolean | "mixed" | null {
  let nativeValue: boolean | "mixed" | null = null;
  if (element.tagName === "INPUT") {
    const input = element as HTMLInputElement;
    const type = (input.getAttribute("type") ?? "").toLowerCase();
    if (type === "checkbox") {
      nativeValue = input.indeterminate ? "mixed" : input.checked;
    } else if (type === "radio") {
      nativeValue = input.checked;
    }
  }
  return getTriState(element, "aria-checked", nativeValue);
}

function getSelectedState(element: Element): boolean | null {
  const raw = element.getAttribute("aria-selected");
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (element.tagName === "OPTION") {
    return (element as HTMLOptionElement).selected;
  }
  return null;
}

function getExpandedState(element: Element): boolean | null {
  const raw = element.getAttribute("aria-expanded");
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (element.tagName === "SUMMARY" && element.parentElement?.tagName === "DETAILS") {
    return (element.parentElement as HTMLDetailsElement).open;
  }
  return null;
}

function matchesCurrent(element: Element, expected: boolean | string): boolean {
  const raw = element.getAttribute("aria-current");
  const normalized = raw === null || raw === "" || raw === "false" ? false : raw;
  if (typeof expected === "boolean") {
    return expected ? normalized !== false : normalized === false;
  }
  return normalized === expected;
}

function getElementVisibleText(element: Element): string {
  if (element.tagName === "INPUT") {
    const input = element as HTMLInputElement;
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") {
      return input.value ?? "";
    }
    return "";
  }
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      if (text) parts.push(text);
      return;
    }
    if (!isElementNode(node)) return;
    if (NON_CONTENT_TAGS.has(node.tagName) || isStagedContainer(node)) return;
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const child = node.childNodes[index];
      if (child) walk(child);
    }
  };
  walk(element);
  return parts.join("");
}

function matchesSelector(element: Element, selector: string | undefined): boolean {
  if (!selector || selector === "*") return true;
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function isShadowAncestor(ancestor: Element, descendant: Element): boolean {
  let current = getParentAcrossShadow(descendant);
  while (current !== null) {
    if (current === ancestor) return true;
    current = getParentAcrossShadow(current);
  }
  return false;
}

function resolveRoot(root: ShadowQueryRoot): ParentNode {
  const resolved = typeof root === "function" ? root() : root;
  if (!resolved) {
    throw new Error(
      "v-frame/testing: query root is not available (no document or shadowRoot).",
    );
  }
  return resolved;
}

function formatMatcher(matcher: TextMatch): string {
  if (typeof matcher === "string") return JSON.stringify(matcher);
  if (matcher instanceof RegExp) return String(matcher);
  return "[custom matcher]";
}

function createQueryError(message: string, root: ParentNode | null): Error {
  const tree = root ? prettyShadowDOM(root, 4000) : "";
  return new Error(tree ? `${message}\n\n${tree}` : message);
}

/**
 * Format a DOM subtree as readable HTML while expanding open shadow roots
 * (such as `<v-frame>` and guest Web Components) and omitting hidden staging buffers.
 */
export function prettyShadowDOM(root?: Node, maxLength = 7000): string {
  const target =
    root ?? globalThis.document?.body ?? globalThis.document?.documentElement;
  if (!target) return "";

  const lines: string[] = [];
  let length = 0;
  let truncated = false;

  const pushLine = (line: string): boolean => {
    if (length + line.length + 1 > maxLength) {
      truncated = true;
      return false;
    }
    lines.push(line);
    length += line.length + 1;
    return true;
  };

  const renderNode = (node: Node, depth: number): boolean => {
    const indent = "  ".repeat(depth);
    if (node.nodeType === 3) {
      const text = defaultNormalizer(node.textContent ?? "");
      if (!text) return true;
      return pushLine(`${indent}${text}`);
    }
    if (isShadowRootNode(node)) {
      if (!pushLine(`${indent}#shadow-root (open)`)) return false;
      for (let index = 0; index < node.childNodes.length; index += 1) {
        const child = node.childNodes[index];
        if (child && !renderNode(child, depth + 1)) return false;
      }
      return true;
    }
    if (node.nodeType === 9 || node.nodeType === 11) {
      for (let index = 0; index < node.childNodes.length; index += 1) {
        const child = node.childNodes[index];
        if (child && !renderNode(child, depth)) return false;
      }
      return true;
    }
    if (!isElementNode(node)) return true;
    if (
      isStagedContainer(node) ||
      isInternalRealmIframe(node) ||
      node.tagName === "V-HEAD" ||
      node.tagName === "STYLE" ||
      node.tagName === "SCRIPT"
    ) {
      return true;
    }

    const tag = node.tagName.toLowerCase();
    const attrs: string[] = [];
    for (let index = 0; index < node.attributes.length; index += 1) {
      const attr = node.attributes[index];
      if (!attr) continue;
      attrs.push(
        attr.value === "" ? attr.name : `${attr.name}=${JSON.stringify(attr.value)}`,
      );
    }
    const open = attrs.length > 0 ? `<${tag} ${attrs.join(" ")}>` : `<${tag}>`;
    const shadow = node.shadowRoot;
    const hasChildContent =
      shadow !== null ||
      Array.from(node.childNodes).some((child) =>
        child.nodeType === 3
          ? defaultNormalizer(child.textContent ?? "") !== ""
          : child.nodeType === 1,
      );

    if (!hasChildContent) {
      return pushLine(`${indent}${open}</${tag}>`);
    }

    if (
      shadow === null &&
      node.childNodes.length === 1 &&
      node.childNodes[0]?.nodeType === 3
    ) {
      const inlineText = defaultNormalizer(node.childNodes[0].textContent ?? "");
      return pushLine(`${indent}${open}${inlineText}</${tag}>`);
    }

    if (!pushLine(`${indent}${open}`)) return false;
    if (shadow) {
      if (!renderNode(shadow, depth + 1)) return false;
    }
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const child = node.childNodes[index];
      if (child && !renderNode(child, depth + 1)) return false;
    }
    return pushLine(`${indent}</${tag}>`);
  };

  renderNode(target, 0);
  if (truncated) {
    lines.push("...");
  }
  return lines.join("\n");
}

/**
 * Find the first element matching a CSS selector within `root`, recursively piercing
 * open shadow roots (including `<v-frame>` and nested guest Web Components).
 */
export function queryShadow<T extends Element = Element>(
  root: ParentNode,
  selector: string,
): T | null {
  const elements = collectShadowElements(root);
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (element && element.matches(selector)) {
      return element as T;
    }
  }
  return null;
}

/**
 * Find every element matching a CSS selector within `root`, recursively piercing
 * open shadow roots (including `<v-frame>` and nested guest Web Components).
 */
export function queryAllShadow<T extends Element = Element>(
  root: ParentNode,
  selector: string,
): T[] {
  const elements = collectShadowElements(root);
  const matched: T[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (element && element.matches(selector)) {
      matched.push(element as T);
    }
  }
  return matched;
}

/**
 * Return the deepest focused element across open shadow roots (including `<v-frame>`,
 * nested `<v-frame>`s, and guest Web Components), or `null` when nothing is focused.
 */
export function activeShadowElement(root?: Document | ShadowRoot): Element | null {
  const start = root ?? globalThis.document ?? null;
  if (!start) return null;
  let active: Element | null = start.activeElement;
  const visited = new Set<Element>();
  while (active !== null && !visited.has(active)) {
    visited.add(active);
    const deeper = active.shadowRoot?.activeElement ?? null;
    if (deeper === null || deeper === active) break;
    active = deeper;
  }
  return active;
}

/**
 * Repeatedly run `callback` until it succeeds without throwing or `timeout` elapses.
 * Combines a short polling interval with DOM mutation observation so updates inside
 * dynamically created open shadow roots are picked up promptly.
 */
export async function waitFor<T>(
  callback: () => T | Promise<T>,
  options?: WaitForOptions,
): Promise<T> {
  const timeout = options?.timeout ?? 1000;
  const interval = Math.max(1, options?.interval ?? 50);
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  const tryOnce = async (): Promise<
    { ok: true; value: T } | { ok: false; error: unknown }
  > => {
    try {
      const value = await callback();
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error };
    }
  };

  const first = await tryOnce();
  if (first.ok) return first.value;
  lastError = first.error;

  if (timeout <= 0) {
    throw lastError;
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let running = false;
    let queued = false;
    let observer: MutationObserver | null = null;
    let intervalTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      observer?.disconnect();
      observer = null;
      if (intervalTimer !== null) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const finishResolve = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const check = (): void => {
      if (settled) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      void tryOnce().then((result) => {
        running = false;
        if (settled) return;
        if (result.ok) {
          finishResolve(result.value);
          return;
        }
        lastError = result.error;
        if (Date.now() >= deadline) {
          finishReject(lastError);
          return;
        }
        if (queued) {
          queued = false;
          check();
        }
      });
    };

    const target = globalThis.document?.documentElement;
    if (target && typeof MutationObserver === "function") {
      observer = new MutationObserver(() => {
        check();
      });
      observer.observe(target, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }

    intervalTimer = setInterval(check, interval);
    timeoutTimer = setTimeout(
      () => {
        if (settled) return;
        void tryOnce().then((result) => {
          if (result.ok) {
            finishResolve(result.value);
          } else {
            finishReject(result.error);
          }
        });
      },
      Math.max(0, deadline - Date.now()),
    );
  });
}

/**
 * Create a full set of Testing Library–style queries that recursively pierce open
 * shadow roots inside `root` (including `<v-frame>` trees and guest Web Components).
 */
export function withinShadow(
  root: ShadowQueryRoot,
  config?: ShadowQueryOptions,
): ShadowQueries {
  const testIdAttribute = config?.testIdAttribute ?? "data-testid";
  const defaultWait = config?.waitFor;

  const mergeWaitOptions = (override?: WaitForOptions): WaitForOptions | undefined => {
    if (!defaultWait && !override) return undefined;
    return { ...defaultWait, ...override };
  };

  const makeSingle = <Opts>(
    queryAll: (matcher: TextMatch, options?: Opts) => HTMLElement[],
    describe: (matcher: TextMatch, options?: Opts) => string,
  ) => {
    const queryBy = (matcher: TextMatch, options?: Opts): HTMLElement | null => {
      const matches = queryAll(matcher, options);
      if (matches.length > 1) {
        throw createQueryError(
          `Found multiple elements (${matches.length}) matching ${describe(matcher, options)}`,
          typeof root === "function" ? root() : root,
        );
      }
      return matches[0] ?? null;
    };

    const getAllBy = (matcher: TextMatch, options?: Opts): HTMLElement[] => {
      const matches = queryAll(matcher, options);
      if (matches.length === 0) {
        throw createQueryError(
          `Unable to find any elements matching ${describe(matcher, options)}`,
          typeof root === "function" ? root() : root,
        );
      }
      return matches;
    };

    const getBy = (matcher: TextMatch, options?: Opts): HTMLElement => {
      const matches = queryAll(matcher, options);
      if (matches.length === 0) {
        throw createQueryError(
          `Unable to find an element matching ${describe(matcher, options)}`,
          typeof root === "function" ? root() : root,
        );
      }
      if (matches.length > 1) {
        throw createQueryError(
          `Found multiple elements (${matches.length}) matching ${describe(matcher, options)}`,
          typeof root === "function" ? root() : root,
        );
      }
      return matches[0]!;
    };

    return { queryBy, getBy, getAllBy };
  };

  const queryAllByRole = <T extends HTMLElement = HTMLElement>(
    role: TextMatch,
    options?: ByRoleOptions,
  ): T[] => {
    const resolved = resolveRoot(root);
    const includeHidden = options?.hidden ?? false;
    const activeModal = includeHidden ? null : findActiveModal(resolved);
    const elements = collectShadowElements(resolved, { skipNonContent: !includeHidden });
    const matched: T[] = [];

    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;
      if (
        activeModal !== null &&
        element !== activeModal &&
        !isShadowAncestor(activeModal, element)
      ) {
        continue;
      }
      if (!includeHidden && isElementInaccessible(element)) continue;

      const elementRole = getElementRole(element);
      if (elementRole === null) continue;
      if (!matchText(elementRole, role, element, options)) continue;

      if (options?.name !== undefined) {
        const name = computeAccessibleName(element, elementRole);
        if (!matchText(name, options.name, element, options)) continue;
      }
      if (options?.description !== undefined) {
        const description = computeAccessibleDescription(element);
        if (!matchText(description, options.description, element, options)) continue;
      }
      if (options?.level !== undefined && getHeadingLevel(element) !== options.level) {
        continue;
      }
      if (
        options?.checked !== undefined &&
        getCheckedState(element) !== options.checked
      ) {
        continue;
      }
      if (
        options?.pressed !== undefined &&
        getTriState(element, "aria-pressed") !== options.pressed
      ) {
        continue;
      }
      if (
        options?.selected !== undefined &&
        getSelectedState(element) !== options.selected
      ) {
        continue;
      }
      if (
        options?.expanded !== undefined &&
        getExpandedState(element) !== options.expanded
      ) {
        continue;
      }
      if (options?.current !== undefined && !matchesCurrent(element, options.current)) {
        continue;
      }
      if (options?.busy !== undefined) {
        const isBusy = element.getAttribute("aria-busy") === "true";
        if (isBusy !== options.busy) continue;
      }

      matched.push(element as T);
    }
    return matched;
  };

  const queryAllByLabelText = <T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T[] => {
    const resolved = resolveRoot(root);
    const elements = collectShadowElements(resolved, { skipNonContent: true });
    const matched: T[] = [];
    const seen = new Set<Element>();

    const record = (candidate: Element): void => {
      if (seen.has(candidate)) return;
      if (!matchesSelector(candidate, options?.selector)) return;
      seen.add(candidate);
      matched.push(candidate as T);
    };

    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;

      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel !== null && matchText(ariaLabel, text, element, options)) {
        record(element);
        continue;
      }

      const labelledBy = resolveIdListText(
        element,
        "aria-labelledby",
        new Set<Element>([element]),
      );
      if (labelledBy && matchText(labelledBy, text, element, options)) {
        record(element);
        continue;
      }

      if (LABELABLE_TAGS.has(element.tagName)) {
        const labels = getAssociatedLabels(element);
        if (labels.length > 0) {
          const combined = labels
            .map((label) =>
              getLabelTextExcludingControl(label, element, new Set<Element>([element])),
            )
            .filter(Boolean)
            .join(" ");
          if (
            (combined && matchText(combined, text, element, options)) ||
            labels.some((label) =>
              matchText(
                getLabelTextExcludingControl(label, element, new Set<Element>([element])),
                text,
                label,
                options,
              ),
            )
          ) {
            record(element);
          }
        }
      }
    }

    return matched;
  };

  const queryAllByPlaceholderText = <T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T[] => {
    const resolved = resolveRoot(root);
    const elements = collectShadowElements(resolved, { skipNonContent: true });
    const matched: T[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;
      const placeholder = element.getAttribute("placeholder");
      if (placeholder !== null && matchText(placeholder, text, element, options)) {
        matched.push(element as T);
      }
    }
    return matched;
  };

  const queryAllByText = <T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: SelectorMatcherOptions,
  ): T[] => {
    const resolved = resolveRoot(root);
    const elements = collectShadowElements(resolved, { skipNonContent: true });
    const candidates: Element[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;
      if (!matchesSelector(element, options?.selector)) continue;
      const content = getElementVisibleText(element);
      if (matchText(content, text, element, options)) {
        candidates.push(element);
      }
    }
    // Keep deepest matching elements so container wrappers do not cause duplicate matches.
    const deepest: T[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate) continue;
      const hasMatchingDescendant = candidates.some(
        (other) => other !== candidate && isShadowAncestor(candidate, other),
      );
      if (!hasMatchingDescendant) {
        deepest.push(candidate as T);
      }
    }
    return deepest;
  };

  const queryAllByDisplayValue = <T extends HTMLElement = HTMLElement>(
    value: TextMatch,
    options?: MatcherOptions,
  ): T[] => {
    const resolved = resolveRoot(root);
    const elements = collectShadowElements(resolved, { skipNonContent: true });
    const matched: T[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;
      if (element.tagName === "INPUT") {
        const input = element as HTMLInputElement;
        const type = (input.getAttribute("type") ?? "text").toLowerCase();
        if (type === "checkbox" || type === "radio") continue;
        if (matchText(input.value, value, element, options)) {
          matched.push(element as T);
        }
      } else if (element.tagName === "TEXTAREA") {
        if (matchText((element as HTMLTextAreaElement).value, value, element, options)) {
          matched.push(element as T);
        }
      } else if (element.tagName === "SELECT") {
        const select = element as HTMLSelectElement;
        const selectedOptions = Array.from(select.options).filter(
          (option) => option.selected,
        );
        if (
          selectedOptions.some((option) =>
            matchText(option.textContent ?? "", value, element, options),
          )
        ) {
          matched.push(element as T);
        }
      }
    }
    return matched;
  };

  const queryAllByAltText = <T extends HTMLElement = HTMLElement>(
    text: TextMatch,
    options?: MatcherOptions,
  ): T[] => {
    const resolved = resolveRoot(root);
    const elements = collectShadowElements(resolved, { skipNonContent: true });
    const matched: T[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;
      if (
        element.tagName !== "IMG" &&
        element.tagName !== "AREA" &&
        !(
          element.tagName === "INPUT" &&
          (element.getAttribute("type") ?? "").toLowerCase() === "image"
        )
      ) {
        continue;
      }
      const alt = element.getAttribute("alt");
      if (alt !== null && matchText(alt, text, element, options)) {
        matched.push(element as T);
      }
    }
    return matched;
  };

  const queryAllByTitle = <T extends HTMLElement = HTMLElement>(
    title: TextMatch,
    options?: MatcherOptions,
  ): T[] => {
    const resolved = resolveRoot(root);
    const elements = collectShadowElements(resolved, { skipNonContent: true });
    const matched: T[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;
      const attr = element.getAttribute("title");
      if (attr !== null && matchText(attr, title, element, options)) {
        matched.push(element as T);
        continue;
      }
      if (
        element.tagName.toLowerCase() === "title" &&
        element.namespaceURI === "http://www.w3.org/2000/svg" &&
        matchText(element.textContent ?? "", title, element, options)
      ) {
        matched.push(element as T);
      }
    }
    return matched;
  };

  const queryAllByTestId = <T extends HTMLElement = HTMLElement>(
    id: TextMatch,
    options?: MatcherOptions,
  ): T[] => {
    const resolved = resolveRoot(root);
    const elements = collectShadowElements(resolved, { skipNonContent: true });
    const matched: T[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!element) continue;
      const attr = element.getAttribute(testIdAttribute);
      if (attr !== null && matchText(attr, id, element, options)) {
        matched.push(element as T);
      }
    }
    return matched;
  };

  const roleApi = makeSingle<ByRoleOptions>(queryAllByRole, (role, options) => {
    const namePart =
      options?.name !== undefined ? ` and name ${formatMatcher(options.name)}` : "";
    return `role ${formatMatcher(role)}${namePart}`;
  });
  const labelApi = makeSingle<SelectorMatcherOptions>(
    queryAllByLabelText,
    (text) => `label text ${formatMatcher(text)}`,
  );
  const placeholderApi = makeSingle<MatcherOptions>(
    queryAllByPlaceholderText,
    (text) => `placeholder text ${formatMatcher(text)}`,
  );
  const textApi = makeSingle<SelectorMatcherOptions>(
    queryAllByText,
    (text) => `text ${formatMatcher(text)}`,
  );
  const displayValueApi = makeSingle<MatcherOptions>(
    queryAllByDisplayValue,
    (value) => `display value ${formatMatcher(value)}`,
  );
  const altTextApi = makeSingle<MatcherOptions>(
    queryAllByAltText,
    (text) => `alt text ${formatMatcher(text)}`,
  );
  const titleApi = makeSingle<MatcherOptions>(
    queryAllByTitle,
    (title) => `title ${formatMatcher(title)}`,
  );
  const testIdApi = makeSingle<MatcherOptions>(
    queryAllByTestId,
    (id) => `[${testIdAttribute}=${formatMatcher(id)}]`,
  );

  return {
    queryShadow: <T extends Element = Element>(selector: string): T | null =>
      queryShadow<T>(resolveRoot(root), selector),
    queryAllShadow: <T extends Element = Element>(selector: string): T[] =>
      queryAllShadow<T>(resolveRoot(root), selector),

    queryByRole: <T extends HTMLElement = HTMLElement>(
      role: TextMatch,
      options?: ByRoleOptions,
    ): T | null => roleApi.queryBy(role, options) as T | null,
    queryAllByRole,
    getByRole: <T extends HTMLElement = HTMLElement>(
      role: TextMatch,
      options?: ByRoleOptions,
    ): T => roleApi.getBy(role, options) as T,
    getAllByRole: <T extends HTMLElement = HTMLElement>(
      role: TextMatch,
      options?: ByRoleOptions,
    ): T[] => roleApi.getAllBy(role, options) as T[],
    findByRole: <T extends HTMLElement = HTMLElement>(
      role: TextMatch,
      options?: ByRoleOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T> =>
      waitFor(() => roleApi.getBy(role, options) as T, mergeWaitOptions(waitForOptions)),
    findAllByRole: <T extends HTMLElement = HTMLElement>(
      role: TextMatch,
      options?: ByRoleOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T[]> =>
      waitFor(
        () => roleApi.getAllBy(role, options) as T[],
        mergeWaitOptions(waitForOptions),
      ),

    queryByLabelText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
    ): T | null => labelApi.queryBy(text, options) as T | null,
    queryAllByLabelText,
    getByLabelText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
    ): T => labelApi.getBy(text, options) as T,
    getAllByLabelText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
    ): T[] => labelApi.getAllBy(text, options) as T[],
    findByLabelText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T> =>
      waitFor(() => labelApi.getBy(text, options) as T, mergeWaitOptions(waitForOptions)),
    findAllByLabelText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T[]> =>
      waitFor(
        () => labelApi.getAllBy(text, options) as T[],
        mergeWaitOptions(waitForOptions),
      ),

    queryByPlaceholderText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
    ): T | null => placeholderApi.queryBy(text, options) as T | null,
    queryAllByPlaceholderText,
    getByPlaceholderText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
    ): T => placeholderApi.getBy(text, options) as T,
    getAllByPlaceholderText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
    ): T[] => placeholderApi.getAllBy(text, options) as T[],
    findByPlaceholderText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T> =>
      waitFor(
        () => placeholderApi.getBy(text, options) as T,
        mergeWaitOptions(waitForOptions),
      ),
    findAllByPlaceholderText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T[]> =>
      waitFor(
        () => placeholderApi.getAllBy(text, options) as T[],
        mergeWaitOptions(waitForOptions),
      ),

    queryByText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
    ): T | null => textApi.queryBy(text, options) as T | null,
    queryAllByText,
    getByText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
    ): T => textApi.getBy(text, options) as T,
    getAllByText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
    ): T[] => textApi.getAllBy(text, options) as T[],
    findByText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T> =>
      waitFor(() => textApi.getBy(text, options) as T, mergeWaitOptions(waitForOptions)),
    findAllByText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: SelectorMatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T[]> =>
      waitFor(
        () => textApi.getAllBy(text, options) as T[],
        mergeWaitOptions(waitForOptions),
      ),

    queryByDisplayValue: <T extends HTMLElement = HTMLElement>(
      value: TextMatch,
      options?: MatcherOptions,
    ): T | null => displayValueApi.queryBy(value, options) as T | null,
    queryAllByDisplayValue,
    getByDisplayValue: <T extends HTMLElement = HTMLElement>(
      value: TextMatch,
      options?: MatcherOptions,
    ): T => displayValueApi.getBy(value, options) as T,
    getAllByDisplayValue: <T extends HTMLElement = HTMLElement>(
      value: TextMatch,
      options?: MatcherOptions,
    ): T[] => displayValueApi.getAllBy(value, options) as T[],
    findByDisplayValue: <T extends HTMLElement = HTMLElement>(
      value: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T> =>
      waitFor(
        () => displayValueApi.getBy(value, options) as T,
        mergeWaitOptions(waitForOptions),
      ),
    findAllByDisplayValue: <T extends HTMLElement = HTMLElement>(
      value: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T[]> =>
      waitFor(
        () => displayValueApi.getAllBy(value, options) as T[],
        mergeWaitOptions(waitForOptions),
      ),

    queryByAltText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
    ): T | null => altTextApi.queryBy(text, options) as T | null,
    queryAllByAltText,
    getByAltText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
    ): T => altTextApi.getBy(text, options) as T,
    getAllByAltText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
    ): T[] => altTextApi.getAllBy(text, options) as T[],
    findByAltText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T> =>
      waitFor(
        () => altTextApi.getBy(text, options) as T,
        mergeWaitOptions(waitForOptions),
      ),
    findAllByAltText: <T extends HTMLElement = HTMLElement>(
      text: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T[]> =>
      waitFor(
        () => altTextApi.getAllBy(text, options) as T[],
        mergeWaitOptions(waitForOptions),
      ),

    queryByTitle: <T extends HTMLElement = HTMLElement>(
      title: TextMatch,
      options?: MatcherOptions,
    ): T | null => titleApi.queryBy(title, options) as T | null,
    queryAllByTitle,
    getByTitle: <T extends HTMLElement = HTMLElement>(
      title: TextMatch,
      options?: MatcherOptions,
    ): T => titleApi.getBy(title, options) as T,
    getAllByTitle: <T extends HTMLElement = HTMLElement>(
      title: TextMatch,
      options?: MatcherOptions,
    ): T[] => titleApi.getAllBy(title, options) as T[],
    findByTitle: <T extends HTMLElement = HTMLElement>(
      title: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T> =>
      waitFor(
        () => titleApi.getBy(title, options) as T,
        mergeWaitOptions(waitForOptions),
      ),
    findAllByTitle: <T extends HTMLElement = HTMLElement>(
      title: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T[]> =>
      waitFor(
        () => titleApi.getAllBy(title, options) as T[],
        mergeWaitOptions(waitForOptions),
      ),

    queryByTestId: <T extends HTMLElement = HTMLElement>(
      id: TextMatch,
      options?: MatcherOptions,
    ): T | null => testIdApi.queryBy(id, options) as T | null,
    queryAllByTestId,
    getByTestId: <T extends HTMLElement = HTMLElement>(
      id: TextMatch,
      options?: MatcherOptions,
    ): T => testIdApi.getBy(id, options) as T,
    getAllByTestId: <T extends HTMLElement = HTMLElement>(
      id: TextMatch,
      options?: MatcherOptions,
    ): T[] => testIdApi.getAllBy(id, options) as T[],
    findByTestId: <T extends HTMLElement = HTMLElement>(
      id: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T> =>
      waitFor(() => testIdApi.getBy(id, options) as T, mergeWaitOptions(waitForOptions)),
    findAllByTestId: <T extends HTMLElement = HTMLElement>(
      id: TextMatch,
      options?: MatcherOptions,
      waitForOptions?: WaitForOptions,
    ): Promise<T[]> =>
      waitFor(
        () => testIdApi.getAllBy(id, options) as T[],
        mergeWaitOptions(waitForOptions),
      ),
  };
}

/**
 * Scope shadow-piercing queries to a `<v-frame>` element.
 * Re-reads `frame.shadowRoot` on every query so handles stay valid across reloads and navigations.
 */
export function withinFrame(
  frame: VFrameLike,
  options?: ShadowQueryOptions,
): FrameQueries {
  const queries = withinShadow(() => frame.shadowRoot ?? frame, options);
  return {
    ...queries,
    ready(): Promise<void> {
      if (typeof frame.whenReady === "function") {
        return frame.whenReady();
      }
      if (frame.status === VFrameStatus.Ready) {
        return Promise.resolve();
      }
      if (frame.status === VFrameStatus.Error) {
        return Promise.reject(new Error("v-frame failed to load"));
      }
      return new Promise<void>((resolve, reject) => {
        const controller = new AbortController();
        frame.addEventListener(
          "v-frame-load",
          () => {
            controller.abort();
            resolve();
          },
          { signal: controller.signal },
        );
        frame.addEventListener(
          "v-frame-error",
          (event: Event) => {
            const detail = (event as CustomEvent<VFrameErrorEventDetail>).detail;
            if (detail?.fatal !== false) {
              controller.abort();
              reject(detail?.error ?? new Error("v-frame failed to load"));
            }
          },
          { signal: controller.signal },
        );
      });
    },
  };
}

/**
 * Page-wide Testing Library–style queries that pierce every open shadow root on the page
 * (host DOM, `<v-frame>` guests, nested `<v-frame>`s, and guest Web Components).
 * Safe to import during SSR because `document` is resolved lazily on each query.
 */
export const shadowScreen: ShadowQueries = withinShadow(
  () => globalThis.document?.body ?? globalThis.document?.documentElement ?? null,
);

interface ChannelHubLike {
  retained?: Map<string, unknown>;
}

/**
 * Clear retained `@mewhhaha/v-frame/channel` state between tests without knowing every topic name.
 */
export function resetChannels(target?: Document | ResetChannelsOptions): void {
  const isOptions =
    target !== undefined && typeof target === "object" && !("nodeType" in target);
  const doc = (isOptions ? target.document : target) ?? globalThis.document;
  if (!doc) return;
  const record = doc as unknown as Record<PropertyKey, ChannelHubLike | undefined>;
  const hub = record[CHANNEL_HUB_KEY];
  if (hub?.retained && typeof hub.retained.clear === "function") {
    hub.retained.clear();
  }
  if (isOptions && target.disconnectSubscribers) {
    delete record[CHANNEL_HUB_KEY];
  }
}

interface MockConfig {
  routes: MockVFrameRoutes;
  renderMode: "shadow" | "light";
  baseURL: string | undefined;
  requests: string[];
}

const mockTagStates = new Map<
  string,
  {
    ctor: CustomElementConstructor;
    stack: MockConfig[];
  }
>();

function extractMockBodyHTML(html: string): string {
  if (!/<(?:!doctype|html|head|body)\b/i.test(html)) {
    return html;
  }
  if (typeof DOMParser === "function") {
    try {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      if (parsed.body) return parsed.body.innerHTML;
    } catch {
      // Fall back to regex extraction in minimal DOM environments.
    }
  }
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return bodyMatch?.[1] ?? html;
}

function isResponseValue(value: MockVFrameRouteResult): value is Response {
  return typeof Response === "function" && value instanceof Response;
}

async function resolveMockRoute(
  routes: MockVFrameRoutes,
  request: MockVFrameRequest,
): Promise<{ html: string; url: string }> {
  let entry: MockVFrameRouteResult | MockVFrameRouteHandler | undefined;
  if (typeof routes === "function") {
    entry = routes;
  } else {
    entry =
      routes[request.url.href] ??
      routes[`${request.url.pathname}${request.url.search}`] ??
      routes[request.url.pathname] ??
      routes["*"];
  }

  if (entry === undefined) {
    throw new Error(`No mock v-frame route matched ${request.url.pathname}`);
  }

  const resolved = typeof entry === "function" ? await entry(request) : entry;
  if (typeof resolved === "string") {
    return { html: resolved, url: request.url.href };
  }
  if (isResponseValue(resolved)) {
    if (!resolved.ok) {
      throw new Error(`Mock v-frame route returned HTTP ${resolved.status}`);
    }
    return {
      html: await resolved.text(),
      url: resolved.url || request.url.href,
    };
  }
  const status = resolved.status ?? 200;
  if (status >= 400) {
    throw new Error(`Mock v-frame route returned HTTP ${status}`);
  }
  return {
    html: resolved.html,
    url: resolved.url ?? request.url.href,
  };
}

/**
 * Register a lightweight mock `<v-frame>` custom element for unit tests in jsdom,
 * happy-dom, or isolated browser tests without booting real guest documents or iframes.
 *
 * Calling `defineMockVFrame()` again updates the active mock routes for the same tag name
 * (respecting the browser's one-time `customElements.define` constraint). Call `restore()`
 * in `afterEach` to restore the previous configuration.
 */
export function defineMockVFrame(
  routes: MockVFrameRoutes = {},
  options?: MockVFrameOptions,
): MockVFrameController {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") {
    throw new Error(
      "defineMockVFrame() requires a DOM environment with customElements and HTMLElement",
    );
  }

  const tagName = options?.tagName ?? "v-frame";
  const config: MockConfig = {
    routes,
    renderMode: options?.renderMode ?? "shadow",
    baseURL: options?.baseURL,
    requests: [],
  };

  let state = mockTagStates.get(tagName);
  const existing = customElements.get(tagName);
  if (existing && (!state || state.ctor !== existing)) {
    throw new Error(
      `Cannot install mock <${tagName}>: a different custom element is already defined for "${tagName}".`,
    );
  }

  if (!state) {
    const getActiveConfig = (): MockConfig => {
      const current = mockTagStates.get(tagName);
      const top = current?.stack[current.stack.length - 1];
      return (
        top ?? {
          routes: {},
          renderMode: "shadow",
          baseURL: undefined,
          requests: [],
        }
      );
    };

    class MockVFrameElement extends HTMLElement {
      static readonly observedAttributes = [
        "src",
        "credentials",
        "navigation",
        "nonce",
        "trusted-types-policy",
      ];

      #status: VFrameStatus = VFrameStatus.Idle;
      #currentURL: string | null = null;
      #generation = 0;
      #connected = false;
      #lastError: unknown = null;
      #history: string[] = [];
      #historyIndex = -1;
      #shadow: ShadowRoot | null = null;
      readonly #readyWaiters: Array<{
        resolve(): void;
        reject(error: unknown): void;
      }> = [];

      constructor() {
        super();
        if (getActiveConfig().renderMode === "shadow") {
          this.#shadow = super.shadowRoot ?? this.attachShadow({ mode: "open" });
        }
      }

      get src(): string {
        return this.getAttribute("src") ?? "";
      }

      set src(value: string) {
        this.setAttribute("src", String(value));
      }

      get adopt(): boolean {
        return this.hasAttribute("adopt");
      }

      set adopt(value: boolean) {
        this.toggleAttribute("adopt", Boolean(value));
      }

      get credentials(): VFrameCredentials {
        const value = this.getAttribute("credentials");
        return value === "omit" || value === "include" || value === "same-origin"
          ? value
          : "same-origin";
      }

      set credentials(value: VFrameCredentials) {
        this.setAttribute("credentials", value);
      }

      get navigation(): VFrameNavigation {
        return this.getAttribute("navigation") === "host" ? "host" : "guest";
      }

      set navigation(value: VFrameNavigation) {
        this.setAttribute("navigation", value);
      }

      get status(): VFrameStatus {
        return this.#status;
      }

      get currentURL(): string | null {
        return this.#currentURL;
      }

      get contentWindow(): Window | null {
        return null;
      }

      get canGoBack(): boolean {
        return this.#historyIndex > 0;
      }

      get canGoForward(): boolean {
        return this.#historyIndex >= 0 && this.#historyIndex < this.#history.length - 1;
      }

      whenReady(): Promise<void> {
        if (this.#status === VFrameStatus.Ready) {
          return Promise.resolve();
        }
        if (this.#status === VFrameStatus.Error) {
          return Promise.reject(
            this.#lastError ?? new Error("Mock v-frame failed to load"),
          );
        }
        return new Promise<void>((resolve, reject) => {
          this.#readyWaiters.push({ resolve, reject });
        });
      }

      connectedCallback(): void {
        this.#connected = true;
        if (this.src) {
          void this.#loadURL(this.src, { mode: "reset" });
        }
      }

      disconnectedCallback(): void {
        this.#connected = false;
        this.#generation += 1;
        this.#rejectReadyWaiters(
          new DOMException(
            "v-frame was disconnected before becoming ready",
            "AbortError",
          ),
        );
      }

      attributeChangedCallback(
        name: string,
        oldValue: string | null,
        newValue: string | null,
      ): void {
        if (name === "src" && oldValue !== newValue && this.#connected) {
          if (newValue) {
            void this.#loadURL(newValue, { mode: "reset" });
          } else {
            this.#generation += 1;
            this.#status = VFrameStatus.Idle;
            this.#currentURL = null;
            this.#history = [];
            this.#historyIndex = -1;
            this.#renderHTML("");
          }
        }
      }

      async navigate(url: string, options?: VFrameNavigateOptions): Promise<void> {
        const kind: VFrameNavigationKind = options?.replace ? "replace" : "push";
        const resolved = this.#resolveURL(url);
        const from = this.#currentURL ?? "";
        const navEvent = new CustomEvent<VFrameNavigateEventDetail>("v-frame-navigate", {
          bubbles: false,
          composed: false,
          cancelable: true,
          detail: { from, to: resolved.href, kind, state: null },
        });
        if (!this.dispatchEvent(navEvent)) {
          throw new DOMException(
            `v-frame navigation to ${resolved.href} was canceled`,
            "AbortError",
          );
        }
        await this.#loadURL(resolved.href, {
          mode: options?.replace ? "replace" : "push",
          navigatedFrom: from,
          navigationKind: kind,
        });
      }

      async reload(): Promise<void> {
        const target = this.#currentURL ?? this.src;
        if (!target) {
          throw new DOMException(
            "v-frame cannot reload without an active guest",
            "InvalidStateError",
          );
        }
        await this.#loadURL(target, { mode: "reload" });
      }

      async back(): Promise<void> {
        await this.go(-1);
      }

      async forward(): Promise<void> {
        await this.go(1);
      }

      async go(delta: number): Promise<void> {
        const nextIndex = this.#historyIndex + delta;
        if (nextIndex < 0 || nextIndex >= this.#history.length) {
          throw new DOMException(
            "v-frame history traversal out of range",
            "InvalidStateError",
          );
        }
        const target = this.#history[nextIndex];
        if (!target) return;
        const from = this.#currentURL ?? "";
        const navEvent = new CustomEvent<VFrameNavigateEventDetail>("v-frame-navigate", {
          bubbles: false,
          composed: false,
          cancelable: true,
          detail: { from, to: target, kind: "traverse", state: null },
        });
        if (!this.dispatchEvent(navEvent)) {
          throw new DOMException(
            `v-frame navigation to ${target} was canceled`,
            "AbortError",
          );
        }
        await this.#loadURL(target, {
          mode: "traverse",
          targetIndex: nextIndex,
          navigatedFrom: from,
          navigationKind: "traverse",
        });
      }

      #resolveURL(input: string): URL {
        const active = getActiveConfig();
        const fallbackBase =
          active.baseURL ??
          (this.#currentURL ||
            (this.ownerDocument?.baseURI && this.ownerDocument.baseURI !== "about:blank"
              ? this.ownerDocument.baseURI
              : "http://localhost/"));
        return new URL(input, fallbackBase);
      }

      #renderHTML(html: string): void {
        const bodyHTML = extractMockBodyHTML(html);
        const active = getActiveConfig();
        if (active.renderMode === "shadow") {
          const shadow =
            this.#shadow ?? super.shadowRoot ?? this.attachShadow({ mode: "open" });
          this.#shadow = shadow;
          shadow.innerHTML = bodyHTML;
        } else {
          this.innerHTML = bodyHTML;
        }
      }

      #resolveReadyWaiters(): void {
        const waiters = this.#readyWaiters.splice(0);
        for (const waiter of waiters) waiter.resolve();
      }

      #rejectReadyWaiters(error: unknown): void {
        const waiters = this.#readyWaiters.splice(0);
        for (const waiter of waiters) waiter.reject(error);
      }

      async #loadURL(
        rawURL: string,
        opts: {
          mode: "reset" | "push" | "replace" | "reload" | "traverse";
          targetIndex?: number;
          navigatedFrom?: string;
          navigationKind?: VFrameNavigationKind;
        },
      ): Promise<void> {
        const generation = ++this.#generation;
        const active = getActiveConfig();
        let resolved: URL;
        try {
          resolved = this.#resolveURL(rawURL);
        } catch (error) {
          this.#status = VFrameStatus.Error;
          this.#lastError = error;
          this.dispatchEvent(
            new CustomEvent<VFrameErrorEventDetail>("v-frame-error", {
              detail: { phase: "entry", url: rawURL, error, fatal: true },
            }),
          );
          this.#rejectReadyWaiters(error);
          return;
        }

        this.#status = VFrameStatus.Loading;
        this.#lastError = null;
        active.requests.push(resolved.href);
        this.dispatchEvent(
          new CustomEvent<VFrameLoadEventDetail>("v-frame-loadstart", {
            detail: { url: resolved.href },
          }),
        );

        try {
          const result = await resolveMockRoute(active.routes, {
            url: resolved,
            pathname: resolved.pathname,
            frame: this,
          });
          if (generation !== this.#generation || !this.#connected) return;

          this.#renderHTML(result.html);
          this.#currentURL = result.url;
          this.#status = VFrameStatus.Ready;

          if (opts.mode === "reset") {
            this.#history = [result.url];
            this.#historyIndex = 0;
          } else if (opts.mode === "push") {
            this.#history = this.#history.slice(0, this.#historyIndex + 1);
            this.#history.push(result.url);
            this.#historyIndex = this.#history.length - 1;
          } else if (opts.mode === "replace") {
            if (this.#historyIndex < 0) {
              this.#history = [result.url];
              this.#historyIndex = 0;
            } else {
              this.#history[this.#historyIndex] = result.url;
            }
          } else if (opts.mode === "traverse" && opts.targetIndex !== undefined) {
            this.#historyIndex = opts.targetIndex;
          }

          if (opts.navigationKind !== undefined) {
            this.dispatchEvent(
              new CustomEvent<VFrameNavigatedEventDetail>("v-frame-navigated", {
                detail: {
                  from: opts.navigatedFrom ?? "",
                  to: result.url,
                  kind: opts.navigationKind,
                },
              }),
            );
          }

          this.dispatchEvent(
            new CustomEvent<VFrameLoadEventDetail>("v-frame-load", {
              detail: { url: result.url },
            }),
          );
          this.#resolveReadyWaiters();
        } catch (error) {
          if (generation !== this.#generation || !this.#connected) return;
          this.#status = VFrameStatus.Error;
          this.#lastError = error;
          this.dispatchEvent(
            new CustomEvent<VFrameErrorEventDetail>("v-frame-error", {
              detail: { phase: "entry", url: resolved.href, error, fatal: true },
            }),
          );
          this.#rejectReadyWaiters(error);
        }
      }
    }

    customElements.define(tagName, MockVFrameElement);
    state = { ctor: MockVFrameElement, stack: [] };
    mockTagStates.set(tagName, state);
  }

  state.stack.push(config);
  let restored = false;

  return {
    setRoutes(nextRoutes: MockVFrameRoutes): void {
      config.routes = nextRoutes;
    },
    get requests(): readonly string[] {
      return config.requests;
    },
    clearRequests(): void {
      config.requests.length = 0;
    },
    restore(): void {
      if (restored) return;
      restored = true;
      const current = mockTagStates.get(tagName);
      if (!current) return;
      const index = current.stack.lastIndexOf(config);
      if (index !== -1) {
        current.stack.splice(index, 1);
      }
    },
  };
}
