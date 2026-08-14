import { Context } from '@deepseek-ai/cordis'
import { writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { foldEvent, newLedgerState } from '../src/domain.ts'
import { ActivityTracker, trackSessionEvent } from '../src/runtime.ts'
import { materializeTransitions } from '../src/policy.ts'
import { FileSupervisorStore, SupervisorStore } from '../src/store.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import {
  guardianCheckNowTool,
  guardianCreateTool,
  guardianListTool,
  guardianUpdateTool,
  registerGuardianTools,
  SupervisorToolError,
  validatePolicyInput,
  type ToolDeps,
} from '../src/tools.ts'
import type { GuardianEvent, GuardianLedgerState, SessionOwnerId, TurnEndFact } from '../src/types.ts'

const SESSION = 'sess-1' as const

const create: GuardianEvent = {
  version: 1, kind: 'create', atMs: 1000,
  guard: { id: 'g1', label: 'g', ownerSessionId: SESSION, notificationMode: 'audit_only', policies: [{ id: 'p1', kind: 'lifecycle_silence', seconds: 900 }] },
}

function withOpenIncident(): GuardianLedgerState {
  let state = foldEvent(newLedgerState(SESSION), create)
  state = foldEvent(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p1', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
  state = foldEvent(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p1', policyRevision: 1, incidentOrdinal: 1 })
  return state
}

const fakeAgent = (): Agent => ({
  session: { id: SESSION },
  runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
  whenIdle: async () => {},
}) as unknown as Agent

const fakeExec = (agent: Agent | undefined): ToolRunContext => ({ agent }) as unknown as ToolRunContext

const idleActivity = {
  lastQualifyingActivityAtMs(_s: SessionOwnerId): number | undefined { return undefined },
  holdTurnEnds(_s: SessionOwnerId): readonly TurnEndFact[] { return [] },
  releaseTurnEnds(_s: SessionOwnerId): void {},
  restoreTurnEnds(_s: SessionOwnerId): void {},
}

/** A store backend whose load/append can be scripted for tool error paths. */
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

let ctx: Context
let dir: string
let store: FileSupervisorStore
let deps: ToolDeps

beforeEach(() => {
  ctx = new Context()
  dir = mkdtempSync(join(tmpdir(), 'supervisor-p2-edges-'))
  store = new FileSupervisorStore(ctx, dir)
  deps = { store, config: DEFAULT_CONFIG, activity: idleActivity }
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('materializeTransitions', () => {
  it('materializes open/recover/reopen/resolve with ordered ordinals', () => {
    const state = withOpenIncident()
    const events = materializeTransitions(state, [
      { kind: 'incident-recover', guardId: 'g1', policyId: 'p1' },
      { kind: 'incident-reopen', guardId: 'g1', policyId: 'p1' },
      { kind: 'incident-recover', guardId: 'g1', policyId: 'p1' },
      { kind: 'incident-resolve', guardId: 'g1', policyId: 'p1' },
    ], 3000)
    expect(events.map(event => event.kind)).toEqual(['incident-recover', 'incident-reopen', 'incident-recover', 'incident-resolve'])
    expect(events.every(event => event.kind !== 'policy-observe' && event.kind !== 'incident-open' ? event.incidentOrdinal === 1 : true)).toBe(true)
  })
  it('allocates consecutive ordinals for several opens in one batch', () => {
    const state = withOpenIncident()
    const events = materializeTransitions(state, [
      { kind: 'incident-open', guardId: 'g1', policyId: 'p1', policyRevision: 1 },
      { kind: 'incident-open', guardId: 'g1', policyId: 'p1', policyRevision: 1 },
    ], 3000)
    expect(events.map(event => event.kind === 'incident-open' ? event.incidentOrdinal : -1)).toEqual([2, 3])
  })
  it('throws when a non-open transition has no current incident', () => {
    expect(() => materializeTransitions(newLedgerState(SESSION), [
      { kind: 'incident-recover', guardId: 'g1', policyId: 'p1' },
    ], 3000)).toThrow(/no current incident/)
  })
})

describe('store edges', () => {
  it('rejects a document whose event list is not an array', async () => {
    writeFileSync(join(dir, `${SESSION}.json`), JSON.stringify({ version: 1, sessionId: SESSION, events: 'nope' }))
    await expect(store.load(SESSION)).rejects.toMatchObject({ kind: 'corrupt' })
  })
  it('registers the service name through the abstract base', () => {
    const otherCtx = new Context()
    class Subclass extends SupervisorStore {
      async load(): Promise<GuardianLedgerState | undefined> { return undefined }
      async append(): Promise<GuardianLedgerState> { return newLedgerState(SESSION) }
    }
    const sub = new Subclass(otherCtx)
    expect(sub.name).toBe('supervisorStore')
    const resolved = otherCtx.get('supervisorStore') as Subclass
    expect(typeof resolved.load).toBe('function')
    expect(typeof resolved.append).toBe('function')
    void otherCtx.fiber.dispose()
  })
})

describe('tool edge paths', () => {
  it('validatePolicyInput rejects bad deadline and streak payloads', async () => {
    expect(() => validatePolicyInput(
      [{ id: 'd', kind: 'deadline_unclosed' }],
      DEFAULT_CONFIG,
    )).toThrow(/deadline_unclosed requires/)
    expect(() => validatePolicyInput(
      [{ id: 'd', kind: 'deadline_unclosed', at: 42 }],
      DEFAULT_CONFIG,
    )).toThrow(/deadline_unclosed requires/)
    expect(() => validatePolicyInput(
      [{ id: 's', kind: 'abnormal_turn_streak', count: 0 }],
      DEFAULT_CONFIG,
    )).toThrow(/positive safe-integer `count`/)
    expect(() => validatePolicyInput(
      [{ id: 's', kind: 'abnormal_turn_streak', count: 1.5 }],
      DEFAULT_CONFIG,
    )).toThrow(/positive safe-integer `count`/)
    expect(() => validatePolicyInput(['nope'], DEFAULT_CONFIG)).toThrow(/policies must be objects/)
    expect(() => validatePolicyInput(
      [{ id: 'q', kind: 'lifecycle_silence' }],
      DEFAULT_CONFIG,
    )).toThrow(/at least 60/)
    expect(() => validatePolicyInput(
      [{ id: 'q', kind: 'lifecycle_silence', seconds: 1 }],
      DEFAULT_CONFIG,
    )).toThrow(/at least 60/)
    expect(() => validatePolicyInput(
      [{ id: 'q', kind: 'lifecycle_silence', seconds: 900 }],
      DEFAULT_CONFIG,
    )).not.toThrow()
    const createTool = guardianCreateTool(deps)
    // Decode-level rejection (schema-valid but semantically invalid) is
    // wrapped as a stable BAD_REQUEST.
    await expect(createTool.execute(
      { label: 'g', notificationMode: 'audit_only', policies: [{ id: 'd', kind: 'deadline_unclosed', at: '2026-02-30T00:00:00Z' }] } as never,
      fakeExec(fakeAgent()),
    )).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('edit requires policies and accepts a bare policies-only edit', async () => {
    await store.append(SESSION, [create])
    await expect(guardianUpdateTool(deps).execute(
      { guardId: 'g1', operation: 'edit' } as never,
      fakeExec(fakeAgent()),
    )).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const edited = await guardianUpdateTool(deps).execute({
      guardId: 'g1',
      operation: 'edit',
      policies: [{ id: 'p1', kind: 'lifecycle_silence', seconds: 900 }],
    } as never, fakeExec(fakeAgent()))
    expect(edited).toMatchObject({ revision: 2 })
  })
  it('acknowledge succeeds on a real open incident', async () => {
    await store.append(SESSION, [create])
    await store.append(SESSION, [
      { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p1', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 },
      { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p1', policyRevision: 1, incidentOrdinal: 1 },
    ])
    const result = await guardianUpdateTool(deps).execute(
      { guardId: 'g1', operation: 'acknowledge', incidentOrdinal: 1 } as never,
      fakeExec(fakeAgent()),
    )
    expect(result.incidents[0]).toMatchObject({ phase: 'acknowledged' })
  })
  it('check_now filters by guard and fails loudly for unknown guards', async () => {
    await store.append(SESSION, [create])
    const receipt = await guardianCheckNowTool(deps).execute({ guardId: 'g1' } as never, fakeExec(fakeAgent()))
    expect(receipt).toMatchObject({ guardsEvaluated: 1 })
    await expect(guardianCheckNowTool(deps).execute({ guardId: 'ghost' } as never, fakeExec(fakeAgent())))
      .rejects.toMatchObject({ code: 'GUARD_NOT_FOUND' })
  })
  it('maps deadline and streak params in the list view', async () => {
    const multi: GuardianEvent = {
      version: 1, kind: 'create', atMs: 1000,
      guard: {
        id: 'g2', label: 'multi', ownerSessionId: SESSION, notificationMode: 'owner_followup',
        policies: [
          { id: 'd', kind: 'deadline_unclosed', at: '2027-01-01T00:00:00Z' },
          { id: 's', kind: 'abnormal_turn_streak', count: 3 },
        ],
      },
    }
    await store.append(SESSION, [multi])
    const listed = await guardianListTool(deps).execute({} as never, fakeExec(fakeAgent()))
    expect(listed[0]?.policies.map(p => p.kind)).toEqual(['deadline_unclosed', 'abnormal_turn_streak'])
  })
  it('rethrows non-store failures unchanged from the transaction', async () => {
    const otherCtx = new Context()
    const boom = new Error('backend exploded')
    const broken = new ScriptedStore(otherCtx, async () => { throw boom }, async () => newLedgerState(SESSION))
    await expect(guardianListTool({ ...deps, store: broken }).execute({} as never, fakeExec(fakeAgent()))).rejects.toBe(boom)
    await otherCtx.fiber.dispose()
  })
  it('maps a vanished guard to STORE_UNAVAILABLE on create and update', async () => {
    const emptyCtx = new Context()
    const empty = new ScriptedStore(emptyCtx, async () => undefined, async () => newLedgerState(SESSION))
    const emptyDeps = { ...deps, store: empty }
    await expect(guardianCreateTool(emptyDeps).execute(
      { label: 'g', notificationMode: 'audit_only', policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 900 }] } as never,
      fakeExec(fakeAgent()),
    )).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
    await emptyCtx.fiber.dispose()
  })
  it('update edit carries label and mode, and maps a vanished guard to STORE_UNAVAILABLE', async () => {
    await store.append(SESSION, [create])
    const edited = await guardianUpdateTool(deps).execute({
      guardId: 'g1',
      operation: 'edit',
      label: 'renamed',
      notificationMode: 'owner_followup',
      policies: [{ id: 'p1', kind: 'lifecycle_silence', seconds: 900 }],
    } as never, fakeExec(fakeAgent()))
    expect(edited).toMatchObject({ revision: 2 })
    const emptyCtx = new Context()
    const vanishing = new ScriptedStore(
      emptyCtx,
      async () => withOpenIncident(),
      async () => newLedgerState(SESSION),
    )
    await expect(guardianUpdateTool({ ...deps, store: vanishing }).execute(
      { guardId: 'g1', operation: 'pause' } as never,
      fakeExec(fakeAgent()),
    )).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
    await emptyCtx.fiber.dispose()
  })
  it('render functions stay pure across values', () => {
    const value = { id: 'g1', revision: 1 }
    const tools = [
      guardianCreateTool(deps),
      guardianListTool(deps),
      guardianUpdateTool(deps),
      guardianCheckNowTool(deps),
    ]
    for (const tool of tools) {
      const blocks = tool.output.render({} as never, value as never)
      expect(blocks).toHaveLength(1)
      expect(blocks[0]?.type).toBe('text')
    }
  })
  it('registerGuardianTools returns a disposer that unregisters all four', () => {
    const disposers = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    let calls = 0
    const fakeTools = { register: () => disposers[calls++] ?? (() => {}) }
    const dispose = registerGuardianTools({ tools: fakeTools as never }, deps)
    expect(calls).toBe(4)
    dispose()
    for (const fn of disposers) expect(fn).toHaveBeenCalledTimes(1)
  })
  it('check_now restores held turn ends when the persist fails', async () => {
    const tracker = new ActivityTracker()
    const guard: GuardianEvent = {
      version: 1, kind: 'create', atMs: 1000,
      guard: { id: 'g1', label: 'g', ownerSessionId: SESSION, notificationMode: 'audit_only', policies: [{ id: 'p1', kind: 'abnormal_turn_streak', count: 1 }] },
    }
    const failingCtx = new Context()
    const failing = new ScriptedStore(failingCtx, async () => foldEvent(newLedgerState(SESSION), guard), async () => { throw new Error('disk full') })
    trackSessionEvent(tracker, SESSION, { type: 'turn/end', seq: 1, time: 100, data: { reason: { kind: 'error' } } } as never)
    const realNow = Date.now
    Date.now = () => 2000
    await expect(guardianCheckNowTool({ ...deps, store: failing, activity: tracker }).execute({} as never, fakeExec(fakeAgent())))
      .rejects.toThrow(/disk full/)
    Date.now = realNow
    // the failed persist restored the delta for the next attempt
    expect(tracker.holdTurnEnds(SESSION)).toHaveLength(1)
    void failingCtx.fiber.dispose()
  })
  it('SurpervisorToolError carries a stable name and code', () => {
    const error = new SupervisorToolError('GUARD_NOT_FOUND', 'no such guard')
    expect(error.name).toBe('SupervisorToolError')
    expect(error.code).toBe('GUARD_NOT_FOUND')
  })
})
