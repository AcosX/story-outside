// Optional preload for an independently deployed runtime while the PR awaits
// review. New providers use the saved original fetch to avoid double wrapping.
import { storyTransportFromEnv } from './storyTransport.mjs';
import { validateStoryTransportPayload } from './realProvider.mjs';

const key = Symbol.for('story-outside.story-transport.original-fetch');
if (!globalThis[key] && (process.env.STORY_OUTSIDE_STORY_SSH_HOST || process.env.STORY_OUTSIDE_STORY_CACHE)) {
  const original = globalThis.fetch;
  globalThis[key] = original;
  const transport = storyTransportFromEnv(validateStoryTransportPayload);
  globalThis.fetch = (input, init) => {
    // Existing realProvider issues string URLs. Other fetch users, Request
    // objects and all unrelated origins retain their original behavior.
    if (typeof input === 'string' && input.startsWith('https://api.zhihu.com/km-indep-home/hackathon/v2/story/')) {
      return transport(input, init);
    }
    return original(input, init);
  };
}
