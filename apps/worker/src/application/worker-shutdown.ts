export type WorkerShutdownResources = Readonly<{
  stopJobAdmission: () => void;
  timers: readonly NodeJS.Timeout[];
  worker: Readonly<{
    pause: (force: boolean) => Promise<void>;
    close: () => Promise<void>;
  }>;
  inbox: Readonly<{ close: () => void }>;
  codeReceiver: Readonly<{ close: () => Promise<void> }> | null;
  browser: Readonly<{ close: () => Promise<void> }>;
  staging: Readonly<{ destroyKey: () => void }> | null;
  removeWorkerStatus: () => Promise<void>;
  releasePortalOwner: () => Promise<void>;
  closePool: () => Promise<void>;
}>;

export const workerShutdownTimeoutMs = 30_000;

/** Stops admission first, then closes active execution and its dependent resources in order. */
export async function shutdownWorkerResources(
  resources: WorkerShutdownResources,
  timeoutMs = workerShutdownTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const withinDeadline = async (operation: () => Promise<unknown>) => {
    const pending = Promise.resolve().then(operation).catch(() => undefined);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remainingMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  };

  resources.stopJobAdmission();
  for (const timer of resources.timers) clearInterval(timer);
  await withinDeadline(() => resources.worker.pause(true));
  resources.inbox.close();
  await withinDeadline(() => resources.worker.close());
  if (resources.codeReceiver) await withinDeadline(() => resources.codeReceiver!.close());
  await withinDeadline(() => resources.browser.close());
  resources.staging?.destroyKey();
  await withinDeadline(resources.removeWorkerStatus);
  await withinDeadline(resources.releasePortalOwner);
  await withinDeadline(resources.closePool);
}
