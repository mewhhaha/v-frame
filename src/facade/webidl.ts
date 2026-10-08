// The facade patches methods whose arguments the browser would have converted
// with WebIDL rules before any behavior ran. Converting the same way, in one
// place, keeps `null`, `undefined` and objects meaning what they mean natively
// instead of whatever `String()` or a property read happens to do with them.

/** DOMString: ToString, which unlike String() also rejects symbols. */
export function toDOMString(value: unknown): string {
  return `${value as string}`;
}

/** USVString: DOMString with lone surrogates replaced by U+FFFD. */
export function toUSVString(value: unknown): string {
  return toDOMString(value).toWellFormed();
}

/** `[LegacyNullToEmptyString] DOMString`: null becomes "" and nothing else changes. */
export function toLegacyNullToEmptyString(value: unknown): string {
  return value === null ? "" : toDOMString(value);
}

/** `DOMString?`: both null and undefined mean no value. */
export function toNullableDOMString(value: unknown): string | null {
  return value === null || value === undefined ? null : toDOMString(value);
}
