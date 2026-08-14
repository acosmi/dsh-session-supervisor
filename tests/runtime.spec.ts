import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../src/config.ts'
import { ActivityTracker, isRootAgent, nextEvaluationAtMs, SessionSupervisorRuntime, trackSessionEvent } from '../src/runtime.ts'
import { newLedgerState, foldEvent } from '../src/domain.ts'
import { FileSupervisorStore, SupervisorStore } from '../src/store.ts'
import type { GuardianEvent, GuardianLedgerState, SessionOwnerId, TurnEndKind } from '../src/types.ts'

const SESSION = 'sess-1' as const

interface PendingTimer { delay: number; cb: () => void; cancelled: boolean }

class VirtualTimerContext {
  readonly pending: PendingTimer[] = []

  timeout(cb: () => void, delay: number): () => void {
    const entry: PendingTimer = { delay, cb, cancelled: false }
    this.pending.push(entry)
    return () => {
      entry.cancelled = true
    }
  }

  fireAll(): void {
    for (const entry of [...this.pending]) {
      if (entry.cancelled) continue
      entry.cancelled = true
      entry.cb()
    }
  }

  fireOne(): void {
    const entry = this.pending.find(candidate => !candidate.cancelled)
    if (!entry) throw new Error('no pending timer')
    entry.cancelled = true
    entry.cb()
  }
}

interface Harness {
  agent: Agent
  timers: VirtualTimerContext
  store: FileSupervisorStore
  tracker: ActivityTracker
  runtime: SessionSupervisorRuntime
  followupSpy: ReturnType<typeof vi.fn>
  sessionListeners: Array<(session: unknown, event: unknown) => void>
  ctx: Context
}

const create: GuardianEvent = {
  version: 1, kind: 'create', atMs: 1000,
  guard: { id: 'g1', label: 'g', ownerSessionId: SESSION, notificationMode: 'owner_followup', policies: [{ id: 'p1', kind: 'lifecycle_silence', seconds: 900 }] },
}

async function buildHarness(config: Partial<Config> = {}, guardEvent: GuardianEvent | null = create): Harness {
  const ctx = new Context()
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-runtime-'))
  const store = new FileSupervisorStore(ctx, dir)
  const tracker = new ActivityTracker()
  const timers = new VirtualTimerContext()
  const followupSpy = vi.fn()
  const sessionListeners: Harness['sessionListeners'] = []
  const agentCtx = {
    on: (_name: string, listener: (session: unknown, event: unknown) => void) => {
      sessionListeners.push(listener)
      return () => {}
    },
  }
  const agent = {
    id: SESSION,
    session: { id: SESSION, header: { parentSession: undefined } },
    ctx: agentCtx,
    runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    whenIdle: async () => {},
    followup: followupSpy,
  } as unknown as Agent
  const runtime = new SessionSupervisorRuntime(agent, {
    timeout: (cb: () => void, delay: number) => timers.timeout(cb, delay),
    logger: () => ({ warn: console.warn }),
  } as never, {
    store,
    config: { ...DEFAULT_CONFIG, ...config },
    tracker,
    target: { followup: (target, guard, state) => { target.followup({ guard, state }) } },
  })
  if (guardEvent) await store.append(SESSION, [guardEvent])
  return { agent, timers, store, tracker, runtime, followupSpy, sessionListeners, ctx }
}

describe('runtime evaluation cycle', () => {
  it('arms the silence deadline and opens the incident after the threshold', async () => {
    const h = await buildHarness({}, { ...create, atMs: 1000 })
    const before = Date.now()
    const realNow = Date.now
    Date.now = () => before + 900_000 + 61_000
    h.runtime.start()
    expect(h.timers.pending.length).toBeGreaterThan(0)
    h.timers.fireAll()
    await vi.waitFor(() => { expect(h.followupSpy).toHaveBeenCalledTimes(1) })
    Date.now = realNow
    const state = await h.store.load(SESSION)
    expect(state?.guards[0]?.incidents[0]?.phase).toBe('open')
    expect(state?.guards[0]?.incidents[0]?.delivery.state).toBe('accepted')
    h.runtime.dispose()
    void h.ctx.fiber.dispose()
  })
  it('retries failed delivery with bounded attempts and dead-letters', async () => {
    const h = await buildHarness({ maxDeliveryAttempts: 2 }, { ...create, atMs: 1000 })
    const before = Date.now()
    const realNow = Date.now
    Date.now = () => before + 900_000 + 61_000
    h.runtime.start()
    h.followupSpy.mockImplementation(() => { throw new Error('inbox down') })
    h.timers.fireAll()
    Date.now = realNow
    await vi.waitFor(() => {
      const timers = h.timers.pending.filter(t => !t.cancelled)
      expect(timers.length).toBeGreaterThan(0)
    })
    // retry fires again → second failure → attempts exhausted → dead-letter
    h.timers.fireAll()
    await vi.waitFor(async () => {
      const state = await h.store.load(SESSION)
      expect(state?.guards[0]?.incidents[0]?.phase).toBe('dead_letter')
      expect(state?.guards[0]?.policies[0]?.phase).toBe('dead_letter')
    })
    h.runtime.dispose()
    void h.ctx.fiber.dispose()
  })
  it('audit_only guards record acceptance without any follow-up', async () => {
    const h = await buildHarness({}, {
      ...create,
      guard: { ...create.guard, notificationMode: 'audit_only' },
    })
    const before = Date.now()
    const realNow = Date.now
    Date.now = () => before + 900_000 + 61_000
    h.runtime.start()
    h.timers.fireAll()
    await vi.waitFor(async () => {
      const state = await h.store.load(SESSION)
      expect(state?.guards[0]?.incidents[0]?.delivery.state).toBe('accepted')
    })
    expect(h.followupSpy).not.toHaveBeenCalled()
    Date.now = realNow
    h.runtime.dispose()
    void h.ctx.fiber.dispose()
  })
})

describe('activity tracking', () => {
  it('ignores clock-backward activity and tolerates bare restores', () => {
    const tracker = new ActivityTracker()
    tracker.observeActivity(SESSION, 5000)
    tracker.observeActivity(SESSION, 4000)
    expect(tracker.lastQualifyingActivityAtMs(SESSION)).toBe(5000)
    tracker.restoreTurnEnds(SESSION)
    expect(tracker.holdTurnEnds(SESSION)).toEqual([])
  })
  it('merges restored facts ahead of freshly pending ones', () => {
    const tracker = new ActivityTracker()
    trackSessionEvent(tracker, SESSION, { type: 'turn/end', seq: 1, time: 100, data: { reason: { kind: 'error' } } } as never)
    tracker.holdTurnEnds(SESSION)
    trackSessionEvent(tracker, SESSION, { type: 'turn/end', seq: 2, time: 200, data: { reason: { kind: 'blocked' } } } as never)
    tracker.restoreTurnEnds(SESSION)
    const facts = tracker.holdTurnEnds(SESSION)
    expect(facts.map(f => f.reason)).toEqual(['error', 'blocked'])
  })
  it('classifies a turn end without a reason as unknown', () => {
    const tracker = new ActivityTracker()
    trackSessionEvent(tracker, SESSION, { type: 'turn/end', seq: 1, time: 100, data: {} } as never)
    expect(tracker.holdTurnEnds(SESSION)[0]?.reason).toBe('unknown')
  })
  it('records qualifying activity and classifies turn ends through the listener', async () => {
    const h = await buildHarness({}, null)
    const tracker = h.tracker
    expect(tracker.lastQualifyingActivityAtMs(SESSION)).toBeUndefined()
    trackSessionEvent(tracker, SESSION, { type: 'tool/call', seq: 1, time: 5000, data: {} } as never)
    expect(tracker.lastQualifyingActivityAtMs(SESSION)).toBe(5000)
    trackSessionEvent(tracker, SESSION, { type: 'turn/end', seq: 2, time: 6000, data: { reason: { kind: 'error' } } } as never)
    trackSessionEvent(tracker, SESSION, { type: 'turn/end', seq: 3, time: 7000, data: { reason: { kind: 'vendor-x' } } } as never)
    const facts = tracker.holdTurnEnds(SESSION)
    expect(facts.map(f => f.reason)).toEqual(['error', 'unknown'])
    tracker.releaseTurnEnds(SESSION)
    expect(tracker.holdTurnEnds(SESSION)).toEqual([])
  })
  it('restores held facts after a failed persist', () => {
    const tracker = new ActivityTracker()
    trackSessionEvent(tracker, SESSION, { type: 'turn/end', seq: 1, time: 100, data: { reason: { kind: 'error' } } } as never)
    const held = tracker.holdTurnEnds(SESSION)
    expect(held).toHaveLength(1)
    // re-holding before a persist merges and returns the outstanding delta
    expect(tracker.holdTurnEnds(SESSION)).toHaveLength(1)
    tracker.restoreTurnEnds(SESSION)
    expect(tracker.holdTurnEnds(SESSION)).toHaveLength(1)
  })
})

describe('nextEvaluationAtMs', () => {
  it('computes silence thresholds, deadlines, and suspect confirmation', async () => {
    const ctx = new Context()
    const dir = mkdtempSync(join(tmpdir(), 'supervisor-next-'))
    const store = new FileSupervisorStore(ctx, dir)
    const now = Date.now()
    await store.append(SESSION, [{
      version: 1, kind: 'create', atMs: now,
      guard: {
        id: 'g1', label: 'g', ownerSessionId: SESSION, notificationMode: 'audit_only',
        policies: [
          { id: 's', kind: 'lifecycle_silence', seconds: 900 },
          { id: 'd', kind: 'deadline_unclosed', at: new Date(now + 3_600_000).toISOString() },
        ],
      },
    }])
    const state = await store.load(SESSION)
    expect(state).toBeDefined()
    const at = nextEvaluationAtMs(state as never, DEFAULT_CONFIG)
    expect(at).toBe(now + 900_000)
    void ctx.fiber.dispose()
  })
  it('ignores closed guards and returns infinity without policies', async () => {
    const ctx = new Context()
    const empty = { version: 1, sessionId: SESSION as SessionOwnerId, nextGuardianOrdinal: 1, nextIncidentOrdinal: 1, guards: [] }
    expect(nextEvaluationAtMs(empty as never, DEFAULT_CONFIG)).toBe(Number.POSITIVE_INFINITY)
    const dir = mkdtempSync(join(tmpdir(), 'supervisor-closed-'))
    const store = new FileSupervisorStore(ctx, dir)
    await store.append(SESSION, [create])
    await store.append(SESSION, [{ version: 1, kind: 'control', atMs: 2000, guardId: 'g1', operation: 'close' }])
    const closed = await store.load(SESSION)
    expect(nextEvaluationAtMs(closed as never, DEFAULT_CONFIG)).toBe(Number.POSITIVE_INFINITY)
    void ctx.fiber.dispose()
  })
  it('skips superseded policies when computing the next evaluation', async () => {
    const ctx = new Context()
    const dir = mkdtempSync(join(tmpdir(), 'supervisor-superseded-'))
    const store = new FileSupervisorStore(ctx, dir)
    await store.append(SESSION, [create])
    await store.append(SESSION, [{ version: 1, kind: 'revise', atMs: 2000, guardId: 'g1', expectedRevision: 1, policies: [{ id: 'd', kind: 'deadline_unclosed', at: '2030-01-01T00:00:00Z' }] }])
    const state = await store.load(SESSION)
    const at = nextEvaluationAtMs(state as never, DEFAULT_CONFIG)
    expect(at).toBe(Date.parse('2030-01-01T00:00:00Z'))
    void ctx.fiber.dispose()
  })
  it('re-arms after a delivery receipt persist failure', async () => {
    const ctx = new Context()
    const crafted = (() => {
      let s = foldEvent(newLedgerState(SESSION), { ...create, atMs: 1000 })
      s = foldEvent(s, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p1', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
      s = foldEvent(s, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p1', policyRevision: 1, incidentOrdinal: 1 })
      return s
    })()
    let appends = 0
    const store = new ScriptedStore(ctx, async () => crafted, async () => {
      appends += 1
      throw new Error('write refused')
    })
    const timers = new VirtualTimerContext()
    const agent = {
      id: SESSION,
      session: { id: SESSION, header: { parentSession: undefined } },
      ctx: { on: () => () => {} },
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
      whenIdle: async () => {},
      followup: () => { throw new Error('inbox down') },
    } as unknown as Agent
    const runtime = new SessionSupervisorRuntime(agent, {
      timeout: (cb: () => void, delay: number) => timers.timeout(cb, delay),
      logger: () => ({ warn: () => {} }),
    } as never, {
      store,
      config: { ...DEFAULT_CONFIG, deliveryRetryDelaysMs: [] },
      tracker: new ActivityTracker(),
      target: { followup: () => { throw new Error('inbox down') } },
    })
    runtime.start()
    timers.fireAll()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(appends).toBeGreaterThan(0)
    expect(timers.pending.some(timer => !timer.cancelled)).toBe(true)
    runtime.dispose()
    void ctx.fiber.dispose()
  })
  it('falls back to a fixed retry delay when the delay table is empty', async () => {
    const ctx = new Context()
    const state = foldEvent(newLedgerState(SESSION), { ...create, atMs: 1000 })
    const timers = new VirtualTimerContext()
    const agent = {
      id: SESSION,
      session: { id: SESSION, header: { parentSession: undefined } },
      ctx: { on: () => () => {} },
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
      whenIdle: async () => {},
      followup: () => { throw new Error('inbox down') },
    } as unknown as Agent
    const store = new ScriptedStore(ctx, async () => state, async () => state)
    const runtime = new SessionSupervisorRuntime(agent, {
      timeout: (cb: () => void, delay: number) => timers.timeout(cb, delay),
      logger: () => ({ warn: () => {} }),
    } as never, {
      store,
      config: { ...DEFAULT_CONFIG, deliveryRetryDelaysMs: [], maxDeliveryAttempts: 2 },
      tracker: new ActivityTracker(),
      target: { followup: () => {} },
    })
    // deliver one open incident so a failed receipt needs a retry delay
    const crafted = (() => {
      let s = foldEvent(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p1', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
      s = foldEvent(s, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p1', policyRevision: 1, incidentOrdinal: 1 })
      return s
    })()
    const failingCtx = new Context()
    const failing = new ScriptedStore(failingCtx, async () => crafted, async () => crafted)
    const failingRuntime = new SessionSupervisorRuntime(agent, {
      timeout: (cb: () => void, delay: number) => timers.timeout(cb, delay),
      logger: () => ({ warn: () => {} }),
    } as never, {
      store: failing,
      config: { ...DEFAULT_CONFIG, deliveryRetryDelaysMs: [] },
      tracker: new ActivityTracker(),
      target: { followup: () => { throw new Error('inbox down') } },
    })
    failingRuntime.start()
    timers.fireAll()
    await new Promise(resolve => setTimeout(resolve, 20))
    const retry = timers.pending.filter(timer => !timer.cancelled)
    expect(retry.length).toBeGreaterThan(0)
    expect(retry.some(timer => timer.delay === 1_000)).toBe(true)
    failingRuntime.dispose()
    void runtime.dispose()
    void failingCtx.fiber.dispose()
    void ctx.fiber.dispose()
  })
})

describe('root detection', () => {
  it('recognizes roots and forks via parentSession', () => {
    const root = { session: { header: { parentSession: undefined } } } as unknown as Agent
    const fork = { session: { header: { parentSession: 'parent' } } } as unknown as Agent
    expect(isRootAgent(root)).toBe(true)
    expect(isRootAgent(fork)).toBe(false)
  })
})

class ScriptedStore extends SupervisorStore {
  constructor(
    ctx: Context,
    private readonly onLoad: () => Promise<GuardianLedgerState | undefined>,
    private readonly onAppend: () => Promise<GuardianLedgerState>,
  ) {
    super(ctx)
  }

  async load(): Promise<GuardianLedgerState | undefined> {
    return this.onLoad()
  }

  async append(): Promise<GuardianLedgerState> {
    return this.onAppend()
  }
}

describe('runtime failure paths', () => {
  it('recovers held facts and re-arms after a drive failure', async () => {
    const ctx = new Context()
    const tracker = new ActivityTracker()
    const stored = foldEvent(newLedgerState(SESSION), { ...create, atMs: 1000 })
    const failing = new ScriptedStore(ctx, async () => stored, async () => { throw new Error('disk full') })
    const timers = new VirtualTimerContext()
    const agent = {
      id: SESSION,
      session: { id: SESSION, header: { parentSession: undefined } },
      ctx: { on: () => () => {} },
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
      whenIdle: async () => {},
      followup: () => {},
    } as unknown as Agent
    const runtime = new SessionSupervisorRuntime(agent, {
      timeout: (cb: () => void, delay: number) => timers.timeout(cb, delay),
      logger: () => ({ warn: () => {} }),
    } as never, {
      store: failing,
      config: { ...DEFAULT_CONFIG, deliveryRetryDelaysMs: [] },
      tracker,
      target: { followup: () => {} },
    })
    trackSessionEvent(tracker, SESSION, { type: 'turn/end', seq: 1, time: 100, data: { reason: { kind: 'error' } } } as never)
    const realNow = Date.now
    Date.now = () => 1000 + 900_000 + 61_000
    runtime.start()
    timers.fireAll()
    Date.now = realNow
    await new Promise(resolve => setTimeout(resolve, 20))
    // the failure restored the held facts and armed a retry timer
    expect(tracker.holdTurnEnds(SESSION)).toHaveLength(1)
    expect(timers.pending.some(timer => !timer.cancelled)).toBe(true)
    runtime.dispose()
    void ctx.fiber.dispose()
  })
  it('dead-letters with a terminal receipt even when the terminal persist fails', async () => {
    const ctx = new Context()
    const state = (() => {
      let s = { version: 1, sessionId: SESSION as SessionOwnerId, nextGuardianOrdinal: 2, nextIncidentOrdinal: 2, guards: [{
        id: 'g1', revision: 1, label: 'g', ownerSessionId: SESSION, createdAt: '', controlState: 'armed', notificationMode: 'owner_followup',
        policies: [{ id: 'p1', kind: 'lifecycle_silence', seconds: 900, guardRevision: 1, phase: 'open', observation: { anchorAtMs: 1000, streak: 0 }, currentIncidentOrdinal: 1 }],
        incidents: [{ ordinal: 1, guardId: 'g1', policyId: 'p1', policyRevision: 1, phase: 'open', openedAtMs: 2000, delivery: { state: 'failed', attempts: 0 } }],
      }] }
      return s as unknown as GuardianLedgerState
    })()
    let appends = 0
    const store = new ScriptedStore(ctx, async () => state, async () => {
      appends += 1
      if (appends === 1) return state
      throw new Error('write refused')
    })
    const timers = new VirtualTimerContext()
    const agent = {
      id: SESSION,
      session: { id: SESSION, header: { parentSession: undefined } },
      ctx: { on: () => () => {} },
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
      whenIdle: async () => {},
      followup: () => {},
    } as unknown as Agent
    const runtime = new SessionSupervisorRuntime(agent, {
      timeout: (cb: () => void, delay: number) => timers.timeout(cb, delay),
      logger: () => ({ warn: () => {} }),
    } as never, {
      store,
      config: { ...DEFAULT_CONFIG, maxDeliveryAttempts: 1 },
      tracker: new ActivityTracker(),
      target: { followup: () => { throw new Error('inbox down') } },
    })
    runtime.start()
    timers.fireAll()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(appends).toBeGreaterThan(0)
    runtime.dispose()
    void ctx.fiber.dispose()
  })
  it('suspect confirmation windows drive the next evaluation', async () => {
    const ctx = new Context()
    const dir = mkdtempSync(join(tmpdir(), 'supervisor-suspect-'))
    const store = new FileSupervisorStore(ctx, dir)
    let state = foldEvent(newLedgerState(SESSION), { ...create, atMs: 1000 })
    state = foldEvent(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p1', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 3000, streak: 0 })
    await store.append(SESSION, [create])
    await store.append(SESSION, [{ version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p1', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 3000, streak: 0 }])
    const loaded = await store.load(SESSION)
    const at = nextEvaluationAtMs(loaded as never, DEFAULT_CONFIG)
    // suspect confirmation (breachSince + 60s) is sooner than the silence threshold
    expect(at).toBe(3000 + 60_000)
    void ctx.fiber.dispose()
  })
  it('does nothing when started after dispose', async () => {
    const h = await buildHarness({}, { ...create, atMs: 1000 })
    h.runtime.dispose()
    h.runtime.start()
    expect(h.timers.pending).toHaveLength(0)
    expect(h.sessionListeners).toHaveLength(0)
    void h.ctx.fiber.dispose()
  })
  it('feeds live session events into the tracker and re-arms the drive', async () => {
    const h = await buildHarness({}, { ...create, atMs: 1000 })
    h.runtime.start()
    h.timers.fireAll()
    await new Promise(resolve => setTimeout(resolve, 10))
    const before = h.timers.pending.length
    const listener = h.sessionListeners[0]
    expect(listener).toBeDefined()
    ;(listener as (session: unknown, event: unknown) => void)({}, { type: 'tool/result', seq: 1, time: 5000, data: {} } as never)
    expect(h.tracker.lastQualifyingActivityAtMs(SESSION)).toBe(5000)
    expect(h.timers.pending.length).toBeGreaterThan(before)
    h.runtime.dispose()
    void h.ctx.fiber.dispose()
  })
  it('arms no timer for an empty ledger', async () => {
    const h = await buildHarness({}, null)
    h.runtime.start()
    h.timers.fireAll()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.timers.pending.every(timer => timer.cancelled)).toBe(true)
    h.runtime.dispose()
    void h.ctx.fiber.dispose()
  })
})

describe('dispose safety', () => {
  it('cancels pending timers and stops re-arming', async () => {
    const h = await buildHarness({}, { ...create, atMs: 1000 })
    const before = Date.now()
    const realNow = Date.now
    Date.now = () => before
    h.runtime.start()
    h.runtime.dispose()
    h.timers.fireAll()
    Date.now = realNow
    expect(h.followupSpy).not.toHaveBeenCalled()
    const state = await h.store.load(SESSION)
    expect(state?.guards[0]?.incidents).toHaveLength(0)
    void h.ctx.fiber.dispose()
  })
})
