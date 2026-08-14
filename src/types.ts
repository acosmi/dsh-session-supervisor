/**
 * Core domain types for the DSH session supervisor (pure, no I/O).
 * Ids are branded so cross-boundary values cannot be forged by string
 * concatenation; decoding is the only place that mints them.
 */

/** Opaque id brand: `Branded<'GuardianId'>` is `string` at runtime. */
export type Branded<B extends string, T = string> = T & { readonly __brand: B }

export type GuardianId = Branded<'GuardianId'>
export type PolicyId = Branded<'PolicyId'>
export type SessionOwnerId = Branded<'SessionOwnerId'>

/** The single ledger schema version; unknown versions fail closed. */
export const GUARDIAN_LEDGER_VERSION = 1

/** User-facing control state (user intent, orthogonal to observed health). */
export type GuardianControlState = 'armed' | 'paused' | 'closed'

/** How a durable incident may notify its owner. */
export type NotificationMode = 'audit_only' | 'owner_followup'

/**
 * Per-policy observed state machine (§7.2 of the plan). `suspect` is an
 * internal projection (never notifies); only `open` produces an incident.
 */
export type PolicyPhase =
  | 'healthy'
  | 'suspect'
  | 'open'
  | 'acknowledged'
  | 'recovering'
  | 'resolved'
  | 'dead_letter'
  | 'superseded'

/** Lifecycle of one durable incident. */
export type IncidentPhase = 'open' | 'acknowledged' | 'recovering' | 'resolved' | 'dead_letter' | 'superseded'

/** Delivery state of the at-most-one owner follow-up. */
export type DeliveryState = 'pending' | 'accepted' | 'failed' | 'dead_letter'

/**
 * Why a `turn/end` closed, as observed from the session log. `unknown` covers
 * extension reasons this plugin does not classify; it never feeds the streak.
 */
export type TurnEndKind =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'blocked'
  | 'max-tokens'
  | 'interrupted'
  | 'unknown'

export type GuardianPolicySpec =
  | {
      id: PolicyId
      kind: 'lifecycle_silence'
      /** Threshold seconds; positive safe integer. */
      seconds: number
    }
  | {
      id: PolicyId
      kind: 'deadline_unclosed'
      /** Strict RFC 3339 instant with offset; validated at decode. */
      at: string
    }
  | {
      id: PolicyId
      kind: 'abnormal_turn_streak'
      /** Consecutive abnormal `turn/end` reasons that open the incident. */
      count: number
    }

/** Public, model-visible Guard view (canonical JSON projection). */
export interface GuardianSpec {
  id: GuardianId
  revision: number
  label: string
  ownerSessionId: SessionOwnerId
  createdAt: string
  controlState: GuardianControlState
  notificationMode: NotificationMode
  policies: readonly GuardianPolicySpec[]
}

/** Snapshot of one policy's observation bookkeeping (durable, no tick events). */
export interface PolicyObservation {
  /** Epoch ms the silence window anchors on (create/resume). */
  anchorAtMs: number
  /** Epoch ms of the last qualifying lifecycle activity, when any. */
  lastActivityAtMs?: number
  /** Epoch ms the current breach started (suspect entry). */
  breachSinceAtMs?: number
  /** Epoch ms the current recovery evidence started. */
  recoverySinceAtMs?: number
  /** Current abnormal-turn streak (abnormal_turn_streak only). */
  streak: number
}

interface PolicyRecordBase {
  id: PolicyId
  /** Guard revision this policy was last declared under. */
  guardRevision: number
  phase: PolicyPhase
  observation: PolicyObservation
  /** Ordinal of the current (open or later) incident, when one exists. */
  currentIncidentOrdinal?: number
}

/**
 * One policy record: the declared spec (discriminated on `kind`, so its
 * params are always present) plus observation bookkeeping. Intersecting the
 * base with {@link GuardianPolicySpec} keeps `kind` narrowing intact.
 */
export type PolicyRecord = PolicyRecordBase & GuardianPolicySpec

export interface IncidentRecord {
  /** Per-session ordinal; combined with GuardId/PolicyId this is the incident identity. */
  ordinal: number
  guardId: GuardianId
  policyId: PolicyId
  /** Guard revision the policy had when the incident opened. */
  policyRevision: number
  phase: IncidentPhase
  openedAtMs: number
  acknowledgedAtMs?: number
  reopenedAtMs?: number
  resolvedAtMs?: number
  supersededAtMs?: number
  delivery: {
    state: DeliveryState
    attempts: number
    lastAttemptAtMs?: number
  }
}

export interface GuardianRecord {
  id: GuardianId
  revision: number
  label: string
  ownerSessionId: SessionOwnerId
  createdAt: string
  controlState: GuardianControlState
  notificationMode: NotificationMode
  policies: PolicyRecord[]
  incidents: IncidentRecord[]
}

/** The folded, durable supervisor state for one session. */
export interface GuardianLedgerState {
  version: 1
  sessionId: SessionOwnerId
  nextGuardianOrdinal: number
  nextIncidentOrdinal: number
  guards: GuardianRecord[]
}

/**
 * Versioned closed union of ledger events. Every append validates its full
 * predecessor state before folding; illegal transitions fail closed.
 */
export type GuardianEvent =
  | {
      version: 1
      kind: 'create'
      atMs: number
      guard: {
        id: GuardianId
        label: string
        ownerSessionId: SessionOwnerId
        notificationMode: NotificationMode
        policies: readonly GuardianPolicySpec[]
      }
    }
  | {
      version: 1
      kind: 'revise'
      atMs: number
      guardId: GuardianId
      expectedRevision: number
      label?: string
      notificationMode?: NotificationMode
      policies: readonly GuardianPolicySpec[]
    }
  | {
      version: 1
      kind: 'control'
      atMs: number
      guardId: GuardianId
      operation: 'pause' | 'resume' | 'close'
    }
  | {
      version: 1
      kind: 'policy-observe'
      atMs: number
      guardId: GuardianId
      policyId: PolicyId
      phase: PolicyPhase
      anchorAtMs: number
      lastActivityAtMs?: number
      breachSinceAtMs?: number
      recoverySinceAtMs?: number
      streak: number
    }
  | {
      version: 1
      kind: 'incident-open'
      atMs: number
      guardId: GuardianId
      policyId: PolicyId
      policyRevision: number
      incidentOrdinal: number
    }
  | {
      version: 1
      kind: 'incident-acknowledge'
      atMs: number
      guardId: GuardianId
      incidentOrdinal: number
    }
  | {
      version: 1
      kind: 'incident-recover'
      atMs: number
      guardId: GuardianId
      incidentOrdinal: number
    }
  | {
      version: 1
      kind: 'incident-reopen'
      atMs: number
      guardId: GuardianId
      incidentOrdinal: number
    }
  | {
      version: 1
      kind: 'incident-resolve'
      atMs: number
      guardId: GuardianId
      incidentOrdinal: number
    }
  | {
      version: 1
      kind: 'delivery-accepted'
      atMs: number
      guardId: GuardianId
      incidentOrdinal: number
    }
  | {
      version: 1
      kind: 'delivery-failed'
      atMs: number
      guardId: GuardianId
      incidentOrdinal: number
      attempt: number
    }
  | {
      version: 1
      kind: 'delivery-dead-letter'
      atMs: number
      guardId: GuardianId
      incidentOrdinal: number
    }

/** Decision targets the policy evaluator hands to the transaction. */
export type PolicyTransition =
  | {
      kind: 'policy-observe'
      guardId: GuardianId
      policyId: PolicyId
      phase: PolicyPhase
      anchorAtMs: number
      lastActivityAtMs?: number
      breachSinceAtMs?: number
      recoverySinceAtMs?: number
      streak: number
    }
  | { kind: 'incident-open'; guardId: GuardianId; policyId: PolicyId; policyRevision: number }
  | { kind: 'incident-recover'; guardId: GuardianId; policyId: PolicyId }
  | { kind: 'incident-reopen'; guardId: GuardianId; policyId: PolicyId }
  | { kind: 'incident-resolve'; guardId: GuardianId; policyId: PolicyId }

/** One durable turn end, as consumed by the policy evaluator. */
export interface TurnEndFact {
  atMs: number
  reason: TurnEndKind
}

/** Wall-clock inputs to one evaluation pass. */
export interface PolicyEvaluationInput {
  nowMs: number
  /** Latest qualifying core-lifecycle activity epoch ms (undefined = none seen). */
  lastQualifyingActivityAtMs?: number
  /** Turn ends observed since the previous evaluation. */
  turnEnds: readonly TurnEndFact[]
}

/** Hysteresis windows; deployment-tunable values come from Config (P2). */
export interface EvaluationConfig {
  /** Suspect-to-open confirmation window. */
  confirmationMs: number
  /** Recovering-to-resolved confirmation window. */
  recoveryConfirmationMs: number
}
