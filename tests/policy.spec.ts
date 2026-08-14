import { describe, expect, it } from 'vitest'
import { foldEvent, newLedgerState } from '../src/domain.ts'
import { classifyTurnEndReason, evaluateGuard } from '../src/policy.ts'
import type { GuardianEvent, GuardianLedgerState, GuardianPolicySpec, GuardianRecord, PolicyEvaluationInput, PolicyTransition } from '../src/types.ts'

const SESSION = 'sess-1' as const
const CONFIG = { confirmationMs: 60_000, recoveryConfirmationMs: 30_000 }

const SILENCE: GuardianPolicySpec = { id: 'p-silence', kind: 'lifecycle_silence', seconds: 900 }
const DEADLINE: GuardianPolicySpec = { id: 'p-deadline', kind: 'deadline_unclosed', at: '2026-08-13T12:00:00Z' }
const STREAK: GuardianPolicySpec = { id: 'p-streak', kind: 'abnormal_turn_streak', count: 3 }

const DEADLINE_MS = Date.parse('2026-08-13T12:00:00Z')

function createState(policies: GuardianPolicySpec[]): GuardianLedgerState {
  return foldEvent(newLedgerState(SESSION), {
    version: 1,
    kind: 'create',
    atMs: 1000,
    guard: {
      id: 'g1',
      label: 'guard',
      ownerSessionId: SESSION,
      notificationMode: 'audit_only',
      policies,
    },
  })
}

const liveGuard = (state: GuardianLedgerState): GuardianRecord => {
  const guard = state.guards[0]
  if (!guard) throw new Error('guard missing')
  return guard
}

/** Apply one evaluator transition as a real ledger event. */
function toEvent(state: GuardianLedgerState, transition: PolicyTransition): GuardianEvent {
  const guard = liveGuard(state)
  if (transition.kind === 'policy-observe') {
    return {
      version: 1,
      kind: 'policy-observe',
      atMs: transition.anchorAtMs, // placeholder, unused by fold validation
      guardId: transition.guardId,
      policyId: transition.policyId,
      phase: transition.phase,
      anchorAtMs: transition.anchorAtMs,
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
  if (ordinal === undefined) throw new Error('no current incident to operate on')
  return { version: 1, kind: transition.kind, atMs: 1, guardId: transition.guardId, incidentOrdinal: ordinal }
}

/** Simulate one evaluation cycle: evaluate, fold every transition, return the new state. */
function cycle(state: GuardianLedgerState, input: PolicyEvaluationInput): { state: GuardianLedgerState; transitions: PolicyTransition[] } {
  const transitions = evaluateGuard(liveGuard(state), input, CONFIG)
  const next = transitions.reduce((acc, transition) => foldEvent(acc, toEvent(acc, transition)), state)
  return { state: next, transitions }
}

const evalInput = (nowMs: number, over: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput => ({
  nowMs,
  turnEnds: [],
  ...over,
})

describe('classifyTurnEndReason', () => {
  it('classifies known reasons and maps extensions to unknown', () => {
    expect(classifyTurnEndReason('completed')).toBe('completed')
    expect(classifyTurnEndReason('interrupted')).toBe('interrupted')
    expect(classifyTurnEndReason('vendor-timeout')).toBe('unknown')
  })
})

describe('lifecycle_silence', () => {
  it('breaches exactly at the threshold and opens after the confirmation window', () => {
    let state = createState([SILENCE])
    expect(evaluateGuard(liveGuard(state), evalInput(1000 + 900_000 - 1), CONFIG)).toEqual([])
    const suspect = evaluateGuard(liveGuard(state), evalInput(1000 + 900_000), CONFIG)
    expect(suspect.map(t => t.kind)).toEqual(['policy-observe'])
    state = foldEvent(state, toEvent(state, suspect[0] as PolicyTransition))
    expect(liveGuard(state).policies[0]?.phase).toBe('suspect')
    expect(evaluateGuard(liveGuard(state), evalInput(1000 + 900_000 + 59_999), CONFIG)).toEqual([])
    expect(evaluateGuard(liveGuard(state), evalInput(1000 + 900_000 + 60_000), CONFIG).map(t => t.kind)).toEqual(['incident-open'])
  })
  it('fresh activity clears suspect; clock-backward activity cannot', () => {
    let state = createState([SILENCE])
    let round = cycle(state, evalInput(901_000))
    expect(round.transitions.map(t => t.kind)).toEqual(['policy-observe'])
    expect(liveGuard(round.state).policies[0]?.phase).toBe('suspect')
    round = cycle(round.state, evalInput(901_100, { lastQualifyingActivityAtMs: 901_050 }))
    expect(liveGuard(round.state).policies[0]?.phase).toBe('healthy')
    // Clock went backward; stored activity 901_050 beats the new 900_500.
    round = cycle(round.state, evalInput(900_000, { lastQualifyingActivityAtMs: 900_500 }))
    expect(round.transitions).toEqual([])
  })
  it('recovers on activity while open, reopens on re-breach, resolves after the window', () => {
    let state = createState([SILENCE])
    let round = cycle(state, evalInput(901_000))
    round = cycle(round.state, evalInput(961_000))
    expect(round.transitions.map(t => t.kind)).toEqual(['incident-open'])
    expect(liveGuard(round.state).policies[0]?.phase).toBe('open')

    round = cycle(round.state, evalInput(1_000_000, { lastQualifyingActivityAtMs: 990_000 }))
    expect(round.transitions.map(t => t.kind)).toEqual(['policy-observe', 'incident-recover'])
    expect(liveGuard(round.state).policies[0]?.phase).toBe('recovering')

    // 29s later: recovery window not yet elapsed, no re-breach.
    round = cycle(round.state, evalInput(1_019_000, { lastQualifyingActivityAtMs: 990_000 }))
    expect(round.transitions).toEqual([])
    // Re-breach while recovering (silence again) reopens, before any resolve.
    round = cycle(round.state, evalInput(1_900_000, { lastQualifyingActivityAtMs: 990_000 }))
    expect(round.transitions.map(t => t.kind)).toEqual(['incident-reopen'])
    expect(liveGuard(round.state).policies[0]?.phase).toBe('open')

    // Fresh recovery evidence again, then the confirmation window resolves.
    round = cycle(round.state, evalInput(2_000_000, { lastQualifyingActivityAtMs: 1_950_000 }))
    expect(liveGuard(round.state).policies[0]?.phase).toBe('recovering')
    round = cycle(round.state, evalInput(2_031_000, { lastQualifyingActivityAtMs: 1_950_000 }))
    expect(round.transitions.map(t => t.kind)).toEqual(['incident-resolve'])
    expect(liveGuard(round.state).policies[0]?.phase).toBe('resolved')
  })
  it('paused guards never evaluate', () => {
    const guard = liveGuard(createState([SILENCE]))
    expect(evaluateGuard({ ...guard, controlState: 'paused' }, evalInput(1000 + 900_000 + 60_000), CONFIG)).toEqual([])
  })
})

describe('deadline_unclosed', () => {
  it('suspects at the deadline and opens after confirmation', () => {
    let state = createState([DEADLINE])
    expect(evaluateGuard(liveGuard(state), evalInput(DEADLINE_MS - 1), CONFIG)).toEqual([])
    const suspect = evaluateGuard(liveGuard(state), evalInput(DEADLINE_MS), CONFIG)
    expect(suspect.map(t => t.kind)).toEqual(['policy-observe'])
    state = foldEvent(state, toEvent(state, suspect[0] as PolicyTransition))
    expect(evaluateGuard(liveGuard(state), evalInput(DEADLINE_MS + 60_000), CONFIG).map(t => t.kind)).toEqual(['incident-open'])
  })
  it('a long-lapsed deadline coalesces into one open in a single evaluation', () => {
    const guard = liveGuard(createState([DEADLINE]))
    const transitions = evaluateGuard(guard, evalInput(DEADLINE_MS + 600_000), CONFIG)
    expect(transitions.map(t => t.kind)).toEqual(['policy-observe', 'incident-open'])
  })
})

describe('abnormal_turn_streak', () => {
  it('counts abnormal reasons and ignores aborted/unknown', () => {
    const state = createState([STREAK])
    const guard = liveGuard(state)
    const one = evaluateGuard(guard, evalInput(2000, { turnEnds: [{ atMs: 1500, reason: 'error' }] }), CONFIG)
    expect(one.map(t => t.kind)).toEqual(['policy-observe'])
    expect(one[0]?.kind === 'policy-observe' ? one[0].streak : -1).toBe(1)
    const two = evaluateGuard(guard, evalInput(3000, {
      turnEnds: [
        { atMs: 1500, reason: 'error' },
        { atMs: 2000, reason: 'aborted' },
        { atMs: 2500, reason: 'unknown' },
        { atMs: 2600, reason: 'blocked' },
      ],
    }), CONFIG)
    expect(two[0]?.kind === 'policy-observe' ? two[0].streak : -1).toBe(2)
  })
  it('three consecutive abnormal turns open after confirmation', () => {
    const state = createState([STREAK])
    const guard = liveGuard(state)
    const end = (atMs: number) => ({ atMs, reason: 'error' as const })
    const suspect = evaluateGuard(guard, evalInput(4000, { turnEnds: [end(1000), end(2000), end(3000)] }), CONFIG)
    expect(suspect.map(t => t.kind)).toEqual(['policy-observe'])
    expect(suspect[0]?.kind === 'policy-observe' ? suspect[0].streak : -1).toBe(3)
    const open = evaluateGuard(guard, evalInput(64_000, { turnEnds: [end(1000), end(2000), end(3000)] }), CONFIG)
    expect(open.some(t => t.kind === 'incident-open')).toBe(true)
  })
  it('a completed turn resets the streak and recovers an open incident', () => {
    let state = createState([STREAK])
    const end = (atMs: number) => ({ atMs, reason: 'error' as const })
    let round = cycle(state, evalInput(4000, { turnEnds: [end(1000), end(2000), end(3000)] }))
    round = cycle(round.state, evalInput(64_000, { turnEnds: [end(1000), end(2000), end(3000)] }))
    expect(liveGuard(round.state).policies[0]?.phase).toBe('open')
    round = cycle(round.state, evalInput(65_000, { turnEnds: [{ atMs: 64_500, reason: 'completed' }] }))
    expect(round.transitions.map(t => t.kind)).toEqual(['policy-observe', 'incident-recover'])
    expect(liveGuard(round.state).policies[0]?.phase).toBe('recovering')
    expect(liveGuard(round.state).policies[0]?.observation.streak).toBe(0)
  })
})
