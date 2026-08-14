import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { foldEvent, newLedgerState } from '../src/domain.ts'
import { DEFAULT_CONFIG, type Config } from '../src/config.ts'
import { FileSupervisorStore } from '../src/store.ts'
import { guardianCreateTool, type ToolDeps } from '../src/tools.ts'
import { materializeTransitions } from '../src/policy.ts'
import { newLedgerState } from '../src/domain.ts'
import type { SessionOwnerId, TurnEndFact } from '../src/types.ts'

const SESSION = 'sess-1' as const

const fakeAgent = (): Agent => ({
  session: { id: SESSION },
  runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
  whenIdle: async () => {},
}) as unknown as Agent

const fakeExec = (agent: Agent | undefined): ToolRunContext => ({ agent }) as unknown as ToolRunContext

const idleActivity = {
  lastQualifyingActivityAtMs(_s: SessionOwnerId): number | undefined { return undefined },
  holdTurnEnds(_s: SessionOwnerId): readonly TurnEndFact[] { return [] },
  releaseTurnEnds(_s: SessionOwnerId): void {},
  restoreTurnEnds(_s: SessionOwnerId): void {},
}

let ctx: Context
let dir: string
let store: FileSupervisorStore
let deps: ToolDeps
let registerSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  ctx = new Context()
  dir = mkdtempSync(join(tmpdir(), 'supervisor-final-'))
  store = new FileSupervisorStore(ctx, dir)
  deps = { store, config: DEFAULT_CONFIG, activity: idleActivity }
  registerSpy = vi.fn(() => () => {})
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('index apply', () => {
  it('provides the store, registers the four tools, and wires the activity stub', async () => {
    process.env.DSH_HOME = dir
    const tree = new Context()
    tree.provide('tools', { register: registerSpy })
    const runtimeAgent = {
      id: 'rt-1',
      session: { id: 'rt-1', header: { parentSession: undefined } },
      ctx: { on: () => () => {} },
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
      whenIdle: async () => {},
      followup: () => {},
    }
    const secondRoot = { ...runtimeAgent, id: 'rt-2', session: { id: 'rt-2', header: { parentSession: undefined } } }
    tree.provide('agents', {
      list: () => [
        runtimeAgent,
        { ...runtimeAgent, id: 'fork-1', session: { id: 'fork-1', header: { parentSession: 'rt-1' } } },
        runtimeAgent,
        secondRoot,
      ],
    })
    tree.provide('sessions', {})
    tree.provide('timer', { timeout: (_cb: () => void, _delay: number) => () => {} })
    ;(tree as never).mixin?.('timer', ['timeout'])
    apply(tree as never, DEFAULT_CONFIG)
    expect(tree.get('supervisorStore')).toBeDefined()
    expect(registerSpy).toHaveBeenCalledTimes(4)
    // The registered check_now tool closes over the activity stub; executing
    // it drives lastQualifyingActivityAtMs/turnEndsSince through the store.
    const checkNow = registerSpy.mock.calls[3]?.[0]
    const receipt = await (checkNow as { execute(args: unknown, exec: ToolRunContext): Promise<{ appliedTransitions: number }> })
      .execute({}, fakeExec(fakeAgent()))
    expect(receipt).toMatchObject({ appliedTransitions: 0 })
    // fire the real lifecycle events the apply handlers subscribed to
    tree.emit('agent/created', { agent: runtimeAgent })
    tree.emit('agent/created', { agent: runtimeAgent })
    const forkAgent = { ...runtimeAgent, id: 'fork-1', session: { id: 'fork-1', header: { parentSession: 'rt-1' } } }
    tree.emit('agent/created', { agent: forkAgent })
    // disposing an unknown agent exercises the early return; disposing a live
    // one exercises teardown; the tree dispose below cleans up the remainder
    tree.emit('agent/disposed', { agent: forkAgent })
    tree.emit('agent/disposed', { agent: runtimeAgent })
    delete process.env.DSH_HOME
    void tree.fiber.dispose()
  })
  it('is a no-op when disabled', () => {
    const tree = new Context()
    tree.provide('tools', { register: registerSpy })
    const runtimeAgent = {
      id: 'rt-1',
      session: { id: 'rt-1', header: { parentSession: undefined } },
      ctx: { on: () => () => {} },
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
      whenIdle: async () => {},
      followup: () => {},
    }
    const secondRoot = { ...runtimeAgent, id: 'rt-2', session: { id: 'rt-2', header: { parentSession: undefined } } }
    tree.provide('agents', {
      list: () => [
        runtimeAgent,
        { ...runtimeAgent, id: 'fork-1', session: { id: 'fork-1', header: { parentSession: 'rt-1' } } },
        runtimeAgent,
        secondRoot,
      ],
    })
    tree.provide('sessions', {})
    tree.provide('timer', { timeout: (_cb: () => void, _delay: number) => () => {} })
    ;(tree as never).mixin?.('timer', ['timeout'])
    apply(tree as never, { ...DEFAULT_CONFIG, enabled: false } as Config)
    expect(tree.get('supervisorStore')).toBeUndefined()
    expect(registerSpy).not.toHaveBeenCalled()
    void tree.fiber.dispose()
  })
})

describe('final coverage edges', () => {
  it('materializes a full observation change with all optional fields', () => {
    const events = materializeTransitions(newLedgerState(SESSION), [
      {
        kind: 'policy-observe',
        guardId: 'g1',
        policyId: 'p1',
        phase: 'suspect',
        anchorAtMs: 1000,
        lastActivityAtMs: 1100,
        breachSinceAtMs: 1200,
        recoverySinceAtMs: 1300,
        streak: 2,
      },
      {
        kind: 'policy-observe',
        guardId: 'g1',
        policyId: 'p2',
        phase: 'healthy',
        anchorAtMs: 1000,
        streak: 0,
      },
    ], 2000)
    expect(events).toHaveLength(2)
    const event = events[0]
    expect(event?.kind === 'policy-observe' && event.lastActivityAtMs).toBe(1100)
  })
  it('create maps deadline and streak params in its canonical output', async () => {
    const tool = guardianCreateTool(deps)
    const result = await tool.execute({
      label: 'multi',
      notificationMode: 'owner_followup',
      policies: [
        { id: 'd', kind: 'deadline_unclosed', at: '2027-01-01T00:00:00Z' },
        { id: 's', kind: 'abnormal_turn_streak', count: 3 },
      ],
    } as never, fakeExec(fakeAgent()))
    expect(result.policies.map(p => p.kind)).toEqual(['deadline_unclosed', 'abnormal_turn_streak'])
  })
  it('classifies a directory posing as the artifact as an uncertain read', async () => {
    mkdirSync(join(dir, `${SESSION}.json`), { recursive: true })
    await expect(store.load(SESSION)).rejects.toMatchObject({ kind: 'uncertain' })
  })
  it('rejects non-document JSON roots as corrupt', async () => {
    for (const content of ['null', '42', '"text"']) {
      writeFileSync(join(dir, `${SESSION}.json`), content)
      await expect(store.load(SESSION)).rejects.toMatchObject({ kind: 'corrupt' })
    }
  })
})
