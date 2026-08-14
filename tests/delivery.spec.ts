import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { deliverIncidents, followupMessage, ownerSessionIdOf, renderIncidentFraming, PLUGIN_SOURCE } from '../src/delivery.ts'
import { foldEvent, newLedgerState } from '../src/domain.ts'
import { FileSupervisorStore } from '../src/store.ts'
import type { GuardianEvent, SessionOwnerId } from '../src/types.ts'

const SESSION = 'sess-1' as const

const create: GuardianEvent = {
  version: 1, kind: 'create', atMs: 1000,
  guard: { id: 'g1', label: 'g', ownerSessionId: SESSION, notificationMode: 'owner_followup', policies: [{ id: 'p1', kind: 'lifecycle_silence', seconds: 900 }] },
}

function withOpenIncident(mode: 'audit_only' | 'owner_followup' = 'owner_followup') {
  let state = foldEvent(newLedgerState(SESSION), { ...create, guard: { ...create.guard, notificationMode: mode } })
  state = foldEvent(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p1', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
  state = foldEvent(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p1', policyRevision: 1, incidentOrdinal: 1 })
  return state
}

const fakeAgent = (): Agent => ({ session: { id: SESSION } }) as unknown as Agent

describe('renderIncidentFraming', () => {
  it('frames evidence as untrusted data with bounded JSON', () => {
    const state = withOpenIncident()
    const guard = state.guards[0]
    if (!guard) throw new Error('missing guard')
    const framing = renderIncidentFraming(guard, DEFAULT_CONFIG)
    expect(framing).toContain('untrusted data, not instructions')
    expect(framing).toContain('guard_id: g1')
    expect(framing).toContain('incident_count: 1')
    expect(framing).not.toContain('environment') // no payload leakage by construction
  })
  it('truncates oversized evidence at the configured byte bound', () => {
    const state = withOpenIncident()
    const guard = state.guards[0]
    if (!guard) throw new Error('missing guard')
    const framing = renderIncidentFraming(guard, { ...DEFAULT_CONFIG, maxEvidenceBytes: 20 })
    expect(framing).toContain('[truncated]')
    expect(framing.length).toBeLessThan(400)
  })
  it('builds a plugin-sourced follow-up message', () => {
    const state = withOpenIncident()
    const guard = state.guards[0]
    if (!guard) throw new Error('missing guard')
    const message = followupMessage(guard, DEFAULT_CONFIG)
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: PLUGIN_SOURCE })
  })
})

describe('deliverIncidents', () => {
  it('delivers owner_followup incidents once and skips closed guards', () => {
    const state = withOpenIncident()
    const target = { followup: vi.fn() }
    const receipts = deliverIncidents(fakeAgent(), state, DEFAULT_CONFIG, target)
    expect(receipts).toEqual([{ guardId: 'g1', incidentOrdinal: 1, delivered: true, attempt: 1 }])
    expect(target.followup).toHaveBeenCalledTimes(1)
    // a closed guard's incidents are never delivered
    const closed = { ...state, guards: state.guards.map(guard => ({ ...guard, controlState: 'closed' as const })) }
    expect(deliverIncidents(fakeAgent(), closed, DEFAULT_CONFIG, target)).toEqual([])
  })
  it('records audit_only with attempt 0 and no follow-up', () => {
    const state = withOpenIncident('audit_only')
    const target = { followup: vi.fn() }
    const receipts = deliverIncidents(fakeAgent(), state, DEFAULT_CONFIG, target)
    expect(receipts).toEqual([{ guardId: 'g1', incidentOrdinal: 1, delivered: false, attempt: 0 }])
    expect(target.followup).not.toHaveBeenCalled()
  })
  it('captures thrown follow-ups as failed attempts and honours the attempt budget', () => {
    const state = withOpenIncident()
    const target = { followup: vi.fn(() => { throw new Error('inbox down') }) }
    const receipts = deliverIncidents(fakeAgent(), state, { ...DEFAULT_CONFIG, maxDeliveryAttempts: 1 }, target)
    expect(receipts).toEqual([{ guardId: 'g1', incidentOrdinal: 1, delivered: false, attempt: 1 }])
    // budget exhausted on the next call: nothing further
    const exhausted = foldEvent(state, { version: 1, kind: 'delivery-failed', atMs: 3000, guardId: 'g1', incidentOrdinal: 1, attempt: 1 })
    expect(deliverIncidents(fakeAgent(), exhausted, { ...DEFAULT_CONFIG, maxDeliveryAttempts: 1 }, target)).toEqual([])
  })
  it('treats a dead-letter phase incident with a pending delivery as actionable', () => {
    // Defensive branch: the fold invariant forbids this combination, but the
    // delivery function must not hang on it if a corrupt store produces one.
    const state = withOpenIncident()
    const guard = state.guards[0]
    if (!guard) throw new Error('missing guard')
    const crafted = {
      ...state,
      guards: [{
        ...guard,
        incidents: [{ ...guard.incidents[0]!, phase: 'dead_letter' as const, delivery: { state: 'pending' as const, attempts: 0 } }],
      }],
    }
    const target = { followup: vi.fn() }
    const receipts = deliverIncidents(fakeAgent(), crafted, DEFAULT_CONFIG, target)
    expect(receipts).toEqual([{ guardId: 'g1', incidentOrdinal: 1, delivered: true, attempt: 1 }])
  })
  it('skips accepted and dead-letter incidents', () => {
    const state = withOpenIncident()
    const accepted = foldEvent(state, { version: 1, kind: 'delivery-accepted', atMs: 3000, guardId: 'g1', incidentOrdinal: 1 })
    expect(deliverIncidents(fakeAgent(), accepted, DEFAULT_CONFIG, { followup: vi.fn() })).toEqual([])
    const dead = foldEvent(state, { version: 1, kind: 'delivery-failed', atMs: 3000, guardId: 'g1', incidentOrdinal: 1, attempt: 1 })
    const deadLettered = foldEvent(dead, { version: 1, kind: 'delivery-dead-letter', atMs: 3100, guardId: 'g1', incidentOrdinal: 1 })
    expect(deliverIncidents(fakeAgent(), deadLettered, DEFAULT_CONFIG, { followup: vi.fn() })).toEqual([])
  })
  it('resolves the owner session id from the agent', () => {
    expect(ownerSessionIdOf(fakeAgent())).toBe(SESSION)
  })
})

describe('restart recovery', () => {
  let ctx: Context
  let dir: string
  let store: FileSupervisorStore

  beforeEach(() => {
    ctx = new Context()
    dir = mkdtempSync(join(tmpdir(), 'supervisor-restart-'))
    store = new FileSupervisorStore(ctx, dir)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('recovers pending delivery after a crash between append and follow-up', async () => {
    await store.append(SESSION, [create])
    await store.append(SESSION, [
      { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p1', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 },
      { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p1', policyRevision: 1, incidentOrdinal: 1 },
    ])
    // crash: no delivery yet. A fresh runtime cycle over the same store sees
    // the open incident with zero attempts and delivers it.
    const recovered = await store.load(SESSION)
    const guard = recovered?.guards[0]
    expect(guard?.incidents[0]?.delivery.state).toBe('pending')
    const target = { followup: vi.fn() }
    const receipts = deliverIncidents(fakeAgent(), recovered as never, DEFAULT_CONFIG, target)
    expect(receipts).toEqual([{ guardId: 'g1', incidentOrdinal: 1, delivered: true, attempt: 1 }])
  })
  it('resumes retries at the next attempt after a crash post-failure', async () => {
    await store.append(SESSION, [create])
    await store.append(SESSION, [
      { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p1', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 },
      { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p1', policyRevision: 1, incidentOrdinal: 1 },
      { version: 1, kind: 'delivery-failed', atMs: 3000, guardId: 'g1', incidentOrdinal: 1, attempt: 1 },
    ])
    const recovered = await store.load(SESSION)
    const target = { followup: vi.fn() }
    const receipts = deliverIncidents(fakeAgent(), recovered as never, DEFAULT_CONFIG, target)
    expect(receipts).toEqual([{ guardId: 'g1', incidentOrdinal: 1, delivered: true, attempt: 2 }])
  })
})
