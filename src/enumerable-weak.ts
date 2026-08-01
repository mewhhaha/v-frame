// Several of the facade's registries need two things the built-in collections
// never provide together: membership keyed by a guest node, and enumeration of
// everything currently registered. A `Set` or a `Map` gives the enumeration and
// pins every element it has ever seen, which turns the facade into a leak — a
// guest that churns rows retains every row it ever rendered for as long as the
// frame lives.
//
// These hold their keys weakly and enumerate the survivors: one `WeakRef` per
// entry in insertion order, dropped by a `FinalizationRegistry` as the keys are
// collected. Enumeration is therefore the live entries only, and no caller may
// depend on a collected entry disappearing at any particular moment — the engine
// decides when, and until then the entry is simply still there.

export class EnumerableWeakSet<T extends object> {
  readonly #references = new Set<WeakRef<T>>();
  readonly #referencesByMember = new WeakMap<T, WeakRef<T>>();
  readonly #collected = new FinalizationRegistry<WeakRef<T>>((reference) => {
    this.#references.delete(reference);
  });

  add(member: T): void {
    if (this.#referencesByMember.has(member)) {
      return;
    }

    const reference = new WeakRef(member);
    this.#referencesByMember.set(member, reference);
    this.#references.add(reference);
    // The member is its own unregister token, so delete() and clear() can drop
    // the registration instead of leaving a dead cell in the registry until the
    // member itself is collected.
    this.#collected.register(member, reference, member);
  }

  has(member: T): boolean {
    return this.#referencesByMember.has(member);
  }

  delete(member: T): void {
    const reference = this.#referencesByMember.get(member);
    if (reference === undefined) {
      return;
    }

    this.#references.delete(reference);
    this.#referencesByMember.delete(member);
    this.#collected.unregister(member);
  }

  clear(): void {
    for (const member of this) {
      this.#referencesByMember.delete(member);
      this.#collected.unregister(member);
    }
    this.#references.clear();
  }

  // Iteration walks a snapshot: every caller here removes members while it goes.
  *[Symbol.iterator](): IterableIterator<T> {
    for (const reference of [...this.#references]) {
      const member = reference.deref();
      if (member !== undefined) {
        yield member;
      }
    }
  }
}

export class EnumerableWeakMap<K extends object, V> {
  readonly #keys = new EnumerableWeakSet<K>();
  readonly #values = new WeakMap<K, V>();

  get(key: K): V | undefined {
    return this.#values.get(key);
  }

  set(key: K, value: V): void {
    this.#keys.add(key);
    this.#values.set(key, value);
  }

  has(key: K): boolean {
    return this.#values.has(key);
  }

  delete(key: K): void {
    this.#keys.delete(key);
    this.#values.delete(key);
  }

  clear(): void {
    for (const key of this.#keys) {
      this.#values.delete(key);
    }
    this.#keys.clear();
  }

  keys(): IterableIterator<K> {
    return this.#keys[Symbol.iterator]();
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const key of this.#keys) {
      const value = this.#values.get(key);
      // Keys and values are written and deleted together, so a key that
      // survives enumeration still has its value; a stored `undefined` would be
      // indistinguishable from an absent one, so no caller stores one.
      if (value !== undefined) {
        yield [key, value];
      }
    }
  }
}
