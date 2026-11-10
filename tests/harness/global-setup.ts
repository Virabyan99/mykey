// Vitest global setup for the integration project: one clean stack per test
// run, removed afterwards. Suites isolate themselves with freshDatabase() and
// freshNamespace(); a suite that must break a service starts its own stack.
import { announceSharedStack, startStack } from "./stack.ts";

export default async function setup(): Promise<() => Promise<void>> {
  const stack = await startStack();
  announceSharedStack(stack);
  return async () => {
    await stack.stop();
  };
}
