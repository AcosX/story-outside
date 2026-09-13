// tests/communitySectionFreshFlow.test.mjs — 全新标签页 → 选故事 → 选角色 →
// 进入故事 → 「故事里的相遇」区块出现「公开这段故事」入口的回归。
//
// 这条链路在改版前后都必须成立的核心不变量：**区块永远不自己创建会话**。
// 历史上曾出现过区块自带「创建 session」按钮、用写死的 work_id/role_id 造一个
// demo 会话并把它当成分享目标的问题。会话的唯一来源是玩家在书架里真实选出的
// 故事 + 角色（player.bootstrapSession）。
//
// 验证内容：
//
//   1. 静态：区块源码不出现写死的故事/角色标识，不调 /api/sessions，
//      不导出任何 createSession 形状的函数。
//   2. 空白开局：没有历史会话时，「公开这段故事」按钮隐藏，文案提示先去选故事。
//   3. 真实开局：点书 → 点角色 → 进入故事，服务端分配真实 session UUID，
//      player 派发 session:changed，区块据此显示公开入口。
//   4. 线上：对该真实 UUID 的 share / unshare 均返回 200。

import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { server } from '../src/server.mjs';
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

const baseUrl = await new Promise((resolve, reject) => {
  const tmp = http.createServer();
  tmp.listen(0, '127.0.0.1', () => {
    const { port } = tmp.address();
    tmp.close(() => resolve(`http://127.0.0.1:${port}`));
  });
  tmp.on('error', reject);
});

await new Promise((resolve) => server.listen(Number(new URL(baseUrl).port), '127.0.0.1', resolve));

console.log('故事里的相遇 — 新标签页开局');

// ---------------------------------------------------------------------------
// 1. 静态：区块不自造会话
// ---------------------------------------------------------------------------
{
  const source = await readFile(SECTION_PATH, 'utf-8');

  check(
    'static: 区块源码没有写死的故事标识 cafe-rain',
    (source.match(/cafe-rain/g) || []).length === 0,
    `count=${(source.match(/cafe-rain/g) || []).length}`
  );
  check(
    'static: 区块源码没有写死的角色标识 stranger',
    (source.match(/stranger/g) || []).length === 0,
    `count=${(source.match(/stranger/g) || []).length}`
  );
  check(
    'static: 区块不调用 /api/sessions',
    (source.match(/POST[^\n]*sessions|\/api\/sessions/g) || []).length === 0,
    `hits=${JSON.stringify(source.match(/POST[^\n]*sessions|\/api\/sessions/g) || [])}`
  );
  check(
    'static: 区块没有 createSession 形状的函数',
    (source.match(/onCreateSessionClick|createSession/g) || []).length === 0,
    `count=${(source.match(/onCreateSessionClick|createSession/g) || []).length}`
  );

  const exports = Object.keys(await import(SECTION_PATH));
  check(
    'static: 模块不导出 handleCreateSession',
    !exports.includes('handleCreateSession'),
    `exports=${JSON.stringify(exports)}`
  );
  check(
    'static: 模块不导出 maybeOfferCreateSessionButton',
    !exports.includes('maybeOfferCreateSessionButton'),
    `exports=${JSON.stringify(exports)}`
  );

  // 其他前端文件也不许把写死的故事/角色标识加回来。
  const files = (await readdir(PUBLIC_SCRIPTS_DIR)).filter((n) => n.endsWith('.js'));
  const offenders = [];
  for (const name of files) {
    const text = await readFile(resolvePath(PUBLIC_SCRIPTS_DIR, name), 'utf-8');
    text.split('\n').forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (/cafe-rain/.test(line) || /stranger/.test(line)) {
        offenders.push({ file: name, lineNo: idx + 1, line: trimmed });
      }
    });
  }
  check(
    'static: public/scripts 代码行没有写死的故事/角色标识',
    offenders.length === 0,
    JSON.stringify(offenders)
  );
}

// ---------------------------------------------------------------------------
// 2-4. 真实开局
// ---------------------------------------------------------------------------
{
  const harness = await createPlayerDom({ baseUrl });
  // 先清掉历史会话，模拟全新标签页。
  if (typeof globalThis.__HARNESS_RESET_SESSION_CONTEXT__ === 'function') {
    globalThis.__HARNESS_RESET_SESSION_CONTEXT__();
  }
  await harness.ready();
  await new Promise((r) => setTimeout(r, 1500));

  const document = globalThis.document;
  const host = document.getElementById('community-section');
  check('dom: #community-section 已渲染', !!host, 'section missing');

  const shareBtn = document.getElementById('community-share-btn');
  const unshareBtn = document.getElementById('community-unshare-btn');
  const shareText = document.getElementById('community-share-text');

  check('dom: 「公开这段故事」按钮存在', !!shareBtn, 'share button missing');
  check('dom: 「撤回」按钮存在', !!unshareBtn, 'unshare button missing');
  check('dom: 公开说明文案存在', !!shareText, 'share text missing');
  check(
    'dom: 没有「创建 session」按钮（区块从不自造会话）',
    !document.getElementById('community-create-session-btn') && !document.getElementById('social-panel-create-session-btn'),
    'create-session button leaked back in'
  );

  check(
    'fresh: 还没有会话时，公开入口隐藏',
    shareBtn && shareBtn.hidden === true,
    `shareBtn.hidden=${shareBtn && shareBtn.hidden}`
  );
  check(
    'fresh: 还没有会话时，文案提示先去选故事',
    shareText && typeof shareText.textContent === 'string' && shareText.textContent.length > 0,
    `text=${shareText && shareText.textContent}`
  );

  // 走真实书架：读服务端渲染出来的第一本书和第一个角色，不写死夹具名。
  const storyChips = document.querySelectorAll('#story-list .book-card');
  check('fresh: 书架至少渲染出一本书', storyChips.length > 0, `count=${storyChips.length}`);
  const storyChip = storyChips[0];
  if (storyChip) storyChip.dispatch('click');
  await new Promise((r) => setTimeout(r, 400));

  const roleChips = document.querySelectorAll('#role-list .chip');
  check('fresh: 选书后渲染出角色', roleChips.length > 0, `count=${roleChips.length}`);
  const roleChip = roleChips[0];
  if (roleChip) roleChip.dispatch('click');
  document.querySelector('#start-story-btn')?.dispatch('click');

  await new Promise((r) => setTimeout(r, 1500));

  const playerState = globalThis.__PLAYER_STATE__ || null;
  const realUuid = playerState && playerState.sessionUuid;
  check(
    'fresh: 玩家状态里有服务端分配的 sessionUuid',
    typeof realUuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(realUuid),
    `sessionUuid=${realUuid}`
  );
  check(
    'fresh: 这是真实分配的 UUID，不是写死的 demo 值',
    realUuid && realUuid !== '00000000-0000-4000-8000-000000000099',
    `uuid=${realUuid}`
  );

  const stored = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('story-outside:last-session') : null;
  let storedUuid = null;
  if (stored) {
    try { storedUuid = JSON.parse(stored).sessionUuid || null; } catch { /* ignore */ }
  }
  check(
    'fresh: last-session 存的是同一个 UUID',
    typeof storedUuid === 'string' && storedUuid === realUuid,
    `stored=${stored}`
  );

  check(
    'fresh: 有了真实会话后，公开入口出现',
    shareBtn && shareBtn.hidden === false,
    `shareBtn.hidden=${shareBtn && shareBtn.hidden}`
  );

  // 通过区块自身的按钮走一遍，确认它指向真实会话。
  if (realUuid && shareBtn) {
    shareBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 400));
    check(
      'fresh: 点击公开后，切换为「撤回」入口',
      unshareBtn && unshareBtn.hidden === false,
      `unshareBtn.hidden=${unshareBtn && unshareBtn.hidden}`
    );
    unshareBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 400));
  }

  if (realUuid) {
    const shareRes = await fetch(`${baseUrl}/v1/ecosystem/sessions/${realUuid}/share`, { method: 'POST' });
    check('wire: POST /v1/ecosystem/sessions/<uuid>/share → 200', shareRes.status === 200, `got ${shareRes.status}`);
    const unshareRes = await fetch(`${baseUrl}/v1/ecosystem/sessions/${realUuid}/unshare`, { method: 'POST' });
    check('wire: POST /v1/ecosystem/sessions/<uuid>/unshare → 200', unshareRes.status === 200, `got ${unshareRes.status}`);
  }
}

console.log(`\n故事里的相遇 — 新标签页开局: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
server.close();
if (failures > 0) process.exit(1);
