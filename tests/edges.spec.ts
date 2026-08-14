import { describe, expect, it } from 'vitest'
import {
  allocateGuardianId,
  decodeGuardianEvent,
  DEFAULT_DECODE_LIMITS,
  foldEvent,
  guardDetailView,
  guardListView,
  newLedgerState,
} from '../src/domain.ts'
import { formatRfc3339Utc, isRfc3339Offset, parseRfc3339Offset } from '../src/rfc3339.ts'
import { assertLedgerInvariants, assertReplayDeterminism } from '../src/invariant.ts'
import { classifyTurnEndReason, evaluateGuard } from '../src/policy.ts'
import type { GuardianEvent, GuardianLedgerState, GuardianPolicySpec, PolicyTransition } from '../src/types.ts'

const SESSION = 'sess-1' as const
const CONFIG = { confirmationMs: 60_000, recoveryConfirmationMs: 30_000 }
const SILENCE: GuardianPolicySpec = { id: 'p-silence', kind: 'lifecycle_silence', seconds: 900 }
const DEADLINE: GuardianPolicySpec = { id: 'p-deadline', kind: 'deadline_unclosed', at: '2026-08-13T12:00:00Z' }
const STREAK: GuardianPolicySpec = { id: 'p-streak', kind: 'abnormal_turn_streak', count: 3 }

const create = (policies: GuardianPolicySpec[] = [SILENCE]): GuardianEvent => ({
  version: 1,
  kind: 'create',
  atMs: 1000,
  guard: { id: 'g1', label: 'guard', ownerSessionId: SESSION, notificationMode: 'audit_only', policies },
})

const fold = (state: GuardianLedgerState, event: GuardianEvent): GuardianLedgerState => foldEvent(state, event)

function guardOf(state: GuardianLedgerState, id = 'g1') {
  const guard = state.guards.find(candidate => candidate.id === id)
  if (!guard) throw new Error(`missing guard ${id}`)
  return guard
}

function openIncident(state: GuardianLedgerState, policyId = 'p-silence', revision = 1): GuardianLedgerState {
  let next = fold(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId, phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
  next = fold(next, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId, policyRevision: revision, incidentOrdinal: next.nextIncidentOrdinal })
  return next
}

function toEvent(state: GuardianLedgerState, transition: PolicyTransition): GuardianEvent {
  const guard = guardOf(state)
  if (transition.kind === 'policy-observe') {
    return {
      version: 1, kind: 'policy-observe', atMs: 1, guardId: transition.guardId, policyId: transition.policyId,
      phase: transition.phase, anchorAtMs: transition.anchorAtMs,
      ...(transition.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: transition.lastActivityAtMs }),
      ...(transition.breachSinceAtMs === undefined ? {} : { breachSinceAtMs: transition.breachSinceAtMs }),
      ...(transition.recoverySinceAtMs === undefined ? {} : { recoverySinceAtMs: transition.recoverySinceAtMs }),
      streak: transition.streak,
    }
  }
  if (transition.kind === 'incident-open') {
    return { version: 1, kind: 'incident-open', atMs: 1, guardId: transition.guardId, policyId: transition.policyId, policyRevision: transition.policyRevision, incidentOrdinal: state.nextIncidentOrdinal }
  }
  const policy = guard.policies.find(candidate => candidate.id === transition.policyId)
  const ordinal = policy?.currentIncidentOrdinal
  if (ordinal === undefined) throw new Error('no current incident')
  return { version: 1, kind: transition.kind, atMs: 1, guardId: transition.guardId, incidentOrdinal: ordinal }
}

function cycle(state: GuardianLedgerState, input: Parameters<typeof evaluateGuard>[1]): { state: GuardianLedgerState; transitions: PolicyTransition[] } {
  const transitions = evaluateGuard(guardOf(state), input, CONFIG)
  const next = transitions.reduce((acc, t) => fold(acc, toEvent(acc, t)), state)
  return { state: next, transitions }
}

describe('rfc3339 strict parsing', () => {
  it('rejects shapes that Date.parse would tolerate', () => {
    expect(isRfc3339Offset('2026-08-13')).toBe(false)
    expect(isRfc3339Offset('2026-08-13T12:00:00')).toBe(false)
    expect(isRfc3339Offset('2026-08-13 12:00:00Z')).toBe(false)
    expect(isRfc3339Offset(null)).toBe(false)
    expect(isRfc3339Offset(42)).toBe(false)
    expect(isRfc3339Offset('2026-08-13T12:00:00+05:30')).toBe(true)
  })
  it('rejects out-of-range fields', () => {
    expect(() => parseRfc3339Offset('2026-13-01T00:00:00Z')).toThrow(/invalid month/)
    expect(() => parseRfc3339Offset('2026-04-31T00:00:00Z')).toThrow(/invalid day/)
    expect(() => parseRfc3339Offset('2023-02-29T00:00:00Z')).toThrow(/invalid day/)
    expect(() => parseRfc3339Offset('2026-01-01T24:00:00Z')).toThrow(/invalid time/)
    expect(() => parseRfc3339Offset('2026-01-01T00:60:00Z')).toThrow(/invalid time/)
    expect(() => parseRfc3339Offset('2026-01-01T00:00:60Z')).toThrow(/invalid time/)
    expect(() => parseRfc3339Offset('0999-01-01T00:00:00Z')).toThrow(/year out of range/)
    expect(() => parseRfc3339Offset('2026-01-01T00:00:00+24:00')).toThrow(/invalid offset/)
    expect(() => parseRfc3339Offset('2026-01-01T00:00:00-05:60')).toThrow(/invalid offset/)
  })
  it('handles leap days, fractions, and offsets', () => {
    expect(parseRfc3339Offset('2024-02-29T12:00:00Z')).toBe(Date.UTC(2024, 1, 29, 12))
    expect(parseRfc3339Offset('2000-02-29T00:00:00Z')).toBe(Date.UTC(2000, 1, 29))
    expect(() => parseRfc3339Offset('2100-02-29T00:00:00Z')).toThrow(/invalid day/)
    expect(parseRfc3339Offset('2026-04-30T00:00:00Z')).toBe(Date.UTC(2026, 3, 30))
    expect(parseRfc3339Offset('2026-01-01T00:00:00.5Z')).toBe(Date.UTC(2026, 0, 1) + 500)
    expect(parseRfc3339Offset('2026-01-01T00:00:00.25Z')).toBe(Date.UTC(2026, 0, 1) + 250)
    expect(parseRfc3339Offset('2026-01-01T00:00:00Z')).toBe(parseRfc3339Offset('2026-01-01T05:30:00+05:30'))
    expect(parseRfc3339Offset('2026-01-01T00:00:00-05:00')).toBe(Date.UTC(2026, 0, 1) + 5 * 3600_000)
  })
  it('formats epoch ms back to strict RFC 3339', () => {
    expect(formatRfc3339Utc(1_768_924_800_000)).toBe('2026-01-20T16:00:00.000Z')
    expect(() => formatRfc3339Utc(1.5)).toThrow(/non-safe-integer/)
  })
})

describe('decoder edge cases', () => {
  it('decodes every event kind and policy kind round-trip', () => {
    const events: unknown[] = [
      create([SILENCE, DEADLINE, STREAK]),
      { version: 1, kind: 'revise', atMs: 1, guardId: 'g1', expectedRevision: 1, label: 'x', notificationMode: 'owner_followup', policies: [DEADLINE] },
      { version: 1, kind: 'control', atMs: 1, guardId: 'g1', operation: 'pause' },
      { version: 1, kind: 'control', atMs: 1, guardId: 'g1', operation: 'resume' },
      { version: 1, kind: 'control', atMs: 1, guardId: 'g1', operation: 'close' },
      { version: 1, kind: 'policy-observe', atMs: 1, guardId: 'g1', policyId: 'p', phase: 'suspect', anchorAtMs: 0, lastActivityAtMs: 1, breachSinceAtMs: 2, recoverySinceAtMs: 3, streak: 2 },
      { version: 1, kind: 'incident-open', atMs: 1, guardId: 'g1', policyId: 'p', policyRevision: 1, incidentOrdinal: 1 },
      { version: 1, kind: 'incident-acknowledge', atMs: 1, guardId: 'g1', incidentOrdinal: 1 },
      { version: 1, kind: 'incident-recover', atMs: 1, guardId: 'g1', incidentOrdinal: 1 },
      { version: 1, kind: 'incident-reopen', atMs: 1, guardId: 'g1', incidentOrdinal: 1 },
      { version: 1, kind: 'incident-resolve', atMs: 1, guardId: 'g1', incidentOrdinal: 1 },
      { version: 1, kind: 'delivery-accepted', atMs: 1, guardId: 'g1', incidentOrdinal: 1 },
      { version: 1, kind: 'delivery-failed', atMs: 1, guardId: 'g1', incidentOrdinal: 1, attempt: 2 },
      { version: 1, kind: 'delivery-dead-letter', atMs: 1, guardId: 'g1', incidentOrdinal: 1 },
      { version: 1, kind: 'revise', atMs: 1, guardId: 'g1', expectedRevision: 1, policies: [STREAK] },
    ]
    for (const event of events) expect(decodeGuardianEvent(event).version).toBe(1)
  })
  it('rejects malformed envelopes and fields', () => {
    expect(() => decodeGuardianEvent(null)).toThrow(/must be an object/)
    expect(() => decodeGuardianEvent([])).toThrow(/must be an object/)
    expect(() => decodeGuardianEvent({ ...create(), version: '1' })).toThrow(/unsupported event version/)
    expect(() => decodeGuardianEvent({ ...create(), kind: 7 })).toThrow(/kind must be a string/)
    expect(() => decodeGuardianEvent({ ...create(), atMs: -1 })).toThrow(/non-negative safe integer/)
    expect(() => decodeGuardianEvent({ ...create(), atMs: 1.5 })).toThrow(/non-negative safe integer/)
  })
  it('rejects invalid labels, owners, modes, and bounds', () => {
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, label: 42 } })).toThrow(/label must be a string/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, label: 'x'.repeat(241) } })).toThrow(/exceeds byte limit/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, ownerSessionId: 'BAD UPPER' } })).toThrow(/not a valid id/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, notificationMode: 'both' } })).toThrow(/unknown notification mode/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, id: 'x'.repeat(200) } })).toThrow(/length out of bounds/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: DEFAULT_DECODE_LIMITS.maxSilenceSeconds + 1 }] } }))
      .toThrow(/within limits/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, policies: [{ id: 'p', kind: 'abnormal_turn_streak', count: DEFAULT_DECODE_LIMITS.maxStreakCount + 1 }] } }))
      .toThrow(/within limits/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, policies: [{ id: 'p', kind: 'cron' }] } })).toThrow(/unknown policy kind/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, policies: [{ id: 'p', kind: 'deadline_unclosed', at: '2026-08-13T12:00:00Z', extra: 1 }] } }))
      .toThrow(/unknown field/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, policies: [{ id: 'p', kind: 'abnormal_turn_streak', count: 3, extra: 1 }] } }))
      .toThrow(/unknown field/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, policies: 'nope' } })).toThrow(/must be an array/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, policies: Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, kind: 'lifecycle_silence', seconds: 1 }) as GuardianPolicySpec) } }))
      .toThrow(/too many policies/)
  })
  it('rejects invalid event payload fields across kinds', () => {
    expect(() => decodeGuardianEvent({ version: 1, kind: 'control', atMs: 1, guardId: 'g1', operation: 'explode' })).toThrow(/unknown control operation/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'revise', atMs: 1, guardId: 'g1', expectedRevision: 0, policies: [SILENCE] })).toThrow(/expectedRevision/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'revise', atMs: 1, guardId: 'g1', expectedRevision: 1, label: 5, policies: [SILENCE] })).toThrow(/label must be a string/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'revise', atMs: 1, guardId: 'g1', expectedRevision: 1, notificationMode: 'loud', policies: [SILENCE] })).toThrow(/unknown notification mode/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'policy-observe', atMs: 1, guardId: 'g1', policyId: 'p', phase: 'healthy', anchorAtMs: 0, streak: -1 })).toThrow(/streak/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'incident-open', atMs: 1, guardId: 'g1', policyId: 'p', policyRevision: 1, incidentOrdinal: 0 })).toThrow(/incidentOrdinal out of bounds/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'incident-open', atMs: 1, guardId: 'g1', policyId: 'p', policyRevision: 1, incidentOrdinal: 200_000 })).toThrow(/incidentOrdinal out of bounds/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'delivery-failed', atMs: 1, guardId: 'g1', incidentOrdinal: 1, attempt: 0 })).toThrow(/attempt/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'delivery-failed', atMs: 1, guardId: 'g1', incidentOrdinal: 0, attempt: 1 })).toThrow(/incidentOrdinal out of bounds/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'delivery-failed', atMs: 1, guardId: 'g1', incidentOrdinal: 200_000, attempt: 1 })).toThrow(/incidentOrdinal out of bounds/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'delivery-dead-letter', atMs: 1, guardId: 'g1', incidentOrdinal: 0 })).toThrow(/incidentOrdinal out of bounds/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'policy-observe', atMs: 1, guardId: 'g1', policyId: 'p', phase: 'healthy', anchorAtMs: 0, streak: 0, bogus: 1 })).toThrow(/unknown field/)
  })
})

describe('fold edge cases', () => {
  it('allocates guard ids and rejects unknown targets', () => {
    expect(allocateGuardianId(newLedgerState(SESSION))).toBe('guardian-1')
    expect(() => fold(newLedgerState(SESSION), { version: 1, kind: 'control', atMs: 1, guardId: 'ghost', operation: 'pause' })).toThrow(/unknown guard/)
    const state = fold(newLedgerState(SESSION), create())
    expect(() => fold(state, { version: 1, kind: 'incident-open', atMs: 1, guardId: 'g1', policyId: 'ghost', policyRevision: 1, incidentOrdinal: 1 })).toThrow(/no policy/)
  })
  it('rejects observations of closed guards and operations on closed guards', () => {
    const closed = fold(fold(newLedgerState(SESSION), create()), { version: 1, kind: 'control', atMs: 3000, guardId: 'g1', operation: 'close' })
    expect(() => fold(closed, { version: 1, kind: 'policy-observe', atMs: 1, guardId: 'g1', policyId: 'p-silence', phase: 'suspect', anchorAtMs: 0, streak: 0 })).toThrow(/closed guard/)
    expect(() => fold(closed, { version: 1, kind: 'control', atMs: 1, guardId: 'g1', operation: 'pause' })).toThrow(/cannot pause/)
    expect(() => fold(closed, { version: 1, kind: 'control', atMs: 1, guardId: 'g1', operation: 'resume' })).toThrow(/cannot resume/)
  })
  it('closes open incidents with superseded phase and keeps them for audit', () => {
    const state = openIncident(fold(newLedgerState(SESSION), create()))
    const closed = fold(state, { version: 1, kind: 'control', atMs: 3000, guardId: 'g1', operation: 'close' })
    expect(guardOf(closed).controlState).toBe('closed')
    expect(guardOf(closed).incidents[0]?.phase).toBe('superseded')
    expect(guardOf(closed).policies[0]?.phase).toBe('superseded')
    expect(() => assertLedgerInvariants(closed)).not.toThrow()
  })
  it('revise with changed deadline/streak params supersedes and keeps records', () => {
    let state = openIncident(fold(newLedgerState(SESSION), create([SILENCE, DEADLINE, STREAK])))
    state = fold(state, { version: 1, kind: 'revise', atMs: 3000, guardId: 'g1', expectedRevision: 1, policies: [{ ...DEADLINE, at: '2027-01-01T00:00:00Z' }, STREAK] })
    let guard = guardOf(state)
    expect(guard.policies.find(p => p.id === 'p-silence')?.phase).toBe('superseded')
    const deadlineRecords = guard.policies.filter(p => p.id === 'p-deadline')
    expect(deadlineRecords.some(p => p.phase === 'superseded')).toBe(true)
    expect(deadlineRecords.find(p => p.phase === 'healthy')?.at).toBe('2027-01-01T00:00:00Z')
    expect(guard.policies.find(p => p.id === 'p-streak')?.phase).toBe('healthy')
    expect(guardListView(state)[0]?.policies.map(p => p.kind)).toEqual(['lifecycle_silence', 'deadline_unclosed', 'abnormal_turn_streak', 'deadline_unclosed'])
    // a changed streak count also supersedes its policy
    state = fold(state, { version: 1, kind: 'revise', atMs: 4000, guardId: 'g1', expectedRevision: 2, policies: [{ ...STREAK, count: 5 }] })
    guard = guardOf(state)
    const streakRecords = guard.policies.filter(p => p.id === 'p-streak')
    expect(streakRecords.some(p => p.phase === 'superseded')).toBe(true)
    expect(streakRecords.find(p => p.phase === 'healthy')?.guardRevision).toBe(3)
  })
  it('rejects recovery, delivery, and acknowledge on closed incidents', () => {
    const base = openIncident(fold(newLedgerState(SESSION), create()))
    const resolved = fold(fold(base, { version: 1, kind: 'incident-recover', atMs: 2500, guardId: 'g1', incidentOrdinal: 1 }),
      { version: 1, kind: 'incident-resolve', atMs: 3000, guardId: 'g1', incidentOrdinal: 1 })
    expect(() => fold(resolved, { version: 1, kind: 'incident-recover', atMs: 1, guardId: 'g1', incidentOrdinal: 1 })).toThrow(/cannot recover resolved/)
    expect(() => fold(resolved, { version: 1, kind: 'incident-acknowledge', atMs: 1, guardId: 'g1', incidentOrdinal: 1 })).toThrow(/cannot acknowledge/)
    expect(() => fold(resolved, { version: 1, kind: 'delivery-accepted', atMs: 1, guardId: 'g1', incidentOrdinal: 1 })).toThrow(/cannot deliver/)
    expect(() => fold(resolved, { version: 1, kind: 'delivery-failed', atMs: 1, guardId: 'g1', incidentOrdinal: 1, attempt: 1 })).toThrow(/cannot record a failed delivery/)
    expect(() => fold(resolved, { version: 1, kind: 'delivery-dead-letter', atMs: 1, guardId: 'g1', incidentOrdinal: 1 })).toThrow(/cannot dead-letter/)
    const dead = fold(fold(base, { version: 1, kind: 'delivery-failed', atMs: 2100, guardId: 'g1', incidentOrdinal: 1, attempt: 1 }),
      { version: 1, kind: 'delivery-dead-letter', atMs: 2200, guardId: 'g1', incidentOrdinal: 1 })
    expect(() => fold(dead, { version: 1, kind: 'delivery-accepted', atMs: 1, guardId: 'g1', incidentOrdinal: 1 })).toThrow(/dead-lettered/)
    expect(() => fold(dead, { version: 1, kind: 'delivery-failed', atMs: 1, guardId: 'g1', incidentOrdinal: 1, attempt: 2 })).toThrow(/cannot record a failed delivery/)
    expect(() => fold(base, { version: 1, kind: 'delivery-failed', atMs: 1, guardId: 'g1', incidentOrdinal: 1, attempt: 2 })).toThrow(/contiguously/)
  })
  it('reopen and resolve record their timestamps and views render superseded incidents', () => {
    let state = openIncident(fold(newLedgerState(SESSION), create()))
    state = fold(state, { version: 1, kind: 'incident-recover', atMs: 2500, guardId: 'g1', incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-reopen', atMs: 2600, guardId: 'g1', incidentOrdinal: 1 })
    expect(guardOf(state).incidents[0]?.reopenedAtMs).toBe(2600)
    state = fold(state, { version: 1, kind: 'incident-recover', atMs: 2700, guardId: 'g1', incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-resolve', atMs: 2800, guardId: 'g1', incidentOrdinal: 1 })
    expect(guardDetailView(state, 'g1')?.incidents[0]?.resolvedAtMs).toBe(2800)
  })
  it('acknowledge is idempotent from recovering and dead-letter phases', () => {
    let state = openIncident(fold(newLedgerState(SESSION), create()))
    state = fold(state, { version: 1, kind: 'incident-recover', atMs: 2500, guardId: 'g1', incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-acknowledge', atMs: 2600, guardId: 'g1', incidentOrdinal: 1 })
    expect(guardOf(state).policies[0]?.phase).toBe('acknowledged')
    expect(guardOf(state).incidents[0]?.acknowledgedAtMs).toBe(2600)
  })
})

describe('policy evaluator edges', () => {
  it('silence returns to healthy on the epoch after resolution', () => {
    let state = fold(newLedgerState(SESSION), create())
    let round = cycle(state, { nowMs: 901_000, turnEnds: [] })
    round = cycle(round.state, { nowMs: 961_000, turnEnds: [] })
    round = cycle(round.state, { nowMs: 1_000_000, turnEnds: [], lastQualifyingActivityAtMs: 990_000 })
    round = cycle(round.state, { nowMs: 1_031_000, turnEnds: [], lastQualifyingActivityAtMs: 990_000 })
    expect(guardOf(round.state).policies[0]?.phase).toBe('resolved')
    round = cycle(round.state, { nowMs: 1_040_000, turnEnds: [], lastQualifyingActivityAtMs: 1_035_000 })
    expect(round.transitions.map(t => t.kind)).toEqual(['policy-observe'])
    expect(guardOf(round.state).policies[0]?.phase).toBe('healthy')
    expect(guardOf(round.state).policies[0]?.currentIncidentOrdinal).toBeUndefined()
  })
  it('streak: completed clears suspect, resolves from recovering, reopens on streak re-breach', () => {
    let state = fold(newLedgerState(SESSION), create([STREAK]))
    const err = (atMs: number) => ({ atMs, reason: 'error' as const })
    // suspect after 3 errors
    let round = cycle(state, { nowMs: 4000, turnEnds: [err(1000), err(2000), err(3000)] })
    expect(guardOf(round.state).policies[0]?.phase).toBe('suspect')
    // a completed turn clears the suspect
    round = cycle(round.state, { nowMs: 5000, turnEnds: [{ atMs: 4500, reason: 'completed' }] })
    expect(guardOf(round.state).policies[0]?.phase).toBe('healthy')
    // open via confirmation
    state = fold(newLedgerState(SESSION), create([STREAK]))
    round = cycle(state, { nowMs: 4000, turnEnds: [err(1000), err(2000), err(3000)] })
    round = cycle(round.state, { nowMs: 64_000, turnEnds: [err(1000), err(2000), err(3000)] })
    expect(guardOf(round.state).policies[0]?.phase).toBe('open')
    // acknowledge then recover
    state = round.state
    state = fold(state, { version: 1, kind: 'incident-acknowledge', atMs: 65_000, guardId: 'g1', incidentOrdinal: 1 })
    round = cycle(state, { nowMs: 66_000, turnEnds: [{ atMs: 65_500, reason: 'completed' }] })
    expect(round.transitions.map(t => t.kind)).toEqual(['policy-observe', 'incident-recover'])
    expect(guardOf(round.state).policies[0]?.phase).toBe('recovering')
    // streak re-breach reopens
    round = cycle(round.state, { nowMs: 67_000, turnEnds: [err(66_100), err(66_200), err(66_300)] })
    expect(round.transitions.map(t => t.kind)).toEqual(['policy-observe', 'incident-reopen'])
    // completed + window resolves
    round = cycle(round.state, { nowMs: 70_000, turnEnds: [{ atMs: 69_000, reason: 'completed' }] })
    round = cycle(round.state, { nowMs: 99_000, turnEnds: [{ atMs: 69_000, reason: 'completed' }] })
    expect(round.transitions.map(t => t.kind)).toEqual(['incident-resolve'])
  })
  it('streak suspect anchors on now when the stored streak crosses the threshold with no new facts', () => {
    let state = fold(newLedgerState(SESSION), create([STREAK]))
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 1000, guardId: 'g1', policyId: 'p-streak', phase: 'healthy', anchorAtMs: 1000, streak: 3 })
    const transitions = evaluateGuard(guardOf(state), { nowMs: 5000, turnEnds: [] }, CONFIG)
    expect(transitions.map(t => t.kind)).toEqual(['policy-observe'])
    const observe = transitions[0]
    expect(observe?.kind === 'policy-observe' ? observe.breachSinceAtMs : -1).toBe(5000)
  })
  it('deadline suspect persists without duplicating observations', () => {
    let state = fold(newLedgerState(SESSION), create([DEADLINE]))
    const atMs = Date.parse('2026-08-13T12:00:00Z')
    let round = cycle(state, { nowMs: atMs, turnEnds: [] })
    expect(round.transitions.map(t => t.kind)).toEqual(['policy-observe'])
    round = cycle(round.state, { nowMs: atMs + 30_000, turnEnds: [] })
    expect(round.transitions).toEqual([])
    round = cycle(round.state, { nowMs: atMs + 61_000, turnEnds: [] })
    expect(round.transitions.map(t => t.kind)).toEqual(['incident-open'])
  })
  it('streak returns to healthy on the epoch after resolution', () => {
    let state = fold(newLedgerState(SESSION), create([STREAK]))
    const err = (atMs: number) => ({ atMs, reason: 'error' as const })
    let round = cycle(state, { nowMs: 4000, turnEnds: [err(1000), err(2000), err(3000)] })
    round = cycle(round.state, { nowMs: 64_000, turnEnds: [err(1000), err(2000), err(3000)] })
    round = cycle(round.state, { nowMs: 70_000, turnEnds: [{ atMs: 69_000, reason: 'completed' }] })
    round = cycle(round.state, { nowMs: 99_000, turnEnds: [{ atMs: 69_000, reason: 'completed' }] })
    expect(guardOf(round.state).policies[0]?.phase).toBe('resolved')
    round = cycle(round.state, { nowMs: 100_000, turnEnds: [{ atMs: 99_500, reason: 'completed' }] })
    expect(round.transitions.map(t => t.kind)).toEqual(['policy-observe'])
    expect(guardOf(round.state).policies[0]?.phase).toBe('healthy')
    expect(guardOf(round.state).policies[0]?.currentIncidentOrdinal).toBeUndefined()
  })
})

describe('branch-completing cases', () => {
  it('decodes non-string ids, non-object policies, non-string phases, every phase value', () => {
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, id: 42 } })).toThrow(/must be a string/)
    expect(() => decodeGuardianEvent({ ...create(), guard: { ...create().guard, policies: [42] } })).toThrow(/policy must be an object/)
    expect(() => decodeGuardianEvent({ ...create(), guard: 42 })).toThrow(/create guard must be an object/)
    for (const phase of ['healthy', 'suspect', 'open', 'acknowledged', 'recovering', 'resolved', 'dead_letter', 'superseded'] as const) {
      expect(() => decodeGuardianEvent({ version: 1, kind: 'policy-observe', atMs: 1, guardId: 'g1', policyId: 'p', phase, anchorAtMs: 0, streak: 0 })).not.toThrow()
    }
    expect(() => decodeGuardianEvent({ version: 1, kind: 'policy-observe', atMs: 1, guardId: 'g1', policyId: 'p', phase: 42, anchorAtMs: 0, streak: 0 })).toThrow(/must be a string/)
    expect(() => decodeGuardianEvent({ version: 1, kind: 'incident-open', atMs: 1, guardId: 'g1', policyId: 'p', policyRevision: 1.5, incidentOrdinal: 1 })).toThrow(/policyRevision/)
    // observe without the optional activity fields decodes to a bare observation
    const bare = decodeGuardianEvent({ version: 1, kind: 'policy-observe', atMs: 1, guardId: 'g1', policyId: 'p', phase: 'healthy', anchorAtMs: 0, streak: 0 })
    expect(bare.kind === 'policy-observe' && bare.lastActivityAtMs).toBeUndefined()
    // revise with only a label, and only a mode
    expect(decodeGuardianEvent({ version: 1, kind: 'revise', atMs: 1, guardId: 'g1', expectedRevision: 1, label: 'only', policies: [SILENCE] }).kind).toBe('revise')
    expect(decodeGuardianEvent({ version: 1, kind: 'revise', atMs: 1, guardId: 'g1', expectedRevision: 1, notificationMode: 'owner_followup', policies: [SILENCE] }).kind).toBe('revise')
  })
  it('classifies max-tokens and interrupted, and folds interrupted into the streak', () => {
    expect(classifyTurnEndReason('max-tokens')).toBe('max-tokens')
    expect(classifyTurnEndReason('interrupted')).toBe('interrupted')
    expect(classifyTurnEndReason('error')).toBe('error')
    expect(classifyTurnEndReason('blocked')).toBe('blocked')
    expect(classifyTurnEndReason('aborted')).toBe('aborted')
    const state = fold(newLedgerState(SESSION), create([STREAK]))
    const transitions = evaluateGuard(guardOf(state), { nowMs: 4000, turnEnds: [{ atMs: 1000, reason: 'interrupted' }, { atMs: 2000, reason: 'max-tokens' }, { atMs: 3000, reason: 'blocked' }] }, CONFIG)
    expect(transitions[0]?.kind === 'policy-observe' ? transitions[0].streak : -1).toBe(3)
  })
  it('a suspect streak below its threshold returns to healthy', () => {
    let state = fold(newLedgerState(SESSION), create([STREAK]))
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p-streak', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 1 })
    const transitions = evaluateGuard(guardOf(state), { nowMs: 3000, turnEnds: [] }, CONFIG)
    expect(transitions.map(t => t.kind)).toEqual(['policy-observe'])
    expect(transitions[0]?.kind === 'policy-observe' ? transitions[0].phase : '').toBe('healthy')
  })
  it('rejects shape-invalid instants at the parser boundary', () => {
    expect(() => parseRfc3339Offset('nope')).toThrow(/invalid RFC 3339/)
    expect(() => parseRfc3339Offset('2026-08-13')).toThrow(/invalid RFC 3339/)
  })
  it('operates on one guard and one policy while others stay untouched', () => {
    let state = fold(newLedgerState(SESSION), create([SILENCE, STREAK]))
    state = fold(state, { ...create([DEADLINE]), guard: { ...create([DEADLINE]).guard, id: 'g2', label: 'second' } })
    state = openIncident(state, 'p-silence')
    // open a second incident first, so every later map runs over two incidents
    state = fold(state, { version: 1, kind: 'policy-observe', atMs: 2050, guardId: 'g1', policyId: 'p-streak', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 2000, streak: 3 })
    state = fold(state, { version: 1, kind: 'incident-open', atMs: 2050, guardId: 'g1', policyId: 'p-streak', policyRevision: 1, incidentOrdinal: 2 })
    state = fold(state, { version: 1, kind: 'incident-acknowledge', atMs: 2100, guardId: 'g1', incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-recover', atMs: 2200, guardId: 'g1', incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-reopen', atMs: 2300, guardId: 'g1', incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-recover', atMs: 2400, guardId: 'g1', incidentOrdinal: 1 })
    state = fold(state, { version: 1, kind: 'incident-resolve', atMs: 2500, guardId: 'g1', incidentOrdinal: 1 })
    expect(guardOf(state, 'g1').policies.find(p => p.id === 'p-streak')?.phase).toBe('open')
    expect(guardOf(state, 'g2').policies[0]?.phase).toBe('healthy')
    expect(guardOf(state, 'g1').incidents[0]?.phase).toBe('resolved')
    expect(guardOf(state, 'g1').incidents[1]?.phase).toBe('open')
    state = fold(state, { version: 1, kind: 'delivery-failed', atMs: 2700, guardId: 'g1', incidentOrdinal: 2, attempt: 1 })
    state = fold(state, { version: 1, kind: 'delivery-accepted', atMs: 2800, guardId: 'g1', incidentOrdinal: 2 })
    state = fold(state, { version: 1, kind: 'delivery-dead-letter', atMs: 2900, guardId: 'g1', incidentOrdinal: 2 })
    expect(guardOf(state, 'g1').incidents[0]?.delivery.state).toBe('pending')
    expect(guardOf(state, 'g1').incidents[1]?.delivery.state).toBe('dead_letter')
  })
  it('revises label and notification mode through the fold', () => {
    let state = fold(newLedgerState(SESSION), create())
    state = fold(state, { ...create([DEADLINE]), guard: { ...create([DEADLINE]).guard, id: 'g2', label: 'second' } })
    state = fold(state, { version: 1, kind: 'revise', atMs: 2000, guardId: 'g1', expectedRevision: 1, label: 'renamed', notificationMode: 'owner_followup', policies: [SILENCE] })
    expect(guardOf(state).label).toBe('renamed')
    expect(guardOf(state).notificationMode).toBe('owner_followup')
    expect(guardOf(state, 'g2').label).toBe('second')
  })
  it('close supersedes acknowledged and recovering incidents', () => {
    const acknowledged = fold(openIncident(fold(newLedgerState(SESSION), create())),
      { version: 1, kind: 'incident-acknowledge', atMs: 2100, guardId: 'g1', incidentOrdinal: 1 })
    expect(fold(acknowledged, { version: 1, kind: 'control', atMs: 2200, guardId: 'g1', operation: 'close' }).guards[0]?.incidents[0]?.phase).toBe('superseded')
    const recovering = fold(openIncident(fold(newLedgerState(SESSION), create())),
      { version: 1, kind: 'incident-recover', atMs: 2100, guardId: 'g1', incidentOrdinal: 1 })
    expect(fold(recovering, { version: 1, kind: 'control', atMs: 2200, guardId: 'g1', operation: 'close' }).guards[0]?.incidents[0]?.phase).toBe('superseded')
  })
  it('resume re-anchors only silence policies; evaluator skips superseded and dead-letter policies', () => {
    let state = fold(newLedgerState(SESSION), create([DEADLINE]))
    state = fold(state, { version: 1, kind: 'control', atMs: 2000, guardId: 'g1', operation: 'pause' })
    state = fold(state, { version: 1, kind: 'control', atMs: 3000, guardId: 'g1', operation: 'resume' })
    expect(guardOf(state).policies[0]?.observation.anchorAtMs).toBe(1000)
    const guard = guardOf(state)
    const skipped = {
      ...guard,
      policies: [
        { ...guard.policies[0]!, phase: 'superseded' as const },
        { ...guard.policies[0]!, id: 'p-dead', phase: 'dead_letter' as const },
      ],
    }
    expect(evaluateGuard(skipped, { nowMs: 1, turnEnds: [] }, CONFIG)).toEqual([])
  })
  it('incident operations against unknown ordinals fail closed', () => {
    const state = openIncident(fold(newLedgerState(SESSION), create()))
    expect(() => fold(state, { version: 1, kind: 'incident-acknowledge', atMs: 1, guardId: 'g1', incidentOrdinal: 99 })).toThrow(/no incident/)
  })
  it('detail views render acknowledged incidents and healthy policies without linkage', () => {
    const state = fold(openIncident(fold(newLedgerState(SESSION), create())), { version: 1, kind: 'incident-acknowledge', atMs: 2100, guardId: 'g1', incidentOrdinal: 1 })
    const detail = guardDetailView(state, 'g1')
    expect(detail?.incidents[0]?.acknowledgedAtMs).toBe(2100)
    const fresh = guardDetailView(fold(newLedgerState(SESSION), create()), 'g1')
    expect(fresh?.policies[0]?.currentIncidentOrdinal).toBeUndefined()
  })
})

describe('invariant edges', () => {
  it('rejects empty session ids, illegal revisions, duplicate policies, bad streaks', () => {
    const empty = { ...newLedgerState(SESSION), sessionId: '' as never }
    expect(() => assertLedgerInvariants(empty)).toThrow(/session id is empty/)
    const state = fold(newLedgerState(SESSION), create())
    const guard = guardOf(state)
    const policy = guard.policies[0]
    if (!policy) throw new Error('missing policy')
    expect(() => assertLedgerInvariants({ ...state, guards: [{ ...guard, revision: 0 }] })).toThrow(/illegal revision/)
    const dup = { ...guard, policies: [policy, { ...policy, id: 'p-silence' as never }] }
    expect(() => assertLedgerInvariants({ ...state, guards: [dup] })).toThrow(/duplicate policy/)
    expect(() => assertLedgerInvariants({ ...state, guards: [{ ...guard, policies: [{ ...policy, observation: { ...policy.observation, streak: -1 } }] }] }))
      .toThrow(/illegal streak/)
  })
  it('rejects incident identity mismatches and regressed allocation', () => {
    const state = openIncident(fold(newLedgerState(SESSION), create()))
    const guard = guardOf(state)
    const incident = guard.incidents[0]
    if (!incident) throw new Error('missing incident')
    expect(() => assertLedgerInvariants({ ...state, guards: [{ ...guard, incidents: [{ ...incident, guardId: 'other' }] }] }))
      .toThrow(/guardId mismatch/)
    expect(() => assertLedgerInvariants({ ...state, guards: [{ ...guard, incidents: [{ ...incident, delivery: { ...incident.delivery, attempts: -1 } }] }] }))
      .toThrow(/illegal attempt count/)
    expect(() => assertLedgerInvariants({ ...state, nextIncidentOrdinal: 1 })).toThrow(/went backwards/)
  })
  it('rejects the phase mirror mismatch between a policy and its incident', () => {
    const state = openIncident(fold(newLedgerState(SESSION), create()))
    const guard = guardOf(state)
    const policy = guard.policies[0]
    const incident = guard.incidents[0]
    if (!policy || !incident) throw new Error('missing record')
    const recoveringPolicy = { ...policy, phase: 'recovering' as const }
    const broken = { ...state, guards: [{ ...guard, policies: [recoveringPolicy], incidents: [incident] }] }
    expect(() => assertLedgerInvariants(broken)).toThrow(/!= incident phase/)
    // a suspect policy must never link an incident
    const suspectLinked = { ...state, guards: [{ ...guard, policies: [{ ...policy, phase: 'suspect' as const }] }] }
    expect(() => assertLedgerInvariants(suspectLinked)).toThrow(/but links incident/)
    // an incident whose policyId names another policy is a mismatch
    const wrongPolicy = { ...state, guards: [{ ...guard, incidents: [{ ...incident, policyId: 'other-policy' }] }] }
    expect(() => assertLedgerInvariants(wrongPolicy)).toThrow(/policyId mismatch/)
    // a linkage to a missing incident is a corruption signal
    const dangling = { ...state, guards: [{ ...guard, policies: [{ ...policy, phase: 'open' as const, currentIncidentOrdinal: 99 }] }] }
    expect(() => assertLedgerInvariants(dangling)).toThrow(/links missing incident/)
  })
  it('accepts superseded policies and verifies replay determinism end to end', () => {
    let state = openIncident(fold(newLedgerState(SESSION), create()))
    state = fold(state, { version: 1, kind: 'revise', atMs: 3000, guardId: 'g1', expectedRevision: 1, policies: [DEADLINE] })
    expect(() => assertLedgerInvariants(state)).not.toThrow()
    const events = [
      create(),
      { version: 1, kind: 'control', atMs: 2000, guardId: 'g1', operation: 'close' },
    ] as const
    expect(() => assertReplayDeterminism(events, SESSION)).not.toThrow()
  })
})
