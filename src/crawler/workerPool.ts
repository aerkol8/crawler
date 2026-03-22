import { FrontierQueue, FrontierItem } from "./frontier";

export type WorkerPoolOptions = {
  maxConcurrent: number;
  ratePerSec: number;
};

export type TaskProcessor = (item: FrontierItem) => Promise<void>;

export class WorkerPool {
  private active = 0;
  private timer: NodeJS.Timeout | null = null;
  private nextStartTime = 0;
  private stopped = false;

  constructor(
    private readonly frontier: FrontierQueue,
    private readonly options: WorkerPoolOptions,
    private readonly processor: TaskProcessor,
    private readonly onTaskSettled?: () => void
  ) {}

  start() {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    this.timer = setInterval(() => void this.pump(), 50);
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getActiveCount() {
    return this.active;
  }

  private async pump() {
    if (this.stopped) {
      return;
    }

    const minIntervalMs = this.options.ratePerSec > 0 ? 1000 / this.options.ratePerSec : 0;

    while (this.active < this.options.maxConcurrent) {
      const now = Date.now();
      if (now < this.nextStartTime) {
        break;
      }

      const item = await this.frontier.dequeue();
      if (!item) {
        break;
      }

      this.active += 1;
      this.nextStartTime = now + minIntervalMs;

      this.processor(item)
        .catch(() => {
          // Errors are handled by the processor.
        })
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.onTaskSettled?.();
        });
    }
  }
}
