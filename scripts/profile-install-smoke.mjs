/**
 * Profile-install smoke (P4 gate): build, pack, install the tarball into a
 * fresh profile through the real `dsh plugin` CLI, and assert the composed
 * tree carries the `dsh-session-supervisor` row. No API key required.
 *
 * `DSH_BIN` may point at a specific `dsh` executable; it defaults to the
 * deepseek-harness source CLI located next to this checkout
 * (`node --import tsx/esm apps/cli/src/bin.ts`).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const home = mkdtempSync(join(tmpdir(), 'dsh-profile-smoke-'))
const profile = 'smoke'

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.status !== 0) {
    console.error(result.stdout)
    console.error(result.stderr)
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
  }
  return result.stdout
}

try {
  run('pnpm', ['run', 'build'])
  run('node', ['-e', "require('node:fs').mkdirSync('dist', { recursive: true })"], { cwd: root })
  run('npm', ['pack', '--pack-destination', 'dist'], { cwd: root })
  const tarball = run('node', ['-e', `
    const fs = require('node:fs')
    const files = fs.readdirSync('dist').filter(name => name.endsWith('.tgz'))
    if (files.length !== 1) throw new Error('expected exactly one tarball')
    console.log(require('node:path').resolve('dist', files[0]))
  `], { cwd: root }).trim()

  const dshBin = process.env.DSH_BIN
  const localCli = dshBin === undefined
  const dsh = dshBin
    ? dshBin.split(' ')
    : ['node', '--import', 'tsx/esm', resolve(root, '../../apps/cli/src/bin.ts')]
  // The source CLI resolves its vendored framework from the monorepo checkout,
  // so it must run with that checkout as its working directory.
  const cliCwd = localCli ? resolve(root, '../..') : root
  run(dsh[0], [...dsh.slice(1), 'plugin', '--profile', profile, 'add', tarball], {
    cwd: cliCwd,
    env: { ...process.env, DSH_HOME: home },
  })
  const dump = run(dsh[0], [...dsh.slice(1), '--profile', profile, '--dump-config'], {
    cwd: cliCwd,
    env: { ...process.env, DSH_HOME: home },
  })
  if (!dump.includes('id: dsh-session-supervisor')) {
    throw new Error('composed profile is missing the dsh-session-supervisor row')
  }
  console.log('profile-install smoke: PASS')
} finally {
  rmSync(home, { recursive: true, force: true })
}
