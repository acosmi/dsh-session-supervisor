import { describe, expect, it } from 'vitest'
import {
  decodeGuardianEvent,
  foldEvent,
  foldEvents,
  guardDetailView,
  guardListView,
  newLedgerState,
  GuardianLogError,
} from '../src/domain.ts'
import type { GuardianEvent, GuardianLedgerState, GuardianPolicySpec, NotificationMode } from '../src/types.ts'

const SESSION = 'sess-1' as const
const SILENCE: GuardianPolicySpec = { id: 'p-silence', kind: 'lifecycle_silence', seconds: 900 }
const DEADLINE: GuardianPolicySpec = { id: 'p-deadline', kind: 'deadline_unclosed', at: '2026-08-13T12:00:00Z' }
const STREAK: GuardianPolicySpec = { id: 'p-streak', kind: 'abnormal_turn_streak', count: 3 }

interface CreateOver {
  atMs?: number
  label?: string
  mode?: NotificationMode
  policies?: GuardianPolicySpec[]
  guardId?: string
  owner?: string
}

function createEvent(over: CreateOver = {}): GuardianEvent {
  return {
    version: 1,
    kind: 'create',
    atMs: over.atMs ?? 1000,
    guard: {
      id: over.guardId ?? 'g1',
      label: over.label ?? 'guard one',
      ownerSessionId: over.owner ?? SESSION,
      notificationMode: over.mode ?? 'audit_only',
      policies: over.policies ?? [SILENCE],
    },
  }
}

const fold = (state: GuardianLedgerState, event: GuardianEvent): GuardianLedgerState => foldEvent(state, event)
const guardOf = (state: GuardianLedgerState, id = 'g1') => {
  const guard = state.guards.find(candidate => candidate.id === id)
  if (!guard) throw new Error(`missing guard ${id}`)
  return guard
}
const policyOf = (state: GuardianLedgerState, id = 'p-silence', guardId = 'g1') => {
  const policy = guardOf(state, guardId).policies.find(candidate => candidate.id === id)
  if (!policy) throw new Error(`missing policy ${id}`)
  return policy
}

describe('decodeGuardianEvent', () => {
  it('rejects unknown versions and kinds', () => {
    expect(() => decodeGuardianEvent({ ...createEvent(), version: 2 })).toThrow(/unsupported event version/)
    expect(() => decodeGuardianEvent({ ...createEvent(), kind: 'nope' })).toThrow(/unknown event kind/)
  })
  it('rejects extra fields on the envelope and nested guards', () => {
    expect(() => decodeGuardianEvent({ ...createEvent(), extra: 1 })).toThrow(/unknown field/)
    expect(() => decodeGuardianEvent({
      version: 1,
      kind: 'create',
      atMs: 1,
      guard: { id: 'g1', label: 'x', ownerSessionId: SESSION, notificationMode: 'audit_only', policies: [SILENCE], extra: 1 },
    })).toThrow(/unknown field/)
  })
  it('rejects malformed ids, labels, and counts', () => {
    expect(() => decodeGuardianEvent(createEvent({ guardId: 'UPPER' }))).toThrow(/not a valid id/)
    expect(() => decodeGuardianEvent(createEvent({ guardId: '' }))).toThrow(/length out of bounds/)
    expect(() => decodeGuardianEvent({ ...createEvent(), guard: { ...createEvent().guard, policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 0 }] } }))
      .toThrow(/positive safe integer/)
    expect(() => decodeGuardianEvent({ ...createEvent(), guard: { ...createEvent().guard, policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 1.5 }] } }))
      .toThrow(/positive safe integer/)
    expect(() => decodeGuardianEvent({ ...createEvent(), guard: { ...createEvent().guard, policies: [{ id: 'p', kind: 'abnormal_turn_streak', count: 0 }] } }))
      .toThrow(/positive safe integer/)
    expect(() => decodeGuardianEvent({ ...createEvent(), guard: { ...createEvent().guard, policies: [] } })).toThrow(/at least one policy/)
    expect(() => decodeGuardianEvent({ ...createEvent(), guard: { ...createEvent().guard, policies: [SILENCE, { ...DEADLINE, id: 'p-silence' }] } }))
      .toThrow(/duplicate policy id/)
  })
  it('rejects invalid deadline text and unknown phases', () => {
    expect(() => decodeGuardianEvent({ ...createEvent(), guard: { ...createEvent().guard, policies: [{ id: 'p', kind: 'deadline_unclosed', at: '2026-08-13 12:00:00Z' }] } }))
      .toThrow(/strict RFC 3339/)
    expect(() => decodeGuardianEvent({ ...createEvent(), guard: { ...createEvent().guard, policies: [{ id: 'p', kind: 'deadline_unclosed', at: '2026-02-30T00:00:00Z' }] } }))
      .toThrow(/invalid day/)
    expect(() => decodeGuardianEvent({
      version: 1,
      kind: 'policy-observe',
      atMs: 1,
      guardId: 'g1',
      policyId: 'p',
      phase: 'wat',
      anchorAtMs: 0,
      streak: 0,
    })).toThrow(/unknown policy phase/)
  })
})

describe('fold: create / revise / control', () => {
  it('creates a guard with armed state, revision 1, and per-policy records', () => {
    const state = fold(newLedgerState(SESSION), createEvent())
    const guard = guardOf(state)
    expect(guard.revision).toBe(1)
    expect(guard.controlState).toBe('armed')
    expect(guard.policies).toHaveLength(1)
    expect(policyOf(state).phase).toBe('healthy')
    expect(state.nextGuardianOrdinal).toBe(2)
  })
  it('rejects duplicate guard ids and cross-owner creates', () => {
    const base = fold(newLedgerState(SESSION), createEvent())
    expect(() => fold(base, createEvent())).toThrow(/already exists/)
    expect(() => fold(newLedgerState(SESSION), createEvent({ owner: 'other-session' }))).toThrow(/does not match session/)
  })
  it('revises only at the expected revision and bumps kept policies', () => {
    let state = fold(newLedgerState(SESSION), createEvent())
    expect(() => fold(state, { version: 1, kind: 'revise', atMs: 2000, guardId: 'g1', expectedRevision: 3, label: 'x', policies: [SILENCE] }))
      .toThrow(/expected revision/)
    state = fold(state, { version: 1, kind: 'revise', atMs: 2000, guardId: 'g1', expectedRevision: 1, label: 'renamed', policies: [SILENCE] })
    expect(guardOf(state).revision).toBe(2)
    expect(guardOf(state).label).toBe('renamed')
    expect(policyOf(state).guardRevision).toBe(2)
  })
  it('supersedes open incidents of removed or changed policies on revise', () => {
    let state = fold(newLedgerState(SESSION), createEvent())
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p-silence', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
    state = fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'revise', atMs: 3000, guardId: 'g1', expectedRevision: 1, policies: [DEADLINE] })
    expect(guardOf(state).incidents[0]?.phase).toBe('superseded')
    expect(guardOf(state).policies.find(p => p.id === 'p-silence')?.phase).toBe('superseded')
    expect(guardOf(state).policies.find(p => p.id === 'p-deadline')?.phase).toBe('healthy')
  })
  it('pause/resume/close enforce their transitions and re-anchor silence', () => {
    let state = fold(newLedgerState(SESSION), createEvent())
    expect(() => fold(state, { version: 1, kind: 'control', atMs: 1, guardId: 'g1', operation: 'pause' })).not.toThrow()
    state = fold(state, { version: 1, kind: 'control', atMs: 1500, guardId: 'g1', operation: 'pause' })
    expect(() => fold(state, { version: 1, kind: 'control', atMs: 1600, guardId: 'g1', operation: 'pause' })).toThrow(/cannot pause/)
    state = fold(state, { version: 1, kind: 'control', atMs: 2000, guardId: 'g1', operation: 'resume' })
    expect(policyOf(state).observation.anchorAtMs).toBe(2000)
    expect(() => fold(state, { version: 1, kind: 'control', atMs: 2100, guardId: 'g1', operation: 'resume' })).toThrow(/cannot resume/)
    state = fold(state, { version: 1, kind: 'control', atMs: 3000, guardId: 'g1', operation: 'close' })
    expect(guardOf(state).controlState).toBe('closed')
    expect(() => fold(state, { version: 1, kind: 'control', atMs: 3100, guardId: 'g1', operation: 'close' })).toThrow(/already closed/)
  })
})

describe('fold: policy-observe', () => {
  it('allows healthy→suspect and suspect→healthy, rejects illegal transitions', () => {
    let state = fold(newLedgerState(SESSION), createEvent())
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 1, guardId: 'g1', policyId: 'p-silence', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 2000, streak: 0 })
    expect(policyOf(state).phase).toBe('suspect')
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 2, guardId: 'g1', policyId: 'p-silence', phase: 'healthy', anchorAtMs: 1000, streak: 0 })
    expect(policyOf(state).phase).toBe('healthy')
    expect(() => fold(state, { version: 1, kind: 'policy-observe', atMs: 3, guardId: 'g1', policyId: 'p-silence', phase: 'resolved', anchorAtMs: 1000, streak: 0 }))
      .toThrow(/illegal phase transition/)
  })
  it('clears the incident linkage on the first healthy epoch after resolution', () => {
    let state = fold(newLedgerState(SESSION), createEvent())
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p-silence', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
    state = fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-recover', atMs: 2500, guardId: 'g1', incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-resolve', atMs: 3000, guardId: 'g1', incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 3100, guardId: 'g1', policyId: 'p-silence', phase: 'healthy', anchorAtMs: 1000, lastActivityAtMs: 3050, streak: 0 })
    expect(policyOf(state).currentIncidentOrdinal).toBeUndefined()
    expect(guardOf(state).incidents[0]?.phase).toBe('resolved')
  })
  it('freezes observations of dead-letter and superseded policies', () => {
    let state = fold(newLedgerState(SESSION), createEvent())
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p-silence', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
    state = fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'delivery-failed', atMs: 2100, guardId: 'g1', incidentOrdinal: 1, attempt: 1 })
    state = fold(state, { version: 1, kind: 'delivery-dead-letter', atMs: 2200, guardId: 'g1', incidentOrdinal: 1 })
    expect(policyOf(state).phase).toBe('dead_letter')
    expect(() => fold(state, { version: 1, kind: 'policy-observe', atMs: 2300, guardId: 'g1', policyId: 'p-silence', phase: 'suspect', anchorAtMs: 1000, streak: 0 }))
      .toThrow(/observations are frozen/)
  })
})

describe('fold: incident lifecycle', () => {
  const openIncident = (policies: GuardianPolicySpec[] = [SILENCE]) => {
    let state = fold(newLedgerState(SESSION), createEvent({ policies }))
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: policies[0]?.id ?? 'p', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
    return state
  }
  it('opens only from suspect with matching revision and allocated ordinal', () => {
    let state = fold(newLedgerState(SESSION), createEvent())
    expect(() => fold(state, { version: 1, kind: 'incident-open', atMs: 1, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 }))
      .toThrow(/requires suspect/)
    state = openIncident()
    expect(() => fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 9, incidentOrdinal: 1 }))
      .toThrow(/revision/)
    expect(() => fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 5 }))
      .toThrow(/allocated in order/)
    state = fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 })
    expect(policyOf(state).phase).toBe('open')
    expect(state.nextIncidentOrdinal).toBe(2)
  })
  it('acknowledges idempotently and rejects resolved incidents', () => {
    let state = openIncident()
    state = fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-acknowledge', atMs: 2100, guardId: 'g1', incidentOrdinal: 1 })
    expect(policyOf(state).phase).toBe('acknowledged')
    expect(fold(state, { version: 1, kind: 'incident-acknowledge', atMs: 2200, guardId: 'g1', incidentOrdinal: 1 })).toBe(state)
    const resolved = fold(fold(state, { version: 1, kind: 'incident-recover', atMs: 2300, guardId: 'g1', incidentOrdinal: 1 }),
      { version: 1, kind: 'incident-resolve', atMs: 2400, guardId: 'g1', incidentOrdinal: 1 })
    expect(() => fold(resolved, { version: 1, kind: 'incident-acknowledge', atMs: 2500, guardId: 'g1', incidentOrdinal: 1 }))
      .toThrow(/cannot acknowledge/)
  })
  it('recovers/reopens/resolves only in legal phases', () => {
    let state = openIncident()
    state = fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 })
    expect(() => fold(state, { version: 1, kind: 'incident-resolve', atMs: 1, guardId: 'g1', incidentOrdinal: 1 })).toThrow(/cannot resolve/)
    state = fold(state, { version: 1, kind: 'incident-recover', atMs: 2100, guardId: 'g1', incidentOrdinal: 1 })
    expect(policyOf(state).phase).toBe('recovering')
    expect(fold(state, { version: 1, kind: 'incident-recover', atMs: 2200, guardId: 'g1', incidentOrdinal: 1 })).toBe(state)
    state = fold(state, { version: 1, kind: 'incident-reopen', atMs: 2300, guardId: 'g1', incidentOrdinal: 1 })
    expect(policyOf(state).phase).toBe('open')
    expect(() => fold(state, { version: 1, kind: 'incident-reopen', atMs: 2400, guardId: 'g1', incidentOrdinal: 1 })).toThrow(/cannot reopen/)
  })
  it('delivery attempts advance contiguously and dead-letter is terminal', () => {
    let state = openIncident()
    state = fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 })
    expect(() => fold(state, { version: 1, kind: 'delivery-failed', atMs: 2100, guardId: 'g1', incidentOrdinal: 1, attempt: 5 }))
      .toThrow(/contiguously/)
    state = fold(state, { version: 1, kind: 'delivery-failed', atMs: 2100, guardId: 'g1', incidentOrdinal: 1, attempt: 1 })
    state = fold(state, { version: 1, kind: 'delivery-accepted', atMs: 2200, guardId: 'g1', incidentOrdinal: 1 })
    expect(guardOf(state).incidents[0]?.delivery.state).toBe('accepted')
    expect(fold(state, { version: 1, kind: 'delivery-accepted', atMs: 2300, guardId: 'g1', incidentOrdinal: 1 })).toBe(state)
  })
})

describe('views and replay', () => {
  it('lists guards and renders bounded incident views', () => {
    let state = fold(newLedgerState(SESSION), createEvent())
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p-silence', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
    state = fold(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 })
    expect(guardListView(state)).toHaveLength(1)
    const detail = guardDetailView(state, 'g1')
    expect(detail?.incidents[0]?.id).toBe('g1/incident-1')
    expect(detail?.incidents[0]?.delivery.state).toBe('pending')
    expect(guardDetailView(state, 'nope')).toBeUndefined()
  })
  it('replays event sequences identically', () => {
    const events = [
      createEvent(),
      { version: 1, kind: 'control', atMs: 2000, guardId: 'g1', operation: 'pause' },
      { version: 1, kind: 'control', atMs: 3000, guardId: 'g1', operation: 'resume' },
    ] as const
    const first = foldEvents(newLedgerState(SESSION), events)
    const second = foldEvents(newLedgerState(SESSION), events)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
