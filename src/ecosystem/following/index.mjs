// src/ecosystem/following/index.mjs — 「故事里的相遇」模块的公开出口。
//
// 其他模块从这里导入，不要直接引用内部文件。与 src/community/index.mjs、
// src/stories/index.mjs 保持同一种间接层风格。
//
// 2026-09-13 转正：`fixtures.mjs` 里那四个虚构关注对象（夜读人 / 咖啡馆漫游 /
// 夜班店员 / 夜行人）已随 demo 关注图谱一起删除。关注关系现在来自知乎官方
// `/api/v1/user/followees`，本站不再持有任何假身份。

export {
  createInMemoryFollowingRepository,
} from './repository.mjs';

export {
  createZhihuAccountDirectory,
} from './directory.mjs';

export {
  FollowingError,
  FOLLOWING_CACHE_TTL_MS,
  computeFriendTimelines,
  createFollowingService,
} from './service.mjs';
