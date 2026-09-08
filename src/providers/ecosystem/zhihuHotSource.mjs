// Official zhihu-cli 0.5.3-beta.20260904115023 HTTP contract.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const ZHIHU_HOT_ENDPOINT = 'https://developer.zhihu.com/api/v1/content/hot_list';

export function loadZhihuAccessSecret(env = process.env) {
  if (env.ZHIHU_ACCESS_SECRET?.trim()) return env.ZHIHU_ACCESS_SECRET.trim();
  try {
    const text = readFileSync(new URL('../../../secrets/secret', import.meta.url), 'utf8');
    return text.match(/^\s*Access Secret\s*[:：=]\s*(.+)\s*$/mi)?.[1]?.trim() || '';
  } catch { return ''; }
}

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function safeUrl(value, image = false) {
  try {
    const url = new URL(value);
    const allowed = image ? /(^|\.)zhimg\.com$/ : /(^|\.)zhihu\.com$/;
    return url.protocol === 'https:' && !url.username && !url.password && allowed.test(url.hostname) ? url.href : '';
  } catch { return ''; }
}

export function createRealZhihuHotSource({ accessSecret = loadZhihuAccessSecret(), fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  return Object.freeze({
    name: 'real',
    endpoint: () => ZHIHU_HOT_ENDPOINT,
    async fetchHotList({ category = 'total' } = {}) {
      // The official endpoint has no category filter. Do not invent labels.
      if (category !== 'total') throw failure('hot_category_unavailable');
      if (!accessSecret?.trim()) throw failure('hot_credentials_missing');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${ZHIHU_HOT_ENDPOINT}?Limit=30`, {
          headers: {
            Authorization: `Bearer ${accessSecret.trim()}`,
            'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
            'Content-Type': 'application/json',
          },
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) throw failure(`hot_http_${response.status}`);
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) {
            await reader.cancel();
            throw failure('hot_response_too_large');
          }
          chunks.push(value);
        }
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw failure('hot_invalid_response'); }
        if (payload.Code !== 0) throw failure('hot_upstream_rejected');
        if (!Array.isArray(payload.Data?.Items)) throw failure('hot_invalid_response');
        const seen = new Set();
        return payload.Data.Items.slice(0, 30).flatMap((item) => {
          const url = safeUrl(item.Url);
          if (!url || typeof item.Title !== 'string' || !item.Title.trim() || seen.has(url)) return [];
          seen.add(url);
          return [{
            id: createHash('sha256').update(url).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
            title: item.Title,
            url,
            thumbnail_url: safeUrl(item.ThumbnailUrl, true),
            excerpt: typeof item.Summary === 'string' ? item.Summary : '',
            // API exposes ordered rank, not a numerical heat score.
            hotness: 0,
          }];
        });
      } catch (error) {
        if (/^hot_[a-z0-9_]+$/.test(error?.code || '')) throw error;
        throw failure(controller.signal.aborted ? 'hot_timeout' : 'hot_network_error');
      } finally { clearTimeout(timer); }
    },
  });
}
