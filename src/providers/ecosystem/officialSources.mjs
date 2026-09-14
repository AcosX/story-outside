// Contracts: Zhihu Skill 0.5.3, http-api.md and hackathon-content-api.md.
import { readFileSync } from 'node:fs';
import { EcosystemUpstreamError } from './zhihuSearchSource.mjs';

export function readAccessSecret(env = process.env) {
  if (env.ZHIHU_ACCESS_SECRET) return env.ZHIHU_ACCESS_SECRET;
  try {
    const text = readFileSync(env.STORY_OUTSIDE_AI_SECRET_FILE || new URL('../../../secrets/secret', import.meta.url), 'utf8');
    return text.split(/\r?\n/).find(line => line.startsWith('Access Secret:'))?.slice('Access Secret:'.length).trim() || '';
  } catch { return ''; }
}

async function getJson(url, fetchImpl, headers = {}) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { accept: 'application/json', ...headers } });
  if (!response.ok) throw new EcosystemUpstreamError('upstream_error', `Zhihu HTTP ${response.status}`);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000) throw new EcosystemUpstreamError('upstream_too_large', 'Zhihu response exceeds limit');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new EcosystemUpstreamError('invalid_response', 'Invalid Zhihu response'); }
}

export function createOfficialSearchSource({ secret = readAccessSecret(), fetchImpl = fetch } = {}) {
  return {
    name: 'official-zhihu-search-v1',
    async search({ query, limit = 8 }) {
      if (!secret) throw new EcosystemUpstreamError('missing_credentials', 'Zhihu search unavailable');
      const url = new URL('https://developer.zhihu.com/api/v1/content/zhihu_search');
      url.searchParams.set('Query', query);
      url.searchParams.set('Count', String(Math.min(10, Math.max(1, limit))));
      const data = await getJson(url, fetchImpl, {
        authorization: `Bearer ${secret}`, 'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)), 'content-type': 'application/json',
      });
      if (data.Code !== 0 || !Array.isArray(data.Data?.Items)) throw new EcosystemUpstreamError('upstream_error', 'Zhihu search failed');
      const discussions = data.Data.Items.filter(item => {
        try { const u = new URL(item.Url); return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'zhihu.com' || u.hostname.endsWith('.zhihu.com')); } catch { return false; }
      }).map(item => ({ id: String(item.ContentID), title: item.Title, url: item.Url,
        excerpt: item.ContentText || '', score: Number(item.RankingScore) || 0, source: 'zhihu', fetched_at: new Date().toISOString() }));
      return { discussions, source: 'real' };
    },
  };
}

// The catalogue is a public work asset, shared across queries and players.
export function createOfficialKnowledgeSource({ fetchImpl = fetch, now = Date.now, searchSource = createOfficialSearchSource({ fetchImpl }) } = {}) {
  let catalogue = null, expires = 0, inflight = null;
  async function list() {
    if (catalogue && now() < expires) return catalogue;
    if (!inflight) inflight = getJson('https://api.zhihu.com/km-indep-home/hackathon/v2/knowledge/list', fetchImpl)
      .then(rows => { if (!Array.isArray(rows)) throw new Error('Invalid knowledge catalogue'); catalogue = rows; expires = now() + 300000; return rows; })
      .finally(() => { inflight = null; });
    return inflight;
  }
  return {
    isConfigured: () => true,
    name: 'official-zhihu-knowledge-v1',
    async fetchKnowledge({ query, limit = 4 }) {
      const rows = await list();
      const tokens = [...new Set(query.match(/[\p{Script=Han}]{2}|[a-zA-Z]{3,}/gu) || [])];
      const ranked = rows.map(row => ({ row, score: tokens.reduce((n, token) => n + ((row.title + row.description).includes(token) ? 1 : 0), 0) }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
      if (ranked.length) return ranked.map(({ row }) => ({ id: String(row.work_id), title: row.title, summary: row.description || '', source: '知乎黑客松知识',
        url: `/api/knowledge/${encodeURIComponent(row.work_id)}`, related_topics: row.labels || [], disclaimer: '现实知识延伸，不是原作设定。' }));
      // The ten-work hackathon catalogue does not cover every story topic.
      // Use real public Zhihu results, never unrelated/fabricated catalogue entries.
      const { discussions: results } = await searchSource.search({ query, limit });
      return results.map(item => ({ ...item, summary: item.excerpt, related_topics: [], disclaimer: '现实知识延伸，不是原作设定。' }));
    },
    async detail(id) {
      const rows = await list();
      if (!rows.some(row => String(row.work_id) === id)) return null;
      return getJson(`https://api.zhihu.com/km-indep-home/hackathon/v2/knowledge/${encodeURIComponent(id)}`, fetchImpl);
    },
  };
}
