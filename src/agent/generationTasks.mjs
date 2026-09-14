// Short HTTP polls share one task, including any requested persistence work. Completed
// outcomes stay available after the original HTTP connection has gone away.
export function createGenerationTasks({ waitMs = 1000, retentionMs = 300000, maxEntries = 128, now = Date.now } = {}) {
  const tasks = new Map();
  return {
    async poll(key, work) {
      for (const [id, task] of tasks) {
        if (task.finishedAt !== null && now() - task.finishedAt >= retentionMs) tasks.delete(id);
      }
      let task = tasks.get(key);
      if (!task) {
        if (tasks.size >= maxEntries) return { kind: 'busy' };
        task = { finishedAt: null, promise: null };
        task.promise = Promise.resolve().then(work).then(
          value => ({ kind: 'done', value }),
          error => ({ kind: 'failed', error }),
        ).then(outcome => { task.finishedAt = now(); return outcome; });
        tasks.set(key, task);
      }
      let timer;
      try {
        const outcome = await Promise.race([
          task.promise,
          new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'pending' }), waitMs); }),
        ]);
        // Successes remain replayable through runTurn (durable after saving). Errors may be
        // retried after delivery; undelivered errors remain until a later poll.
        if (outcome.kind === 'done' || outcome.kind === 'failed') tasks.delete(key);
        return outcome;
      } finally { clearTimeout(timer); }
    },
  };
}
