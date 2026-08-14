/**
 * Pure ledger invariants. In the shipped plugin these run under a dev/CI
 * companion; here they are dependency-free so the pure core can be verified
 * without a Context. Violations throw — invariants describe owned
 * relationships (event/data relations), never service presence.
 */

import { decodeGuardianEvent, foldEvents, newLedgerState } from './domain.ts'
import type { GuardianEvent, GuardianLedgerState, PolicyRecord, SessionOwnerId } from './types.ts'

class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(`guardian invariant: ${message}`)
    this.name = 'LedgerInvariantError'
  }
}

/**
 * Assert the folded state is self-consistent: ownership, id monotonicity,
 * policy/incident linkage, and the phase mirror between a policy and its
 * current incident.
 */
export function assertLedgerInvariants(state: GuardianLedgerState): void {
  if (state.sessionId.length === 0) throw new LedgerInvariantError('session id is empty')
  let maxIncidentOrdinal = 0
  for (const guard of state.guards) {
    if (guard.ownerSessionId !== state.sessionId) {
      throw new LedgerInvariantError(`guard ${guard.id} owner ${guard.ownerSessionId} != session ${state.sessionId}`)
    }
    if (guard.revision < 1 || !Number.isSafeInteger(guard.revision)) {
      throw new LedgerInvariantError(`guard ${guard.id} has illegal revision ${guard.revision}`)
    }
    const policyIds = new Set<string>()
    for (const policy of guard.policies) {
      if (policyIds.has(policy.id)) throw new LedgerInvariantError(`duplicate policy ${policy.id} on guard ${guard.id}`)
      policyIds.add(policy.id)
      if (policy.phase !== 'superseded' && policy.guardRevision !== guard.revision) {
        throw new LedgerInvariantError(`policy ${policy.id} revision ${policy.guardRevision} != guard revision ${guard.revision}`)
      }
      if (policy.observation.streak < 0 || !Number.isSafeInteger(policy.observation.streak)) {
        throw new LedgerInvariantError(`policy ${policy.id} has illegal streak ${policy.observation.streak}`)
      }
      assertIncidentMirror(guard, policy)
    }
    let previous = 0
    for (const incident of guard.incidents) {
      if (incident.ordinal <= previous || !Number.isSafeInteger(incident.ordinal)) {
        throw new LedgerInvariantError(`guard ${guard.id} incident ordinals are not strictly increasing`)
      }
      previous = incident.ordinal
      maxIncidentOrdinal = Math.max(maxIncidentOrdinal, incident.ordinal)
      if (incident.guardId !== guard.id) throw new LedgerInvariantError('incident guardId mismatch')
      if (incident.delivery.attempts < 0 || !Number.isSafeInteger(incident.delivery.attempts)) {
        throw new LedgerInvariantError(`incident #${incident.ordinal} has illegal attempt count`)
      }
    }
  }
  if (state.nextIncidentOrdinal <= maxIncidentOrdinal) throw new LedgerInvariantError('incident ordinal allocation went backwards')
}

function assertIncidentMirror(guard: GuardianLedgerState['guards'][number], policy: PolicyRecord): void {
  const linked = policy.currentIncidentOrdinal
  if (policy.phase === 'suspect' || policy.phase === 'healthy') {
    if (linked !== undefined) throw new LedgerInvariantError(`policy ${policy.id} is ${policy.phase} but links incident #${linked}`)
    return
  }
  if (policy.phase === 'superseded') return
  if (linked === undefined) throw new LedgerInvariantError(`policy ${policy.id} is ${policy.phase} without a current incident`)
  const incident = guard.incidents.find(candidate => candidate.ordinal === linked)
  if (!incident) throw new LedgerInvariantError(`policy ${policy.id} links missing incident #${linked}`)
  if (incident.policyId !== policy.id) throw new LedgerInvariantError('incident policyId mismatch')
  const mirror = {
    open: 'open',
    acknowledged: 'acknowledged',
    recovering: 'recovering',
    resolved: 'resolved',
    dead_letter: 'dead_letter',
  } as const
  const expected = mirror[policy.phase as keyof typeof mirror]
  if (expected !== undefined && incident.phase !== expected) {
    throw new LedgerInvariantError(`policy ${policy.id} phase ${policy.phase} != incident phase ${incident.phase}`)
  }
}

/** Fold twice and require byte-identical states: replay is deterministic. */
export function assertReplayDeterminism(
  events: readonly unknown[],
  sessionId: SessionOwnerId,
): void {
  const decoded: GuardianEvent[] = events.map(event => decodeGuardianEvent(event))
  const first = foldEvents(newLedgerState(sessionId), decoded)
  const second = foldEvents(newLedgerState(sessionId), decoded)
  /* v8 ignore next 3 -- defensive: deterministic pure folds cannot differ, so the mismatch path is unreachable */
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new LedgerInvariantError('event replay is not deterministic')
  }
}
