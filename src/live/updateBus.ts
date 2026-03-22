import { EventEmitter } from "node:events";

export type JobUpdateEvent = {
  jobId: string;
  sequence: number;
  updatedAt: string;
};

export class UpdateBus {
  private readonly emitter = new EventEmitter();
  private sequence = 0;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publishJob(jobId: string) {
    const event: JobUpdateEvent = {
      jobId,
      sequence: ++this.sequence,
      updatedAt: new Date().toISOString()
    };

    this.emitter.emit("job", event);
  }

  subscribe(listener: (event: JobUpdateEvent) => void) {
    this.emitter.on("job", listener);
    return () => {
      this.emitter.off("job", listener);
    };
  }
}
