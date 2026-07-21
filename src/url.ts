const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export function parseEntryURL(value: string, baseURL: string): URL {
  let url: URL;

  try {
    url = new URL(value, baseURL);
  } catch (cause) {
    throw new TypeError(`v-frame src ${JSON.stringify(value)} is not a valid URL`, {
      cause,
    });
  }

  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    throw new TypeError(
      `v-frame src ${JSON.stringify(value)} must use http: or https:, received ${url.protocol}`,
    );
  }

  return url;
}

interface HistoryURLRealm {
  URL: typeof URL;
  DOMException: typeof DOMException;
  TypeError: typeof TypeError;
}

export function resolveHistoryURL(
  value: string | URL | null | undefined,
  baseURL: string,
  currentURL: string,
  realm: HistoryURLRealm,
): string {
  if (value === null || value === undefined) {
    return currentURL;
  }

  let serializedValue: string;
  try {
    serializedValue = `${value}`;
  } catch (cause) {
    throw new realm.TypeError("History URL cannot be converted to a string", { cause });
  }
  if (serializedValue === "") {
    return currentURL;
  }

  const nextURL = new realm.URL(serializedValue, baseURL);
  const currentOrigin = new realm.URL(currentURL).origin;

  if (nextURL.origin !== currentOrigin) {
    throw new realm.DOMException(
      `History URL ${nextURL.href} does not share the current origin ${currentOrigin}`,
      "SecurityError",
    );
  }

  return nextURL.href;
}

export function isSameDocumentFragment(from: string, to: string): boolean {
  const fromURL = new URL(from);
  const toURL = new URL(to);

  return (
    fromURL.origin === toURL.origin &&
    fromURL.pathname === toURL.pathname &&
    fromURL.search === toURL.search &&
    (toURL.hash.length > 0 || toURL.href.endsWith("#"))
  );
}
