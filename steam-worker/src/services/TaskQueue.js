/**
 * Global FIFO queue with max concurrent workers and max pending jobs.
 */
export class TaskQueue {
  constructor(maxConcurrent = 4, maxQueueSize = 50) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueueSize = maxQueueSize;
    this.running = 0;
    /** @type {Array<{ run: () => Promise<any>, resolve: (v: any) => void, reject: (e: any) => void }>} */
    this.queue = [];
  }

  getStats() {
    return {
      pending: this.queue.length,
      running: this.running,
    };
  }

  add(fn) {
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(Object.assign(new Error("queue_overflow"), { code: "QUEUE_OVERFLOW" }));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ run: fn, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.running++;
      Promise.resolve()
        .then(() => job.run())
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.#pump();
        });
    }
  }
}
