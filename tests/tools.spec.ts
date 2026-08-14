import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FileSupervisorStore } from '../src/store.ts'
import { runAgentTransaction } from '../src/transaction.ts'
import { guardianCheckNowTool, guardianCreateTool, guardianListTool, guardianUpdateTool, SupervisorToolError, type ToolDeps } from '../src/tools.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import type { SessionOwnerId, TurnEndFact } from '../src/types.ts'

const SESSION = 'sess-1' as const

/** A maintenance-transaction agent fake: one busy rejection, then honest work. */
function fakeAgent(busyOnce = false): Agent {
  let calls = 0
  const agent = {
    session: { id: SESSION },
    runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => {
      calls += 1
      if (busyOnce && calls === 1) throw new Error('agent "fake" already has active work')
      return task(new AbortController().signal)
    },
    whenIdle: vi.fn(async () => {}),
  }
  return agent as unknown as Agent
}

function fakeExec(agent: Agent | undefined): ToolRunContext {
  return { agent } as unknown as ToolRunContext
}

const idleActivity = {
  lastQualifyingActivityAtMs(_sessionId: SessionOwnerId): number | undefined {
    return undefined
  },
  holdTurnEnds(_sessionId: SessionOwnerId): readonly TurnEndFact[] {
    return []
  },
  releaseTurnEnds(_sessionId: SessionOwnerId): void {},
  restoreTurnEnds(_sessionId: SessionOwnerId): void {},
}

let ctx: Context
let dir: string
let deps: ToolDeps

beforeEach(() => {
  ctx = new Context()
  dir = mkdtempSync(join(tmpdir(), 'supervisor-tools-'))
  deps = { store: new FileSupervisorStore(ctx, dir), config: DEFAULT_CONFIG, activity: idleActivity }
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('runAgentTransaction', () => {
  it('waits for idle and retries once when the agent is busy', async () => {
    const agent = fakeAgent(true)
    await expect(runAgentTransaction(agent, async () => 'done')).resolves.toBe('done')
    expect(agent.whenIdle).toHaveBeenCalledTimes(1)
  })
  it('propagates non-busy failures unchanged', async () => {
    const agent = fakeAgent(false)
    const boom = new Error('boom')
    await expect(runAgentTransaction(agent, async () => { throw boom })).rejects.toBe(boom)
    expect(agent.whenIdle).not.toHaveBeenCalled()
  })
})

describe('guardian tools', () => {
  it('create enforces ownership and config floors', async () => {
    const createTool = guardianCreateTool(deps)
    await expect(createTool.execute(
      { label: 'g', notificationMode: 'audit_only', policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 900 }] } as never,
      fakeExec(undefined),
    )).rejects.toMatchObject({ code: 'OWNER_MISSING' })
    await expect(createTool.execute(
      { label: 'g', notificationMode: 'audit_only', policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 1 }] } as never,
      fakeExec(fakeAgent()),
    )).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('create/list round-trip one guard and enforce the per-session cap', async () => {
    const createTool = guardianCreateTool(deps)
    const listTool = guardianListTool(deps)
    const result = await createTool.execute(
      { label: 'watch', notificationMode: 'owner_followup', policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 900 }] } as never,
      fakeExec(fakeAgent()),
    )
    expect(result).toMatchObject({ id: 'guardian-1', revision: 1, controlState: 'armed' })
    const listed = await listTool.execute({} as never, fakeExec(fakeAgent()))
    expect(listed).toHaveLength(1)
    const limited = { ...deps, config: { ...DEFAULT_CONFIG, maxGuardsPerSession: 1 } }
    await expect(guardianCreateTool(limited).execute(
      { label: 'second', notificationMode: 'audit_only', policies: [{ id: 'q', kind: 'lifecycle_silence', seconds: 900 }] } as never,
      fakeExec(fakeAgent()),
    )).rejects.toMatchObject({ code: 'TOO_MANY_GUARDS' })
  })
  it('update performs pause/resume/acknowledge/close with stable errors', async () => {
    const createTool = guardianCreateTool(deps)
    const updateTool = guardianUpdateTool(deps)
    await createTool.execute(
      { label: 'watch', notificationMode: 'audit_only', policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 900 }] } as never,
      fakeExec(fakeAgent()),
    )
    const paused = await updateTool.execute({ guardId: 'guardian-1', operation: 'pause' } as never, fakeExec(fakeAgent()))
    expect(paused).toMatchObject({ controlState: 'paused' })
    const resumed = await updateTool.execute({ guardId: 'guardian-1', operation: 'resume' } as never, fakeExec(fakeAgent()))
    expect(resumed).toMatchObject({ controlState: 'armed' })
    const closed = await updateTool.execute({ guardId: 'guardian-1', operation: 'close' } as never, fakeExec(fakeAgent()))
    expect(closed).toMatchObject({ controlState: 'closed' })
    await expect(updateTool.execute({ guardId: 'ghost', operation: 'pause' } as never, fakeExec(fakeAgent())))
      .rejects.toMatchObject({ code: 'GUARD_NOT_FOUND' })
    await expect(updateTool.execute({ guardId: 'guardian-1', operation: 'acknowledge' } as never, fakeExec(fakeAgent())))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('edit bumps the revision and replaces policies', async () => {
    const createTool = guardianCreateTool(deps)
    const updateTool = guardianUpdateTool(deps)
    await createTool.execute(
      { label: 'watch', notificationMode: 'audit_only', policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 900 }] } as never,
      fakeExec(fakeAgent()),
    )
    const edited = await updateTool.execute({
      guardId: 'guardian-1',
      operation: 'edit',
      label: 'renamed',
      policies: [{ id: 'd', kind: 'deadline_unclosed', at: '2027-01-01T00:00:00Z' }],
    } as never, fakeExec(fakeAgent()))
    expect(edited).toMatchObject({ revision: 2 })
  })
  it('check_now is a no-op receipt without observations and applies transitions when silence breached', async () => {
    const checkTool = guardianCheckNowTool(deps)
    const createTool = guardianCreateTool(deps)
    await createTool.execute(
      { label: 'watch', notificationMode: 'audit_only', policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 900 }] } as never,
      fakeExec(fakeAgent()),
    )
    const quiet = await checkTool.execute({} as never, fakeExec(fakeAgent()))
    expect(quiet).toMatchObject({ appliedTransitions: 0, incidentsOpened: 0 })
    // A guard created long enough ago breaches on the next check.
    const lateCtx = new Context()
    const late = { ...deps, store: new FileSupervisorStore(lateCtx, dir) }
    const before = Date.now() - 901_000 - 61_000
    vi.spyOn(Date, 'now').mockReturnValue(before)
    await guardianCreateTool(late).execute(
      { label: 'old', notificationMode: 'audit_only', policies: [{ id: 's', kind: 'lifecycle_silence', seconds: 900 }] } as never,
      fakeExec(fakeAgent()),
    )
    vi.restoreAllMocks()
    const receipt = await guardianCheckNowTool(late).execute({} as never, fakeExec(fakeAgent()))
    expect(receipt).toMatchObject({ incidentsOpened: 1 })
    await lateCtx.fiber.dispose()
  })
  it('surfaces store failures as stable tool errors', async () => {
    const corrupt = join(dir, `${SESSION}.json`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(corrupt, '{broken')
    await expect(guardianListTool(deps).execute({} as never, fakeExec(fakeAgent())))
      .rejects.toBeInstanceOf(SupervisorToolError)
  })
})
