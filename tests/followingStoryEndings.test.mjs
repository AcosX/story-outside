import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFollowingService } from '../src/ecosystem/following/service.mjs';
import { createInMemoryFollowingRepository } from '../src/ecosystem/following/repository.mjs';
import { createZhihuAccountDirectory } from '../src/ecosystem/following/directory.mjs';
import { listOwnerActivities, repositoryState } from '../src/stories/sessionService.mjs';

const me = randomUUID(), friend = randomUUID(), storyId = randomUUID(), otherId = randomUUID();
const repo = createInMemoryFollowingRepository();
const directory = createZhihuAccountDirectory();
directory.remember({ url_token: 'friend', user_uuid: friend });
const storyRepo = { findStoryByUuid: id => ({ slug: id === storyId ? 'target-story' : 'other-story', title: '故事' }) };
const sessions = repositoryState(storyRepo).sessions;
const add = (id, story_uuid, state, payload, date) => sessions.set(id, {
 session_uuid: id, user_uuid: friend, story_uuid, state, lastTouchedAt: date,
 finish_envelope: payload ? { tool_call: { name: 'finish_story', payload } } : null,
});
const finished = randomUUID();
add(finished, storyId, 'finished', { ending: '雨停之后', summary: '他们终于重逢。', key_choices: ['private detail'] }, '2026-09-01');
add(randomUUID(), otherId, 'finished', { ending: '另一个结局' }, '2026-09-14');
add(randomUUID(), storyId, 'playing', { ending: '未提交的结局' }, '2026-09-13');
add(randomUUID(), storyId, 'finished', null, '2026-09-12');
const service = createFollowingService({ repository: repo, accountDirectory: directory,
 fetchFollowees: async () => ({ items: [{ url_token: 'friend', fullname: '朋友' }] }),
 listActivities: owner => listOwnerActivities(storyRepo, owner),
});
const input = { followerUuid: me, oauthToken: 'test-token', storyRepository: storyRepo, storySlug: 'target-story', finishedOnly: true, limit: 1 };
const feed = await service.friendTimelinesSafe(input);
assert.equal(feed.items.length, 1);
assert.equal(feed.items[0].session_uuid, finished, 'filter before pagination, excluding unfinished/uncommitted endings');
assert.deepEqual(feed.items[0].ending, { ending: '雨停之后', summary: '他们终于重逢。' });
assert.equal(feed.items[0].owner_user_uuid, undefined);
assert.equal((await service.friendTimelinesSafe({ ...input, storySlug: 'missing' })).items.length, 0);
assert.equal((await service.friendTimelinesSafe({ ...input, oauthToken: null })).status, 'login_required');
repo.setVisibility(friend, false);
assert.equal((await service.friendTimelinesSafe(input)).items.length, 0, 'privacy changes apply immediately');
console.log('Following story endings: projection, filtering before pagination, committed-only and privacy PASS');
