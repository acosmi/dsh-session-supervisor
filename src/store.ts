/**
 * Plugin-owned durable store: the supervisor's only write path. Anchored at
 * `$DSH_HOME/plugins/session-supervisor/`, one JSON artifact per session,
 * written atomically (temp file + rename). v1 never writes session-log events
 * (§7.3 of the plan), so this store is the durability source of truth.
 *
 * Failure taxonomy: `corrupt`/`unsupported` fail closed (never retried as
 * transient); `uncertain` means a write could not be proven durable (callers
 * must not claim the append succeeded).
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decodeGuardianEvent, foldEvents, newLedgerState, DEFAULT_DECODE_LIMITS } from './domain.ts'
import type { GuardianEvent, GuardianLedgerState, SessionOwnerId } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    supervisorStore: SupervisorStore
  }
}

export type SupervisorStoreFailureKind = 'corrupt' | 'unsupported' | 'uncertain'

/** Fail-closed store failure. `corrupt`/`unsupported` are integrity errors. */
export class SupervisorStoreError extends Error {
  readonly kind: SupervisorStoreFailureKind

  constructor(
    kind: SupervisorStoreFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`supervisor store: ${message}`, options)
    this.name = 'SupervisorStoreError'
    this.kind = kind
  }
}

interface StoredDocument {
  version: 1
  sessionId: SessionOwnerId
  events: GuardianEvent[]
}

/**
 * Durable per-session supervisor state. Implementations must be
 * single-writer per process; multi-host coordination is out of v1 scope.
 */
export abstract class SupervisorStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'supervisorStore')
  }

  /** Fold the stored event log; `undefined` when the session has no state. */
  abstract load(sessionId: SessionOwnerId): Promise<GuardianLedgerState | undefined>

  /** Durably append events in order and return the folded state. */
  abstract append(sessionId: SessionOwnerId, events: readonly GuardianEvent[]): Promise<GuardianLedgerState>
}

/** JSON-file backend with atomic replace and per-session serialization. */
export class FileSupervisorStore extends SupervisorStore {
  private readonly dir: string
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, dir: string = dshHomePath('plugins', 'session-supervisor')) {
    super(ctx)
    this.dir = dir
  }

  private pathFor(sessionId: SessionOwnerId): string {
    return join(this.dir, `${sessionId}.json`)
  }

  async load(sessionId: SessionOwnerId): Promise<GuardianLedgerState | undefined> {
    const stored = this.readDocument(sessionId)
    if (stored === undefined) return undefined
    return foldEvents(newLedgerState(sessionId), stored.events)
  }

  async append(sessionId: SessionOwnerId, events: readonly GuardianEvent[]): Promise<GuardianLedgerState> {
    if (events.length === 0) {
      const current = await this.load(sessionId)
      return current ?? newLedgerState(sessionId)
    }
    // Per-session FIFO: tools and the runtime share one serialized write path.
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      const stored = this.readDocument(sessionId)
      const existing = stored?.events ?? []
      const merged = [...existing, ...events]
      const state = foldEvents(newLedgerState(sessionId), merged)
      this.writeDocument(sessionId, merged)
      return state
    })
    this.queues.set(sessionId, task)
    try {
      return await task
    } finally {
      if (this.queues.get(sessionId) === task) this.queues.delete(sessionId)
    }
  }

  /** Read and strictly decode the raw event document; undefined when absent. */
  private readDocument(sessionId: SessionOwnerId): StoredDocument | undefined {
    const path = this.pathFor(sessionId)
    if (!existsSync(path)) return undefined
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (cause) {
      throw new SupervisorStoreError('uncertain', `cannot read artifact for ${sessionId}`, { cause })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new SupervisorStoreError('corrupt', `artifact for ${sessionId} is not valid JSON`, { cause })
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new SupervisorStoreError('corrupt', `artifact for ${sessionId} is not a document`)
    }
    const doc = parsed as Partial<StoredDocument>
    if (doc.version !== 1) {
      throw new SupervisorStoreError('unsupported', `artifact for ${sessionId} has version ${String(doc.version)}`)
    }
    if (doc.sessionId !== sessionId) {
      throw new SupervisorStoreError('corrupt', `artifact session id mismatch for ${sessionId}`)
    }
    if (!Array.isArray(doc.events)) {
      throw new SupervisorStoreError('corrupt', `artifact for ${sessionId} has no event list`)
    }
    const decoded = doc.events.map((event, index) => {
      try {
        return decodeGuardianEvent(event, DEFAULT_DECODE_LIMITS)
      } catch (cause) {
        throw new SupervisorStoreError('corrupt', `event ${index} in ${sessionId} failed strict decode`, { cause })
      }
    })
    return { version: 1, sessionId, events: decoded }
  }

  private writeDocument(sessionId: SessionOwnerId, events: readonly GuardianEvent[]): void {
    const document: StoredDocument = { version: 1, sessionId, events: [...events] }
    const target = this.pathFor(sessionId)
    const temporary = `${target}.${process.pid}.${Date.now().toString(16)}.tmp`
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(temporary, JSON.stringify(document), 'utf8')
      renameSync(temporary, target)
    } catch (cause) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Best-effort cleanup; the original failure carries the diagnosis.
      }
      throw new SupervisorStoreError('uncertain', `cannot durably write artifact for ${sessionId}`, { cause })
    }
  }
}
