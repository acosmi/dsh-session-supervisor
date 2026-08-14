/**
 * Pure policy evaluator: computes the next observation + incident operations
 * for one Guard from observation inputs and the current clock. Emits
 * transitions (ledger event payloads), never appends or notifies. Timer ticks
 * that change nothing produce an empty list — no tick events ever hit the
 * ledger.
 *
 * Transition ordering contract: the `policy-observe` transition comes FIRST
 * (it may flip healthy→suspect or clear a breach), then incident operations
 * run against the post-observation phase. The transaction applies the list
 * in order.
 */

import { parseRfc3339Offset } from './rfc3339.ts'
import type {
  EvaluationConfig,
  GuardianEvent,
  GuardianLedgerState,
  GuardianRecord,
  PolicyEvaluationInput,
  PolicyPhase,
  PolicyRecord,
  PolicyTransition,
  TurnEndKind,
} from './types.ts'

/**
 * Materialize evaluator transitions into real ledger events, allocating
 * incident ordinals in order. Pure and deterministic: folding the returned
 * list over `state` yields the same result the transaction will persist.
 */
export function materializeTransitions(
  state: GuardianLedgerState,
  transitions: readonly PolicyTransition[],
  atMs: number,
): GuardianEvent[] {
  const events: GuardianEvent[] = []
  let nextOrdinal = state.nextIncidentOrdinal
  for (const transition of transitions) {
    if (transition.kind === 'policy-observe') {
      events.push({
        version: 1,
        kind: 'policy-observe',
        atMs,
        guardId: transition.guardId,
        policyId: transition.policyId,
        phase: transition.phase,
        anchorAtMs: transition.anchorAtMs,
        ...(transition.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: transition.lastActivityAtMs }),
        ...(transition.breachSinceAtMs === undefined ? {} : { breachSinceAtMs: transition.breachSinceAtMs }),
        ...(transition.recoverySinceAtMs === undefined ? {} : { recoverySinceAtMs: transition.recoverySinceAtMs }),
        streak: transition.streak,
      })
      continue
    }
    if (transition.kind === 'incident-open') {
      events.push({
        version: 1,
        kind: 'incident-open',
        atMs,
        guardId: transition.guardId,
        policyId: transition.policyId,
        policyRevision: transition.policyRevision,
        incidentOrdinal: nextOrdinal,
      })
      nextOrdinal += 1
      continue
    }
    const guard = state.guards.find(candidate => candidate.id === transition.guardId)
    const policy = guard?.policies.find(candidate => candidate.id === transition.policyId)
    const ordinal = policy?.currentIncidentOrdinal
    if (ordinal === undefined) {
      throw new Error(`cannot materialize ${transition.kind}: no current incident for ${String(transition.policyId)}`)
    }
    events.push({ version: 1, kind: transition.kind, atMs, guardId: transition.guardId, incidentOrdinal: ordinal })
  }
  return events
}

/** Map a durable `turn/end` reason to a classified kind; unknown reasons never feed the streak. */
export function classifyTurnEndReason(reason: string): TurnEndKind {
  switch (reason) {
    case 'completed':
    case 'aborted':
    case 'error':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      return reason
    default:
      return 'unknown'
  }
}

/**
 * Evaluate every policy of one armed Guard. Returns the ordered transitions to
 * apply in a single transaction. Deterministic in `input.nowMs` alone.
 */
export function evaluateGuard(
  guard: GuardianRecord,
  input: PolicyEvaluationInput,
  config: EvaluationConfig,
): PolicyTransition[] {
  if (guard.controlState !== 'armed') return []
  const transitions: PolicyTransition[] = []
  for (const policy of guard.policies) {
    if (policy.phase === 'dead_letter' || policy.phase === 'superseded') continue
    if (policy.kind === 'lifecycle_silence') evaluateSilence(guard, policy, input, config, transitions)
    else if (policy.kind === 'deadline_unclosed') evaluateDeadline(guard, policy, input, config, transitions)
    else evaluateStreak(guard, policy, input, config, transitions)
  }
  return transitions
}

interface ObservationChange {
  phase: PolicyPhase
  anchorAtMs: number
  lastActivityAtMs?: number
  breachSinceAtMs?: number
  recoverySinceAtMs?: number
  streak: number
}

/** Emit one observation change when anything differs from the current record. */
function emitObserve(
  guard: GuardianRecord,
  policy: PolicyRecord,
  change: ObservationChange,
  transitions: PolicyTransition[],
): void {
  const current = policy.observation
  const same = change.phase === policy.phase
    && change.anchorAtMs === current.anchorAtMs
    && change.lastActivityAtMs === current.lastActivityAtMs
    && change.breachSinceAtMs === current.breachSinceAtMs
    && change.recoverySinceAtMs === current.recoverySinceAtMs
    && change.streak === current.streak
  if (same) return
  transitions.push({
    kind: 'policy-observe',
    guardId: guard.id,
    policyId: policy.id,
    phase: change.phase,
    anchorAtMs: change.anchorAtMs,
    ...(change.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: change.lastActivityAtMs }),
    ...(change.breachSinceAtMs === undefined ? {} : { breachSinceAtMs: change.breachSinceAtMs }),
    ...(change.recoverySinceAtMs === undefined ? {} : { recoverySinceAtMs: change.recoverySinceAtMs }),
    streak: change.streak,
  })
}

function pushIncident(
  kind: PolicyTransition['kind'] & ('incident-open' | 'incident-recover' | 'incident-reopen' | 'incident-resolve'),
  guard: GuardianRecord,
  policy: PolicyRecord,
  transitions: PolicyTransition[],
): void {
  if (kind === 'incident-open') {
    transitions.push({ kind, guardId: guard.id, policyId: policy.id, policyRevision: policy.guardRevision })
    return
  }
  transitions.push({ kind, guardId: guard.id, policyId: policy.id })
}

function evaluateSilence(
  guard: GuardianRecord,
  policy: PolicyRecord,
  input: PolicyEvaluationInput,
  config: EvaluationConfig,
  transitions: PolicyTransition[],
): void {
  /* v8 ignore next -- defensive narrowing: callers dispatch on kind, so a mismatched record cannot arrive */
  if (policy.kind !== 'lifecycle_silence') return
  const observation = policy.observation
  const thresholdMs = policy.seconds * 1000
  const change: ObservationChange = {
    phase: policy.phase,
    anchorAtMs: observation.anchorAtMs,
    lastActivityAtMs: observation.lastActivityAtMs,
    breachSinceAtMs: observation.breachSinceAtMs,
    recoverySinceAtMs: observation.recoverySinceAtMs,
    streak: observation.streak,
  }

  // Fresh qualifying activity is both the suspect exit and the recovery
  // evidence. Clock-backward activity cannot undo a breach start.
  const freshActivity = input.lastQualifyingActivityAtMs !== undefined
    && (observation.lastActivityAtMs === undefined || input.lastQualifyingActivityAtMs > observation.lastActivityAtMs)
  if (freshActivity) {
    change.lastActivityAtMs = input.lastQualifyingActivityAtMs
    if (policy.phase === 'suspect') {
      change.phase = 'healthy'
      change.breachSinceAtMs = undefined
      change.recoverySinceAtMs = undefined
    } else if (policy.phase === 'open' || policy.phase === 'acknowledged' || policy.phase === 'recovering') {
      change.recoverySinceAtMs = input.lastQualifyingActivityAtMs
    } else if (policy.phase === 'resolved') {
      // Next observation epoch after resolution returns to healthy.
      change.phase = 'healthy'
      change.recoverySinceAtMs = undefined
    }
  }

  // Breach test against the effective silence base (anchor or latest activity).
  const base = Math.max(change.anchorAtMs, change.lastActivityAtMs ?? change.anchorAtMs)
  const breached = input.nowMs >= base + thresholdMs
  if (breached && change.phase === 'healthy') {
    change.phase = 'suspect'
    change.breachSinceAtMs = base + thresholdMs
  }

  const phase = change.phase
  const breachSince = change.breachSinceAtMs ?? observation.breachSinceAtMs
  const recoverySince = change.recoverySinceAtMs ?? observation.recoverySinceAtMs

  emitObserve(guard, policy, change, transitions)

  if (phase === 'suspect' && breachSince !== undefined && input.nowMs - breachSince >= config.confirmationMs) {
    pushIncident('incident-open', guard, policy, transitions)
  }
  if (phase === 'recovering') {
    if (breached) {
      pushIncident('incident-reopen', guard, policy, transitions)
    } else if (recoverySince !== undefined && input.nowMs - recoverySince >= config.recoveryConfirmationMs) {
      pushIncident('incident-resolve', guard, policy, transitions)
    }
  }
  if ((policy.phase === 'open' || policy.phase === 'acknowledged') && freshActivity) {
    pushIncident('incident-recover', guard, policy, transitions)
  }
}

function evaluateDeadline(
  guard: GuardianRecord,
  policy: PolicyRecord,
  input: PolicyEvaluationInput,
  config: EvaluationConfig,
  transitions: PolicyTransition[],
): void {
  /* v8 ignore next -- defensive narrowing: callers dispatch on kind, so a mismatched record cannot arrive */
  if (policy.kind !== 'deadline_unclosed') return
  const atMs = parseRfc3339Offset(policy.at)
  const overdue = input.nowMs >= atMs
  const observation = policy.observation
  const change: ObservationChange = {
    phase: policy.phase,
    anchorAtMs: observation.anchorAtMs,
    lastActivityAtMs: observation.lastActivityAtMs,
    breachSinceAtMs: observation.breachSinceAtMs,
    recoverySinceAtMs: observation.recoverySinceAtMs,
    streak: observation.streak,
  }
  if (overdue && policy.phase === 'healthy') {
    change.phase = 'suspect'
    change.breachSinceAtMs = atMs
  }
  const breachSince = change.breachSinceAtMs ?? observation.breachSinceAtMs
  emitObserve(guard, policy, change, transitions)
  if (change.phase === 'suspect' && breachSince !== undefined && input.nowMs - breachSince >= config.confirmationMs) {
    pushIncident('incident-open', guard, policy, transitions)
  }
}

function evaluateStreak(
  guard: GuardianRecord,
  policy: PolicyRecord,
  input: PolicyEvaluationInput,
  config: EvaluationConfig,
  transitions: PolicyTransition[],
): void {
  /* v8 ignore next -- defensive narrowing: callers dispatch on kind, so a mismatched record cannot arrive */
  if (policy.kind !== 'abnormal_turn_streak') return
  const observation = policy.observation
  const threshold = policy.count
  const change: ObservationChange = {
    phase: policy.phase,
    anchorAtMs: observation.anchorAtMs,
    lastActivityAtMs: observation.lastActivityAtMs,
    breachSinceAtMs: observation.breachSinceAtMs,
    recoverySinceAtMs: observation.recoverySinceAtMs,
    streak: observation.streak,
  }
  let lastAbnormalAtMs: number | undefined
  let sawCompleted = false
  for (const fact of input.turnEnds) {
    const kind = classifyTurnEndReason(fact.reason)
    if (kind === 'completed') {
      change.streak = 0
      sawCompleted = true
      if (policy.phase === 'open' || policy.phase === 'acknowledged' || policy.phase === 'recovering') {
        change.recoverySinceAtMs = fact.atMs
      } else if (policy.phase === 'resolved') {
        change.phase = 'healthy'
        change.recoverySinceAtMs = undefined
      } else if (policy.phase === 'suspect') {
        change.phase = 'healthy'
        change.breachSinceAtMs = undefined
      }
    } else if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens' || kind === 'interrupted') {
      change.streak += 1
      lastAbnormalAtMs = fact.atMs
    }
    // aborted and unknown reasons are recorded nowhere and reset nothing.
  }

  if (change.streak >= threshold) {
    if (change.phase === 'healthy') {
      change.phase = 'suspect'
      change.breachSinceAtMs = lastAbnormalAtMs ?? input.nowMs
    }
  } else if (change.phase === 'suspect') {
    change.phase = 'healthy'
    change.breachSinceAtMs = undefined
  }

  const breachSince = change.breachSinceAtMs ?? observation.breachSinceAtMs
  const recoverySince = change.recoverySinceAtMs ?? observation.recoverySinceAtMs

  emitObserve(guard, policy, change, transitions)

  if (change.phase === 'suspect' && breachSince !== undefined && input.nowMs - breachSince >= config.confirmationMs) {
    pushIncident('incident-open', guard, policy, transitions)
  }
  if (policy.phase === 'recovering' && change.phase === 'recovering') {
    if (change.streak >= threshold) {
      pushIncident('incident-reopen', guard, policy, transitions)
    } else if (sawCompleted && recoverySince !== undefined && input.nowMs - recoverySince >= config.recoveryConfirmationMs) {
      pushIncident('incident-resolve', guard, policy, transitions)
    }
  }
  if ((policy.phase === 'open' || policy.phase === 'acknowledged') && sawCompleted) {
    pushIncident('incident-recover', guard, policy, transitions)
  }
}
