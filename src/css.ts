import { FRAGMENT_TARGET_ATTRIBUTE, SHELL_ELEMENT_NAMES } from "./wire-format.js";

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

export interface StylesheetFetchOptions {
  /** Aborted when the result is no longer wanted; a fetch should stop and reject. */
  signal?: AbortSignal;
  /** Authored link integrity to verify on the original bytes before rewriting. */
  integrity?: string;
  /** Authored `crossorigin` attribute on a `<link rel="stylesheet">` element. */
  crossOrigin?: string | null;
  /** Authored `referrerpolicy` attribute on a `<link rel="stylesheet">` element. */
  referrerPolicy?: ReferrerPolicy | "";
}

export interface StylesheetFetch {
  (url: string, options?: StylesheetFetchOptions): Promise<string | StylesheetSource>;
}

export interface StylesheetImportFailure {
  url: string;
  error: unknown;
}

const DEFAULT_MAX_IMPORT_EXPANSIONS = 128;
const DEFAULT_MAX_EXPANDED_CSS_BYTES = 4 * 1024 * 1024;

/** Normalizes an HTML `crossorigin` attribute per the CORS settings attribute spec. */
export function normalizeCrossOrigin(
  value: string | null | undefined,
): "anonymous" | "use-credentials" | null {
  if (value === null || value === undefined) return null;
  return value.toLowerCase() === "use-credentials" ? "use-credentials" : "anonymous";
}

export interface StylesheetContext {
  fetchText: StylesheetFetch;
  requests: Map<string, Promise<StylesheetSource>>;
  /** Passed to every fetch; once aborted, failures are expected and not reported. */
  signal?: AbortSignal;
  /** Maximum nested `@import` depth; deeper imports are dropped and reported. */
  maxImportDepth?: number;
  /** Maximum total `@import` rule expansions per stylesheet rewrite. Defaults to 128. */
  maxImportExpansions?: number;
  /** Maximum expanded CSS output characters per stylesheet rewrite. Defaults to 4 MiB. */
  maxExpandedBytes?: number;
  onImportFailure?(failure: StylesheetImportFailure): void;
}

export function createStylesheetContext(
  fetchText: StylesheetFetch,
  onImportFailure?: StylesheetContext["onImportFailure"],
  signal?: AbortSignal,
  maxImportDepth?: number,
): StylesheetContext {
  const context: StylesheetContext = {
    fetchText,
    requests: new Map(),
  };
  if (onImportFailure !== undefined) {
    context.onImportFailure = onImportFailure;
  }
  if (signal !== undefined) {
    context.signal = signal;
  }
  if (maxImportDepth !== undefined) {
    context.maxImportDepth = maxImportDepth;
  }
  return context;
}

// ---------------------------------------------------------------------------
// Zero-dependency CSS Syntax Level 3 tokenizer
// ---------------------------------------------------------------------------

const TokenKind = {
  Ident: 0,
  Function: 1,
  AtKeyword: 2,
  Hash: 3,
  String: 4,
  Url: 5,
  Number: 6,
  Whitespace: 7,
  Colon: 8,
  Semicolon: 9,
  Comma: 10,
  LParen: 11,
  RParen: 12,
  LBracket: 13,
  RBracket: 14,
  LBrace: 15,
  RBrace: 16,
  Delim: 17,
  BadString: 18,
  BadUrl: 19,
} as const;
type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

interface Token {
  kind: TokenKind;
  raw: string;
  value: string;
}

const SHADOW_ONLY_PSEUDO_CLASSES = new Set(["host", "host-context"]);
const SELECTOR_LIST_PSEUDOS = new Set([
  "is",
  "where",
  "not",
  "has",
  "matches",
  "-webkit-any",
  "-moz-any",
  "slotted",
  "host",
  "host-context",
]);
const STRING_URL_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "src"]);
const NON_RULE_BLOCK_ATRULES = new Set([
  "font-face",
  "keyframes",
  "-webkit-keyframes",
  "page",
  "property",
  "counter-style",
  "font-palette-values",
  "position-try",
]);
const FONT_CONTAINER_ATRULES = new Set(["media", "supports", "layer"]);
const ROOT_SELECTOR = ":where(v-html):nth-child(n)";
const TARGET_SELECTOR = `[${FRAGMENT_TARGET_ATTRIBUTE}]`;

function isWhitespaceCode(code: number): boolean {
  return (
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c
  );
}

function isNewlineCode(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x0c;
}

function isHexCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function isDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isIdentStartCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code >= 0x80
  );
}

function isIdentCode(code: number): boolean {
  return isIdentStartCode(code) || isDigitCode(code) || code === 0x2d;
}

function isValidEscape(source: string, pos: number): boolean {
  if (source.charCodeAt(pos) !== 0x5c) return false;
  if (pos + 1 >= source.length) return true;
  return !isNewlineCode(source.charCodeAt(pos + 1));
}

function startsIdent(source: string, pos: number): boolean {
  const code = source.charCodeAt(pos);
  if (isIdentStartCode(code)) return true;
  if (code === 0x2d) {
    const next = source.charCodeAt(pos + 1);
    return isIdentStartCode(next) || next === 0x2d || isValidEscape(source, pos + 1);
  }
  return isValidEscape(source, pos);
}

function startsNumber(source: string, pos: number): boolean {
  const code = source.charCodeAt(pos);
  if (isDigitCode(code)) return true;
  if (code === 0x2e) return isDigitCode(source.charCodeAt(pos + 1));
  if (code === 0x2b || code === 0x2d) {
    const next = source.charCodeAt(pos + 1);
    if (isDigitCode(next)) return true;
    return next === 0x2e && isDigitCode(source.charCodeAt(pos + 2));
  }
  return false;
}

function consumeEscape(source: string, pos: number): { char: string; next: number } {
  // pos points to '\'
  let cursor = pos + 1;
  if (cursor >= source.length) {
    return { char: "\uFFFD", next: cursor };
  }
  if (isHexCode(source.charCodeAt(cursor))) {
    const hexStart = cursor;
    let count = 0;
    while (cursor < source.length && count < 6 && isHexCode(source.charCodeAt(cursor))) {
      cursor += 1;
      count += 1;
    }
    const codePoint = Number.parseInt(source.slice(hexStart, cursor), 16);
    if (cursor < source.length && isWhitespaceCode(source.charCodeAt(cursor))) {
      if (source.charCodeAt(cursor) === 0x0d && source.charCodeAt(cursor + 1) === 0x0a) {
        cursor += 2;
      } else {
        cursor += 1;
      }
    }
    const valid =
      codePoint === 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? "\uFFFD"
        : String.fromCodePoint(codePoint);
    return { char: valid, next: cursor };
  }
  const codePoint = source.codePointAt(cursor)!;
  return {
    char: String.fromCodePoint(codePoint),
    next: cursor + (codePoint > 0xffff ? 2 : 1),
  };
}

function consumeIdent(source: string, pos: number): { value: string; next: number } {
  let cursor = pos;
  let value = "";
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor);
    if (isIdentCode(code)) {
      const runStart = cursor;
      cursor += 1;
      while (cursor < source.length && isIdentCode(source.charCodeAt(cursor))) {
        cursor += 1;
      }
      value += source.slice(runStart, cursor);
    } else if (isValidEscape(source, cursor)) {
      const escaped = consumeEscape(source, cursor);
      value += escaped.char;
      cursor = escaped.next;
    } else {
      break;
    }
  }
  return { value, next: cursor };
}

function consumeString(
  source: string,
  pos: number,
): {
  kind: typeof TokenKind.String | typeof TokenKind.BadString;
  value: string;
  next: number;
} {
  const quote = source.charCodeAt(pos);
  let cursor = pos + 1;
  let value = "";
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor);
    if (code === quote) {
      return { kind: TokenKind.String, value, next: cursor + 1 };
    }
    if (isNewlineCode(code)) {
      return { kind: TokenKind.BadString, value, next: cursor };
    }
    if (code === 0x5c) {
      if (cursor + 1 >= source.length) {
        return { kind: TokenKind.String, value, next: cursor + 1 };
      }
      if (isNewlineCode(source.charCodeAt(cursor + 1))) {
        if (
          source.charCodeAt(cursor + 1) === 0x0d &&
          source.charCodeAt(cursor + 2) === 0x0a
        ) {
          cursor += 3;
        } else {
          cursor += 2;
        }
        continue;
      }
      const escaped = consumeEscape(source, cursor);
      value += escaped.char;
      cursor = escaped.next;
      continue;
    }
    const runStart = cursor;
    cursor += 1;
    while (cursor < source.length) {
      const c = source.charCodeAt(cursor);
      if (c === quote || c === 0x5c || isNewlineCode(c)) break;
      cursor += 1;
    }
    value += source.slice(runStart, cursor);
  }
  return { kind: TokenKind.String, value, next: cursor };
}

function consumeUnquotedUrl(
  source: string,
  pos: number,
): {
  kind: typeof TokenKind.Url | typeof TokenKind.BadUrl;
  value: string;
  next: number;
} {
  let cursor = pos;
  while (cursor < source.length && isWhitespaceCode(source.charCodeAt(cursor))) {
    cursor += 1;
  }
  let value = "";
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor);
    if (code === 0x29) {
      return { kind: TokenKind.Url, value, next: cursor + 1 };
    }
    if (isWhitespaceCode(code)) {
      while (cursor < source.length && isWhitespaceCode(source.charCodeAt(cursor))) {
        cursor += 1;
      }
      if (cursor >= source.length) {
        return { kind: TokenKind.Url, value, next: cursor };
      }
      if (source.charCodeAt(cursor) === 0x29) {
        return { kind: TokenKind.Url, value, next: cursor + 1 };
      }
      // Consume remnants of bad url
      while (cursor < source.length) {
        if (source.charCodeAt(cursor) === 0x29) {
          cursor += 1;
          break;
        }
        if (isValidEscape(source, cursor)) {
          cursor = consumeEscape(source, cursor).next;
        } else {
          cursor += 1;
        }
      }
      return { kind: TokenKind.BadUrl, value: "", next: cursor };
    }
    if (code === 0x22 || code === 0x27 || code === 0x28) {
      while (cursor < source.length) {
        if (source.charCodeAt(cursor) === 0x29) {
          cursor += 1;
          break;
        }
        if (isValidEscape(source, cursor)) {
          cursor = consumeEscape(source, cursor).next;
        } else {
          cursor += 1;
        }
      }
      return { kind: TokenKind.BadUrl, value: "", next: cursor };
    }
    if (code === 0x5c) {
      if (isValidEscape(source, cursor)) {
        const escaped = consumeEscape(source, cursor);
        value += escaped.char;
        cursor = escaped.next;
        continue;
      }
      while (cursor < source.length) {
        if (source.charCodeAt(cursor) === 0x29) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      return { kind: TokenKind.BadUrl, value: "", next: cursor };
    }
    value += source[cursor]!;
    cursor += 1;
  }
  return { kind: TokenKind.Url, value, next: cursor };
}

function tokenizeCSS(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;
  let pos = 0;

  while (pos < length) {
    const code = source.charCodeAt(pos);

    // Comment
    if (code === 0x2f && source.charCodeAt(pos + 1) === 0x2a) {
      const end = source.indexOf("*/", pos + 2);
      pos = end === -1 ? length : end + 2;
      continue;
    }

    // Whitespace
    if (isWhitespaceCode(code)) {
      pos += 1;
      while (pos < length && isWhitespaceCode(source.charCodeAt(pos))) {
        pos += 1;
      }
      tokens.push({ kind: TokenKind.Whitespace, raw: " ", value: " " });
      continue;
    }

    // String
    if (code === 0x22 || code === 0x27) {
      const str = consumeString(source, pos);
      tokens.push({
        kind: str.kind,
        raw: source.slice(pos, str.next),
        value: str.value,
      });
      pos = str.next;
      continue;
    }

    // Hash
    if (code === 0x23) {
      if (isIdentCode(source.charCodeAt(pos + 1)) || isValidEscape(source, pos + 1)) {
        const ident = consumeIdent(source, pos + 1);
        tokens.push({
          kind: TokenKind.Hash,
          raw: source.slice(pos, ident.next),
          value: ident.value,
        });
        pos = ident.next;
        continue;
      }
      tokens.push({ kind: TokenKind.Delim, raw: "#", value: "#" });
      pos += 1;
      continue;
    }

    // At-keyword
    if (code === 0x40) {
      if (startsIdent(source, pos + 1)) {
        const ident = consumeIdent(source, pos + 1);
        tokens.push({
          kind: TokenKind.AtKeyword,
          raw: source.slice(pos, ident.next),
          value: ident.value,
        });
        pos = ident.next;
        continue;
      }
      tokens.push({ kind: TokenKind.Delim, raw: "@", value: "@" });
      pos += 1;
      continue;
    }

    // Punctuation
    switch (code) {
      case 0x3a:
        tokens.push({ kind: TokenKind.Colon, raw: ":", value: ":" });
        pos += 1;
        continue;
      case 0x3b:
        tokens.push({ kind: TokenKind.Semicolon, raw: ";", value: ";" });
        pos += 1;
        continue;
      case 0x2c:
        tokens.push({ kind: TokenKind.Comma, raw: ",", value: "," });
        pos += 1;
        continue;
      case 0x28:
        tokens.push({ kind: TokenKind.LParen, raw: "(", value: "(" });
        pos += 1;
        continue;
      case 0x29:
        tokens.push({ kind: TokenKind.RParen, raw: ")", value: ")" });
        pos += 1;
        continue;
      case 0x5b:
        tokens.push({ kind: TokenKind.LBracket, raw: "[", value: "[" });
        pos += 1;
        continue;
      case 0x5d:
        tokens.push({ kind: TokenKind.RBracket, raw: "]", value: "]" });
        pos += 1;
        continue;
      case 0x7b:
        tokens.push({ kind: TokenKind.LBrace, raw: "{", value: "{" });
        pos += 1;
        continue;
      case 0x7d:
        tokens.push({ kind: TokenKind.RBrace, raw: "}", value: "}" });
        pos += 1;
        continue;
    }

    // Number / percentage / dimension
    if (startsNumber(source, pos)) {
      const start = pos;
      if (code === 0x2b || code === 0x2d) pos += 1;
      while (pos < length && isDigitCode(source.charCodeAt(pos))) pos += 1;
      if (source.charCodeAt(pos) === 0x2e && isDigitCode(source.charCodeAt(pos + 1))) {
        pos += 2;
        while (pos < length && isDigitCode(source.charCodeAt(pos))) pos += 1;
      }
      const exp = source.charCodeAt(pos);
      if (exp === 0x65 || exp === 0x45) {
        let expCursor = pos + 1;
        const sign = source.charCodeAt(expCursor);
        if (sign === 0x2b || sign === 0x2d) expCursor += 1;
        if (isDigitCode(source.charCodeAt(expCursor))) {
          pos = expCursor + 1;
          while (pos < length && isDigitCode(source.charCodeAt(pos))) pos += 1;
        }
      }
      if (source.charCodeAt(pos) === 0x25) {
        pos += 1;
      } else if (startsIdent(source, pos)) {
        pos = consumeIdent(source, pos).next;
      }
      const raw = source.slice(start, pos);
      tokens.push({ kind: TokenKind.Number, raw, value: raw });
      continue;
    }

    // Ident / Function / URL
    if (startsIdent(source, pos)) {
      const start = pos;
      const ident = consumeIdent(source, pos);
      pos = ident.next;
      if (source.charCodeAt(pos) === 0x28) {
        pos += 1;
        if (ident.value.toLowerCase() === "url") {
          let peek = pos;
          while (peek < length && isWhitespaceCode(source.charCodeAt(peek))) {
            peek += 1;
          }
          const quote = source.charCodeAt(peek);
          if (quote !== 0x22 && quote !== 0x27) {
            const url = consumeUnquotedUrl(source, pos);
            tokens.push({
              kind: url.kind,
              raw: source.slice(start, url.next),
              value: url.value,
            });
            pos = url.next;
            continue;
          }
        }
        tokens.push({
          kind: TokenKind.Function,
          raw: source.slice(start, pos),
          value: ident.value,
        });
        continue;
      }
      tokens.push({
        kind: TokenKind.Ident,
        raw: source.slice(start, pos),
        value: ident.value,
      });
      continue;
    }

    // Delim
    const ch = source[pos]!;
    tokens.push({ kind: TokenKind.Delim, raw: ch, value: ch });
    pos += 1;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Compact CSS serialization helpers
// ---------------------------------------------------------------------------

function serializeCSSString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\a ";
    else if (ch === "\r") out += "\\d ";
    else if (ch === "\f") out += "\\c ";
    else out += ch;
  }
  return `${out}"`;
}

function serializeCSSUrl(value: string): string {
  if (value === "") return "url()";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (
      isWhitespaceCode(code) ||
      code === 0x22 ||
      code === 0x27 ||
      code === 0x28 ||
      code === 0x29 ||
      code === 0x5c
    ) {
      return `url(${serializeCSSString(value)})`;
    }
  }
  return `url(${value})`;
}

function resolveCSSUrlValue(rawValue: string, baseURL: string): string {
  if (rawValue === "" || rawValue.startsWith("#")) {
    return rawValue;
  }
  try {
    return new URL(rawValue, baseURL).href;
  } catch {
    return rawValue;
  }
}

function isCombinatorDelim(token: Token): boolean {
  return (
    token.kind === TokenKind.Delim &&
    (token.raw === ">" || token.raw === "+" || token.raw === "~")
  );
}

function emitCompactTokens(
  tokens: readonly Token[],
  start: number,
  end: number,
  isSelector: boolean,
): string {
  let lo = start;
  let hi = end;
  while (lo < hi && tokens[lo]!.kind === TokenKind.Whitespace) lo += 1;
  while (hi > lo && tokens[hi - 1]!.kind === TokenKind.Whitespace) hi -= 1;

  let out = "";
  let prev: Token | null = null;
  for (let i = lo; i < hi; i += 1) {
    const token = tokens[i]!;
    if (token.kind === TokenKind.Whitespace) {
      // Find next non-whitespace token
      let nextIdx = i + 1;
      while (nextIdx < hi && tokens[nextIdx]!.kind === TokenKind.Whitespace) {
        nextIdx += 1;
      }
      i = nextIdx - 1;
      const next = nextIdx < hi ? tokens[nextIdx]! : null;
      if (prev === null || next === null) continue;
      if (isSelector) {
        if (
          prev.kind === TokenKind.Comma ||
          next.kind === TokenKind.Comma ||
          prev.kind === TokenKind.LParen ||
          prev.kind === TokenKind.Function ||
          next.kind === TokenKind.RParen ||
          prev.kind === TokenKind.LBracket ||
          next.kind === TokenKind.RBracket ||
          isCombinatorDelim(prev) ||
          isCombinatorDelim(next)
        ) {
          continue;
        }
        out += " ";
      } else {
        const omitAround = (t: Token): boolean =>
          t.kind === TokenKind.Colon ||
          t.kind === TokenKind.Semicolon ||
          t.kind === TokenKind.Comma ||
          t.kind === TokenKind.LBrace ||
          t.kind === TokenKind.RBrace ||
          t.kind === TokenKind.LBracket ||
          t.kind === TokenKind.RBracket ||
          t.kind === TokenKind.Url ||
          t.kind === TokenKind.String;
        if (
          prev.kind !== TokenKind.AtKeyword &&
          (omitAround(prev) ||
            omitAround(next) ||
            prev.kind === TokenKind.LParen ||
            prev.kind === TokenKind.Function ||
            next.kind === TokenKind.RParen ||
            (next.kind === TokenKind.LParen && prev.kind !== TokenKind.Ident) ||
            (prev.kind === TokenKind.RParen &&
              next.kind !== TokenKind.Ident &&
              next.kind !== TokenKind.Number &&
              next.kind !== TokenKind.Hash &&
              next.kind !== TokenKind.LParen))
        ) {
          continue;
        }
        out += " ";
      }
      continue;
    }

    if (token.kind === TokenKind.String) {
      out += serializeCSSString(token.value);
    } else if (token.kind === TokenKind.Url) {
      out += serializeCSSUrl(token.value);
    } else {
      out += token.raw;
    }
    prev = token;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selector rewriting (shell elements, :root, :target, :host, :host-context)
// ---------------------------------------------------------------------------

interface SelectorParenFrame {
  isSelectorList: boolean;
  isNth: boolean;
  sawOf: boolean;
}

const VALID_SELECTOR_DELIMS = new Set([".", ">", "+", "~", "*", "|", "&", "-", "="]);

function rewriteSelectorTokens(
  tokens: readonly Token[],
  start: number,
  end: number,
  suppressShadowOnly: boolean,
  shellNames: boolean,
  validate: boolean,
): Token[] {
  const out: Token[] = [];
  let bracketDepth = 0;
  const parenStack: SelectorParenFrame[] = [];
  let hasNonWs = false;
  let expectingSelector = validate;
  let lastNonWsKind: TokenKind | null = null;

  for (let i = start; i < end; i += 1) {
    const token = tokens[i]!;
    if (validate) {
      if (
        token.kind === TokenKind.BadString ||
        token.kind === TokenKind.BadUrl ||
        token.kind === TokenKind.AtKeyword ||
        token.kind === TokenKind.Semicolon ||
        token.kind === TokenKind.LBrace ||
        token.kind === TokenKind.RBrace
      ) {
        throw new SyntaxError("Invalid CSS selector");
      }
      if (
        bracketDepth === 0 &&
        parenStack.length === 0 &&
        token.kind === TokenKind.Delim &&
        !VALID_SELECTOR_DELIMS.has(token.raw)
      ) {
        throw new SyntaxError(`Invalid CSS selector token ${token.raw}`);
      }
    }

    if (token.kind === TokenKind.LBracket) {
      bracketDepth += 1;
      hasNonWs = true;
      expectingSelector = false;
      lastNonWsKind = token.kind;
      out.push(token);
      continue;
    }
    if (token.kind === TokenKind.RBracket) {
      if (bracketDepth === 0) {
        if (validate) throw new SyntaxError("Unmatched ] in CSS selector");
      } else {
        bracketDepth -= 1;
      }
      lastNonWsKind = token.kind;
      out.push(token);
      continue;
    }

    if (bracketDepth > 0) {
      out.push(token);
      continue;
    }

    if (token.kind === TokenKind.RParen) {
      if (parenStack.length === 0) {
        if (validate) throw new SyntaxError("Unmatched ) in CSS selector");
      } else {
        parenStack.pop();
      }
      lastNonWsKind = token.kind;
      out.push(token);
      continue;
    }

    if (token.kind === TokenKind.LParen) {
      parenStack.push({ isSelectorList: false, isNth: false, sawOf: false });
      hasNonWs = true;
      expectingSelector = false;
      lastNonWsKind = token.kind;
      out.push(token);
      continue;
    }

    if (token.kind === TokenKind.Comma && parenStack.length === 0) {
      if (validate && expectingSelector) {
        throw new SyntaxError("Empty selector in selector list");
      }
      expectingSelector = validate;
      lastNonWsKind = token.kind;
      out.push(token);
      continue;
    }

    if (token.kind !== TokenKind.Whitespace) {
      hasNonWs = true;
      expectingSelector = false;
    }

    const topFrame = parenStack.length > 0 ? parenStack[parenStack.length - 1]! : null;
    const inActiveSelector =
      topFrame === null || topFrame.isSelectorList || topFrame.sawOf;

    if (topFrame !== null && topFrame.isNth && !topFrame.sawOf) {
      if (token.kind === TokenKind.Ident && token.value.toLowerCase() === "of") {
        topFrame.sawOf = true;
      }
      if (token.kind !== TokenKind.Whitespace) lastNonWsKind = token.kind;
      out.push(token);
      continue;
    }

    // Pseudo-class starting with single ':'
    if (
      inActiveSelector &&
      token.kind === TokenKind.Colon &&
      (i === start || tokens[i - 1]!.kind !== TokenKind.Colon) &&
      i + 1 < end &&
      tokens[i + 1]!.kind !== TokenKind.Colon
    ) {
      const next = tokens[i + 1]!;
      if (next.kind === TokenKind.Ident) {
        const lower = next.value.toLowerCase();
        if (suppressShadowOnly && SHADOW_ONLY_PSEUDO_CLASSES.has(lower)) {
          out.push({ kind: TokenKind.Ident, raw: ":not(*)", value: ":not(*)" });
          i += 1;
          lastNonWsKind = TokenKind.RParen;
          continue;
        }
        if (lower === "target") {
          out.push({
            kind: TokenKind.Ident,
            raw: TARGET_SELECTOR,
            value: TARGET_SELECTOR,
          });
          i += 1;
          lastNonWsKind = TokenKind.RBracket;
          continue;
        }
        if (shellNames && lower === "root") {
          out.push({
            kind: TokenKind.Ident,
            raw: ROOT_SELECTOR,
            value: ROOT_SELECTOR,
          });
          i += 1;
          lastNonWsKind = TokenKind.RParen;
          continue;
        }
      } else if (next.kind === TokenKind.Function) {
        const lower = next.value.toLowerCase();
        if (suppressShadowOnly && SHADOW_ONLY_PSEUDO_CLASSES.has(lower)) {
          // Skip through matching ')'
          let depth = 1;
          let cursor = i + 2;
          while (cursor < end && depth > 0) {
            const inner = tokens[cursor]!;
            if (inner.kind === TokenKind.Function || inner.kind === TokenKind.LParen) {
              depth += 1;
            } else if (inner.kind === TokenKind.RParen) {
              depth -= 1;
            }
            cursor += 1;
          }
          out.push({ kind: TokenKind.Ident, raw: ":not(*)", value: ":not(*)" });
          i = cursor - 1;
          lastNonWsKind = TokenKind.RParen;
          continue;
        }
        out.push(token, next);
        parenStack.push({
          isSelectorList: SELECTOR_LIST_PSEUDOS.has(lower),
          isNth: lower === "nth-child" || lower === "nth-last-child",
          sawOf: false,
        });
        i += 1;
        lastNonWsKind = TokenKind.Function;
        continue;
      }
    }

    if (token.kind === TokenKind.Function) {
      parenStack.push({ isSelectorList: false, isNth: false, sawOf: false });
      lastNonWsKind = token.kind;
      out.push(token);
      continue;
    }

    // Type selector
    if (inActiveSelector && shellNames && token.kind === TokenKind.Ident) {
      const prev = i > start ? tokens[i - 1]! : null;
      const next = i + 1 < end ? tokens[i + 1]! : null;
      const isPrefixed =
        prev !== null &&
        ((prev.kind === TokenKind.Delim && (prev.raw === "." || prev.raw === "|")) ||
          prev.kind === TokenKind.Colon);
      const isNamespacePrefix =
        next !== null && next.kind === TokenKind.Delim && next.raw === "|";
      if (!isPrefixed && !isNamespacePrefix) {
        const replacement = SHELL_ELEMENT_NAMES.get(token.value.toLowerCase());
        if (replacement !== undefined) {
          out.push({ kind: TokenKind.Ident, raw: replacement, value: replacement });
          lastNonWsKind = TokenKind.Ident;
          continue;
        }
      }
    }

    if (token.kind !== TokenKind.Whitespace) {
      lastNonWsKind = token.kind;
    }
    out.push(token);
  }

  if (
    validate &&
    (!hasNonWs ||
      expectingSelector ||
      bracketDepth !== 0 ||
      parenStack.length !== 0 ||
      lastNonWsKind === TokenKind.Colon)
  ) {
    throw new SyntaxError("Invalid CSS selector");
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL rebasing across arbitrary CSS token ranges
// ---------------------------------------------------------------------------

function absolutizeTokenURLs(
  tokens: readonly Token[],
  start: number,
  end: number,
  baseURL: string,
  allowBareImportString = false,
): Token[] {
  const out: Token[] = [];
  const fnStack: string[] = [];

  for (let i = start; i < end; i += 1) {
    const token = tokens[i]!;
    if (token.kind === TokenKind.Url) {
      const resolved = resolveCSSUrlValue(token.value, baseURL);
      out.push({
        kind: TokenKind.Url,
        raw: serializeCSSUrl(resolved),
        value: resolved,
      });
      continue;
    }

    if (token.kind === TokenKind.Function) {
      const fnName = token.value.toLowerCase();
      if (fnName === "url") {
        // url( "foo.png" ) -> collapse to Url token
        let cursor = i + 1;
        while (cursor < end && tokens[cursor]!.kind === TokenKind.Whitespace) {
          cursor += 1;
        }
        const strToken = cursor < end ? tokens[cursor]! : null;
        if (strToken !== null && strToken.kind === TokenKind.String) {
          let after = cursor + 1;
          while (after < end && tokens[after]!.kind === TokenKind.Whitespace) {
            after += 1;
          }
          if (after < end && tokens[after]!.kind === TokenKind.RParen) {
            const resolved = resolveCSSUrlValue(strToken.value, baseURL);
            out.push({
              kind: TokenKind.Url,
              raw: serializeCSSUrl(resolved),
              value: resolved,
            });
            i = after;
            continue;
          }
        }
      }
      fnStack.push(fnName);
      out.push(token);
      continue;
    }

    if (token.kind === TokenKind.LParen) {
      fnStack.push("");
      out.push(token);
      continue;
    }

    if (token.kind === TokenKind.RParen) {
      fnStack.pop();
      out.push(token);
      continue;
    }

    if (token.kind === TokenKind.String) {
      const owner = fnStack.length > 0 ? fnStack[fnStack.length - 1]! : "";
      const isUrlString =
        (owner === "" && allowBareImportString) || STRING_URL_FUNCTIONS.has(owner);
      if (isUrlString) {
        const resolved = resolveCSSUrlValue(token.value, baseURL);
        out.push({
          kind: TokenKind.String,
          raw: serializeCSSString(resolved),
          value: resolved,
        });
        continue;
      }
    }

    out.push(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block statement splitter (handles CSS Nesting Level 1 & custom properties)
// ---------------------------------------------------------------------------

interface BlockStatement {
  /** Index of first token in prelude / statement. */
  start: number;
  /** Index past last token in prelude / statement (before ';' or '{'). */
  end: number;
  /** If hasBlock is true, range inside '{ ... }'. */
  hasBlock: boolean;
  blockStart: number;
  blockEnd: number;
  /** True for stray unmatched '}' tokens preserved on malformed input. */
  strayClose?: boolean;
}

function isCustomPropertyDeclaration(
  tokens: readonly Token[],
  start: number,
  end: number,
): boolean {
  let i = start;
  while (i < end && tokens[i]!.kind === TokenKind.Whitespace) i += 1;
  if (i >= end) return false;
  const first = tokens[i]!;
  if (first.kind !== TokenKind.Ident || !first.value.startsWith("--")) return false;
  i += 1;
  while (i < end && tokens[i]!.kind === TokenKind.Whitespace) i += 1;
  return i < end && tokens[i]!.kind === TokenKind.Colon;
}

function splitBlockStatements(
  tokens: readonly Token[],
  start: number,
  end: number,
  inStyleRule: boolean,
): BlockStatement[] {
  const statements: BlockStatement[] = [];
  let cursor = start;

  while (cursor < end) {
    while (cursor < end && tokens[cursor]!.kind === TokenKind.Whitespace) {
      cursor += 1;
    }
    if (cursor >= end) break;

    if (tokens[cursor]!.kind === TokenKind.RBrace) {
      statements.push({
        start: cursor,
        end: cursor + 1,
        hasBlock: false,
        blockStart: -1,
        blockEnd: -1,
        strayClose: true,
      });
      cursor += 1;
      continue;
    }
    if (tokens[cursor]!.kind === TokenKind.Semicolon) {
      cursor += 1;
      continue;
    }

    const stmtStart = cursor;
    const customProp = inStyleRule && isCustomPropertyDeclaration(tokens, stmtStart, end);
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let matched = false;

    while (cursor < end) {
      const kind = tokens[cursor]!.kind;
      if (kind === TokenKind.LParen || kind === TokenKind.Function) {
        parenDepth += 1;
      } else if (kind === TokenKind.RParen) {
        if (parenDepth > 0) parenDepth -= 1;
      } else if (kind === TokenKind.LBracket) {
        bracketDepth += 1;
      } else if (kind === TokenKind.RBracket) {
        if (bracketDepth > 0) bracketDepth -= 1;
      } else if (kind === TokenKind.LBrace) {
        if (!customProp && parenDepth === 0 && bracketDepth === 0) {
          const preludeEnd = cursor;
          const blockStart = cursor + 1;
          let depth = 1;
          cursor += 1;
          while (cursor < end && depth > 0) {
            if (tokens[cursor]!.kind === TokenKind.LBrace) depth += 1;
            else if (tokens[cursor]!.kind === TokenKind.RBrace) depth -= 1;
            cursor += 1;
          }
          const blockEnd = depth === 0 ? cursor - 1 : cursor;
          statements.push({
            start: stmtStart,
            end: preludeEnd,
            hasBlock: true,
            blockStart,
            blockEnd,
          });
          matched = true;
          break;
        }
        braceDepth += 1;
      } else if (kind === TokenKind.RBrace) {
        if (braceDepth > 0) braceDepth -= 1;
      } else if (
        kind === TokenKind.Semicolon &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        statements.push({
          start: stmtStart,
          end: cursor,
          hasBlock: false,
          blockStart: -1,
          blockEnd: -1,
        });
        cursor += 1;
        matched = true;
        break;
      }
      cursor += 1;
    }

    if (!matched && stmtStart < cursor) {
      statements.push({
        start: stmtStart,
        end: cursor,
        hasBlock: false,
        blockStart: -1,
        blockEnd: -1,
      });
    }
  }

  return statements;
}

// ---------------------------------------------------------------------------
// @import parsing & inlining
// ---------------------------------------------------------------------------

interface ImportParts {
  url: string;
  layer: string | null;
  supports: string | null;
  media: string | null;
}

function parseImportStatement(
  tokens: readonly Token[],
  start: number,
  end: number,
  stylesheetURL: string,
): ImportParts | null {
  // start points to AtKeyword("import")
  let i = start + 1;
  while (i < end && tokens[i]!.kind === TokenKind.Whitespace) i += 1;
  if (i >= end) return null;

  let rawUrl: string | null = null;
  const first = tokens[i]!;
  if (first.kind === TokenKind.Url || first.kind === TokenKind.String) {
    rawUrl = first.value;
    i += 1;
  } else if (first.kind === TokenKind.Function && first.value.toLowerCase() === "url") {
    let cursor = i + 1;
    while (cursor < end && tokens[cursor]!.kind === TokenKind.Whitespace) cursor += 1;
    if (cursor < end && tokens[cursor]!.kind === TokenKind.String) {
      rawUrl = tokens[cursor]!.value;
      cursor += 1;
      while (cursor < end && tokens[cursor]!.kind === TokenKind.Whitespace) cursor += 1;
      if (cursor < end && tokens[cursor]!.kind === TokenKind.RParen) {
        i = cursor + 1;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
  if (rawUrl === null) return null;

  let url: string;
  try {
    url = new URL(rawUrl, stylesheetURL).href;
  } catch {
    return null;
  }

  let layer: string | null = null;
  let supports: string | null = null;
  let media: string | null = null;

  while (i < end && tokens[i]!.kind === TokenKind.Whitespace) i += 1;
  if (i < end) {
    const t = tokens[i]!;
    if (t.kind === TokenKind.Ident && t.value.toLowerCase() === "layer") {
      layer = "";
      i += 1;
    } else if (t.kind === TokenKind.Function && t.value.toLowerCase() === "layer") {
      const innerStart = i + 1;
      let depth = 1;
      let cursor = innerStart;
      while (cursor < end && depth > 0) {
        if (
          tokens[cursor]!.kind === TokenKind.Function ||
          tokens[cursor]!.kind === TokenKind.LParen
        ) {
          depth += 1;
        } else if (tokens[cursor]!.kind === TokenKind.RParen) {
          depth -= 1;
        }
        cursor += 1;
      }
      layer = emitCompactTokens(
        tokens,
        innerStart,
        depth === 0 ? cursor - 1 : cursor,
        false,
      );
      i = cursor;
    }
  }

  while (i < end && tokens[i]!.kind === TokenKind.Whitespace) i += 1;
  if (
    i < end &&
    tokens[i]!.kind === TokenKind.Function &&
    tokens[i]!.value.toLowerCase() === "supports"
  ) {
    const innerStart = i + 1;
    let depth = 1;
    let cursor = innerStart;
    while (cursor < end && depth > 0) {
      if (
        tokens[cursor]!.kind === TokenKind.Function ||
        tokens[cursor]!.kind === TokenKind.LParen
      ) {
        depth += 1;
      } else if (tokens[cursor]!.kind === TokenKind.RParen) {
        depth -= 1;
      }
      cursor += 1;
    }
    supports = emitCompactTokens(
      tokens,
      innerStart,
      depth === 0 ? cursor - 1 : cursor,
      false,
    );
    i = cursor;
  }

  while (i < end && tokens[i]!.kind === TokenKind.Whitespace) i += 1;
  if (i < end) {
    const mediaText = emitCompactTokens(tokens, i, end, false);
    if (mediaText !== "") {
      media = mediaText;
    }
  }

  return { url, layer, supports, media };
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
  integrity = "",
  requestOptions?: Pick<StylesheetFetchOptions, "crossOrigin" | "referrerPolicy">,
): Promise<StylesheetSource> {
  const crossOrigin = normalizeCrossOrigin(requestOptions?.crossOrigin);
  const referrerPolicy = requestOptions?.referrerPolicy ?? "";
  let key = url;
  if (integrity !== "" || crossOrigin !== null || referrerPolicy !== "") {
    key = JSON.stringify([url, integrity, crossOrigin, referrerPolicy]);
  }
  const existing = context.requests.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const options: StylesheetFetchOptions = {};
  if (context.signal !== undefined) options.signal = context.signal;
  if (integrity !== "") options.integrity = integrity;
  if (crossOrigin !== null) options.crossOrigin = crossOrigin;
  if (referrerPolicy !== "") options.referrerPolicy = referrerPolicy;
  let fetched: ReturnType<StylesheetFetch>;
  if (
    context.signal === undefined &&
    integrity === "" &&
    crossOrigin === null &&
    referrerPolicy === ""
  ) {
    fetched = context.fetchText(url);
  } else {
    fetched = context.fetchText(url, options);
  }
  const request = fetched.then((source) =>
    typeof source === "string"
      ? { text: source, url }
      : { text: source.text, url: new URL(source.url, url).href },
  );
  context.requests.set(key, request);
  // A rejected fetch is evicted so a later insertion can retry the network
  // instead of replaying the cached failure for the realm's lifetime.
  request.catch(() => {
    if (context.requests.get(key) === request) {
      context.requests.delete(key);
    }
  });
  return request;
}

// ---------------------------------------------------------------------------
// Synchronous stylesheet/block rewriter + async @import inlining
// ---------------------------------------------------------------------------

function rewriteBlockSync(
  tokens: readonly Token[],
  start: number,
  end: number,
  baseURL: string,
  inStyleRule: boolean,
  urlsOnly: boolean,
  rejectImports: boolean,
): string {
  const statements = splitBlockStatements(tokens, start, end, inStyleRule);
  let out = "";

  for (let idx = 0; idx < statements.length; idx += 1) {
    const stmt = statements[idx]!;
    if (stmt.strayClose) {
      out += "}";
      continue;
    }

    const first = tokens[stmt.start]!;
    if (first.kind === TokenKind.AtKeyword) {
      const name = first.value.toLowerCase();
      if (rejectImports && name === "import") {
        throw new CSSOMImportRuleError();
      }
      if (stmt.hasBlock) {
        const preludeTokens =
          name === "namespace"
            ? tokens.slice(stmt.start, stmt.end)
            : absolutizeTokenURLs(tokens, stmt.start, stmt.end, baseURL);
        let preludeText = emitCompactTokens(
          preludeTokens,
          0,
          preludeTokens.length,
          false,
        );
        if (name === "scope" && !urlsOnly) {
          // Rewrite shell selectors inside @scope (...) to (...)
          const rewrittenScope = rewriteScopePrelude(preludeTokens);
          preludeText = emitCompactTokens(
            rewrittenScope,
            0,
            rewrittenScope.length,
            false,
          );
        }
        const innerUrlsOnly = urlsOnly || NON_RULE_BLOCK_ATRULES.has(name);
        const inner = rewriteBlockSync(
          tokens,
          stmt.blockStart,
          stmt.blockEnd,
          baseURL,
          inStyleRule,
          innerUrlsOnly,
          rejectImports,
        );
        out += `${preludeText}{${inner}}`;
      } else {
        const stmtTokens =
          name === "namespace"
            ? tokens.slice(stmt.start, stmt.end)
            : absolutizeTokenURLs(
                tokens,
                stmt.start,
                stmt.end,
                baseURL,
                name === "import",
              );
        out += `${emitCompactTokens(stmtTokens, 0, stmtTokens.length, false)};`;
      }
      continue;
    }

    if (stmt.hasBlock) {
      const prelude = urlsOnly
        ? absolutizeTokenURLs(tokens, stmt.start, stmt.end, baseURL)
        : rewriteSelectorTokens(tokens, stmt.start, stmt.end, true, true, false);
      const preludeText = emitCompactTokens(prelude, 0, prelude.length, !urlsOnly);
      const inner = rewriteBlockSync(
        tokens,
        stmt.blockStart,
        stmt.blockEnd,
        baseURL,
        true,
        urlsOnly,
        rejectImports,
      );
      out += `${preludeText}{${inner}}`;
      continue;
    }

    // Declaration (or trailing non-block statement)
    const declTokens = absolutizeTokenURLs(tokens, stmt.start, stmt.end, baseURL);
    const declText = emitCompactTokens(declTokens, 0, declTokens.length, false);
    if (declText === "") continue;
    const hasNext = idx + 1 < statements.length && !statements[idx + 1]!.strayClose;
    out += hasNext ? `${declText};` : declText;
  }

  return out;
}

function rewriteScopePrelude(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind === TokenKind.LParen) {
      let depth = 1;
      let cursor = i + 1;
      while (cursor < tokens.length && depth > 0) {
        if (
          tokens[cursor]!.kind === TokenKind.LParen ||
          tokens[cursor]!.kind === TokenKind.Function
        ) {
          depth += 1;
        } else if (tokens[cursor]!.kind === TokenKind.RParen) {
          depth -= 1;
        }
        cursor += 1;
      }
      out.push(token);
      out.push(
        ...rewriteSelectorTokens(
          tokens,
          i + 1,
          depth === 0 ? cursor - 1 : cursor,
          true,
          true,
          false,
        ),
      );
      if (depth === 0) out.push(tokens[cursor - 1]!);
      i = cursor;
      continue;
    }
    out.push(token);
    i += 1;
  }
  return out;
}

interface StylesheetExpansionState {
  hasImport: boolean;
  importExpansions: number;
  expandedBytes: number;
}

async function transformStylesheet(
  source: string,
  stylesheetURL: string,
  context: StylesheetContext,
  ancestors: ReadonlySet<string>,
  state?: StylesheetExpansionState,
): Promise<string> {
  const maxImportExpansions =
    context.maxImportExpansions ?? DEFAULT_MAX_IMPORT_EXPANSIONS;
  const maxExpandedBytes = context.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_CSS_BYTES;
  const tokens = tokenizeCSS(source);
  const statements = splitBlockStatements(tokens, 0, tokens.length, false);
  const parts: Array<string | Promise<string>> = [];
  let importsAllowed = true;
  let foundImport = false;

  for (let idx = 0; idx < statements.length; idx += 1) {
    const stmt = statements[idx]!;
    if (stmt.strayClose) {
      importsAllowed = false;
      parts.push("}");
      continue;
    }

    const first = tokens[stmt.start]!;
    if (first.kind === TokenKind.AtKeyword) {
      const name = first.value.toLowerCase();
      if (name === "import" && !stmt.hasBlock && importsAllowed) {
        foundImport = true;
        if (state !== undefined) state.hasImport = true;
        const importSpec = parseImportStatement(
          tokens,
          stmt.start,
          stmt.end,
          stylesheetURL,
        );
        if (importSpec === null) {
          const fallback = absolutizeTokenURLs(
            tokens,
            stmt.start,
            stmt.end,
            stylesheetURL,
            true,
          );
          parts.push(`${emitCompactTokens(fallback, 0, fallback.length, false)};`);
          continue;
        }
        if (ancestors.has(importSpec.url)) {
          continue;
        }
        parts.push(
          (async () => {
            try {
              if (
                context.maxImportDepth !== undefined &&
                ancestors.size > context.maxImportDepth
              ) {
                throw new RangeError(
                  `Stylesheet @import depth exceeded limit of ${context.maxImportDepth}`,
                );
              }
              if (state !== undefined) {
                state.importExpansions += 1;
                if (state.importExpansions > maxImportExpansions) {
                  throw new RangeError(
                    `Stylesheet @import expansion count exceeded limit of ${maxImportExpansions}`,
                  );
                }
              }
              const fetched = await fetchStylesheet(importSpec.url, context);
              if (ancestors.has(fetched.url)) {
                return "";
              }
              const importedAncestors = new Set(ancestors);
              importedAncestors.add(importSpec.url);
              importedAncestors.add(fetched.url);
              const transformed = await transformStylesheet(
                fetched.text,
                fetched.url,
                context,
                importedAncestors,
                state,
              );
              return wrapImportedStylesheet(transformed, importSpec);
            } catch (error) {
              if (!context.signal?.aborted) {
                context.onImportFailure?.({ url: importSpec.url, error });
              }
              return "";
            }
          })(),
        );
        continue;
      }

      if (name === "charset" && !stmt.hasBlock) {
        parts.push(`${emitCompactTokens(tokens, stmt.start, stmt.end, false)};`);
        continue;
      }

      if (name === "layer" && !stmt.hasBlock && importsAllowed) {
        if (foundImport) importsAllowed = false;
        parts.push(`${emitCompactTokens(tokens, stmt.start, stmt.end, false)};`);
        continue;
      }

      importsAllowed = false;
      if (stmt.hasBlock) {
        const preludeTokens =
          name === "namespace"
            ? tokens.slice(stmt.start, stmt.end)
            : absolutizeTokenURLs(tokens, stmt.start, stmt.end, stylesheetURL);
        let preludeText = emitCompactTokens(
          preludeTokens,
          0,
          preludeTokens.length,
          false,
        );
        if (name === "scope") {
          const rewrittenScope = rewriteScopePrelude(preludeTokens);
          preludeText = emitCompactTokens(
            rewrittenScope,
            0,
            rewrittenScope.length,
            false,
          );
        }
        const inner = rewriteBlockSync(
          tokens,
          stmt.blockStart,
          stmt.blockEnd,
          stylesheetURL,
          false,
          NON_RULE_BLOCK_ATRULES.has(name),
          false,
        );
        parts.push(`${preludeText}{${inner}}`);
      } else {
        const stmtTokens =
          name === "namespace"
            ? tokens.slice(stmt.start, stmt.end)
            : absolutizeTokenURLs(
                tokens,
                stmt.start,
                stmt.end,
                stylesheetURL,
                name === "import",
              );
        parts.push(`${emitCompactTokens(stmtTokens, 0, stmtTokens.length, false)};`);
      }
      continue;
    }

    importsAllowed = false;
    if (stmt.hasBlock) {
      const prelude = rewriteSelectorTokens(
        tokens,
        stmt.start,
        stmt.end,
        true,
        true,
        false,
      );
      const preludeText = emitCompactTokens(prelude, 0, prelude.length, true);
      const inner = rewriteBlockSync(
        tokens,
        stmt.blockStart,
        stmt.blockEnd,
        stylesheetURL,
        true,
        false,
        false,
      );
      parts.push(`${preludeText}{${inner}}`);
      continue;
    }

    const trailing = absolutizeTokenURLs(tokens, stmt.start, stmt.end, stylesheetURL);
    const text = emitCompactTokens(trailing, 0, trailing.length, false);
    if (text !== "") {
      const hasNext = idx + 1 < statements.length && !statements[idx + 1]!.strayClose;
      parts.push(hasNext ? `${text};` : text);
    }
  }

  const resolvedParts = await Promise.all(parts);
  let outputLength = 0;
  for (let i = 0; i < resolvedParts.length; i += 1) {
    outputLength += resolvedParts[i]!.length;
    if (outputLength > maxExpandedBytes) {
      throw new RangeError(
        `Stylesheet expanded output exceeded limit of ${maxExpandedBytes} characters`,
      );
    }
  }
  if (state !== undefined) {
    state.expandedBytes = Math.max(state.expandedBytes, outputLength);
    if (state.expandedBytes > maxExpandedBytes) {
      throw new RangeError(
        `Stylesheet expanded output exceeded limit of ${maxExpandedBytes} characters`,
      );
    }
  }
  return resolvedParts.join("");
}

const MAX_CSS_CACHE_ENTRIES = 128;
const MAX_CSS_CACHE_ENTRY_CHARS = 65_536;
const MAX_CSS_CACHE_TOTAL_CHARS = 524_288;
const rewrittenCSSCache = new Map<string, string>();
let rewrittenCSSCacheChars = 0;

function readRewrittenCSSCache(key: string): string | undefined {
  const hit = rewrittenCSSCache.get(key);
  if (hit !== undefined) {
    rewrittenCSSCache.delete(key);
    rewrittenCSSCache.set(key, hit);
  }
  return hit;
}

function writeRewrittenCSSCache(key: string, value: string): void {
  const entryChars = key.length + value.length;
  if (entryChars > MAX_CSS_CACHE_ENTRY_CHARS) return;
  const previous = rewrittenCSSCache.get(key);
  if (previous !== undefined) {
    rewrittenCSSCacheChars -= key.length + previous.length;
    rewrittenCSSCache.delete(key);
  }
  while (
    rewrittenCSSCache.size >= MAX_CSS_CACHE_ENTRIES ||
    rewrittenCSSCacheChars + entryChars > MAX_CSS_CACHE_TOTAL_CHARS
  ) {
    const oldest = rewrittenCSSCache.entries().next().value;
    if (oldest === undefined) break;
    rewrittenCSSCache.delete(oldest[0]);
    rewrittenCSSCacheChars -= oldest[0].length + oldest[1].length;
  }
  rewrittenCSSCache.set(key, value);
  rewrittenCSSCacheChars += entryChars;
}

export async function rewriteStylesheet(
  source: string,
  stylesheetURL: string,
  context: StylesheetContext,
): Promise<string> {
  const cacheable = source.length <= MAX_CSS_CACHE_ENTRY_CHARS;
  const cacheKey = cacheable ? `s\0${stylesheetURL}\0${source}` : null;
  if (cacheKey !== null) {
    const cached = readRewrittenCSSCache(cacheKey);
    if (cached !== undefined) return cached;
  }
  const state: StylesheetExpansionState = {
    hasImport: false,
    importExpansions: 0,
    expandedBytes: 0,
  };
  const result = await transformStylesheet(
    source,
    stylesheetURL,
    context,
    new Set([stylesheetURL]),
    state,
  );
  if (cacheKey !== null && !state.hasImport) {
    writeRewrittenCSSCache(cacheKey, result);
  }
  return result;
}

function extractFontFacesFromBlock(
  tokens: readonly Token[],
  start: number,
  end: number,
): string {
  const statements = splitBlockStatements(tokens, start, end, false);
  let out = "";
  for (const stmt of statements) {
    if (stmt.strayClose || !stmt.hasBlock) continue;
    const first = tokens[stmt.start]!;
    if (first.kind !== TokenKind.AtKeyword) continue;
    const name = first.value.toLowerCase();
    if (name === "font-face") {
      const prelude = emitCompactTokens(tokens, stmt.start, stmt.end, false);
      const body = emitCompactTokens(tokens, stmt.blockStart, stmt.blockEnd, false);
      out += `${prelude}{${body}}`;
    } else if (FONT_CONTAINER_ATRULES.has(name)) {
      const inner = extractFontFacesFromBlock(tokens, stmt.blockStart, stmt.blockEnd);
      if (inner !== "") {
        const prelude = emitCompactTokens(tokens, stmt.start, stmt.end, false);
        out += `${prelude}{${inner}}`;
      }
    }
  }
  return out;
}

/** Font definitions must be placed in the host stylesheet for shadow-tree interoperability. */
export function extractFontFaces(source: string, _stylesheetURL: string): string {
  if (!source.toLowerCase().includes("@font-face")) {
    return "";
  }
  const tokens = tokenizeCSS(source);
  return extractFontFacesFromBlock(tokens, 0, tokens.length);
}

export function rewriteStyleAttribute(source: string, baseURL: string): string {
  const tokens = tokenizeCSS(source);
  return rewriteBlockSync(tokens, 0, tokens.length, baseURL, true, true, false);
}

export function rewriteConstructedStylesheet(source: string, baseURL: string): string {
  const cacheKey =
    source.length <= MAX_CSS_CACHE_ENTRY_CHARS ? `c\0${baseURL}\0${source}` : null;
  if (cacheKey !== null) {
    const cached = readRewrittenCSSCache(cacheKey);
    if (cached !== undefined) return cached;
  }
  const tokens = tokenizeCSS(source);
  const result = rewriteBlockSync(tokens, 0, tokens.length, baseURL, false, false, false);
  if (cacheKey !== null) {
    writeRewrittenCSSCache(cacheKey, result);
  }
  return result;
}

export function rewriteCSSOMInsertRule(source: string, baseURL: string): string {
  const tokens = tokenizeCSS(source);
  return rewriteBlockSync(tokens, 0, tokens.length, baseURL, false, false, true);
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
  const tokens = tokenizeCSS(source);
  const rewritten = rewriteSelectorTokens(tokens, 0, tokens.length, true, true, true);
  return emitCompactTokens(rewritten, 0, rewritten.length, true);
}

export function translateShellSelector(selector: string): string {
  const tokens = tokenizeCSS(selector);
  const rewritten = rewriteSelectorTokens(tokens, 0, tokens.length, false, true, false);
  return emitCompactTokens(rewritten, 0, rewritten.length, true);
}

/** Rewrite target state on the unaliased branch of a DOM selector lookup too. */
export function translateTargetSelector(selector: string): string {
  if (!selector.includes(":")) return selector;
  const tokens = tokenizeCSS(selector);
  const rewritten = rewriteSelectorTokens(tokens, 0, tokens.length, false, false, false);
  return emitCompactTokens(rewritten, 0, rewritten.length, true);
}

// ---------------------------------------------------------------------------
// Inline declaration list helpers for style.ts
// ---------------------------------------------------------------------------

interface ParsedDeclaration {
  property: string;
  key: string;
  value: string;
}

function normalizeUrlFunctions(
  tokens: readonly Token[],
  start: number,
  end: number,
): Token[] {
  const out: Token[] = [];
  for (let i = start; i < end; i += 1) {
    const token = tokens[i]!;
    if (token.kind === TokenKind.Url) {
      out.push({
        kind: TokenKind.Url,
        raw: serializeCSSUrl(token.value),
        value: token.value,
      });
      continue;
    }
    if (token.kind === TokenKind.Function && token.value.toLowerCase() === "url") {
      let cursor = i + 1;
      while (cursor < end && tokens[cursor]!.kind === TokenKind.Whitespace) {
        cursor += 1;
      }
      const strToken = cursor < end ? tokens[cursor]! : null;
      if (strToken !== null && strToken.kind === TokenKind.String) {
        let after = cursor + 1;
        while (after < end && tokens[after]!.kind === TokenKind.Whitespace) {
          after += 1;
        }
        if (after < end && tokens[after]!.kind === TokenKind.RParen) {
          out.push({
            kind: TokenKind.Url,
            raw: serializeCSSUrl(strToken.value),
            value: strToken.value,
          });
          i = after;
          continue;
        }
      }
    }
    out.push(token);
  }
  return out;
}

function parseDeclarationList(source: string): ParsedDeclaration[] {
  const tokens = tokenizeCSS(source);
  const statements = splitBlockStatements(tokens, 0, tokens.length, true);
  const declarations: ParsedDeclaration[] = [];

  for (const stmt of statements) {
    if (stmt.strayClose || stmt.hasBlock) continue;
    let i = stmt.start;
    while (i < stmt.end && tokens[i]!.kind === TokenKind.Whitespace) i += 1;
    if (i >= stmt.end || tokens[i]!.kind !== TokenKind.Ident) continue;
    const property = tokens[i]!.value;
    i += 1;
    while (i < stmt.end && tokens[i]!.kind === TokenKind.Whitespace) i += 1;
    if (i >= stmt.end || tokens[i]!.kind !== TokenKind.Colon) continue;
    i += 1;
    const normalized = normalizeUrlFunctions(tokens, i, stmt.end);
    const value = emitCompactTokens(normalized, 0, normalized.length, false);
    const key = property.startsWith("--") ? property : property.toLowerCase();
    declarations.push({ property, key, value });
  }
  return declarations;
}

const NO_URL_DECLARATIONS: ReadonlyMap<string, string> = new Map();

export function extractAuthoredURLDeclarations(
  source: string,
): ReadonlyMap<string, string> {
  if (!source.includes("(")) {
    return NO_URL_DECLARATIONS;
  }
  const properties = new Map<string, string>();
  for (const declaration of parseDeclarationList(source)) {
    if (/url\s*\(/i.test(declaration.value)) {
      properties.set(declaration.key, declaration.value);
    }
  }
  return properties;
}

export function normalizeDeclarationList(source: string): string {
  return parseDeclarationList(source)
    .map((d) => `${d.property}:${d.value}`)
    .join(";");
}

export function updateDeclarationProperty(
  source: string,
  property: string,
  value: string,
  priority: string,
): string {
  const targetKey = property.startsWith("--") ? property : property.toLowerCase();
  const kept = parseDeclarationList(source)
    .filter((d) => d.key !== targetKey)
    .map((d) => `${d.property}:${d.value}`);
  if (value !== "") {
    const addition = parseDeclarationList(
      `${property}:${value}${priority === "" ? "" : `!${priority}`}`,
    );
    if (addition.length > 0) {
      kept.push(`${addition[0]!.property}:${addition[0]!.value}`);
    }
  }
  return kept.join(";");
}
