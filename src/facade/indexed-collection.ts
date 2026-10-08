// Collections the realm hands out are objects on the native NodeList,
// HTMLCollection and similar prototypes, so brand and prototype checks
// (instanceof, Object.prototype.toString) answer as they do natively. The
// native accessors on those prototypes brand-check their receiver, which a
// plain object fails, so the object is a proxy that answers the indexed and
// named properties itself and forwards the rest.

import { toDOMString } from "./webidl.js";

export interface LiveIndexedCollection<T extends object> {
  readonly length: number;
  item(index: number): T | null;
  readonly [index: number]: T;
}

export interface IndexedValues<T> extends Iterable<T> {
  readonly length: number;
  readonly [index: number]: T;
}

export function propertyIndex(property: PropertyKey): number | null {
  if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) {
    return null;
  }
  const index = Number(property);
  return Number.isSafeInteger(index) ? index : null;
}

export function liveIndexedCollection<T extends object>(
  prototype: object,
  currentValues: () => IndexedValues<T>,
  currentNamedValue?: (name: string) => T | null,
): LiveIndexedCollection<T> {
  const target = Object.create(prototype) as object;
  const itemAt = (index: number): T | null => currentValues()[index] ?? null;
  const namedItem = (name: string): T | null =>
    currentNamedValue?.(toDOMString(name)) ?? null;
  const iterator = (): Iterator<T> => currentValues()[Symbol.iterator]();

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
              const values = currentValues();
              for (let index = 0; index < values.length; index += 1) {
                callback.call(thisArg, values[index]!, index, proxy);
              }
            };
          case "entries":
            return () => Array.from(currentValues()).entries();
          case "keys":
            return () => Array.from(currentValues()).keys();
          case "values":
            return iterator;
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
        ...Array.from({ length: currentValues().length }, (_value, index) =>
          String(index),
        ),
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
