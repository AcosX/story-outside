import { gzipSync, gunzipSync } from 'node:zlib';

// Lossless, versioned storage encoding; legacy plain JSON remains readable.
// Keep state and finish metadata queryable. Only replay caches are compressed.
const FIELDS = ['requestIds', 'turnRequests', 'compact_history'];
export function encodeRuntimePayload(runtime) {
  const replay = Object.fromEntries(FIELDS.filter(key => key in runtime).map(key => [key, runtime[key]]));
  const raw = JSON.stringify(replay);
  if (Buffer.byteLength(raw) < 16384) return runtime;
  const out = { ...runtime };
  for (const key of FIELDS) delete out[key];
  out.replay_cache = { codec: 'gzip-json-v1', data: gzipSync(raw, { level: 6 }).toString('base64') };
  return out;
}
export function decodeRuntimePayload(runtime) {
  if (!runtime?.replay_cache) return runtime;
  if (runtime.replay_cache.codec !== 'gzip-json-v1') throw new Error('Unsupported runtime replay codec');
  const replay = JSON.parse(gunzipSync(Buffer.from(runtime.replay_cache.data, 'base64'), { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8'));
  if (!replay || typeof replay !== 'object' || Object.keys(replay).some(key => !FIELDS.includes(key))) throw new Error('Invalid runtime replay cache');
  const { replay_cache, ...out } = runtime;
  return { ...out, ...replay };
}
