import { describe, expect, it } from 'vitest'
import { foldEvent, foldEvents, newLedgerState } from '../src/domain.ts'
import { assertLedgerInvariants, assertReplayDeterminism } from '../src/invariant.ts'
import type { GuardianEvent, GuardianPolicySpec } from '../src/types.ts'

const SESSION = 'sess-1' as const
const SILENCE: GuardianPolicySpec = { id: 'p-silence', kind: 'lifecycle_silence', seconds: 900 }

const createEvent: GuardianEvent = {
  version: 1,
  kind: 'create',
  atMs: 1000,
  guard: { id: 'g1', label: 'g', ownerSessionId: SESSION, notificationMode: 'audit_only', policies: [SILENCE] },
}

function stateWithOpenIncident() {
  let state = foldEvent(newLedgerState(SESSION), createEvent)
  state = foldEvent(state, { version: 1, kind: 'policy-observe', atMs: 2000, guardId: 'g1', policyId: 'p-silence', phase: 'suspect', anchorAtMs: 1000, breachSinceAtMs: 1900, streak: 0 })
  state = foldEvent(state, { version: 1, kind: 'incident-open', atMs: 2000, guardId: 'g1', policyId: 'p-silence', policyRevision: 1, incidentOrdinal: 1 })
  return state
}

describe('assertLedgerInvariants', () => {
  it('accepts a consistent ledger', () => {
    expect(() => assertLedgerInvariants(stateWithOpenIncident())).not.toThrow()
  })
  it('rejects phase/incident mirror mismatches', () => {
    const state = stateWithOpenIncident()
    const guard = state.guards[0]
    if (!guard) throw new Error('missing guard')
    const policy = guard.policies[0]
    if (!policy) throw new Error('missing policy')
    const broken = {
      ...state,
      guards: [{ ...guard, policies: [{ ...policy, currentIncidentOrdinal: undefined }] }],
    }
    expect(() => assertLedgerInvariants(broken)).toThrow(/without a current incident/)
  })
  it('rejects cross-owner guards and revision drift on live policies', () => {
    const state = stateWithOpenIncident()
    const guard = state.guards[0]
    if (!guard) throw new Error('missing guard')
    const brokenOwner = { ...state, guards: [{ ...guard, ownerSessionId: 'other' }] }
    expect(() => assertLedgerInvariants(brokenOwner)).toThrow(/owner/)
    const policy = guard.policies[0]
    if (!policy) throw new Error('missing policy')
    expect(() => assertLedgerInvariants({
      ...state,
      guards: [{ ...guard, policies: [{ ...policy, guardRevision: 7 }] }],
    })).toThrow(/revision/)
  })
  it('rejects non-monotonic incident ordinals', () => {
    const state = stateWithOpenIncident()
    const guard = state.guards[0]
    if (!guard) throw new Error('missing guard')
    const incident = guard.incidents[0]
    if (!incident) throw new Error('missing incident')
    expect(() => assertLedgerInvariants({
      ...state,
      guards: [{ ...guard, incidents: [incident, { ...incident, ordinal: 1 }] }],
    })).toThrow(/strictly increasing/)
  })
})

describe('assertReplayDeterminism', () => {
  it('folds an event stream to byte-identical states', () => {
    const events = [
      createEvent,
      { version: 1, kind: 'control', atMs: 2000, guardId: 'g1', operation: 'pause' },
      { version: 1, kind: 'control', atMs: 3000, guardId: 'g1', operation: 'resume' },
    ] as const
    expect(() => assertReplayDeterminism(events, SESSION)).not.toThrow()
    expect(JSON.stringify(foldEvents(newLedgerState(SESSION), events))).toMatch(/"g1"/)
  })
  it('throws on streams a strict decoder rejects', () => {
    expect(() => assertReplayDeterminism([{ ...createEvent, version: 9 }], SESSION)).toThrow(/unsupported event version/)
  })
})
