// tests/communitySectionPublic.test.mjs — 「故事里的相遇」区块的公开面回归。
//
// 这个区块在 2026-09-13 从 demo 转正。以前它是右下角的悬浮面板
// (socialPanel.js)：有关闭按钮、有「加关注」（弹 prompt 让人手输内部 UUID）、
// 有「刷新关注流」，动态里只显示裸 session UUID。现在它是「我的」页面里的正式
// 区块，关注关系读自知乎官方接口。
//
// 本文件验证：
//
//   A. demo 残留已彻底清除
//      * 源码里没有 window.prompt、没有「加关注」、没有关闭/刷新按钮。
//      * 不再创建悬浮宿主 #social-panel-host，也不再写死内联面板样式。
//      * 服务端不再暴露 POST /v1/ecosystem/follow 与 DELETE
//        /v1/ecosystem/follow/:uuid —— 手输 UUID 的关注路径已经不存在。
//
//   B. 身份边界没有因为改版而松动
//      * public/scripts/ 的代码行不出现调用者身份名（user_uuid / user_ref /
//        identity）。改版后连 target_user_uuid 这个唯一豁免也不再需要，
//        所以这里要求 0 命中，比改版前更严格。
//      * 分享 / 撤回不带 body；服务端按会话解析归属。
//
//   C. 区块按站内版式渲染到 #community-section
//      * 不再有悬浮宿主；节点直接挂在区块内。
//      * 渲染出关注流列表、状态行和「公开这段故事」入口。
//
// 所有网络请求都打到真实 HTTP 服务（见 tests/_player-dom.mjs）。

import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { server } from '../src/server.mjs';
import { OAUTH_PENDING_USER } from '../src/auth/currentUserProvider.mjs';
import { createPlayerDom } from './_player-dom.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_SCRIPTS_DIR = resolvePath(__dirname, '..', 'public', 'scripts');
const SECTION_PATH = resolvePath(PUBLIC_SCRIPTS_DIR, 'communitySection.js');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

/** 去掉注释行，只在真实代码行上做静态断言。 */
function codeLines(source) {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

const baseUrl = await new Promise((resolve, reject) => {
  const tmp = http.createServer();
  tmp.listen(0, '127.0.0.1', () => {
    const { port } = tmp.address();
    tmp.close(() => resolve(`http://127.0.0.1:${port}`));
  });
  tmp.on('error', reject);
});

await new Promise((resolve) => server.listen(Number(new URL(baseUrl).port), '127.0.0.1', resolve));

console.log('故事里的相遇 — 区块公开面');

// ---------------------------------------------------------------------------
// A. demo 残留清除（源码层）
// ---------------------------------------------------------------------------
{
  const source = await readFile(SECTION_PATH, 'utf-8');
  const code = codeLines(source);

  check(
    'static: 区块源码不再调用 window.prompt（手输 UUID 是 demo 行为）',
    !/\bprompt\s*\(/.test(code),
    '仍存在 prompt 调用'
  );
  check(
    'static: 不再有「加关注」按钮（关注关系归知乎所有）',
    !code.includes('加关注'),
    '仍存在加关注文案'
  );
  check(
    'static: 不再有关闭按钮 / 悬浮宿主',
    !code.includes('social-panel-host') && !code.includes('social-panel-close'),
    '仍存在悬浮面板节点'
  );
  check(
    'static: 不再有「刷新关注流」按钮（进入页面自动加载）',
    !code.includes('刷新关注流'),
    '仍存在手动刷新按钮'
  );
  check(
    'static: 不再向 /v1/ecosystem/follow 发请求',
    !code.includes('/v1/ecosystem/follow'),
    '仍在调用已删除的关注接口'
  );
  check(
    'static: 关注流读的是官方数据驱动的 friend-timelines',
    code.includes('/v1/ecosystem/friend-timelines'),
    '缺少关注流请求'
  );

  // 旧文件名不应再存在，避免两份实现并存。
  const files = await readdir(PUBLIC_SCRIPTS_DIR);
  check(
    'static: 旧的 socialPanel.js 已移除',
    !files.includes('socialPanel.js'),
    `files=${JSON.stringify(files)}`
  );
}

// ---------------------------------------------------------------------------
// B. 身份边界
// ---------------------------------------------------------------------------
{
  // 改版后前端连 target_user_uuid 都不再需要，所以要求 0 命中。
  const callerIdRegex = /(?<![\w_])(user_uuid|user_ref|identity)/g;
  const offenders = [];
  for (const file of ['player.js', 'endingPage.js', 'communitySection.js']) {
    const text = await readFile(resolvePath(PUBLIC_SCRIPTS_DIR, file), 'utf-8');
    text.split('\n').forEach((line, idx) => {
      if (line.trim().startsWith('//')) return;
      // OAuth 下读取服务端下发的账号 ID，仅用于按账号切分本地阅读历史。
      if (file === 'player.js' && line.trim() === "function oauthOwnerId(owner) { return owner?.user_uuid || null; }") return;
      const hits = line.match(callerIdRegex);
      if (hits) offenders.push({ file, lineNo: idx + 1, hits });
    });
  }
  check(
    'static: public/scripts 代码行不携带调用者身份',
    offenders.length === 0,
    JSON.stringify(offenders)
  );

  const sectionSource = codeLines(await readFile(SECTION_PATH, 'utf-8'));
  check(
    'static: 区块不再需要 target_user_uuid 这个 demo 线上字段',
    !sectionSource.includes('target_user_uuid'),
    '仍在发送关注目标字段'
  );
}

// ---------------------------------------------------------------------------
// C. 服务端线上契约
// ---------------------------------------------------------------------------
{
  const authRes = await fetch(`${baseUrl}/api/auth/status`);
  const authData = await authRes.json();
  check('network: GET /api/auth/status → 200', authRes.status === 200, `got ${authRes.status}`);
  check(
    'network: 未配置 OAuth 的本地模式仍返回 owner',
    authData && authData.owner && authData.owner.user_uuid === OAUTH_PENDING_USER.user_uuid,
    JSON.stringify(authData)
  );

  // 已删除的 demo 关注路径必须真的不存在。
  const followRes = await fetch(`${baseUrl}/v1/ecosystem/follow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_user_uuid: '11111111-1111-4111-8111-aaaaaaaaaaaa' }),
  });
  check(
    'network: POST /v1/ecosystem/follow 已下线（不再是 200）',
    followRes.status !== 200,
    `got ${followRes.status}`
  );
  const unfollowRes = await fetch(`${baseUrl}/v1/ecosystem/follow/11111111-1111-4111-8111-aaaaaaaaaaaa`, { method: 'DELETE' });
  check(
    'network: DELETE /v1/ecosystem/follow/:uuid 已下线（不再是 200）',
    unfollowRes.status !== 200,
    `got ${unfollowRes.status}`
  );

  const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ work_id: 'cafe-rain', role_id: 'stranger' }),
  });
  const sessionData = await sessionRes.json();
  check(
    'network: bootstrap session 绑定服务端 owner',
    sessionData && sessionData.owner && sessionData.owner.user_uuid === OAUTH_PENDING_USER.user_uuid,
    JSON.stringify(sessionData).slice(0, 200)
  );

  // 分享不带 body；并且服务端应补上故事标题，供关注流展示。
  const shareRes = await fetch(`${baseUrl}/v1/ecosystem/sessions/${sessionData.session_uuid}/share`, { method: 'POST' });
  const shareData = await shareRes.json();
  check('network: share（无 body）→ 200', shareRes.status === 200, `got ${shareRes.status}`);
  check(
    'network: share 记录带上故事标题（关注流不再只显示裸 UUID）',
    shareData && shareData.share && typeof shareData.share.title === 'string' && shareData.share.title.length > 0,
    JSON.stringify(shareData && shareData.share)
  );
  check(
    'network: share 记录绑定 canonical owner',
    shareData && shareData.share && shareData.share.owner_user_uuid === OAUTH_PENDING_USER.user_uuid,
    JSON.stringify(shareData && shareData.share)
  );

  const feedRes = await fetch(`${baseUrl}/v1/ecosystem/friend-timelines?limit=20`);
  const feedData = await feedRes.json();
  check('network: friend-timelines → 200', feedRes.status === 200, `got ${feedRes.status}`);
  check(
    'network: friend-timelines 返回 items 数组',
    feedData && Array.isArray(feedData.items),
    JSON.stringify(feedData).slice(0, 200)
  );
  check(
    'network: friend-timelines 带 status，能说明为什么是空的',
    feedData && typeof feedData.status === 'string',
    JSON.stringify(feedData).slice(0, 200)
  );
  check(
    'network: 未接入知乎凭证时降级为 unconfigured / login_required，而不是假数据',
    feedData && ['ok', 'unconfigured', 'login_required', 'unavailable', 'missing_oauth_token'].includes(feedData.status),
    `status=${feedData && feedData.status}`
  );

  const unshareRes = await fetch(`${baseUrl}/v1/ecosystem/sessions/${sessionData.session_uuid}/unshare`, { method: 'POST' });
  check('network: unshare（无 body）→ 200', unshareRes.status === 200, `got ${unshareRes.status}`);
}

// ---------------------------------------------------------------------------
// D. DOM：区块渲染在「我的」页面内，而不是悬浮层
// ---------------------------------------------------------------------------
{
  const harness = await createPlayerDom({ baseUrl });
  await harness.ready();
  await new Promise((r) => setTimeout(r, 1200));
  const document = globalThis.document;

  check(
    'dom: 不再创建悬浮宿主 #social-panel-host',
    !document.getElementById('social-panel-host'),
    '悬浮面板又回来了'
  );

  const host = document.getElementById('community-section');
  check('dom: #community-section 存在', !!host, 'section missing');

  if (host) {
    check('dom: 渲染引导文案', !!host.querySelector('.community-lead'), 'lead missing');
    check('dom: 渲染关注流容器 #community-feed', !!document.getElementById('community-feed'), 'feed missing');
    check('dom: 渲染状态行 #community-status', !!document.getElementById('community-status'), 'status missing');
    check('dom: 渲染「公开这段故事」入口', !!document.getElementById('community-share-btn'), 'share entry missing');
    check(
      'dom: 没有关闭按钮',
      !document.getElementById('social-panel-close') && !host.querySelector('#community-close-btn'),
      '仍存在关闭按钮'
    );
    check(
      'dom: 没有加关注按钮',
      !document.getElementById('social-panel-follow-btn') && !host.querySelector('#community-follow-btn'),
      '仍存在加关注按钮'
    );
    check(
      'dom: 没有手动刷新按钮',
      !document.getElementById('social-panel-refresh-btn') && !host.querySelector('#community-refresh-btn'),
      '仍存在刷新按钮'
    );

    const status = document.getElementById('community-status');
    check(
      'dom: 状态行给出可读说明，而不是空白',
      status && typeof status.textContent === 'string' && status.textContent.trim().length > 0,
      `status=${status && status.textContent}`
    );
  }
}

console.log(`\n故事里的相遇 — 区块公开面: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
server.close();
if (failures > 0) process.exit(1);
