/**
 * The four guardian_* tools: create / list / update / check_now. Registered
 * once at plugin load; ownership is enforced at execution time against
 * `exec.agent` (missing = fail closed). All writes run through the
 * per-Agent maintenance transaction and the shared store; decode is strict.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { evaluationConfig, type Config } from './config.ts'
import {
  allocateGuardianId,
  decodeGuardianEvent,
  guardDetailView,
  guardListView,
  newLedgerState,
} from './domain.ts'
import { evaluateGuard, materializeTransitions } from './policy.ts'
import { runAgentTransaction } from './transaction.ts'
import type { SupervisorStore } from './store.ts'
import type { GuardianEvent, GuardianLedgerState, GuardianPolicySpec, SessionOwnerId, TurnEndFact } from './types.ts'

export type SupervisorErrorCode =
  | 'OWNER_MISSING'
  | 'GUARD_NOT_FOUND'
  | 'INCIDENT_NOT_FOUND'
  | 'BAD_REQUEST'
  | 'TOO_MANY_GUARDS'
  | 'STORE_UNAVAILABLE'

/** Stable tool error: model-facing message only, never stack/path internals. */
export class SupervisorToolError extends Error {
  readonly code: SupervisorErrorCode

  constructor(
    code: SupervisorErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SupervisorToolError'
    this.code = code
  }
}

/** Live observation inputs the runtime feeds to evaluation. Deltas are held
 *  until the persisting transaction releases them (or restores on failure). */
export interface ActivitySource {
  lastQualifyingActivityAtMs(sessionId: SessionOwnerId): number | undefined
  holdTurnEnds(sessionId: SessionOwnerId): readonly TurnEndFact[]
  releaseTurnEnds(sessionId: SessionOwnerId): void
  restoreTurnEnds(sessionId: SessionOwnerId): void
}

export interface ToolDeps {
  store: SupervisorStore
  config: Config
  activity: ActivitySource
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

const summary = (value: Record<string, unknown>): ContentBlock[] => [text(JSON.stringify(value))]

const requireOwner = (exec: ToolRunContext) => {
  const agent = exec.agent
  if (!agent) throw new SupervisorToolError('OWNER_MISSING', 'guardian tools require an owning agent session')
  return agent
}

/** Fold the session's durable state inside the maintenance transaction. */
async function withState<T>(deps: ToolDeps, exec: ToolRunContext, task: (state: GuardianLedgerState, sessionId: SessionOwnerId) => Promise<T>): Promise<T> {
  const agent = requireOwner(exec)
  const sessionId = agent.session.id as unknown as SessionOwnerId
  return runAgentTransaction(agent, async () => {
    let state: GuardianLedgerState
    try {
      state = await deps.store.load(sessionId) ?? newLedgerState(sessionId)
    } catch (error) {
      if (error instanceof Error && error.name === 'SupervisorStoreError') {
        throw new SupervisorToolError('STORE_UNAVAILABLE', 'supervisor state is temporarily unreadable')
      }
      throw error
    }
    return task(state, sessionId)
  })
}

const POLICY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', required: true, description: 'Stable policy id within the guard' },
    kind: { type: 'string', enum: ['lifecycle_silence', 'deadline_unclosed', 'abnormal_turn_streak'] as const, required: true },
    seconds: { type: 'integer', description: 'lifecycle_silence: threshold seconds' },
    at: { type: 'string', description: 'deadline_unclosed: strict RFC 3339 instant with offset' },
    count: { type: 'integer', description: 'abnormal_turn_streak: consecutive abnormal turn ends' },
  },
  additionalProperties: false,
} as const

const LIST_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    revision: { type: 'integer' },
    label: { type: 'string' },
    ownerSessionId: { type: 'string' },
    createdAt: { type: 'string' },
    controlState: { type: 'string', enum: ['armed', 'paused', 'closed'] as const },
    notificationMode: { type: 'string', enum: ['audit_only', 'owner_followup'] as const },
    policies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          seconds: { type: 'integer' },
          at: { type: 'string' },
          count: { type: 'integer' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const

/**
 * Cross-field semantic floors the tool schema DSL cannot express
 * (minSilenceSeconds, positive streak counts). Exported so both the tools and
 * their tests exercise the same validator.
 */
export function validatePolicyInput(policies: unknown[], config: Config): void {
  for (const raw of policies) {
    if (typeof raw !== 'object' || raw === null) throw new SupervisorToolError('BAD_REQUEST', 'policies must be objects')
    const policy = raw as { kind?: unknown; seconds?: unknown; at?: unknown; count?: unknown }
    if (policy.kind === 'lifecycle_silence' && (typeof policy.seconds !== 'number' || !Number.isSafeInteger(policy.seconds) || policy.seconds < config.minSilenceSeconds)) {
      throw new SupervisorToolError('BAD_REQUEST', `lifecycle_silence seconds must be a safe integer of at least ${config.minSilenceSeconds}`)
    }
    if (policy.kind === 'deadline_unclosed' && typeof policy.at !== 'string') {
      throw new SupervisorToolError('BAD_REQUEST', 'deadline_unclosed requires a strict RFC 3339 `at` instant')
    }
    if (policy.kind === 'abnormal_turn_streak' && (typeof policy.count !== 'number' || !Number.isSafeInteger(policy.count) || policy.count < 1)) {
      throw new SupervisorToolError('BAD_REQUEST', 'abnormal_turn_streak requires a positive safe-integer `count`')
    }
  }
}

function decodeEvent(raw: unknown): GuardianEvent {
  try {
    return decodeGuardianEvent(raw)
  } catch (error) {
    /* v8 ignore next -- decodeGuardianEvent always throws Error; the fallback guards exotic throws */
    throw new SupervisorToolError('BAD_REQUEST', error instanceof Error ? error.message : 'invalid supervisor event')
  }
}

export function guardianCreateTool(deps: ToolDeps) {
  return defineTool({
    name: 'guardian_create',
    description: 'Create a supervision guard over this root session (lifecycle silence, absolute deadline, or abnormal-turn streak policies). Observe-and-notify only: never cancels the agent or runs side effects.',
    parameters: {
      label: { type: 'string', required: true, description: 'Short human label for this guard' },
      notificationMode: { type: 'string', enum: ['audit_only', 'owner_followup'] as const, required: true, description: 'audit_only records incidents silently; owner_followup queues one bounded follow-up' },
      policies: { type: 'array', items: POLICY_SCHEMA, required: true, description: 'At least one policy; closed union, no cron or free-form expressions' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          revision: { type: 'integer' },
          controlState: { type: 'string' },
          notificationMode: { type: 'string' },
          policies: { type: 'array', items: POLICY_SCHEMA },
        },
        additionalProperties: false,
      },
      render: (_args, value) => summary(value as unknown as Record<string, unknown>),
    },
    execute: async (args, exec) => {
      validatePolicyInput(args.policies as unknown[], deps.config)
      return withState(deps, exec, async (state, sessionId) => {
        const active = state.guards.filter(guard => guard.controlState !== 'closed').length
        if (active >= deps.config.maxGuardsPerSession) {
          throw new SupervisorToolError('TOO_MANY_GUARDS', `at most ${deps.config.maxGuardsPerSession} guards per session`)
        }
        const id = allocateGuardianId(state)
        const event = decodeEvent({
          version: 1,
          kind: 'create',
          atMs: Date.now(),
          guard: {
            id,
            label: args.label,
            ownerSessionId: sessionId,
            notificationMode: args.notificationMode,
            policies: args.policies as unknown as GuardianPolicySpec[],
          },
        })
        const next = await deps.store.append(sessionId, [event])
        const guard = next.guards.find(candidate => candidate.id === id)
        if (!guard) throw new SupervisorToolError('STORE_UNAVAILABLE', 'guard vanished after append')
        return {
          id: guard.id,
          revision: guard.revision,
          controlState: guard.controlState,
          notificationMode: guard.notificationMode,
          policies: guard.policies.filter(policy => policy.phase !== 'superseded').map(policy => ({
            id: policy.id,
            kind: policy.kind,
            ...(policy.kind === 'lifecycle_silence' ? { seconds: policy.seconds }
              : policy.kind === 'deadline_unclosed' ? { at: policy.at }
                : { count: policy.count }),
          })),
        }
      })
    },
  })
}

export function guardianListTool(deps: ToolDeps) {
  return defineTool({
    name: 'guardian_list',
    description: 'List this session\'s guards with their current control state and policy summary (bounded; no long history).',
    parameters: {},
    output: {
      schema: { type: 'array', items: LIST_SCHEMA },
      render: (_args, value) => summary({ guards: value } as unknown as Record<string, unknown>),
    },
    execute: async (_args, exec) => withState(deps, exec, async (state) => guardListView(state).map(guard => ({
      id: guard.id,
      revision: guard.revision,
      label: guard.label,
      ownerSessionId: guard.ownerSessionId,
      createdAt: guard.createdAt,
      controlState: guard.controlState,
      notificationMode: guard.notificationMode,
      policies: guard.policies.map(policy => ({
        id: policy.id,
        kind: policy.kind,
        ...(policy.kind === 'lifecycle_silence' ? { seconds: policy.seconds }
          : policy.kind === 'deadline_unclosed' ? { at: policy.at }
            : { count: policy.count }),
      })),
    }))),
  })
}

export function guardianUpdateTool(deps: ToolDeps) {
  return defineTool({
    name: 'guardian_update',
    description: 'Update one guard: edit (new revision), pause, resume, acknowledge an incident, or close permanently. Ids are never reused.',
    parameters: {
      guardId: { type: 'string', required: true, description: 'Guard to update' },
      operation: { type: 'string', enum: ['edit', 'pause', 'resume', 'acknowledge', 'close'] as const, required: true },
      label: { type: 'string', description: 'edit: replacement label' },
      notificationMode: { type: 'string', enum: ['audit_only', 'owner_followup'] as const, description: 'edit: replacement mode' },
      policies: { type: 'array', items: POLICY_SCHEMA, description: 'edit: full replacement policy list' },
      incidentOrdinal: { type: 'integer', description: 'acknowledge: the incident ordinal to mark known' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          revision: { type: 'integer' },
          controlState: { type: 'string' },
          policies: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, phase: { type: 'string' } }, additionalProperties: false } },
          incidents: { type: 'array', items: { type: 'object', properties: { ordinal: { type: 'integer' }, phase: { type: 'string' }, delivery: { type: 'object', properties: { state: { type: 'string' }, attempts: { type: 'integer' } }, additionalProperties: false } }, additionalProperties: false } },
        },
        additionalProperties: false,
      },
      render: (_args, value) => summary(value as unknown as Record<string, unknown>),
    },
    execute: async (args, exec) => withState(deps, exec, async (state, sessionId) => {
      const guard = state.guards.find(candidate => candidate.id === args.guardId)
      if (!guard) throw new SupervisorToolError('GUARD_NOT_FOUND', `no guard ${args.guardId} in this session`)
      let event: GuardianEvent
      switch (args.operation) {
        case 'pause':
        case 'resume':
        case 'close':
          event = decodeEvent({ version: 1, kind: 'control', atMs: Date.now(), guardId: args.guardId, operation: args.operation })
          break
        case 'acknowledge': {
          if (typeof args.incidentOrdinal !== 'number') {
            throw new SupervisorToolError('BAD_REQUEST', 'acknowledge requires incidentOrdinal')
          }
          event = decodeEvent({ version: 1, kind: 'incident-acknowledge', atMs: Date.now(), guardId: args.guardId, incidentOrdinal: args.incidentOrdinal })
          break
        }
        case 'edit': {
          if (args.policies === undefined) throw new SupervisorToolError('BAD_REQUEST', 'edit requires the replacement policies list')
          validatePolicyInput(args.policies as unknown[], deps.config)
          event = decodeEvent({
            version: 1,
            kind: 'revise',
            atMs: Date.now(),
            guardId: args.guardId,
            expectedRevision: guard.revision,
            ...(args.label === undefined ? {} : { label: args.label }),
            ...(args.notificationMode === undefined ? {} : { notificationMode: args.notificationMode }),
            policies: args.policies as unknown as GuardianPolicySpec[],
          })
          break
        }
      }
      const next = await deps.store.append(sessionId, [event])
      const detail = guardDetailView(next, args.guardId as never)
      if (!detail) throw new SupervisorToolError('STORE_UNAVAILABLE', 'guard vanished after append')
      return {
        id: detail.guard.id,
        revision: detail.guard.revision,
        controlState: detail.guard.controlState,
        policies: detail.policies.map(policy => ({ id: policy.id, phase: policy.phase })),
        incidents: detail.incidents.map(incident => ({ ordinal: incident.ordinal, phase: incident.phase, delivery: { state: incident.delivery.state, attempts: incident.delivery.attempts } })),
      }
    }),
  })
}

export function guardianCheckNowTool(deps: ToolDeps) {
  return defineTool({
    name: 'guardian_check_now',
    description: 'Run one policy evaluation pass now and record only the state transitions that changed. Never runs user tasks or side effects.',
    parameters: {
      guardId: { type: 'string', description: 'Optional: evaluate only this guard' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          evaluatedAt: { type: 'string' },
          guardsEvaluated: { type: 'integer' },
          appliedTransitions: { type: 'integer' },
          incidentsOpened: { type: 'integer' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => summary(value as unknown as Record<string, unknown>),
    },
    execute: async (args, exec) => withState(deps, exec, async (state, sessionId) => {
      const nowMs = Date.now()
      const targets = state.guards.filter(guard => args.guardId === undefined || guard.id === args.guardId)
      if (args.guardId !== undefined && !targets.length) {
        throw new SupervisorToolError('GUARD_NOT_FOUND', `no guard ${args.guardId} in this session`)
      }
      const turnEnds = deps.activity.holdTurnEnds(sessionId)
      try {
        const input = {
          nowMs,
          lastQualifyingActivityAtMs: deps.activity.lastQualifyingActivityAtMs(sessionId),
          turnEnds,
        }
        const transitions = targets.flatMap(guard => evaluateGuard(guard, input, evaluationConfig(deps.config)))
        if (transitions.length === 0) {
          deps.activity.releaseTurnEnds(sessionId)
          return { evaluatedAt: new Date(nowMs).toISOString(), guardsEvaluated: targets.length, appliedTransitions: 0, incidentsOpened: 0 }
        }
        const events = materializeTransitions(state, transitions, nowMs)
        await deps.store.append(sessionId, events)
        deps.activity.releaseTurnEnds(sessionId)
        return {
          evaluatedAt: new Date(nowMs).toISOString(),
          guardsEvaluated: targets.length,
          appliedTransitions: events.length,
          incidentsOpened: events.filter(event => event.kind === 'incident-open').length,
        }
      } catch (error) {
        deps.activity.restoreTurnEnds(sessionId)
        throw error
      }
    }),
  })
}

export function registerGuardianTools(ctx: { tools: ToolRuntime }, deps: ToolDeps): () => void {
  const disposers = [
    ctx.tools.register(guardianCreateTool(deps)),
    ctx.tools.register(guardianListTool(deps)),
    ctx.tools.register(guardianUpdateTool(deps)),
    ctx.tools.register(guardianCheckNowTool(deps)),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
