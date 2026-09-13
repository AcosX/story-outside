// src/ecosystem/following/directory.mjs — 知乎账号 ↔ 本站账号的映射目录。
//
// 「故事里的相遇」的真实语义是：**我在知乎关注的人，如果也在这里玩过并主动
// 公开了世界线，就让我看到**。要成立需要两端能对上：
//
//   左端：知乎官方 `/api/v1/user/followees` 只给 `UrlToken`，不给 uid。
//   右端：本站账号的主键是由 `app_id + uid` 派生的稳定业务 UUID。
//
// 因此每次 OAuth 登录成功后，把「该账号的 url_token → 业务 UUID」登记进这个
// 目录；查关注流时用关注列表里的 UrlToken 反查，就能得到本站账号。
//
// 边界：
//   * 目录只存公开主页标识和业务 UUID，不存昵称、头像、手机号、邮箱或 token。
//   * 只有本人登录才能登记自己的映射；没有任何接口能代别人写入。
//   * 反查不到就是不到——返回 null，让上层显示空态，绝不猜测或回退到示例数据。
//   * 与会话一样是进程内状态；多进程部署前需要换成共享存储（见 docs/zhihu-oauth.md）。

const URL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createZhihuAccountDirectory({ maxEntries = 50000 } = {}) {
  /** @type {Map<string, string>} url_token → user_uuid */
  const byUrlToken = new Map();

  return {
    /**
     * 登记「当前登录者」的知乎主页标识。重复登录是幂等的；同一 url_token 改绑
     * 到新的业务 UUID 时以最新一次为准（知乎允许改 url_token，旧值自然失效）。
     */
    remember(owner) {
      const urlToken = owner && typeof owner.url_token === 'string' ? owner.url_token : '';
      const userUuid = owner && typeof owner.user_uuid === 'string' ? owner.user_uuid : '';
      if (!URL_TOKEN_PATTERN.test(urlToken) || !UUID_PATTERN.test(userUuid)) return false;
      if (!byUrlToken.has(urlToken) && byUrlToken.size >= maxEntries) return false;
      byUrlToken.set(urlToken, userUuid);
      return true;
    },
    /** 反查本站业务 UUID；未登记过返回 null。 */
    resolve(urlToken) {
      if (typeof urlToken !== 'string' || !URL_TOKEN_PATTERN.test(urlToken)) return null;
      return byUrlToken.get(urlToken) || null;
    },
    size() { return byUrlToken.size; },
    _exportSnapshot() {
      return [...byUrlToken.entries()].map(([url_token, user_uuid]) => ({ url_token, user_uuid }));
    },
    _hydrateSnapshot(rows) {
      byUrlToken.clear();
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row) continue;
        if (!URL_TOKEN_PATTERN.test(row.url_token || '') || !UUID_PATTERN.test(row.user_uuid || '')) continue;
        byUrlToken.set(row.url_token, row.user_uuid);
      }
    },
    _resetForTests() { byUrlToken.clear(); },
  };
}
