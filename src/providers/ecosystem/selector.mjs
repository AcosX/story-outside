// src/providers/ecosystem/selector.mjs — choose between mock and real
// ecosystem providers based on env vars.

import { createMockEcosystemProvider } from './mockProvider.mjs';
import { createRealZhihuEcosystemProvider } from './realProvider.mjs';

const ENV_KEYS = Object.freeze(['STORY_OUTSIDE_PROVIDER', 'ZHIHU_PROVIDER', 'ECOSYSTEM_PROVIDER']);
const DEFAULT_VALUE = 'mock';

function readProviderEnv() {
  for (const key of ENV_KEYS) {
    const raw = process.env[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    return { key, value: trimmed };
  }
  return { key: 'default', value: DEFAULT_VALUE };
}

const _cache = new Map();

/**
 * Resolve the active ecosystem provider. Memoised.
 * @returns {ReturnType<typeof createMockEcosystemProvider>}
 */
export function resolveEcosystemProvider() {
  const { key, value } = readProviderEnv();
  const cacheKey = `${key}::${value}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;
  if (value === 'mock') {
    const provider = createMockEcosystemProvider();
    _cache.set(cacheKey, provider);
    return provider;
  }
  if (value === 'real') {
    const provider = createRealZhihuEcosystemProvider();
    _cache.set(cacheKey, provider);
    return provider;
  }
  throw new Error(
    `Unknown ecosystem provider value="${value}" (from env ${key}). Expected "mock" or "real".`,
  );
}

export function __resetEcosystemProviderForTests() {
  _cache.clear();
}