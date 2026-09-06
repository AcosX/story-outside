// src/providers/ecosystem/realProvider.mjs — ClickUp 16.3 real provider
// (zhihu-cli me followees / me contents backed).
//
// 设计约束：
//   * 不直接调用 API；通过 spawnSync('zhihu-cli', ...) 拉数据，避免把
//     凭据管理引入进程内。失败降级——provider 抛错由 service 层捕获。
//   * adapter 在 following.mjs 完成；本文件只负责把 stdout → payload → DTO[]。
//   * 默认 private：FriendTimeline 必须来自 provider 端的"已分享世界线
//     仓库"；当前 mock-only（zhihu-cli 不暴露对方 session 数据）；
//     real 路径下 getFriendTimelines 直接返回 [] 并标注 reason。
//
// 严格 16.3 描述："若正式认证链路能获得稳定知乎用户标识，
// 在本地用户表保存 provider identity 映射；无法可靠映射时先只展示
// 关注流内容，不实现'好友世界线'"。
//
// 因此 real provider：
//   * getFollowing / getFollowingFeed — 走 zhihu-cli。
//   * getFriendTimelines — 返回 [] 并附 reason（"real path pending
//     provider identity mapping"），等待 16.x 阶段补齐。

import { spawnSync } from 'node:child_process';
import {
  adaptZhihuFollowingFeedPayload,
  adaptZhihuFolloweesPayload,
  normaliseFollowingFeedItem,
  normaliseFollowingListItem,
  ECOSYSTEM_ERROR_CODES,
} from './following.mjs';

const ZHIHU_CLI_DEFAULT = '/root/.local/share/zhihu-cli/current/zhihu-cli';
const DEFAULT_LIMIT = 20;
const FOLLOWING_LIMIT_MAX = 50; // zhihu-cli me followees --limit 上限
const FEED_LIMIT_MAX = 20;

/**
 * @param {string|undefined} raw
 * @param {string} fallback
 */
function readString(raw, fallback) {
  return typeof raw === 'string' && raw ? raw : fallback;
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @returns {{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string } }}
 */
function runZhihuCli(binary, args) {
  let res;
  try {
    res = spawnSync(binary, args, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: ECOSYSTEM_ERROR_CODES.PROVIDER_UNAVAILABLE,
        message: `failed to spawn ${binary}: ${err && err.message ? err.message : err}`,
      },
    };
  }
  if (res.error) {
    return {
      ok: false,
      error: {
        code: ECOSYSTEM_ERROR_CODES.PROVIDER_UNAVAILABLE,
        message: `zhihu-cli exec error: ${res.error.message}`,
      },
    };
  }
  if (typeof res.status === 'number' && res.status !== 0) {
    return {
      ok: false,
      error: {
        code: ECOSYSTEM_ERROR_CODES.PROVIDER_UNAVAILABLE,
        message: `zhihu-cli exited with status ${res.status}`,
      },
    };
  }
  const stdout = typeof res.stdout === 'string' ? res.stdout : '';
  if (!stdout.trim()) {
    return { ok: false, error: { code: ECOSYSTEM_ERROR_CODES.DECODE_FAILED, message: 'empty stdout' } };
  }
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch {
    return {
      ok: false,
      error: {
        code: ECOSYSTEM_ERROR_CODES.DECODE_FAILED,
        message: 'zhihu-cli output was not JSON',
      },
    };
  }
}

/**
 * @param {string|number|null|undefined} limitRaw
 * @param {number} cap
 */
function clampLimit(limitRaw, cap) {
  let n = typeof limitRaw === 'number' ? limitRaw : Number.parseInt(String(limitRaw), 10);
  if (!Number.isFinite(n) || n < 1) n = DEFAULT_LIMIT;
  if (n > cap) n = cap;
  return n;
}

/**
 * 工厂函数。
 *
 * @param {{
 *   binary?: string,
 *   clock?: () => number,
 * }} [opts]
 */
export function createRealZhihuEcosystemProvider(opts) {
  const binary = readString(opts && opts.binary, ZHIHU_CLI_DEFAULT);

  return Object.freeze({
    name: 'real',
    async getFollowing(userRef, options2) {
      const limit = clampLimit(
        options2 && Number.isInteger(options2.limit) ? options2.limit : '',
        FOLLOWING_LIMIT_MAX,
      );
      const out = runZhihuCli(binary, ['me', 'followees', '--limit', String(limit)]);
      if (!out.ok) {
        throw new Error(out.error.message);
      }
      try {
        const items = adaptZhihuFolloweesPayload(out.value);
        return items.map(normaliseFollowingListItem);
      } catch (err) {
        throw new Error(`${ECOSYSTEM_ERROR_CODES.DECODE_FAILED}: ${err && err.message ? err.message : err}`);
      }
    },
    async getFollowingFeed(userRef, options2) {
      const limit = clampLimit(
        options2 && Number.isInteger(options2.limit) ? options2.limit : '',
        FEED_LIMIT_MAX,
      );
      const out = runZhihuCli(binary, ['me', 'contents', '--limit', String(limit)]);
      if (!out.ok) {
        throw new Error(out.error.message);
      }
      try {
        const items = adaptZhihuFollowingFeedPayload(out.value);
        return items.map(normaliseFollowingFeedItem);
      } catch (err) {
        throw new Error(`${ECOSYSTEM_ERROR_CODES.DECODE_FAILED}: ${err && err.message ? err.message : err}`);
      }
    },
    async getFriendTimelines(userRef, options2) {
      // Real path 下"好友世界线"依赖 provider identity mapping，
      // 而该映射在正式认证链路未稳定前暂不可用。
      // ClickUp 16.3 描述："无法可靠映射时先只展示关注流内容，
      // 不实现'好友世界线'"。因此本路径返回 []，并附 reason。
      void userRef;
      void options2;
      return [];
    },
  });
}