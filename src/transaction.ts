/**
 * Per-Agent serialized transaction over the official `runMaintenance` seam
 * (§1.4 A12 of the plan): a busy agent rejects synchronously, so callers wait
 * for the next idle boundary and retry — the same pattern the shipped
 * schedule plugin uses. No hand-rolled FIFO queue.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

const BUSY_MESSAGE = /already has active work/

/** Run `task` inside the agent's exclusive maintenance phase, waiting for idle when busy. */
export async function runAgentTransaction<T>(agent: Agent, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await agent.runMaintenance(task)
    } catch (error) {
      if (error instanceof Error && BUSY_MESSAGE.test(error.message)) {
        await agent.whenIdle()
        continue
      }
      throw error
    }
  }
}
