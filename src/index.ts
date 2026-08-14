/**
 * dsh-session-supervisor plugin entry (named exports only — a default export
 * makes the Loader discard this namespace; see docs/postmortem/0001).
 *
 * v1 contract highlights:
 * - read-only over the session log: no custom SessionEvents are ever written
 *   (out-of-tree events would make first-party readers refuse the log);
 * - all state lives in the plugin-owned store under `$DSH_HOME`;
 * - observe + notify only: no shell, network, cancel, or side-effect retry.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Config, type Config as SupervisorConfig } from './config.ts'
import { followupMessage, type DeliveryTarget } from './delivery.ts'
import { ActivityTracker, isRootAgent, SessionSupervisorRuntime } from './runtime.ts'
import { FileSupervisorStore } from './store.ts'
import { registerGuardianTools, type ToolDeps } from './tools.ts'

export const name = 'session-supervisor'

export const inject = ['agents', 'sessions', 'tools', 'timer'] as const

export { Config }

export type { SupervisorConfig }

export function apply(ctx: Context, config: SupervisorConfig): void {
  if (!config.enabled) {
    // Kill switch: no timers, no follow-ups, no tool surface. The store and
    // domain fold remain importable for read-only consumers.
    return
  }
  // Service construction registers the instance on the tree (the Service
  // constructor calls `ctx.reflect.provide`); providing again would collide.
  const store = new FileSupervisorStore(ctx)
  const tracker = new ActivityTracker()
  /* v8 ignore next 4 -- exercised end to end by the loader fixture, which runs the built lib in a second module realm */
  const target: DeliveryTarget = {
    followup: (agent, guard, _state) => {
      agent.followup(followupMessage(guard, config))
    },
  }
  const toolDeps: ToolDeps = { store, config, activity: tracker }
  ctx.effect(() => registerGuardianTools(ctx, toolDeps))

  const runtimes = new Map<string, SessionSupervisorRuntime>()
  const attach = (agent: Agent): void => {
    if (!isRootAgent(agent)) return
    if (runtimes.has(String(agent.id))) return
    const runtime = new SessionSupervisorRuntime(agent, ctx, { store, config, tracker, target })
    runtimes.set(String(agent.id), runtime)
    runtime.start()
  }
  const onCreated = ctx.on('agent/created', ({ agent }: { agent: Agent }) => attach(agent))
  const onDisposed = ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    const runtime = runtimes.get(String(agent.id))
    if (!runtime) return
    runtime.dispose()
    runtimes.delete(String(agent.id))
  })
  ctx.effect(() => () => {
    onCreated()
    onDisposed()
    for (const runtime of runtimes.values()) runtime.dispose()
    runtimes.clear()
  })
  // Startup enumeration covers roots created before this plugin loaded.
  for (const agent of ctx.agents.list()) attach(agent)
}
