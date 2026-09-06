// src/providers/ecosystem/realSearchAdapter.mjs — ClickUp 16.2 real
// adapter for 知乎搜索。
//
// 调用方式：
//   * 使用 `zhihu-cli search zhihu --query "<q>" --count <n>` 调知乎
//     开放平台；不引入 npm 依赖（仅使用 Node 内置 child_process）。
//   * auth_configured=false 时自动回落到 mockSearchAdapter（fixture），
//     让 demo / CI / 离线场景也能跑。
//   * 任何超时 / 非 0 退出码 / 非 JSON 输出都翻译成统一的
//     ProviderError-like 错误，search.mjs 在上一层把它转成
//     ecosystem_status='unavailable'。
//
// 安全：
//   * 进程不传 credential；zhihu-cli 自己读环境变量或 keychain。
//   * CLI 输出大小有上限（防止异常输出撑爆内存）。
//   * 不 echo 任何 stderr 文本到业务响应里；只取稳定 code。

import { spawn } from 'node:child_process';
import { PER_QUERY_COUNT } from './search.mjs';
import { createMockSearchAdapter } from './mockSearchAdapter.mjs';

/**
 * CLI 默认路径。可以通过 opts.cliPath 覆盖，便于 CI / 本地装到非默认
 * 路径的情况。
 */
const DEFAULT_CLI_PATH = '/root/.local/share/zhihu-cli/current/zhihu-cli';

/**
 * CLI 单次调用超时（毫秒）。点击 16.2 description 要求"搜索超时"时
 * 走降级，这里给 10s — 知乎搜索一般在 1-2s 内返。
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * CLI stdout 字节上限。防止 server 端被异常输出撑爆内存。
 */
const MAX_CLI_STDOUT_BYTES = 1024 * 1024; // 1 MiB

/**
 * 把 query 喂给 CLI、解析 JSON 输出、超时/异常路径抛错。**不**直接面
 * 向业务层，被 realSearchAdapter 包了一层。
 *
 * @param {object} input
 * @param {string} input.cliPath
 * @param {string} input.query
 * @param {number} input.count
 * @param {number} input.timeoutMs
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<unknown>}
 */
function runZhihuCliSearch(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(input.cliPath, [
      'search',
      'zhihu',
      '--query', input.query,
      '--count', String(input.count),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(err);
    };
    const timer = setTimeout(() => {
      const err = new Error(`zhihu-cli search timed out after ${input.timeoutMs}ms`);
      err.code = 'upstream_timeout';
      fail(err);
    }, input.timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CLI_STDOUT_BYTES) {
        const err = new Error('zhihu-cli stdout exceeded cap');
        err.code = 'upstream_body_too_large';
        fail(err);
        return;
      }
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const wrapped = new Error(`zhihu-cli spawn error: ${err.message}`);
      wrapped.code = 'upstream_unavailable';
      fail(wrapped);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        // 已经被 fail() 处理；这里只是保险。
        return;
      }
      if (code !== 0) {
        const err = new Error(`zhihu-cli exited with code ${code}`);
        err.code = code === 429 ? 'upstream_rate_limited'
          : (code >= 500 ? 'upstream_5xx' : 'upstream_non_zero_exit');
        // 不暴露 stderr 给业务层，但保留在 err.details 给运维
        err.details = { stderr: stderr.slice(0, 256) };
        reject(err);
        return;
      }
      if (!stdout) {
        const err = new Error('zhihu-cli returned empty body');
        err.code = 'upstream_empty_body';
        reject(err);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        const err = new Error('zhihu-cli did not return valid JSON');
        err.code = 'upstream_invalid_json';
        reject(err);
        return;
      }
      resolve(parsed);
    });
    if (input.signal) {
      if (input.signal.aborted) {
        const err = new Error('search aborted by signal');
        err.code = 'search_aborted';
        fail(err);
        return;
      }
      input.signal.addEventListener('abort', () => {
        const err = new Error('search aborted by signal');
        err.code = 'search_aborted';
        fail(err);
      }, { once: true });
    }
  });
}

/**
 * 把 zhihu-cli 的原始返回（list[].work_id/title/excerpt/...）翻译成
 * ZhihuDiscussionResult DTO。CLI 真实 schema 取决于服务端；这里做宽
 * 容归一：缺字段用合理默认值，title/url 必填校验。
 *
 * @param {unknown} raw
 * @param {object} ctx
 * @param {string} ctx.story_version_uuid
 * @param {string} ctx.community_profile_version
 * @param {{ id: string, query: string }} ctx.query
 * @returns {import('./search.mjs').ZhihuDiscussionResult[]}
 */
function translateZhihuCliOutput(raw, ctx) {
  if (!raw) return [];
  /** @type {unknown[]} */
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    const obj = /** @type {any} */ (raw);
    if (Array.isArray(obj.data)) list = obj.data;
    else if (Array.isArray(obj.results)) list = obj.results;
    else if (Array.isArray(obj.items)) list = obj.items;
  }
  /** @type {import('./search.mjs').ZhihuDiscussionResult[]} */
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const it = /** @type {any} */ (item);
    const title = typeof it.title === 'string' && it.title
      ? it.title
      : (typeof it.question === 'string' ? it.question : '');
    if (!title) continue;
    const url = typeof it.url === 'string' && it.url
      ? it.url
      : (typeof it.link === 'string' && it.link ? it.link
        : (typeof it.object_url === 'string' ? it.object_url : ''));
    if (!url || !/^https?:\/\//i.test(url)) {
      // 没有 url 的项跳过；业务层必须有跳转入口
      continue;
    }
    const kind = it.type === 'answer' || it.kind === 'answer'
      ? 'answer'
      : it.type === 'article' || it.kind === 'article'
        ? 'article'
        : 'question';
    const authority = typeof it.authority_level === 'string'
      ? it.authority_level
      : (typeof it.authority === 'string' ? it.authority : 'medium');
    out.push({
      result_uuid: '',
      story_version_uuid: ctx.story_version_uuid,
      community_profile_version: ctx.community_profile_version,
      query_id: ctx.query.id,
      query_text: ctx.query.query,
      kind,
      title,
      excerpt: typeof it.excerpt === 'string' ? it.excerpt : (typeof it.summary === 'string' ? it.summary : ''),
      author_name: typeof it.author_name === 'string' ? it.author_name : (typeof it.author === 'object' && it.author && typeof it.author.name === 'string' ? it.author.name : ''),
      author_avatar: typeof it.author_avatar === 'string' ? it.author_avatar : '',
      url,
      relevance_score: Number.isFinite(it.relevance_score) ? Number(it.relevance_score) : (Number.isFinite(it.score) ? Number(it.score) : 0),
      authority_level: ['low', 'medium', 'high', 'top'].includes(authority) ? authority : 'medium',
      like_count: Number.isInteger(it.like_count) && it.like_count >= 0 ? it.like_count : 0,
      comment_count: Number.isInteger(it.comment_count) && it.comment_count >= 0 ? it.comment_count : 0,
      top_comment: typeof it.top_comment === 'string' ? it.top_comment : '',
      published_at: typeof it.published_at === 'string' && it.published_at
        ? it.published_at
        : (typeof it.created_time === 'number' ? new Date(it.created_time * 1000).toISOString() : new Date(0).toISOString()),
      attribution: 'zhihu',
      source: /** @type {Record<string, unknown>} */ ({ raw_cli_entry: it }),
    });
  }
  return out;
}

/**
 * 构造 real adapter。`isAuthConfigured()` 是一个 () => boolean；调用
 * 方（server 层）根据 `auth status` 的 CLI 输出 / 配置注入。
 *
 * @param {object} [opts]
 * @param {string} [opts.cliPath]
 * @param {number} [opts.timeoutMs]
 * @param {() => boolean} [opts.isAuthConfigured]
 * @param {(story_version_uuid: string) => string} [opts.slugResolver]
 * @returns {import('./search.mjs').EcosystemSearchAdapter}
 */
export function createRealSearchAdapter(opts = {}) {
  const cliPath = opts.cliPath || DEFAULT_CLI_PATH;
  const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const isAuthConfigured = typeof opts.isAuthConfigured === 'function'
    ? opts.isAuthConfigured
    : () => false; // 默认未配置 → 自动回落 mock
  // 回落 adapter：用一个独立 mock adapter 实例（共享 fixture）。
  const fallbackMock = createMockSearchAdapter({
    slugResolver: opts.slugResolver,
  });
  return Object.freeze({
    name: 'real',
    async searchZhihuDiscussions({ story_version_uuid, queries, limit, signal }) {
      // auth 未配置 → 回落 mock（demo / CI 友好；不依赖 Access Secret）
      if (!isAuthConfigured()) {
        // 标注 provider 以便运维层看见当前正在 fallback
        const out = await fallbackMock.searchZhihuDiscussions({
          story_version_uuid,
          queries,
          limit,
          signal,
        });
        return out;
      }
      // 真实路径：每个 query 调一次 CLI，合并结果。query 数受 ClickUp
      // 16.2 description 限定（"对一篇故事发起少量主题查询"），上限
      // 5 已足够。
      const queryLimit = Math.min(queries.length, 5);
      /** @type {import('./search.mjs').ZhihuDiscussionResult[]} */
      const all = [];
      for (let i = 0; i < queryLimit; i += 1) {
        const q = queries[i];
        if (!q || typeof q.query !== 'string' || !q.query) continue;
        try {
          const cliOutput = await runZhihuCliSearch({
            cliPath,
            query: q.query,
            count: PER_QUERY_COUNT,
            timeoutMs,
            signal,
          });
          const translated = translateZhihuCliOutput(cliOutput, {
            story_version_uuid,
            community_profile_version: '', // 由 search.mjs 在 stamp 时补
            query: { id: q.id, query: q.query },
          });
          for (const t of translated) all.push(t);
        } catch (err) {
          // 单条 query 失败不致命：抛给 search.mjs 由它统一降级。
          throw err;
        }
      }
      // 按 limit 截断
      return all.slice(0, limit || PER_QUERY_COUNT);
    },
  });
}