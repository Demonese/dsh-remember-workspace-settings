#!/usr/bin/env node
/**
 * Logic tests for dsh-remember-workspace-settings.
 *
 * They exercise the plugin class without installing it: the four bare
 * specifiers it imports are redirected to the running DSH installation's own
 * copies, then each method is called on an object whose prototype is the
 * plugin's, with fake `ctx`, `config`, and table.
 *
 * Usage:
 *   node test/logic.mjs
 *   DSH_INSTALL_DIR=/path/to/@deepseek-ai/dsh node test/logic.mjs
 *
 * `DSH_INSTALL_DIR` must point at the @deepseek-ai/dsh package directory of a
 * DSH installation that provides the four peer packages. When it is omitted,
 * the test tries to resolve @deepseek-ai/dsh from its own module path.
 *
 * Exit codes: 0 all checks passed; 1 a check failed or this Node is too old
 * to import module.registerHooks; 2 skipped because no usable DSH
 * installation was found.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Resolve @deepseek-ai/dsh from this module's own lookup path, if present. */
function installedDsh() {
  try {
    return packageRootOf(createRequire(import.meta.url).resolve('@deepseek-ai/dsh'))
  } catch {
    return undefined
  }
}

const INSTALL = process.env.DSH_INSTALL_DIR ?? installedDsh()
if (INSTALL === undefined) {
  console.error('[skip] set DSH_INSTALL_DIR to the @deepseek-ai/dsh package directory')
  process.exit(2)
}
const INSTALL_MANIFEST = join(INSTALL, 'package.json')

if (!existsSync(INSTALL_MANIFEST)) {
  console.error(`[skip] no DSH installation at ${INSTALL_MANIFEST}; set DSH_INSTALL_DIR`)
  process.exit(2)
}
if (typeof registerHooks !== 'function') {
  console.error(`[skip] this Node (${process.version}) has no module.registerHooks; Node 22.15+ is required`)
  process.exit(2)
}

/** Resolve one package through the installation, falling back to its directory. */
function resolvePackage(name) {
  for (const anchor of [INSTALL_MANIFEST, join(INSTALL, 'node_modules/@deepseek-ai/dsh-base/package.json')]) {
    try {
      return createRequire(anchor).resolve(name)
    } catch { /* try the next anchor */ }
  }
  const direct = join(INSTALL, 'node_modules', name)
  if (existsSync(direct)) return direct
  throw new Error(`cannot resolve ${name} from ${INSTALL}`)
}

const storageDomainEntry = resolvePackage('@deepseek-ai/dsh-storage-domain')

/** Find the package root for an entry file, an entry directory, or a lib/ path. */
function packageRootOf(entry) {
  for (const candidate of [entry, dirname(entry), dirname(dirname(entry))]) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  throw new Error(`cannot find a package root for ${entry}`)
}

const storageDomainRoot = packageRootOf(storageDomainEntry)
const zodEntry = createRequire(join(storageDomainRoot, 'package.json')).resolve('zod')

const OVERRIDES = {
  '@deepseek-ai/cordis': resolvePackage('@deepseek-ai/cordis'),
  '@deepseek-ai/schemastery': resolvePackage('@deepseek-ai/schemastery'),
  '@deepseek-ai/dsh-storage-domain': storageDomainEntry,
  'zod': zodEntry,
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = OVERRIDES[specifier]
    if (target !== undefined) return { url: pathToFileURL(target).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { default: Plugin } = await import(
  pathToFileURL(fileURLToPath(new URL('../index.js', import.meta.url))).href
)

let checks = 0
function check(label, body) {
  body()
  checks += 1
  console.log(`  ok  ${label}`)
}
async function checkAsync(label, body) {
  await body()
  checks += 1
  console.log(`  ok  ${label}`)
}

// ---------------------------------------------------------------- test doubles

function fakeTable() {
  const data = new Map()
  let writes = 0
  return {
    get: (key) => data.get(key),
    put: async (key, value) => { writes += 1; data.set(key, value) },
    delete: async (key) => { writes += 1; return data.delete(key) },
    get size() { return data.size },
    writes: () => writes,
  }
}

function host({ config, services } = {}) {
  const self = Object.create(Plugin.prototype)
  self.config = config ?? Plugin.Config({})
  self.table = fakeTable()
  self.writeChain = Promise.resolve()
  self.warns = []
  self.ctx = {
    get: (name) => services?.[name],
    logger: { info() {}, warn: (message) => self.warns.push(String(message)) },
  }
  return self
}

const session = (header) => ({ header })
const blankAgents = { turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }) }
const startedAgents = { turnBoundaryOf: () => ({ openTurnStartSeq: 7, lastTurn: 1 }) }

// Platform-neutral workspace paths; nothing here touches the filesystem.
const WORK = resolve('fixture-workspace')
const OTHER = resolve('fixture-other')
const ELSEWHERE = resolve('fixture-elsewhere')
const keyFor = (cwd) => process.platform === 'win32' ? cwd.toLowerCase() : cwd

// ---------------------------------------------------------------- config shape

const { Service } = await import(pathToFileURL(OVERRIDES['@deepseek-ai/cordis']).href)

check('the Service init symbol exists and the plugin implements it', () => {
  // `[Service.init]` with an undefined Service.init would silently become the
  // string key "undefined" and the plugin would never initialize.
  assert.equal(typeof Service.init, 'symbol', 'cordis must export Service.init')
  assert.equal(typeof Plugin.prototype[Service.init], 'function', 'the plugin must implement [Service.init]')
  assert.equal(typeof Plugin.prototype.apply, 'undefined', 'a Service class must not also export apply')
})

check('Config defaults', () => {
  assert.deepEqual(Plugin.Config({}), {
    enabled: true,
    applyPreset: true,
    applyModel: true,
    rememberPreset: true,
    rememberModel: true,
    skipForks: true,
    verbose: false,
  })
  assert.throws(() => Plugin.Config({ verbose: 'yes' }))
})

// ---------------------------------------------------------------- scopeOf

check('scopeOf keys, subagents, forks, missing cwd', () => {
  const self = host()
  const normal = self.scopeOf(session({ cwd: WORK, isSeeded: false }))
  assert.equal(typeof normal.key, 'string')
  assert.equal(normal.key, keyFor(WORK))
  assert.equal(normal.cwd, WORK)
  assert.equal(self.scopeOf(session({ cwd: OTHER, origin: 'subagent' })), undefined)
  assert.equal(self.scopeOf(session({ cwd: OTHER, isSeeded: true })), undefined)
  assert.equal(self.scopeOf(session({ isSeeded: false })), undefined)
  const inclusive = host({ config: Plugin.Config({ skipForks: false }) })
  assert.notEqual(inclusive.scopeOf(session({ cwd: OTHER, isSeeded: true })), undefined)
})

// ---------------------------------------------------------------- writeRecord

await checkAsync('writeRecord merges, clears fields, and deletes empty records', async () => {
  const self = host()
  const scope = { key: 'k', cwd: OTHER }

  await self.writeRecord(scope, { provider: 'p', model: 'm' })
  assert.equal(self.table.get('k').provider, 'p')
  assert.equal(self.table.get('k').model, 'm')
  assert.equal(self.table.get('k').path, OTHER)
  assert.equal(typeof self.table.get('k').updatedAt, 'number')

  await self.writeRecord(scope, { agentPreset: 'ptc' })
  assert.equal(self.table.get('k').provider, 'p', 'preset write must keep the model')
  assert.equal(self.table.get('k').agentPreset, 'ptc')

  await self.writeRecord(scope, { reasoningEffort: 'high' })
  assert.equal(self.table.get('k').reasoningEffort, 'high')

  await self.writeRecord(scope, { reasoningEffort: undefined })
  assert.equal('reasoningEffort' in self.table.get('k'), false, 'undefined clears the effort')

  await self.writeRecord(scope, { agentPreset: undefined })
  assert.equal('agentPreset' in self.table.get('k'), false, 'undefined clears the preset')
  assert.equal(self.table.get('k').model, 'm')

  const before = self.table.writes()
  await self.writeRecord(scope, { provider: 'p', model: 'm' })
  assert.equal(self.table.writes(), before, 'unchanged record must not write')

  await self.writeRecord(scope, { provider: undefined, model: undefined })
  assert.equal(self.table.get('k'), undefined, 'a record with no fields is deleted')
  assert.equal(self.table.size, 0)
})

// ---------------------------------------------------------------- rememberPreset

await checkAsync('rememberPreset records a non-default preset and clears a default one', async () => {
  const s = session({ cwd: OTHER, isSeeded: false })
  let used = 'ptc'
  const self = host({ services: { agentPresets: { defaultId: 'standard', presetForSession: () => used } } })

  self.rememberPreset(s)
  await self.writeChain
  assert.equal(self.table.get(self.scopeOf(s).key).agentPreset, 'ptc')

  used = 'standard'
  self.rememberPreset(s)
  await self.writeChain
  assert.equal(self.table.get(self.scopeOf(s).key), undefined, 'the default is "no preference"')
})

// ---------------------------------------------------------------- applyPreset

await checkAsync('applyPreset yields to an explicitly requested preset', async () => {
  const agent = { session: session({ cwd: OTHER }) }
  let calls = 0
  let running = 'cordis'
  const presets = {
    defaultId: 'standard',
    presetForSession: () => running,
    select: async (_agent, id) => { calls += 1; return id },
  }
  const self = host({ services: { agents: blankAgents, agentPresets: presets } })

  await self.applyPreset(agent, { agentPreset: 'ptc' })
  assert.equal(calls, 0, 'explicit request wins')

  running = 'standard'
  await self.applyPreset(agent, { agentPreset: 'ptc' })
  assert.equal(calls, 1, 'a default-created session takes the memory')

  running = null
  await self.applyPreset(agent, { agentPreset: 'ptc' })
  assert.equal(calls, 2, 'a session with no recorded preset takes the memory')
})

// ---------------------------------------------------------------- applyModel

await checkAsync('applyModel validates, dedupes, and degrades', async () => {
  const makeAgent = (current) => {
    const selected = []
    return {
      selected,
      session: session({ cwd: OTHER }),
      model: { current: () => current, select: (selection) => selected.push(selection) },
    }
  }
  let resolved = 0
  const self = host({
    services: { agents: blankAgents, llm: { resolveCallConfig: async () => { resolved += 1; return {} } } },
  })

  const same = makeAgent({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  await self.applyModel(same, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(same.selected.length, 0, 'an equal selection is not rewritten')
  assert.equal(resolved, 0, 'an equal selection is not validated')

  const different = makeAgent({ provider: 'p', model: 'm' })
  await self.applyModel(different, { provider: 'q', model: 'n', reasoningEffort: 'low' })
  assert.deepEqual(different.selected, [{ provider: 'q', model: 'n', reasoningEffort: 'low' }])

  const failing = host({ services: { llm: { resolveCallConfig: async () => { throw new Error('unavailable') } } } })
  const blocked = makeAgent({ provider: 'p', model: 'm' })
  await failing.applyModel(blocked, { provider: 'q', model: 'n' })
  assert.equal(blocked.selected.length, 0, 'an unavailable model is skipped')
  assert.equal(failing.warns.length, 1, 'the failure is warned once')
})

// ---------------------------------------------------------------- applyDefaults

await checkAsync('applyDefaults touches only blank sessions with memory', async () => {
  const makeAgent = () => {
    const selected = []
    return {
      selected,
      session: session({ cwd: OTHER, isSeeded: false }),
      model: { current: () => undefined, select: (selection) => selected.push(selection) },
    }
  }
  const presets = (sink) => ({
    defaultId: 'standard',
    presetForSession: () => 'standard',
    select: async (_agent, id) => { sink.push(id); return id },
  })

  const applied = []
  const blank = host({
    services: {
      agents: blankAgents,
      agentPresets: presets(applied),
      llm: { resolveCallConfig: async () => ({}) },
    },
  })
  const agent = makeAgent()
  await blank.writeRecord(blank.scopeOf(agent.session), { agentPreset: 'ptc', provider: 'p', model: 'm' })
  await blank.applyDefaults(agent)
  assert.deepEqual(applied, ['ptc'])
  assert.deepEqual(agent.selected, [{ provider: 'p', model: 'm' }])

  const untouched = []
  const started = host({
    services: { agents: startedAgents, agentPresets: presets(untouched), llm: { resolveCallConfig: async () => ({}) } },
  })
  const busy = makeAgent()
  await started.writeRecord(started.scopeOf(busy.session), { agentPreset: 'ptc', provider: 'p', model: 'm' })
  await started.applyDefaults(busy)
  assert.deepEqual(untouched, [], 'a started session is never switched')
  assert.deepEqual(busy.selected, [], 'a started session is never re-routed')

  const none = host({ services: { agents: blankAgents } })
  await none.applyDefaults({ session: session({ cwd: ELSEWHERE }), model: { current: () => undefined, select() {} } })
})

// ---------------------------------------------------------------- packaging

check('package.json, patch, and locales agree', () => {
  const dir = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dependencies, undefined, 'shipped packages come from the installation, not a local tree')
  // A linked layer resolves a bare import only when its own manifest lists the
  // name under peerDependencies (profile-resolution-bootstrap readPeerNames).
  const peers = manifest.peerDependencies ?? {}
  for (const name of [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-storage-domain',
    'zod',
  ]) {
    assert.equal(typeof peers[name], 'string', `${name} must be a peer or the linked layer cannot resolve it`)
  }
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`name: ${manifest.name.replaceAll('/', '\\/')}`))
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(join(dir, 'locale', `${locale}.json`), 'utf8')).meta
    assert.equal(typeof meta.title, 'string')
    assert.equal(typeof meta.description, 'string')
  }
  assert.ok(existsSync(join(dir, 'icon.svg')))
})

check('the dsh peer range passes the installation compatibility gate', () => {
  const dir = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const appBootRoot = packageRootOf(resolvePackage('@deepseek-ai/dsh-app-boot'))
  const semver = createRequire(join(appBootRoot, 'package.json'))('semver')
  const runtime = JSON.parse(readFileSync(INSTALL_MANIFEST, 'utf8')).version
  // evaluatePluginCompatibility checks only @deepseek-ai/dsh* peers, with includePrerelease.
  const range = manifest.peerDependencies['@deepseek-ai/dsh-storage-domain']
  assert.ok(
    semver.satisfies(runtime, range, { includePrerelease: true }),
    `peer range ${range} must accept dsh ${runtime} or installation is blocked`,
  )
})

console.log(`\n${checks} checks passed`)