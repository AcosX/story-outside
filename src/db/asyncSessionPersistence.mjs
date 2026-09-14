import { randomUUID } from 'node:crypto';

// Coalesce accepted session mutations without queuing a database transaction
// for every HTTP poll. A watermark only advances after its flush succeeds;
// mutations accepted during that flush require a subsequent snapshot.
export function createAsyncSessionPersistence({ flush, enabled = () => true, onError = () => {}, now = Date.now, retentionMs = 30 * 60 * 1000 } = {}) {
  const epoch = randomUUID();
  const sessions = new Map();
  let running = null;
  let version = 0;
  const status = sessionUuid => {
    const entry = sessions.get(sessionUuid);
    return { epoch, status: entry?.status || 'saved', requested_version: entry?.requested || 0,
      saved_version: entry?.saved || 0 };
  };
  function start() {
    if (running) return;
    running = Promise.resolve().then(async () => {
      while (true) {
        const batch = [...sessions.entries()].filter(([, entry]) => entry.status === 'pending')
          .map(([id, entry]) => [id, entry.requested]);
        if (!batch.length) return;
        try { await flush(); }
        catch (error) {
          // Stop on failure, including work accepted while this write ran.
          // A caller can explicitly retry the entire unacknowledged snapshot.
          for (const entry of sessions.values()) {
            if (entry.requested > entry.saved) entry.status = 'failed';
          }
          onError(error);
          return;
        }
        for (const [id, saved] of batch) {
          const entry = sessions.get(id);
          entry.saved = saved;
          entry.status = entry.saved >= entry.requested ? 'saved' : 'pending';
          entry.updated = now();
        }
      }
    }).finally(() => {
      running = null;
      if ([...sessions.values()].some(entry => entry.status === 'pending')) start();
    });
  }
  return {
    status,
    enqueue(sessionUuid) {
      if (!enabled()) return status(sessionUuid);
      for (const [id, entry] of sessions) {
        if (entry.status === 'saved' && now() - entry.updated > retentionMs) sessions.delete(id);
      }
      const entry = sessions.get(sessionUuid) || { saved: 0 };
      Object.assign(entry, { requested: ++version, status: 'pending', updated: now() });
      sessions.set(sessionUuid, entry);
      start();
      return status(sessionUuid);
    },
    retry(sessionUuid) {
      const entry = sessions.get(sessionUuid);
      if (entry?.status === 'failed') { entry.status = 'pending'; start(); }
      return status(sessionUuid);
    },
    async drain() { while (running) await running; },
  };
}
