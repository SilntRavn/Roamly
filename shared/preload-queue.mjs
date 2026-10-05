// 同一任务合并，低数字优先；已经开始的任务不会因访问详情而重复执行。
export function createPreloadQueue(worker, { concurrency = 2 } = {}) {
  const jobs = new Map();
  let running = 0;
  function drain() {
    while (running < concurrency) {
      const next = [...jobs.values()].filter((job) => !job.running)
        .sort((a, b) => a.priority - b.priority || a.order - b.order)[0];
      if (!next) break;
      next.running = true;
      running++;
      Promise.resolve().then(() => worker(next.key, next.options)).then(
        (value) => finish(next, null, value),
        (error) => finish(next, error),
      );
    }
  }
  function finish(job, error, value) {
    jobs.delete(job.key);
    running--;
    if (error) job.reject(error);
    else job.resolve(value);
    drain();
  }
  let order = 0;
  function enqueue(key, { priority = 1, ...options } = {}) {
    const existing = jobs.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      if (!existing.running) existing.options.force ||= options.force;
      return existing.promise;
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    jobs.set(key, { key, priority, order: order++, options, promise, resolve, reject, running: false });
    queueMicrotask(drain);
    return promise;
  }
  enqueue.promote = (key, priority) => {
    const job = jobs.get(key);
    if (job) job.priority = Math.min(job.priority, priority);
  };
  return enqueue;
}
