// src/util/boundedMap.mjs — A minimal bounded Map with LRU eviction.
//
// Used by every process-local cache that would otherwise grow without
// bound across the lifetime of a long-running server:
//   * src/providers/realProvider.mjs — detailCache (one entry per work_id)
//   * src/server.mjs                  — sessionPinnedMetadata, demoTurnCounter
//
// Why we need this:
//   * Node has no native LRU; pulling in a library would break the
//     "zero npm dependencies" hard constraint.
//   * A naive Map.set can be evicted by an attacker driving arbitrary
//     session_uuid traffic; even without abuse, a long-lived process
//     accumulates state forever.
//
// Semantics:
//   * Insertion-ordered (Map semantics preserved).
//   * get() promotes the key to MRU.
//   * set() inserts at MRU; if the size exceeds `max`, the LRU entry
//     (the oldest one we have NOT touched recently) is evicted.
//   * delete() / clear() / keys() / values() / entries() match the
//     parts of Map we actually use.
//
// This module is intentionally tiny and dependency-free. Do NOT add
// observability hooks here — they belong in the calling site.

/**
 * @template K, V
 */
export class BoundedMap {
  /**
   * @param {{ max?: number, name?: string }} [opts]
   */
  constructor(opts = {}) {
    const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : 1000;
    /** @type {Map<K, V>} */
    this._inner = new Map();
    this._max = max;
    this._name = typeof opts.name === 'string' ? opts.name : 'bounded';
  }

  /**
   * @returns {number}
   */
  get max() {
    return this._max;
  }

  /**
   * @returns {number}
   */
  get size() {
    return this._inner.size;
  }

  /**
   * @param {K} key
   * @returns {V | undefined}
   */
  get(key) {
    const v = this._inner.get(key);
    if (v === undefined && !this._inner.has(key)) return undefined;
    // Promote to MRU.
    this._inner.delete(key);
    this._inner.set(key, v);
    return v;
  }

  /**
   * @param {K} key
   * @returns {boolean}
   */
  has(key) {
    return this._inner.has(key);
  }

  /**
   * Insert / overwrite at MRU. Evicts the LRU entry when over capacity.
   * @param {K} key
   * @param {V} value
   * @returns {this}
   */
  set(key, value) {
    if (this._inner.has(key)) {
      this._inner.delete(key);
    }
    this._inner.set(key, value);
    while (this._inner.size > this._max) {
      const oldest = this._inner.keys().next().value;
      if (oldest === undefined) break;
      this._inner.delete(oldest);
    }
    return this;
  }

  /**
   * @param {K} key
   * @returns {boolean}
   */
  delete(key) {
    return this._inner.delete(key);
  }

  /**
   * @returns {void}
   */
  clear() {
    this._inner.clear();
  }

  /**
   * @returns {IterableIterator<K>}
   */
  keys() {
    return this._inner.keys();
  }

  /**
   * @returns {IterableIterator<V>}
   */
  values() {
    return this._inner.values();
  }

  /**
   * @returns {IterableIterator<[K, V]>}
   */
  entries() {
    return this._inner.entries();
  }
}