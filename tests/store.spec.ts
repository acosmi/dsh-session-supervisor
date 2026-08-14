import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileSupervisorStore, SupervisorStoreError } from '../src/store.ts'
import type { GuardianEvent } from '../src/types.ts'

const SESSION = 'sess-1' as const

const create: GuardianEvent = {
  version: 1,
  kind: 'create',
  atMs: 1000,
  guard: { id: 'g1', label: 'g', ownerSessionId: SESSION, notificationMode: 'audit_only', policies: [{ id: 'p1', kind: 'lifecycle_silence', seconds: 900 }] },
}

let ctx: Context
let dir: string
let store: FileSupervisorStore

beforeEach(() => {
  ctx = new Context()
  dir = mkdtempSync(join(tmpdir(), 'supervisor-store-'))
  store = new FileSupervisorStore(ctx, dir)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('FileSupervisorStore', () => {
  it('round-trips appends and folds back the same state', async () => {
    expect(await store.load(SESSION)).toBeUndefined()
    const state = await store.append(SESSION, [create])
    expect(state.guards[0]?.id).toBe('g1')
    const loaded = await store.load(SESSION)
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(state))
  })
  it('appends contiguously and serializes concurrent writers per session', async () => {
    await store.append(SESSION, [create])
    const pause: GuardianEvent = { version: 1, kind: 'control', atMs: 2000, guardId: 'g1', operation: 'pause' }
    const resume: GuardianEvent = { version: 1, kind: 'control', atMs: 3000, guardId: 'g1', operation: 'resume' }
    await Promise.all([store.append(SESSION, [pause]), store.append(SESSION, [resume])])
    const loaded = await store.load(SESSION)
    expect(loaded?.guards[0]?.controlState).toBe('armed')
    const raw = JSON.parse(readFileSync(join(dir, `${SESSION}.json`), 'utf8')) as { events: GuardianEvent[] }
    expect(raw.events.map(event => event.kind)).toEqual(['create', 'control', 'control'])
  })
  it('treats an empty append as a no-op', async () => {
    const state = await store.append(SESSION, [])
    expect(state.guards).toHaveLength(0)
    expect(existsSync(join(dir, `${SESSION}.json`))).toBe(false)
  })
  it('fails closed on corrupt, unsupported, and misowned artifacts', async () => {
    const path = join(dir, `${SESSION}.json`)
    writeFileSync(path, '{not json')
    await expect(store.load(SESSION)).rejects.toMatchObject({ kind: 'corrupt' })
    writeFileSync(path, JSON.stringify({ version: 2, sessionId: SESSION, events: [] }))
    await expect(store.load(SESSION)).rejects.toMatchObject({ kind: 'unsupported' })
    writeFileSync(path, JSON.stringify({ version: 1, sessionId: 'other-session', events: [] }))
    await expect(store.load(SESSION)).rejects.toMatchObject({ kind: 'corrupt' })
    writeFileSync(path, JSON.stringify({ version: 1, sessionId: SESSION, events: [{ version: 9 }] }))
    await expect(store.load(SESSION)).rejects.toMatchObject({ kind: 'corrupt' })
  })
  it('reports uncertain when the target directory cannot be created', async () => {
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'file-in-the-way')
    const otherCtx = new Context()
    const broken = new FileSupervisorStore(otherCtx, join(blocked, 'nested'))
    await expect(broken.append(SESSION, [create])).rejects.toMatchObject({ kind: 'uncertain' })
    expect(existsSync(join(blocked, 'nested'))).toBe(false)
    await otherCtx.fiber.dispose()
  })
  it('rejects domain-invalid event sequences before writing anything', async () => {
    await store.append(SESSION, [create])
    await expect(store.append(SESSION, [create])).rejects.toThrow(/already exists/)
    const loaded = await store.load(SESSION)
    expect(loaded?.guards).toHaveLength(1)
  })
  it('keeps errors typed and named', async () => {
    const path = join(dir, `${SESSION}.json`)
    writeFileSync(path, 'x'.repeat(10))
    try {
      await store.load(SESSION)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SupervisorStoreError)
      expect((error as SupervisorStoreError).name).toBe('SupervisorStoreError')
    }
  })
})
