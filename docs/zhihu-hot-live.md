# 知乎真实热榜

热榜已按 AGENTS.md 指定的官方 `zhihu-cli 0.5.3-beta.20260904115023` 包中 `references/http-api.md` 对接：

- `GET https://developer.zhihu.com/api/v1/content/hot_list?Limit=30`
- 服务端使用 `Authorization: Bearer <Access Secret>` 和秒级 `X-Request-Timestamp`。
- 凭证优先来自 `ZHIHU_ACCESS_SECRET`，其次来自已忽略的 `secrets/secret` 的 `Access Secret` 标签；仅在真实热榜源初始化时读取，不发送到浏览器。
- `STORY_OUTSIDE_PROVIDER=real`（或兼容别名 `ZHIHU_PROVIDER=real`）选择真实热榜；mock 模式仍使用测试数据。真实调用失败不会回退 mock，响应明确 `unavailable: true` 和稳定错误码。
- 官方只提供有序的 `Title`、`Url`、`ThumbnailUrl`、`Summary`。对外保留 `title`、`url`、`thumbnail_url`、`excerpt`，不编造分类或数值热度；兼容字段 `heat` 为 0，UI 应隐藏它。非 total 分类明确不可用。
- 仅接受 HTTPS 知乎内容链接和 zhimg 图片；不跟随重定向。请求超时 10 秒，响应最多 1 MiB，上游错误正文不回显。

2026-09-07 本地真实只读请求成功返回 30 条，其中 28 条有图片、25 条有摘要。首条链接为 `https://www.zhihu.com/question/2080237961358963743`。热榜会实时变化，此处仅记录该次验证。

独立回归：`node tests/zhihuHotSource.test.mjs`。

## 首页故事关联

首页 `/v1/ecosystem/hot` 无完整 identity triple 时由服务端读取 provider 的故事目录，再执行 `hotStoryMatch.mjs` 的确定性匹配。客户端不能注入候选故事或匹配词。只有与目录中故事有明确证据的热点会返回，每项包含 `related_stories`（id、title、cover_url、categories、matched_terms、matched_reason）及热点层聚合解释。完整 identity triple 保留原社区画像相关接口契约。

匹配仅使用故事标题、简介、标签和热点标题、摘要。明确引用完整具体书名可关联；否则必须至少三个独立非泛词、总长度至少八个字符，并且热点标题命中至少一个长度三字符以上的具体词。人生、爱情、生活、家庭、科幻等泛词或分类不能作为关联依据。无证据返回空，不推荐不相关书；目录不可用返回空并标记 `hot_catalog_unavailable`。

带完整 identity triple 的 HTTP 响应保留原画像校验和 `relevant_to_story` 元数据，但仅输出 `relevant.score > 0` 的热点，并用服务端已导入故事记录填入 `related_stories`。找不到该故事记录时返回空。内部画像评分函数的排序与校验契约保持不变，HTTP 展示层不再混入零分热点。

2026-09-08 同时读取真实故事目录（20 本）和官方热榜（30 条），此次保守关联得到 **0 条**，因此首页热榜应显示暂无相关故事。该结果不会以模拟关联补齐。独立回归：`node tests/hotStoryMatch.test.mjs`。
