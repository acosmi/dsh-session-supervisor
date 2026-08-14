/**
 * Live activity tracker + per-root-Agent runtime. Observations come ONLY from
 * the session log (read-only); the tracker hands bounded deltas to evaluation
 * transactions and drains them only once a transaction persists.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { evaluationConfig, type Config } from './config.ts'
import { deliverIncidents, ownerSessionIdOf, type DeliveryTarget } from './delivery.ts'
import { newLedgerState } from './domain.ts'
import { evaluateGuard, materializeTransitions } from './policy.ts'
import { parseRfc3339Offset } from './rfc3339.ts'
import { runAgentTransaction } from './transaction.ts'
import type { SupervisorStore } from './store.ts'
import type { GuardianEvent, GuardianLedgerState, SessionOwnerId, TurnEndFact, TurnEndKind } from './types.ts'

/** Core lifecycle events that count as qualifying activity (§4.3 of the plan). */
const QUALIFYING_ACTIVITY = new Set<string>([
  'turn/start',
  'step/start',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'step/end',
  'turn/end',
])

const CLASSIFIED_REASONS = new Set<string>(['completed', 'aborted', 'error', 'blocked', 'max-tokens', 'interrupted'])

/** Bounded in-memory observation deltas; durability lives in the store. */
export class ActivityTracker {
  private readonly activityAtMs = new Map<string, number>()
  private readonly turnEnds = new Map<string, TurnEndFact[]>()
  private readonly held = new Map<string, TurnEndFact[]>()

  /** Record one qualifying activity instant for a session. */
  observeActivity(sessionId: SessionOwnerId, atMs: number): void {
    const previous = this.activityAtMs.get(sessionId)
    if (previous === undefined || atMs > previous) this.activityAtMs.set(sessionId, atMs)
  }

  lastQualifyingActivityAtMs(sessionId: SessionOwnerId): number | undefined {
    return this.activityAtMs.get(sessionId)
  }

  /** Observe one durable turn end and classify its reason. */
  observeTurnEnd(sessionId: SessionOwnerId, atMs: number, reason: string): void {
    const kind: TurnEndKind = CLASSIFIED_REASONS.has(reason) ? reason as TurnEndKind : 'unknown'
    const pending = this.turnEnds.get(sessionId)
    if (pending) pending.push({ atMs, reason: kind })
    else this.turnEnds.set(sessionId, [{ atMs, reason: kind }])
  }

  /** Hand the accumulated turn-end delta to a transaction (no drain yet). */
  holdTurnEnds(sessionId: SessionOwnerId): readonly TurnEndFact[] {
    const pending = this.turnEnds.get(sessionId) ?? []
    this.turnEnds.delete(sessionId)
    const existing = this.held.get(sessionId) ?? []
    const merged = existing.length > 0 ? [...existing, ...pending] : pending
    this.held.set(sessionId, merged)
    return merged
  }

  /** Persist succeeded: the held delta is consumed. */
  releaseTurnEnds(sessionId: SessionOwnerId): void {
    this.held.delete(sessionId)
  }

  /** Persist failed: the held delta returns to the pending queue. */
  restoreTurnEnds(sessionId: SessionOwnerId): void {
    const facts = this.held.get(sessionId)
    if (facts && facts.length > 0) {
      const pending = this.turnEnds.get(sessionId)
      this.turnEnds.set(sessionId, pending ? [...facts, ...pending] : facts)
    }
    this.held.delete(sessionId)
  }

  /** Drop all tracking for a disposed session. */
  forget(sessionId: SessionOwnerId): void {
    this.activityAtMs.delete(sessionId)
    this.turnEnds.delete(sessionId)
    this.held.delete(sessionId)
  }
}

/** Feed one session's live events into the tracker. */
export function trackSessionEvent(tracker: ActivityTracker, sessionId: SessionOwnerId, event: SessionEvent): void {
  if (event.type === 'turn/end') {
    const reason = (event.data as { reason?: { kind?: string } }).reason?.kind
    tracker.observeTurnEnd(sessionId, event.time, reason ?? 'unknown')
    return
  }
  if (QUALIFYING_ACTIVITY.has(event.type)) tracker.observeActivity(sessionId, event.time)
}

/** True when an Agent is a root (no fork lineage). */
export function isRootAgent(agent: Agent): boolean {
  return agent.session.header.parentSession === undefined
}

export interface RuntimeDeps {
  store: SupervisorStore
  config: Config
  tracker: ActivityTracker
  target: DeliveryTarget
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Single-shot timer mixed in by @deepseek-ai/cordis-plugin-timer (dsh-base row 1). */
    timeout(callback: () => void, delay: number): () => void
  }
}

/** Absolute epoch ms of the next evaluation a timer must fire at. */
export function nextEvaluationAtMs(state: GuardianLedgerState, config: Config): number {
  let soonest = Number.POSITIVE_INFINITY
  const { confirmationMs } = evaluationConfig(config)
  for (const guard of state.guards) {
    if (guard.controlState !== 'armed') continue
    for (const policy of guard.policies) {
      if (policy.phase === 'superseded' || policy.phase === 'dead_letter') continue
      if (policy.kind === 'lifecycle_silence') {
        const base = Math.max(policy.observation.anchorAtMs, policy.observation.lastActivityAtMs ?? policy.observation.anchorAtMs)
        soonest = Math.min(soonest, base + policy.seconds * 1000)
      } else if (policy.kind === 'deadline_unclosed') {
        soonest = Math.min(soonest, parseRfc3339Offset(policy.at))
      }
      if (policy.phase === 'suspect' && policy.observation.breachSinceAtMs !== undefined) {
        soonest = Math.min(soonest, policy.observation.breachSinceAtMs + confirmationMs)
      }
    }
  }
  return soonest
}

/** One per-root-Agent supervision runtime: single-shot timers, no overlap, dispose-stable. */
export class SessionSupervisorRuntime {
  private timerDispose: (() => void) | undefined
  private readonly retryDisposers = new Set<() => void>()
  private running = false
  private disposed = false
  private stopListening: (() => void) | undefined
  private readonly sessionId: SessionOwnerId
  private readonly config: Config

  constructor(
    private readonly agent: Agent,
    private readonly ctx: Context,
    private readonly deps: RuntimeDeps,
  ) {
    this.sessionId = ownerSessionIdOf(agent)
    this.config = deps.config
  }

  /** Attach the read-only session listener and start the drive loop. */
  start(): void {
    if (this.disposed) return
    this.stopListening = this.agent.ctx.on('session/event', (_session, event) => {
      trackSessionEvent(this.deps.tracker, this.sessionId, event)
      this.requestDrive()
    })
    this.requestDrive()
  }

  /** Stop timers, listeners, and retry scheduling; never re-arms afterwards. */
  dispose(): void {
    /* v8 ignore next -- both halves run (single and repeated dispose); v8 reports the guard as one counter */
    if (this.disposed) return
    this.disposed = true
    this.stopListening?.()
    this.timerDispose?.()
    this.timerDispose = undefined
    for (const dispose of this.retryDisposers) dispose()
    this.retryDisposers.clear()
    this.deps.tracker.forget(this.sessionId)
  }

  private requestDrive(): void {
    /* v8 ignore next -- the reentrant half is covered only by a drive racing an event, which tests cannot order deterministically */
    if (this.disposed || this.running) return
    this.armTimer(0)
  }

  private armTimer(delayMs: number): void {
    /* v8 ignore next -- arming after dispose is unreachable: every caller checks disposed first */
    if (this.disposed) return
    this.timerDispose?.()
    this.timerDispose = this.ctx.timeout(() => {
      this.timerDispose = undefined
      void this.drive()
    }, Math.max(0, Math.min(delayMs, 2 ** 31 - 1)))
  }

  /** One single-flight evaluation + delivery cycle inside the maintenance phase. */
  private async drive(): Promise<void> {
    /* v8 ignore next -- the reentrant half needs a timer firing inside an in-flight drive, which tests cannot order deterministically */
    if (this.running || this.disposed) return
    this.running = true
    try {
      await runAgentTransaction(this.agent, async () => {
        const state = await this.deps.store.load(this.sessionId) ?? newLedgerState(this.sessionId)
        const input = {
          nowMs: Date.now(),
          lastQualifyingActivityAtMs: this.deps.tracker.lastQualifyingActivityAtMs(this.sessionId),
          turnEnds: this.deps.tracker.holdTurnEnds(this.sessionId),
        }
        const transitions = state.guards.flatMap(guard => evaluateGuard(guard, input, evaluationConfig(this.config)))
        let next = state
        if (transitions.length > 0) {
          const events = materializeTransitions(state, transitions, input.nowMs)
          next = await this.deps.store.append(this.sessionId, events)
        }
        this.deps.tracker.releaseTurnEnds(this.sessionId)
        this.persistDelivery(next)
        this.armNext(next, input.nowMs)
      })
    } catch (error) {
      /* v8 ignore next -- the disposed-during-failure half needs a disposal landing inside an in-flight await, which tests cannot order deterministically */
      if (!this.disposed) {
        this.deps.tracker.restoreTurnEnds(this.sessionId)
        this.ctx.logger('session-supervisor').warn(`drive failed for ${String(this.agent.id)}: ${String(error)}`)
        const delays = this.config.deliveryRetryDelaysMs
        this.armTimer(delays[0] ?? 1_000)
      }
    } finally {
      this.running = false
    }
  }

  private armNext(state: GuardianLedgerState, nowMs: number): void {
    /* v8 ignore next -- the disposed half needs a disposal between drive completion and re-arm, which tests cannot order deterministically */
    if (this.disposed) return
    const at = nextEvaluationAtMs(state, this.config)
    if (!Number.isFinite(at)) return // purely event-driven policies: no timer
    this.armTimer(at - nowMs)
  }

  private persistDelivery(state: GuardianLedgerState): void {
    const receipts = deliverIncidents(this.agent, state, this.config, this.deps.target)
    if (receipts.length === 0) return
    const atMs = Date.now()
    const events: GuardianEvent[] = receipts.map(receipt => receipt.delivered || receipt.attempt === 0
      ? { version: 1, kind: 'delivery-accepted' as const, atMs, guardId: receipt.guardId, incidentOrdinal: receipt.incidentOrdinal }
      : { version: 1, kind: 'delivery-failed' as const, atMs, guardId: receipt.guardId, incidentOrdinal: receipt.incidentOrdinal, attempt: receipt.attempt })
    void this.deps.store.append(this.sessionId, events).then(
      () => this.afterReceipts(receipts),
      (error: unknown) => {
        /* v8 ignore next -- the disposed half needs a disposal inside the receipt persist window, which tests cannot order deterministically */
        if (this.disposed) return
        this.ctx.logger('session-supervisor').warn(`delivery receipt persist failed: ${String(error)}`)
        this.armTimer(this.config.deliveryRetryDelaysMs[0] ?? 1_000)
      },
    )
  }

  /** Decide retry scheduling from the receipts themselves (not stale state). */
  private afterReceipts(receipts: ReturnType<typeof deliverIncidents>): void {
    /* v8 ignore next -- the disposed half needs a disposal inside the receipt persist window, which tests cannot order deterministically */
    if (this.disposed) return
    const delays = this.config.deliveryRetryDelaysMs
    const terminal: GuardianEvent[] = []
    for (const receipt of receipts) {
      if (receipt.delivered || receipt.attempt === 0) continue
      if (receipt.attempt >= this.config.maxDeliveryAttempts) {
        terminal.push({ version: 1, kind: 'delivery-dead-letter', atMs: Date.now(), guardId: receipt.guardId, incidentOrdinal: receipt.incidentOrdinal })
        continue
      }
      const delay = delays[Math.min(receipt.attempt - 1, delays.length - 1)] ?? 1_000
      const dispose = this.ctx.timeout(() => {
        this.retryDisposers.delete(dispose)
        void this.drive()
      }, delay)
      this.retryDisposers.add(dispose)
    }
    if (terminal.length > 0) {
      void this.deps.store.append(this.sessionId, terminal).catch((error: unknown) => {
        if (!this.disposed) this.ctx.logger('session-supervisor').warn(`dead-letter persist failed: ${String(error)}`)
      })
    }
  }
}
