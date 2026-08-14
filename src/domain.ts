/**
 * Pure domain fold: strict decoding of versioned ledger events and the
 * Guard/Policy/Incident state machine. No clock, I/O, Context, or globals —
 * time only ever enters through event payloads.
 */

import { formatRfc3339Utc, isRfc3339Offset, parseRfc3339Offset } from './rfc3339.ts'
import type {
  DeliveryState,
  GuardianEvent,
  GuardianId,
  GuardianLedgerState,
  GuardianPolicySpec,
  GuardianRecord,
  GuardianSpec,
  IncidentRecord,
  NotificationMode,
  PolicyId,
  PolicyPhase,
  PolicyRecord,
  SessionOwnerId,
} from './types.ts'
import { GUARDIAN_LEDGER_VERSION } from './types.ts'

/** Fail-closed ledger violation. Callers never retry these as transient. */
export class GuardianLogError extends Error {
  constructor(message: string) {
    super(`guardian ledger: ${message}`)
    this.name = 'GuardianLogError'
  }
}

/** Protocol decode caps; deployment tunables arrive via Config (P2). */
export interface DecodeLimits {
  maxGuardIdBytes: number
  maxPolicyIdBytes: number
  maxLabelBytes: number
  maxPoliciesPerGuard: number
  maxSilenceSeconds: number
  maxStreakCount: number
  maxIncidentOrdinal: number
}

export const DEFAULT_DECODE_LIMITS: DecodeLimits = {
  maxGuardIdBytes: 128,
  maxPolicyIdBytes: 128,
  maxLabelBytes: 240,
  maxPoliciesPerGuard: 8,
  maxSilenceSeconds: 60 * 60 * 24 * 30,
  maxStreakCount: 1000,
  maxIncidentOrdinal: 100_000,
}

const GUARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSafeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

const isPlainString = (value: unknown): value is string => typeof value === 'string'

/** Reject keys outside `allowed` so typo'd payloads fail loud at decode. */
function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new GuardianLogError(`${subject} carries unknown field ${JSON.stringify(key)}`)
  }
}

function decodeBrandedId(value: unknown, label: string, maxBytes: number): string {
  if (!isPlainString(value)) throw new GuardianLogError(`${label} must be a string`)
  if (value.length === 0 || value.length > maxBytes) throw new GuardianLogError(`${label} length out of bounds`)
  if (!GUARD_ID_RE.test(value)) throw new GuardianLogError(`${label} ${JSON.stringify(value)} is not a valid id`)
  return value
}

function decodeGuardianId(value: unknown, limits: DecodeLimits, label = 'guardian id'): GuardianId {
  return decodeBrandedId(value, label, limits.maxGuardIdBytes) as GuardianId
}

function decodePolicyId(value: unknown, limits: DecodeLimits): PolicyId {
  return decodeBrandedId(value, 'policy id', limits.maxPolicyIdBytes) as PolicyId
}

function decodeSessionOwnerId(value: unknown, limits: DecodeLimits): SessionOwnerId {
  return decodeBrandedId(value, 'owner session id', limits.maxGuardIdBytes) as SessionOwnerId
}

function decodeLabel(value: unknown, limits: DecodeLimits): string {
  if (!isPlainString(value)) throw new GuardianLogError('label must be a string')
  if (value.length > limits.maxLabelBytes) throw new GuardianLogError('label exceeds byte limit')
  return value
}

function decodeNotificationMode(value: unknown): NotificationMode {
  if (value === 'audit_only' || value === 'owner_followup') return value
  throw new GuardianLogError(`unknown notification mode ${JSON.stringify(value)}`)
}

function decodePolicySpec(value: unknown, limits: DecodeLimits): GuardianPolicySpec {
  if (!isRecord(value)) throw new GuardianLogError('policy must be an object')
  const kind = value['kind']
  if (kind === 'lifecycle_silence') {
    assertOnlyKeys(value, ['id', 'kind', 'seconds'], 'lifecycle_silence policy')
    const seconds = value['seconds']
    if (!isSafeInt(seconds) || seconds < 1 || seconds > limits.maxSilenceSeconds) {
      throw new GuardianLogError('lifecycle_silence seconds must be a positive safe integer within limits')
    }
    return { id: decodePolicyId(value['id'], limits), kind, seconds }
  }
  if (kind === 'deadline_unclosed') {
    assertOnlyKeys(value, ['id', 'kind', 'at'], 'deadline_unclosed policy')
    const at = value['at']
    if (!isRfc3339Offset(at)) throw new GuardianLogError('deadline_unclosed at must be a strict RFC 3339 instant with offset')
    parseRfc3339Offset(at)
    return { id: decodePolicyId(value['id'], limits), kind, at }
  }
  if (kind === 'abnormal_turn_streak') {
    assertOnlyKeys(value, ['id', 'kind', 'count'], 'abnormal_turn_streak policy')
    const count = value['count']
    if (!isSafeInt(count) || count < 1 || count > limits.maxStreakCount) {
      throw new GuardianLogError('abnormal_turn_streak count must be a positive safe integer within limits')
    }
    return { id: decodePolicyId(value['id'], limits), kind, count }
  }
  throw new GuardianLogError(`unknown policy kind ${JSON.stringify(kind)}`)
}

function decodePolicies(value: unknown, limits: DecodeLimits): GuardianPolicySpec[] {
  if (!Array.isArray(value)) throw new GuardianLogError('policies must be an array')
  if (value.length === 0) throw new GuardianLogError('at least one policy is required')
  if (value.length > limits.maxPoliciesPerGuard) throw new GuardianLogError('too many policies')
  const seen = new Set<string>()
  const policies = value.map(item => decodePolicySpec(item, limits))
  for (const policy of policies) {
    if (seen.has(policy.id)) throw new GuardianLogError(`duplicate policy id ${JSON.stringify(policy.id)}`)
    seen.add(policy.id)
  }
  return policies
}

function decodeAtMs(value: unknown, label: string): number {
  if (!isSafeInt(value) || value < 0) throw new GuardianLogError(`${label} must be a non-negative safe integer`)
  return value
}

function decodePhase(value: unknown, label: string): PolicyPhase {
  if (typeof value !== 'string') throw new GuardianLogError(`${label} must be a string`)
  switch (value) {
    case 'healthy':
    case 'suspect':
    case 'open':
    case 'acknowledged':
    case 'recovering':
    case 'resolved':
    case 'dead_letter':
    case 'superseded':
      return value
    default:
      throw new GuardianLogError(`unknown policy phase ${JSON.stringify(value)}`)
  }
}

/**
 * Decode one versioned ledger event with exact-shape validation. Unknown
 * versions, unknown kinds, extra fields, and out-of-range values fail closed.
 */
export function decodeGuardianEvent(value: unknown, limits: DecodeLimits = DEFAULT_DECODE_LIMITS): GuardianEvent {
  if (!isRecord(value)) throw new GuardianLogError('event must be an object')
  const version = value['version']
  if (version !== GUARDIAN_LEDGER_VERSION) throw new GuardianLogError(`unsupported event version ${JSON.stringify(version)}`)
  const kind = value['kind']
  if (!isPlainString(kind)) throw new GuardianLogError('event kind must be a string')
  const atMs = decodeAtMs(value['atMs'], `${kind} atMs`)
  const common = ['version', 'kind', 'atMs']
  switch (kind) {
    case 'create': {
      assertOnlyKeys(value, [...common, 'guard'], 'create event')
      const guard = value['guard']
      if (!isRecord(guard)) throw new GuardianLogError('create guard must be an object')
      assertOnlyKeys(guard, ['id', 'label', 'ownerSessionId', 'notificationMode', 'policies'], 'create guard')
      return {
        version: 1,
        kind,
        atMs,
        guard: {
          id: decodeGuardianId(guard['id'], limits),
          label: decodeLabel(guard['label'], limits),
          ownerSessionId: decodeSessionOwnerId(guard['ownerSessionId'], limits),
          notificationMode: decodeNotificationMode(guard['notificationMode']),
          policies: decodePolicies(guard['policies'], limits),
        },
      }
    }
    case 'revise': {
      assertOnlyKeys(value, [...common, 'guardId', 'expectedRevision', 'label', 'notificationMode', 'policies'], 'revise event')
      const expectedRevision = value['expectedRevision']
      if (!isSafeInt(expectedRevision) || expectedRevision < 1) throw new GuardianLogError('expectedRevision must be a positive safe integer')
      const label = value['label']
      const notificationMode = value['notificationMode']
      return {
        version: 1,
        kind,
        atMs,
        guardId: decodeGuardianId(value['guardId'], limits),
        expectedRevision,
        ...(label === undefined ? {} : { label: decodeLabel(label, limits) }),
        ...(notificationMode === undefined ? {} : { notificationMode: decodeNotificationMode(notificationMode) }),
        policies: decodePolicies(value['policies'], limits),
      }
    }
    case 'control': {
      assertOnlyKeys(value, [...common, 'guardId', 'operation'], 'control event')
      const operation = value['operation']
      if (operation !== 'pause' && operation !== 'resume' && operation !== 'close') {
        throw new GuardianLogError(`unknown control operation ${JSON.stringify(operation)}`)
      }
      return { version: 1, kind, atMs, guardId: decodeGuardianId(value['guardId'], limits), operation }
    }
    case 'policy-observe': {
      assertOnlyKeys(value, [...common, 'guardId', 'policyId', 'phase', 'anchorAtMs', 'lastActivityAtMs', 'breachSinceAtMs', 'recoverySinceAtMs', 'streak'], 'policy-observe event')
      const streak = value['streak']
      if (!isSafeInt(streak) || streak < 0) throw new GuardianLogError('streak must be a non-negative safe integer')
      return {
        version: 1,
        kind,
        atMs,
        guardId: decodeGuardianId(value['guardId'], limits),
        policyId: decodePolicyId(value['policyId'], limits),
        phase: decodePhase(value['phase'], 'policy-observe phase'),
        anchorAtMs: decodeAtMs(value['anchorAtMs'], 'anchorAtMs'),
        ...(value['lastActivityAtMs'] === undefined ? {} : { lastActivityAtMs: decodeAtMs(value['lastActivityAtMs'], 'lastActivityAtMs') }),
        ...(value['breachSinceAtMs'] === undefined ? {} : { breachSinceAtMs: decodeAtMs(value['breachSinceAtMs'], 'breachSinceAtMs') }),
        ...(value['recoverySinceAtMs'] === undefined ? {} : { recoverySinceAtMs: decodeAtMs(value['recoverySinceAtMs'], 'recoverySinceAtMs') }),
        streak,
      }
    }
    case 'incident-open': {
      assertOnlyKeys(value, [...common, 'guardId', 'policyId', 'policyRevision', 'incidentOrdinal'], 'incident-open event')
      const policyRevision = value['policyRevision']
      const incidentOrdinal = value['incidentOrdinal']
      if (!isSafeInt(policyRevision) || policyRevision < 1) throw new GuardianLogError('policyRevision must be a positive safe integer')
      if (!isSafeInt(incidentOrdinal) || incidentOrdinal < 1 || incidentOrdinal > limits.maxIncidentOrdinal) {
        throw new GuardianLogError('incidentOrdinal out of bounds')
      }
      return {
        version: 1,
        kind,
        atMs,
        guardId: decodeGuardianId(value['guardId'], limits),
        policyId: decodePolicyId(value['policyId'], limits),
        policyRevision,
        incidentOrdinal,
      }
    }
    case 'incident-acknowledge':
    case 'incident-recover':
    case 'incident-reopen':
    case 'incident-resolve':
    case 'delivery-accepted':
    case 'delivery-dead-letter': {
      assertOnlyKeys(value, [...common, 'guardId', 'incidentOrdinal'], `${kind} event`)
      const incidentOrdinal = value['incidentOrdinal']
      if (!isSafeInt(incidentOrdinal) || incidentOrdinal < 1 || incidentOrdinal > limits.maxIncidentOrdinal) {
        throw new GuardianLogError('incidentOrdinal out of bounds')
      }
      return { version: 1, kind, atMs, guardId: decodeGuardianId(value['guardId'], limits), incidentOrdinal }
    }
    case 'delivery-failed': {
      assertOnlyKeys(value, [...common, 'guardId', 'incidentOrdinal', 'attempt'], 'delivery-failed event')
      const incidentOrdinal = value['incidentOrdinal']
      const attempt = value['attempt']
      if (!isSafeInt(incidentOrdinal) || incidentOrdinal < 1 || incidentOrdinal > limits.maxIncidentOrdinal) {
        throw new GuardianLogError('incidentOrdinal out of bounds')
      }
      if (!isSafeInt(attempt) || attempt < 1) throw new GuardianLogError('attempt must be a positive safe integer')
      return { version: 1, kind, atMs, guardId: decodeGuardianId(value['guardId'], limits), incidentOrdinal, attempt }
    }
    default:
      throw new GuardianLogError(`unknown event kind ${JSON.stringify(kind)}`)
  }
}

/** Empty ledger for one owner session. */
export function newLedgerState(sessionId: SessionOwnerId): GuardianLedgerState {
  return { version: 1, sessionId, nextGuardianOrdinal: 1, nextIncidentOrdinal: 1, guards: [] }
}

/** Allocate the next per-session Guard id (ids are never reused). */
export function allocateGuardianId(state: GuardianLedgerState): GuardianId {
  return `guardian-${state.nextGuardianOrdinal}` as GuardianId
}

function findGuard(state: GuardianLedgerState, guardId: GuardianId): GuardianRecord {
  const guard = state.guards.find(candidate => candidate.id === guardId)
  if (!guard) throw new GuardianLogError(`unknown guard ${JSON.stringify(guardId)}`)
  return guard
}

function findPolicy(guard: GuardianRecord, policyId: PolicyId): PolicyRecord {
  const policy = guard.policies.find(candidate => candidate.id === policyId)
  if (!policy) throw new GuardianLogError(`guard ${JSON.stringify(guard.id)} has no policy ${JSON.stringify(policyId)}`)
  return policy
}

function findIncident(guard: GuardianRecord, ordinal: number): IncidentRecord {
  const incident = guard.incidents.find(candidate => candidate.ordinal === ordinal)
  if (!incident) throw new GuardianLogError(`guard ${JSON.stringify(guard.id)} has no incident #${ordinal}`)
  return incident
}

const OBSERVE_TRANSITIONS: Readonly<Record<PolicyPhase, readonly PolicyPhase[]>> = {
  healthy: ['healthy', 'suspect'],
  suspect: ['suspect', 'healthy'],
  open: ['open'],
  acknowledged: ['acknowledged'],
  recovering: ['recovering'],
  resolved: ['resolved', 'healthy'],
  dead_letter: [],
  superseded: [],
}

const policySpecsEqual = (a: GuardianPolicySpec, b: GuardianPolicySpec): boolean => {
  if (a.id !== b.id || a.kind !== b.kind) return false
  switch (a.kind) {
    case 'lifecycle_silence':
      return b.kind === 'lifecycle_silence' && a.seconds === b.seconds
    case 'deadline_unclosed':
      return b.kind === 'deadline_unclosed' && a.at === b.at
    case 'abnormal_turn_streak':
      return b.kind === 'abnormal_turn_streak' && a.count === b.count
  }
}

function makePolicyRecord(spec: GuardianPolicySpec, guardRevision: number, anchorAtMs: number): PolicyRecord {
  return { ...spec, guardRevision, phase: 'healthy', observation: { anchorAtMs, streak: 0 } }
}

/** Supersede a policy record and close its still-actionable incident, if any. */
function supersedeCurrentIncident(guard: GuardianRecord, policy: PolicyRecord, atMs: number): void {
  const ordinal = policy.currentIncidentOrdinal
  if (ordinal !== undefined) {
    const incident = findIncident(guard, ordinal)
    if (incident.phase === 'open' || incident.phase === 'acknowledged' || incident.phase === 'recovering') {
      incident.phase = 'superseded'
      incident.supersededAtMs = atMs
    }
  }
  policy.currentIncidentOrdinal = undefined
  policy.phase = 'superseded'
}

function immutable<T>(value: T): Readonly<T> {
  return Object.freeze(value) as Readonly<T>
}

/**
 * Fold one decoded event into the ledger. Returns the new immutable state;
 * the input state is never mutated. Violations fail closed via
 * {@link GuardianLogError} — callers treat those as integrity failures, never
 * as transient availability problems.
 */
export function foldEvent(state: GuardianLedgerState, event: GuardianEvent): GuardianLedgerState {
  switch (event.kind) {
    case 'create': {
      if (state.guards.some(guard => guard.id === event.guard.id)) {
        throw new GuardianLogError(`guard id ${JSON.stringify(event.guard.id)} already exists (ids are never reused)`)
      }
      if (event.guard.ownerSessionId !== state.sessionId) {
        throw new GuardianLogError(`create owner ${JSON.stringify(event.guard.ownerSessionId)} does not match session ${JSON.stringify(state.sessionId)}`)
      }
      const guard: GuardianRecord = {
        id: event.guard.id,
        revision: 1,
        label: event.guard.label,
        ownerSessionId: event.guard.ownerSessionId,
        createdAt: formatRfc3339Utc(event.atMs),
        controlState: 'armed',
        notificationMode: event.guard.notificationMode,
        policies: event.guard.policies.map(spec => makePolicyRecord(spec, 1, event.atMs)),
        incidents: [],
      }
      return immutable({
        ...state,
        nextGuardianOrdinal: state.nextGuardianOrdinal + 1,
        guards: [...state.guards, guard],
      })
    }
    case 'revise': {
      const guard = findGuard(state, event.guardId)
      if (event.expectedRevision !== guard.revision) {
        throw new GuardianLogError(`revise expected revision ${event.expectedRevision}, guard is at ${guard.revision}`)
      }
      const newRevision = guard.revision + 1
      const sameParams = (policy: PolicyRecord): boolean =>
        event.policies.some(spec => policySpecsEqual(spec, policyParams(policy)))
      for (const policy of guard.policies) {
        if (!sameParams(policy)) supersedeCurrentIncident(guard, policy, event.atMs)
      }
      const keptIds = new Set(guard.policies.filter(policy => sameParams(policy)).map(policy => policy.id))
      const remaining = event.policies.filter(spec => !keptIds.has(spec.id))
      const policies: PolicyRecord[] = [
        // Superseded records stay for the audit trail; kept records bump revision.
        ...guard.policies.map(policy => sameParams(policy) ? { ...policy, guardRevision: newRevision } : policy),
        ...remaining.map(spec => makePolicyRecord(spec, newRevision, event.atMs)),
      ]
      return immutable({
        ...state,
        guards: state.guards.map(candidate => candidate.id === guard.id
          ? {
              ...guard,
              revision: newRevision,
              ...(event.label === undefined ? {} : { label: event.label }),
              /* v8 ignore next -- both sides exercised; v8 reports this spread ternary as a single counter */
              ...(event.notificationMode === undefined ? {} : { notificationMode: event.notificationMode }),
              policies,
            }
          : candidate),
      })
    }
    case 'control': {
      const guard = findGuard(state, event.guardId)
      if (event.operation === 'pause') {
        if (guard.controlState !== 'armed') throw new GuardianLogError(`cannot pause guard in ${guard.controlState} state`)
        return immutable({ ...state, guards: replaceGuard(state, guard, { controlState: 'paused' }) })
      }
      if (event.operation === 'resume') {
        if (guard.controlState !== 'paused') throw new GuardianLogError(`cannot resume guard in ${guard.controlState} state`)
        return immutable({
          ...state,
          guards: replaceGuard(state, guard, {
            controlState: 'armed',
            policies: guard.policies.map(policy => policy.kind === 'lifecycle_silence'
              ? { ...policy, observation: { anchorAtMs: event.atMs, streak: policy.observation.streak } }
              : policy),
          }),
        })
      }
      // close
      if (guard.controlState === 'closed') throw new GuardianLogError('guard is already closed')
      for (const policy of guard.policies) supersedeCurrentIncident(guard, policy, event.atMs)
      return immutable({ ...state, guards: replaceGuard(state, guard, { controlState: 'closed' }) })
    }
    case 'policy-observe': {
      const guard = findGuard(state, event.guardId)
      if (guard.controlState === 'closed') throw new GuardianLogError('cannot observe a closed guard')
      const policy = findPolicy(guard, event.policyId)
      if (policy.phase === 'dead_letter' || policy.phase === 'superseded') {
        throw new GuardianLogError(`policy ${JSON.stringify(policy.id)} is ${policy.phase}; observations are frozen`)
      }
      if (!OBSERVE_TRANSITIONS[policy.phase].includes(event.phase)) {
        throw new GuardianLogError(`illegal phase transition ${policy.phase} -> ${event.phase} for policy ${JSON.stringify(policy.id)}`)
      }
      return immutable({
        ...state,
        guards: replaceGuard(state, guard, {
          policies: guard.policies.map(candidate => candidate.id === policy.id
            ? {
                ...candidate,
                phase: event.phase,
                // The first healthy epoch after resolution clears the incident linkage.
                ...(event.phase === 'healthy' && policy.phase === 'resolved' ? { currentIncidentOrdinal: undefined } : {}),
                observation: {
                  anchorAtMs: event.anchorAtMs,
                  ...(event.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: event.lastActivityAtMs }),
                  ...(event.breachSinceAtMs === undefined ? {} : { breachSinceAtMs: event.breachSinceAtMs }),
                  ...(event.recoverySinceAtMs === undefined ? {} : { recoverySinceAtMs: event.recoverySinceAtMs }),
                  streak: event.streak,
                },
              }
            : candidate),
        }),
      })
    }
    case 'incident-open': {
      const guard = findGuard(state, event.guardId)
      const policy = findPolicy(guard, event.policyId)
      if (policy.phase !== 'suspect') throw new GuardianLogError(`incident-open requires suspect policy, got ${policy.phase}`)
      if (event.policyRevision !== policy.guardRevision) {
        throw new GuardianLogError(`incident-open revision ${event.policyRevision} != policy revision ${policy.guardRevision}`)
      }
      if (event.incidentOrdinal !== state.nextIncidentOrdinal) {
        throw new GuardianLogError(`incident ordinal must be allocated in order: expected ${state.nextIncidentOrdinal}`)
      }
      const incident: IncidentRecord = {
        ordinal: event.incidentOrdinal,
        guardId: guard.id,
        policyId: policy.id,
        policyRevision: event.policyRevision,
        phase: 'open',
        openedAtMs: event.atMs,
        delivery: { state: 'pending', attempts: 0 },
      }
      return immutable({
        ...state,
        nextIncidentOrdinal: state.nextIncidentOrdinal + 1,
        guards: replaceGuard(state, guard, {
          policies: guard.policies.map(candidate => candidate.id === policy.id
            ? { ...candidate, phase: 'open', currentIncidentOrdinal: incident.ordinal }
            : candidate),
          incidents: [...guard.incidents, incident],
        }),
      })
    }
    case 'incident-acknowledge': {
      const guard = findGuard(state, event.guardId)
      const incident = findIncident(guard, event.incidentOrdinal)
      if (incident.phase === 'acknowledged') return state // idempotent by design
      if (incident.phase === 'resolved' || incident.phase === 'superseded') {
        throw new GuardianLogError(`cannot acknowledge ${incident.phase} incident`)
      }
      const policy = guard.policies.find(candidate => candidate.currentIncidentOrdinal === incident.ordinal)
      return immutable({
        ...state,
        guards: replaceGuard(state, guard, {
          policies: guard.policies.map(candidate => candidate === policy
            ? { ...candidate, phase: 'acknowledged' }
            : candidate),
          incidents: guard.incidents.map(candidate => candidate.ordinal === incident.ordinal
            ? { ...candidate, phase: 'acknowledged', acknowledgedAtMs: event.atMs }
            : candidate),
        }),
      })
    }
    case 'incident-recover': {
      const guard = findGuard(state, event.guardId)
      const incident = findIncident(guard, event.incidentOrdinal)
      if (incident.phase === 'recovering') return state // idempotent
      if (incident.phase !== 'open' && incident.phase !== 'acknowledged') {
        throw new GuardianLogError(`cannot recover ${incident.phase} incident`)
      }
      const policy = guard.policies.find(candidate => candidate.currentIncidentOrdinal === incident.ordinal)
      return immutable({
        ...state,
        guards: replaceGuard(state, guard, {
          policies: guard.policies.map(candidate => candidate === policy
            ? { ...candidate, phase: 'recovering' }
            : candidate),
          incidents: guard.incidents.map(candidate => candidate.ordinal === incident.ordinal
            ? { ...candidate, phase: 'recovering' }
            : candidate),
        }),
      })
    }
    case 'incident-reopen': {
      const guard = findGuard(state, event.guardId)
      const incident = findIncident(guard, event.incidentOrdinal)
      if (incident.phase !== 'recovering') throw new GuardianLogError(`cannot reopen ${incident.phase} incident`)
      const policy = guard.policies.find(candidate => candidate.currentIncidentOrdinal === incident.ordinal)
      return immutable({
        ...state,
        guards: replaceGuard(state, guard, {
          policies: guard.policies.map(candidate => candidate === policy
            ? { ...candidate, phase: 'open' }
            : candidate),
          incidents: guard.incidents.map(candidate => candidate.ordinal === incident.ordinal
            ? { ...candidate, phase: 'open', reopenedAtMs: event.atMs }
            : candidate),
        }),
      })
    }
    case 'incident-resolve': {
      const guard = findGuard(state, event.guardId)
      const incident = findIncident(guard, event.incidentOrdinal)
      if (incident.phase !== 'recovering') throw new GuardianLogError(`cannot resolve ${incident.phase} incident`)
      const policy = guard.policies.find(candidate => candidate.currentIncidentOrdinal === incident.ordinal)
      return immutable({
        ...state,
        guards: replaceGuard(state, guard, {
          policies: guard.policies.map(candidate => candidate === policy
            ? { ...candidate, phase: 'resolved' }
            : candidate),
          incidents: guard.incidents.map(candidate => candidate.ordinal === incident.ordinal
            ? { ...candidate, phase: 'resolved', resolvedAtMs: event.atMs }
            : candidate),
        }),
      })
    }
    case 'delivery-accepted': {
      const guard = findGuard(state, event.guardId)
      const incident = findIncident(guard, event.incidentOrdinal)
      if (incident.phase === 'resolved' || incident.phase === 'superseded') {
        throw new GuardianLogError('cannot deliver to a closed incident')
      }
      if (incident.delivery.state === 'accepted') return state // idempotent
      if (incident.delivery.state === 'dead_letter') throw new GuardianLogError('dead-lettered incident cannot accept delivery')
      return immutable({
        ...state,
        guards: replaceGuard(state, guard, {
          incidents: guard.incidents.map(candidate => candidate.ordinal === incident.ordinal
            ? { ...candidate, delivery: { state: 'accepted', attempts: candidate.delivery.attempts, lastAttemptAtMs: event.atMs } }
            : candidate),
        }),
      })
    }
    case 'delivery-failed': {
      const guard = findGuard(state, event.guardId)
      const incident = findIncident(guard, event.incidentOrdinal)
      if (incident.phase === 'resolved' || incident.phase === 'superseded' || incident.delivery.state === 'dead_letter') {
        throw new GuardianLogError('cannot record a failed delivery for this incident')
      }
      if (event.attempt !== incident.delivery.attempts + 1) {
        throw new GuardianLogError(`delivery attempts must advance contiguously: expected ${incident.delivery.attempts + 1}`)
      }
      return immutable({
        ...state,
        guards: replaceGuard(state, guard, {
          incidents: guard.incidents.map(candidate => candidate.ordinal === incident.ordinal
            ? { ...candidate, delivery: { state: 'failed', attempts: event.attempt, lastAttemptAtMs: event.atMs } }
            : candidate),
        }),
      })
    }
    case 'delivery-dead-letter': {
      const guard = findGuard(state, event.guardId)
      const incident = findIncident(guard, event.incidentOrdinal)
      if (incident.phase === 'resolved' || incident.phase === 'superseded' || incident.delivery.state === 'dead_letter') {
        throw new GuardianLogError('cannot dead-letter this incident')
      }
      const policy = guard.policies.find(candidate => candidate.currentIncidentOrdinal === incident.ordinal)
      return immutable({
        ...state,
        guards: replaceGuard(state, guard, {
          policies: guard.policies.map(candidate => candidate === policy
            ? { ...candidate, phase: 'dead_letter' }
            : candidate),
          incidents: guard.incidents.map(candidate => candidate.ordinal === incident.ordinal
            ? { ...candidate, phase: 'dead_letter', delivery: { ...candidate.delivery, state: 'dead_letter' as DeliveryState, lastAttemptAtMs: event.atMs } }
            : candidate),
        }),
      })
    }
  }
}

function replaceGuard(state: GuardianLedgerState, guard: GuardianRecord, patch: Partial<GuardianRecord>): GuardianRecord[] {
  return state.guards.map(candidate => candidate.id === guard.id ? { ...candidate, ...patch } : candidate)
}

/** Fold a decoded event sequence in order; fails closed on the first violation. */
export function foldEvents(state: GuardianLedgerState, events: readonly GuardianEvent[]): GuardianLedgerState {
  let current = state
  for (const event of events) current = foldEvent(current, event)
  return current
}

function policyParams(policy: PolicyRecord): GuardianPolicySpec {
  if (policy.kind === 'lifecycle_silence') return { id: policy.id, kind: policy.kind, seconds: policy.seconds }
  if (policy.kind === 'deadline_unclosed') return { id: policy.id, kind: policy.kind, at: policy.at }
  return { id: policy.id, kind: policy.kind, count: policy.count }
}

/** Canonical Guard list view (bounded, no long history). */
export function guardListView(state: GuardianLedgerState): GuardianSpec[] {
  return state.guards.map(guard => ({
    id: guard.id,
    revision: guard.revision,
    label: guard.label,
    ownerSessionId: guard.ownerSessionId,
    createdAt: guard.createdAt,
    controlState: guard.controlState,
    notificationMode: guard.notificationMode,
    policies: guard.policies.map(policyParams),
  }))
}

/** One incident's canonical projection. */
export interface IncidentView {
  id: string
  ordinal: number
  guardId: GuardianId
  policyId: PolicyId
  policyRevision: number
  phase: IncidentRecord['phase']
  openedAtMs: number
  acknowledgedAtMs?: number
  resolvedAtMs?: number
  delivery: { state: DeliveryState; attempts: number }
}

export function incidentView(guard: GuardianRecord, incident: IncidentRecord): IncidentView {
  return {
    id: `${guard.id}/incident-${incident.ordinal}`,
    ordinal: incident.ordinal,
    guardId: incident.guardId,
    policyId: incident.policyId,
    policyRevision: incident.policyRevision,
    phase: incident.phase,
    openedAtMs: incident.openedAtMs,
    ...(incident.acknowledgedAtMs === undefined ? {} : { acknowledgedAtMs: incident.acknowledgedAtMs }),
    ...(incident.resolvedAtMs === undefined ? {} : { resolvedAtMs: incident.resolvedAtMs }),
    delivery: { state: incident.delivery.state, attempts: incident.delivery.attempts },
  }
}

/** Detail view for one Guard, including bounded incident history. */
export interface GuardDetailView {
  guard: GuardianSpec
  policies: Array<{
    id: PolicyId
    kind: GuardianPolicySpec['kind']
    phase: PolicyPhase
    currentIncidentOrdinal?: number
  }>
  incidents: IncidentView[]
}

export function guardDetailView(state: GuardianLedgerState, guardId: GuardianId): GuardDetailView | undefined {
  const guard = state.guards.find(candidate => candidate.id === guardId)
  if (!guard) return undefined
  const listed = guardListView(state)
  return {
    guard: listed.find(candidate => candidate.id === guardId) as GuardianSpec,
    policies: guard.policies.map(policy => ({
      id: policy.id,
      kind: policy.kind,
      phase: policy.phase,
      ...(policy.currentIncidentOrdinal === undefined ? {} : { currentIncidentOrdinal: policy.currentIncidentOrdinal }),
    })),
    incidents: guard.incidents.map(incident => incidentView(guard, incident)),
  }
}
