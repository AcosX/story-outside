// OAuth /user.url is an API resource (/users/<uid>), not a public profile.
// Resolve the public slug using its stable hash_id, without forwarding credentials.
const HASH_ID = /^[a-f0-9]{32}$/;
const URL_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BYTES = 65536;

export async function fetchPublicUrlToken(hashId, { fetchImpl = (...args) => fetch(...args), timeoutMs = 5000 } = {}) {
  if (typeof hashId !== 'string' || !HASH_ID.test(hashId)) return null;
  const response = await fetchImpl(`https://www.zhihu.com/api/v4/members/${hashId}?include=url_token`, {
    headers: { accept: 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) { await response.body?.cancel(); return null; }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_BYTES) return null;
    chunks.push(Buffer.from(chunk));
  }
  const member = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  // A slug is only usable after proving the response describes this OAuth user.
  if (member?.id !== hashId || typeof member.url_token !== 'string' || !URL_TOKEN.test(member.url_token)) return null;
  return member.url_token;
}
