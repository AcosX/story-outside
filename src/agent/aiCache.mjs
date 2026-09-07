import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../stories/canonicalHash.mjs';

const active = new Map();
export const cacheHash = canonicalSha256;
export async function readAICache(config, key) {
  if (!config.cacheDir) return null;
  try { return JSON.parse(await readFile(join(config.cacheDir, `${key}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw new Error('AI cache could not be read'); }
}
export async function writeAICache(config, key, value) {
  if (!config.cacheDir) return;
  await mkdir(config.cacheDir, { recursive: true, mode: 0o700 });
  const target = join(config.cacheDir, `${key}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, target);
}
export async function cachedAIResult(config, key, producer, validate = () => true) {
  const scope = `${config.cacheDir || 'memory'}:${key}`;
  if (active.has(scope)) return active.get(scope);
  const promise = (async () => {
    const prior = await readAICache(config, key);
    if (prior && validate(prior)) return prior;
    const result = await producer();
    if (!validate(result)) throw new Error('AI returned invalid story analysis');
    await writeAICache(config, key, result);
    return result;
  })();
  active.set(scope, promise);
  try { return await promise; } finally { active.delete(scope); }
}
