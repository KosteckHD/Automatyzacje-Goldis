/** Production queue payload deliberately contains only a run identifier. */
export function createRunJob(runId: string, dispatchId?: string) {
  return {
    name: "verify-row",
    data: { runId },
    options: {
      jobId: dispatchId ? `dispatch-${dispatchId}` : runId,
      attempts: 1,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  } as const;
}
