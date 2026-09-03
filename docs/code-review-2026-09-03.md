# 《故事之外》代码审核报告

- 审核日期：2026-09-03
- 审核范围：`src/`、`public/`、`db/`、`tests/`、`package.json`
- 审核方式：静态阅读 + 关键路径复现（Node 22 / 原生 HTTP）
- 基线结果：
  - `npm run check` → 通过（58 files，语法检查全绿）
  - `npm test` → 通过（全部测试套件，包括 provider / session / agent / ending / observability / integration 等）

总体评价：项目结构清晰，职责划分合理（provider / stories / agent / observability 分层干净），对契约、幂等性、敏感字段、缓存 key 边界做了很多主动防护，测试覆盖也比较完整。但代码里仍然存在几个会导致**进程崩溃**、**客户端连接被重置**以及**上线后内存/鉴权风险**的问题，建议在进入部署前修复。

> 修复状态（2026-09-04）：本报告中列出的 1–13 项已全部修复，并新增回归测试 `tests/codeReviewFixes.test.mjs` 锁定核心行为；`npm run check` 与 `npm test` 均通过。修复说明见下方各项。

---

## 一、高优先级（建议尽快修复）

### 1. 非法 URL 编码会让整个服务进程崩溃

- 位置：`src/server.mjs:227`
- 代码：

```js
async function serveStatic(req, res, urlPath) {
  let safePath = normalize(decodeURIComponent(urlPath.split('?')[0]));
  ...
}
```

- 问题：`decodeURIComponent(urlPath)` 放在 `try/catch` 之外。请求 `GET /%zz` 会产生 `URIError: URI malformed`。由于 `server` 回调是 `async` 函数，且此处 `return serveStatic(...)` 没有 `await`，这个 rejected Promise 没有对应处理，最终变成未捕获异常，**直接终止 Node 进程**。
- 复现结果：`GET /%zz` → `URIError: URI malformed`，进程崩溃。
- 影响：任何人向静态资源路径发一个畸形字符序列即可打挂整个服务，属于低成本的 DoS。
- 建议：
  - 对 `decodeURIComponent` 做 `try/catch`，失败时返回 `400 Bad Request`；
  - 给整个请求入口补充统一的 `Promise` capture / `server.on('error')`，避免任何里层 async 函数的 rejected Promise 逃逸导致进程崩溃。

### 2. 请求体超过 64KB 时客户端收到的是连接重置，而不是 JSON 错误

- 位置：`src/server.mjs:262`
- 代码：

```js
if (total > 64 * 1024) {
  reject(new ValidationError('payload_too_large'));
  req.destroy();
  return;
}
```

- 问题：`req.destroy()` 会在尝试写响应之前把底层 socket 关掉。外层 `try/catch` 虽然会把 `ValidationError('payload_too_large')` 映射成响应，但 socket 已断，客户端实际收到的是 `ECONNRESET`。
- 复现结果：POST `/api/chat` 发送约 70KB 的 JSON → 客户端 `error ECONNRESET`，没有收到 400/413 响应。
- 影响：客户端无法区分“超限”和“网络故障”，日志里也会出现大量连接中断。
- 建议：
  - 不要 `req.destroy()`；
  - 改用 `res.writeHead(413, ...)` + `res.end(...)`，并在回包后 `req.resume()`（或 `req.unpipe()`）把剩余请求体消费掉；
  - 如果担心大 body 继续读取浪费带宽，可以在回包后调用 `req.destroy()`，但要确保先完成响应。

---

## 二、中优先级

### 3. `ensureOpeningCache` 没有 `await` 自定义 generator，异步生成器会拿到一个 Promise

- 位置：`src/stories/storyService.mjs:226`
- 代码：

```js
try {
  payload = generator({ story, profile });
} catch (err) { ... }
```

- 问题：`ensureOpeningCache` 本身是 `async` 函数，文档里也把它当作“未来 LLM / generator override”的接缝，但这里没有 `await generator(...)`。如果调用方传入一个 `async` generator（返回 Promise），`payload.hash.content_hash` 会变成对 Promise 取属性，直接抛 `TypeError: Cannot read properties of undefined`。
- 复现结果：传入 async 自定义 generator 后，`ensureOpeningCache` 抛出 `TypeError`（不是预期的 `generation_failed`）。
- 影响：未来接真实 LLM/异步生成逻辑时必须额外改这里，且错误路径会从“生成失败”退化成裸 TypeError。
- 建议：

```js
payload = await generator({ story, profile });
```

并且把 `await` 放进现有 `try/catch` 内，让异步生成失败也能被记录成 `failed` 缓存并抛出可辨识的错误。

### 4. 无鉴权 admin/dev 路由 + 多个进程内 Map 无界增长

- 位置：`src/server.mjs:156, 303`、`src/stories/sessionService.mjs:228`
- 说明：
  - `/api/admin/*`、`/api/dev/*` 全部没有鉴权、没有限流，虽然在 README 中明确标注“demo-only / 严禁公网”，但当前代码没有运行期防护，一旦忘记前置 proxy 就会暴露。
  - `demoTurnCounter`、`sessionPinnedMetadata`、`sessionService.clientRequestIndex` 都是进程级 Map，且 `clientRequestIndex` 注释明确说“永不 evict”。在没有限流的情况下，攻击者可以用任意 `session_uuid` / `client_request_id` 让内存无限增长。
- 影响：公网部署时存在立即被刷爆内存/被滥用接口的窗口期。
- 建议：
  - 上线前强制前置网关鉴权（或至少增加一个 `ENABLE_DEV_ROUTES` 开关并在生产默认关闭）；
  - 给 `clientRequestIndex`、`sessionPinnedMetadata`、`demoTurnCounter` 增加容量上限（如 1000 / 5000）或改用严格保留窗口；
  - `clientRequestIndex` 如果目标是镜像 SQL 全局唯一约束，那么它不应只存在于内存；要么按容量丢弃（明确声明仅为短窗口），要么将来由 DAO 写入真实 DB。

### 5. 缓存生成失败后，`failed` 行不会按文档描述被“覆盖复用”

- 位置：`src/stories/repository.mjs:397`
- 说明：
  - `upsertOpeningCache` 只在**新建**的 `valid` 行上写入 `openingCachesByScope`；
  - `findOpeningCacheByScope` 永远找不到 `failed` / `invalidated` 行；
  - 因此第一次生成失败后的第二次重试，实际上是在 scope 索引中“找不到旧失败行”，随后新建一个 `valid` 行，失败行被永久留在内存里成为孤儿。
  - 代码注释与 `storyService` 文档声称“retry 会复用相同 generation_hash 并覆盖 failed 行”，与真实行为不一致。
- 影响：失败缓存不可见、不可复用，长期跑会累积孤儿缓存行；对当前 demo 影响较小，但对未来 MariaDB DAO / 运维排查是个坑。
- 建议：
  - 让 `upsertOpeningCache` 在把一个已有行从 `failed` / `invalidated` 更新为 `valid` 时，同步补写 `openingCachesByScope`；
  - 或提供显式的“按 cache_uuid 更新”路径，避免依赖 scope 索引来“找到”原本就不可通过 scope 查到的行。

---

## 三、低优先级 / 改进建议

### 6. 静态文件路径边界判断不够严谨

- 位置：`src/server.mjs:230`
- 问题：`absolutePath.startsWith(PUBLIC_DIR)` 没有带分隔符，理论上如果存在一个名为 `public-xxx` 的兄弟目录，路径判断会误判为“仍在 PUBLIC_DIR 内”。另外 `stat()` 会跟随 symlink，若 `public/` 内出现指向外部的符号链接，也可能泄漏文件。
- 建议：

```js
const relative = path.relative(PUBLIC_DIR, absolutePath);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
  return 403;
}
```

并在 `stat`/`readFile` 前基于 `realpath` 再校验一次。

### 7. 静态路由对所有 HTTP 方法都生效

- 位置：`src/server.mjs:1212` 附近的兜底 `return serveStatic(req, res, pathname);`
- 问题：`POST /index.html`、`HEAD /index.html` 等也会被当作静态文件返回 200，缺少 405 / HEAD 语义。
- 建议：在兜底分支里按方法分开：`GET`/`HEAD` 走静态文件，其他方法在可识别的 API 之外返回 `405 Method Not Allowed`。

### 8. `STORY_OUTSIDE_PROVIDER=real` 不会在启动时报错

- 位置：`src/providers/index.mjs` 的 `getStoryProvider()`
- 问题：README 声称“real 会启动报错”，但当前 provider 是惰性初始化，`getStoryProvider()` 只在每次请求时调用；配置 `real` 后服务能正常监听，直到第一个 API 请求才返回 500。
- 建议：在 `server.listen` 前主动调用一次 `getStoryProvider()`，或者在 `/api/health` 中声明当前 provider 状态。

### 9. `stageNarrativeBatch` 允许 tool-only 批，与 ClickUp 08 契约不一致

- 位置：`src/stories/sessionService.mjs:555-563`
- 问题：服务层校验只要求“至少一个 narrative item **或** 一个 tool_call”，因此 `items=[]` + 合法 `tool_call` 可以入库为 pending；而 `agent/runtime.mjs` 的 `normalizeProviderResult` 明确禁止 tool-only 批。任何绕过 runtime 直接调用服务层的未来调用方都会得到一个无法提交到 canonical history 的 pending。
- 建议：在服务层严格改为“`items.length >= 1`（最多 4）+ 可选 tool_call”，并把 tool-only 批拒绝掉，保持与 runtime/08 契约一致。

### 10. `stageNarrativeBatch` 对非字符串 `source` 的幂等指纹不一致

- 位置：`src/stories/sessionService.mjs:596, 658`
- 问题：幂等指纹用 `source || NARRATIVE_SOURCE`，但实际存储用 `typeof source === 'string' && source ? source : NARRATIVE_SOURCE`。若调用方传一个 truthy 的非字符串 `source`，同一 `client_request_id` 重放时会因为指纹不同而被当作“不同请求”拒绝。
- 建议：在函数开头就把 `source` 归一化为字符串，再统一用于 fingerprint 和存储。

### 11. `sessionError` 把所有未知错误都映射成 400

- 位置：`src/server.mjs:315-331`
- 问题：服务层内部错误（如 `repository required`、`TypeError`）不会被识别为 500，而是返回 `400 validation_failed`。这会掩盖真实服务端故障，不利于排障。
- 建议：只对明确的已知业务错误映射 4xx；不在已知列表内的错误默认 500，并记录日志。

### 12. `observeSession` 的 `sessionsByState` 统计语义不明显

- 位置：`src/observability/metrics.mjs:285`
- 问题：每次 `observeSession` 调用都会把对应 state 的全局计数 +1，包括同一会话在同一状态被多次观察。`sessionsByState` 实际是“状态观察次数”而非“去重会话数”。如果下游想用它判断当前有多少会话处于某状态，会高估。
- 建议：要么明确文档化为观察次数，要么在 session 内部跟踪 `lastState` 并在变化时才累加全局 `sessionsByState`。

### 13. 会话 UUID 校验不一致

- 位置：`src/server.mjs` 中 `/recover`、`/discard-pending`、`/ending` 等使用了宽松正则 `[0-9a-fA-F-]+`
- 问题：`/recover` 和 ending 路由会因 `assertUuid` 返回 400，而 `/discard-pending` 等路径不校验 UUID，导致同一类畸形路径出现 400 / 404 不一致。
- 建议：这些路由统一先走 `isSessionUuid()`，畸形输入统一返回 `400 validation_failed`。

---

## 四、可以继续强化的点

- 持久化边界：当前 `sessionService` / `endingService` 都依赖进程内 `repository` 和私有 `repository.sessionState`（非 enumerable 属性）。`endingService` 直接读 `repository.sessionState`，而不是复用 `repositoryState()` 公开 helper，未来替换 MariaDB DAO 时耦合点较隐蔽。
- 日志脱敏：`logger` 对 `extra` 的 text / sensitive key 做了不错的多层防护；建议将来真实 provider 接入后，把 provider 原始响应也走一遍 `redactValue`，避免上游字段绕过 `extra` 白名单。
- HTTP 层：没有全局 request timeout / connection drain / graceful shutdown；对长期公网运行建议补充。
- 幂等性：turn 级、事件级、opening 级三套幂等做得比较完整；但 `sessionPinnedMetadata` 没有随会话生命周期清理，建议与 session 清空/过期策略绑定。

---

## 结论

当前代码作为**本地 / 演示用途**质量不错：分层、契约、幂等、敏感信息防护和测试都下了功夫。但有两处会直接导致服务不可用的问题（**畸形 URL 崩溃**、**超限 body 连接重置**）建议在发布任何非 localhost 环境之前修复；同时 `admin/dev` 路由的无鉴权与进程级无界 Map 是上线时必须解决的硬门槛。

---

## 修复清单

| # | 问题 | 修复位置 | 状态 |
| --- | --- | --- | --- |
| 1 | 非法 URL 编码崩溃进程 | `src/server.mjs` 静态解码加 `try/catch` + 统一请求 `catch` 兜底 | 已修复 |
| 2 | 超限 body 返回 ECONNRESET | `readJsonBody` 改为 `req.resume()` 并先抛规范错误，不销毁 socket | 已修复 |
| 3 | `ensureOpeningCache` 未 await generator | `storyService.mjs` 改为 `await generator(...)` | 已修复 |
| 4 | dev 路由无鉴权 + Map 无界 | server 内 `demoTurnCounter`/`sessionPinnedMetadata` 加容量上限；`clientRequestIndex` 加 50000 上限 | 已缓解（保留文档性“严禁公网”警告） |
| 5 | failed 缓存孤儿行 | `repository.upsertOpeningCache` 让 failed 行也可被 scope 定位，retry 复用同一 cache_uuid | 已修复 |
| 6 | 静态路径边界不严谨 | 改用 `path.relative(PUBLIC_DIR, absolutePath)` 判断 | 已修复 |
| 7 | 静态路由接受所有 HTTP 方法 | 非 GET/HEAD 返回 `405 method_not_allowed` | 已修复 |
| 8 | `STORY_OUTSIDE_PROVIDER=real` 启动不报错 | `isMainModule` 启动前检测 provider 配置并 `process.exit(1)` | 已修复 |
| 9 | 服务层允许 tool-only 批 | `stageNarrativeBatch` 拒绝 `items=[] + tool_call` | 已修复 |
| 10 | `source` 幂等指纹不一致 | `stageNarrativeBatch` 统一预先归一化 `source` | 已修复 |
| 11 | 未知业务错误映射成 400 | `sessionError` 增加内部错误识别并默认 500 | 已修复 |
| 12 | `observeSession` 重复计数状态 | 改为仅在 `lastState` 变化时累加 `sessionsByState` | 已修复 |
| 13 | 会话 UUID 校验不一致 | 所有 `/api/dev/sessions/:uuid/*` 路由统一先 `isSessionUuid`，畸形返回 400 | 已修复 |

回归测试：`tests/codeReviewFixes.test.mjs`（并已加入 `npm test`）。

