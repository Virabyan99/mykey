// The in-flight gate of one process (Run 6.3, P-114, Doc 06 §11
// `concurrency.httpPerProcess`): the first step after the request id. A
// request that finds `max` requests in flight is refused at once with
// `503 busy` and `connection: close`, its body unread; nothing queues.
export interface InflightGate {
  enter(): boolean;
  leave(): void;
  current(): number;
}

export function createInflightGate(max: number): InflightGate {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("invalid in-flight limit");
  let running = 0;
  return {
    enter() {
      if (running >= max) return false;
      running += 1;
      return true;
    },
    leave() {
      running = Math.max(0, running - 1);
    },
    current: () => running,
  };
}
