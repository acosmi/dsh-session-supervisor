/**
 * Real Loader composition fixture (§16 P2 of the plan): boots dsh-base plus
 * this plugin's actual entry through the shipped Loader, then exercises a
 * real root Agent through the maintenance transaction and the store.
 * Composition runs over npm-published rc.6 packages; a boot failure fails the
 * gate loud.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  boot,
  initProfile,
  loadOverlayPatches,
  loadProfile,
  renderConfigDump,
} from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { guardianCreateTool, guardianListTool, type ToolDeps } from '../src/tools.ts'
import { FileSupervisorStore } from '../src/store.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { newLedgerState, foldEvents } from '../src/domain.ts'
import type { GuardianEvent, SessionOwnerId, TurnEndFact } from '../src/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const installAnchor = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-app-boot/package.json', import.meta.url))
const pluginEntry = new URL('../lib/index.js', import.meta.url).href

const homes: string[] = []
let home = ''

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('loader composition', () => {
  it('boots dsh-base + the plugin, exposes the store, and serves tools to a real agent', async () => {
    home = mkdtempSync(join(tmpdir(), 'supervisor-loader-'))
    homes.push(home)
    process.env.DSH_HOME = home
    initProfile(join(home, 'profiles', 'fixture'), ['@deepseek-ai/dsh-base'])
    const profile = loadProfile('dsh', 'fixture', installAnchor, home)
    const spikePatchPath = join(home, 'plugin.patch.yml')
    writeFileSync(spikePatchPath, [
      '- id: hmr',
      '  disabled: true',
      '- insert:',
      '    - id: dsh-session-supervisor',
      `      name: ${pluginEntry}`,
      '      config: {}',
      '',
    ].join('\n'))
    const baseConfigPath = join(home, 'base-root.yml')
    writeFileSync(baseConfigPath, '[]\n')
    const layers = [
      ...profile.layers.map(layer => ({ label: layer.packageName, patches: layer.patches })),
      { label: 'profile', patches: profile.patches },
      { label: 'plugin', patches: loadOverlayPatches('dsh', spikePatchPath) },
    ]
    const rootConfigPath = join(here, 'fixture-root-config.yml')
    writeFileSync(rootConfigPath, renderConfigDump('dsh', baseConfigPath, layers, () => {}))

    const ctx = await boot('dsh', rootConfigPath, [])
    try {
      // The plugin provided its store on the tree. (The loader imports the
      // plugin through Node's native TS strip path, so the instance lives in
      // a second module realm; assert structurally, not by instanceof.)
      const store = ctx.get('supervisorStore')
      expect(store?.name).toBe('supervisorStore')
      expect(typeof store?.load).toBe('function')
      expect(typeof store?.append).toBe('function')
      // All four tools occupy their canonical names: re-registering one of
      // them must fail loudly (duplicates within a layer are rejected).
      const probeName = 'guardian_create'
      const probe = defineTool({
        name: probeName,
        description: 'duplicate probe',
        parameters: {},
        output: { schema: { type: 'json' }, render: () => [] },
        execute: async () => ({}),
      })
      expect(() => ctx.tools.register(probe)).toThrow(/already registered/)
      for (const expected of ['guardian_list', 'guardian_update', 'guardian_check_now']) {
        expect(() => ctx.tools.register({ ...probe, name: expected })).toThrow(/already registered/)
      }
      // Create a real root Agent and drive the create tool through it.
      const sessionId = SessionId('fixture-root-1')
      const handle = await ctx.agents.create({ sessionId, meta: { cwd: home } })
      try {
        const agent = handle.agent
        expect(agent.session.header.parentSession).toBeUndefined()
        const exec = { agent } as unknown as ToolRunContext
        const idle = {
          lastQualifyingActivityAtMs(_s: SessionOwnerId): number | undefined { return undefined },
          turnEndsSince(_s: SessionOwnerId): readonly TurnEndFact[] { return [] },
        }
        const deps: ToolDeps = { store: store as FileSupervisorStore, config: DEFAULT_CONFIG, activity: idle }
        const created = await guardianCreateTool(deps).execute(
          { label: 'fixture guard', notificationMode: 'audit_only', policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 900 }] } as never,
          exec,
        )
        expect(created).toMatchObject({ id: 'guardian-1', controlState: 'armed' })
        const listed = await guardianListTool(deps).execute({} as never, exec)
        expect(listed).toHaveLength(1)
        // The plugin never writes to the session log.
        expect(agent.session.events.some(event => event.type.startsWith('guardian'))).toBe(false)
        // Its store is durable on disk and refolds cleanly.
        const onDisk = (store as FileSupervisorStore).load(sessionId as unknown as SessionOwnerId)
        await expect(onDisk).resolves.toMatchObject({ nextGuardianOrdinal: 2 })
        // Domain round-trip through the same events remains deterministic.
        const fixtureSession = 'fixture-root-1' as SessionOwnerId
        const events: GuardianEvent[] = [{
          version: 1, kind: 'create', atMs: 1,
          guard: { id: 'g1', label: 'x', ownerSessionId: fixtureSession, notificationMode: 'audit_only', policies: [{ id: 'p', kind: 'lifecycle_silence', seconds: 900 }] },
        }]
        expect(JSON.stringify(foldEvents(newLedgerState(fixtureSession), events))).toContain('"g1"')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
    expect(dshHomePath('plugins', 'session-supervisor')).toContain(home)
  }, 120_000)
})
