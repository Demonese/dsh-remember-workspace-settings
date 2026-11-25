/**
 * Per-workspace launch defaults.
 *
 * A working directory keeps the agent preset and the provider/model/reasoning
 * effort last used in it, and gets them back on its next blank session.
 *
 * What is recorded, and from where:
 *
 * - `turn/start`      — the preset the turn actually ran under. Recording only
 *                       here keeps the reusable-blank churn out of the memory:
 *                       `session/create` re-composes a reused blank Session
 *                       with the configured default before the Agent exists,
 *                       which is not a user choice.
 * - `model/selection` — a complete model selection committed to the log; the
 *                       Web GUI writes one whenever the user picks a model.
 *
 * Applying happens once, on `agent/created`, while the session is still blank:
 * `agentPresets.select()` is the same call the GUI makes for a new blank
 * session, and `agent.model.select()` is the low-level write that does NOT
 * touch the deployment-wide `agent-default-model` (unlike `session/selectModel`).
 *
 * @module dsh-remember-workspace-settings
 */

import { resolve as resolvePath } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Fields a workspace record carries besides its path and timestamp. */
const REMEMBERED_FIELDS = ['agentPreset', 'provider', 'model', 'reasoningEffort']

/** One workspace's remembered launch defaults. */
const recordSchema = zod.object({
  path: zod.string(),
  agentPreset: zod.string().optional(),
  provider: zod.string().optional(),
  model: zod.string().optional(),
  reasoningEffort: zod.string().optional(),
  updatedAt: zod.number(),
})

/**
 * The plugin's own durable domain. The name is also the JSON unit file name
 * under the harness home's storage root, so it must stay stable across releases.
 */
const domainSpec = defineDomain({
  name: 'workspace_launch_defaults',
  version: 1,
  tables: { workspaces: domainTable(recordSchema) },
})

export default class RememberWorkspaceSettings extends Service {
  static inject = ['storageDomain']

  static Config = z.object({
    /** Master switch; false stops both remembering and applying. */
    enabled: z.boolean().default(true),
    /** Re-apply the remembered agent preset to a blank session. */
    applyPreset: z.boolean().default(true),
    /** Re-apply the remembered provider/model/reasoning effort. */
    applyModel: z.boolean().default(true),
    /** Record the preset a turn ran under into the workspace memory. */
    rememberPreset: z.boolean().default(true),
    /** Record model switches into the workspace memory. */
    rememberModel: z.boolean().default(true),
    /** Leave forked sessions alone: neither apply the memory nor record from them. */
    skipForks: z.boolean().default(true),
    /** Log every applied and remembered value, not only warnings. */
    verbose: z.boolean().default(false),
  })

  constructor(ctx, config) {
    super(ctx, 'rememberWorkspaceSettings')
    this.config = config
    /** @type {import('@deepseek-ai/dsh-storage-domain').KvTable<string, any> | undefined} */
    this.table = undefined
    /**
     * Serializes read-merge-write so two nearby events cannot drop a field.
     * The chain never rejects: a failed write is warned and the next one runs.
     */
    this.writeChain = Promise.resolve()
  }

  async [Service.init]() {
    const ctx = this.ctx
    try {
      const domain = await ctx.storageDomain.open(domainSpec)
      this.table = domain.table('workspaces')
      ctx.effect(() => () => domain.close(), 'remember-workspace-settings.domain')
      this.log(`storage ready, ${this.table.size} workspace(s) remembered`)
    } catch (error) {
      // A broken or migrating unit must not take the plugin (or the app) down:
      // degrade to "no memory" and say so once.
      this.warn(`storage unavailable, workspace memory disabled: ${describeError(error)}`)
    }

    ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })

    ctx.on('agent/created', async ({ agent }) => {
      try {
        await this.applyDefaults(agent)
      } catch (error) {
        // `agent/created` is a serial listener: rethrowing would fail the whole
        // session creation. Every failure here stays inside the plugin.
        this.warn(`could not apply remembered defaults: ${describeError(error)}`)
      }
    })
  }

  /**
   * Fold one durable session event into the owning directory's record.
   * @param {any} session - session that appended the event.
   * @param {any} event - committed session event.
   */
  onSessionEvent(session, event) {
    if (!this.config.enabled) return
    try {
      if (event.type === 'turn/start') {
        if (this.config.rememberPreset) this.rememberPreset(session)
        return
      }
      if (event.type === 'model/selection') {
        if (!this.config.rememberModel) return
        this.remember(session, {
          provider: event.data.provider,
          model: event.data.model,
          reasoningEffort: event.data.reasoningEffort,
        })
      }
    } catch (error) {
      this.warn(`could not record selection: ${describeError(error)}`)
    }
  }

  /**
   * Record the preset a turn ran under. A turn on the configured default stores
   * "no preference" instead of pinning it, so a workspace that never chose a
   * preset keeps following the deployment default.
   * @param {any} session - session that started a turn.
   */
  rememberPreset(session) {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return
    const used = presets.presetForSession(session)
    if (typeof used !== 'string' || used.length === 0) return
    const fallback = presets.defaultId
    const preference = typeof fallback === 'string' && used === fallback ? undefined : used
    this.remember(session, { agentPreset: preference })
  }

  /**
   * Queue one read-merge-write against the workspace record. Queueing keeps a
   * preset event and a model event that arrive together from overwriting each
   * other with a stale read.
   * @param {any} session - session whose cwd names the workspace.
   * @param {Record<string, string | undefined>} patch - fields to merge.
   */
  remember(session, patch) {
    const scope = this.scopeOf(session)
    if (scope === undefined) return
    this.writeChain = this.writeChain
      .then(() => this.writeRecord(scope, patch))
      .catch((error) => { this.warn(`could not save workspace memory: ${describeError(error)}`) })
  }

  /**
   * Merge and persist one record, skipping writes that change nothing.
   * @param {{ key: string, cwd: string }} scope - workspace identity.
   * @param {Record<string, string | undefined>} patch - fields to merge.
   */
  async writeRecord(scope, patch) {
    const table = this.table
    if (table === undefined) return
    const previous = table.get(scope.key)
    const next = { ...previous, ...patch, path: scope.cwd, updatedAt: Date.now() }
    // An explicit `undefined` means "forget this field": an absent reasoning
    // effort returns to the adapter default, and an absent preset means "no
    // preference". Drop the key instead of merging the old value forward.
    for (const field of REMEMBERED_FIELDS) {
      if (next[field] === undefined) delete next[field]
    }
    if (!REMEMBERED_FIELDS.some(field => next[field] !== undefined)) {
      if (previous !== undefined) {
        await table.delete(scope.key)
        this.log(`forgot ${scope.cwd}`)
      }
      return
    }
    if (previous !== undefined && sameMemory(previous, next)) return
    await table.put(scope.key, next)
    this.log(`remembered ${scope.cwd}: ${describeMemory(next)}`)
  }

  /**
   * Apply the directory's remembered values to a session that has not started.
   * @param {any} agent - newly created or resumed agent.
   */
  async applyDefaults(agent) {
    if (!this.config.enabled) return
    const table = this.table
    if (table === undefined) return
    const session = agent?.session
    if (session === undefined) return
    const scope = this.scopeOf(session)
    if (scope === undefined) return
    if (!this.isBlank(session)) return
    const memory = table.get(scope.key)
    if (memory === undefined) return
    if (this.config.applyPreset) await this.applyPreset(agent, memory)
    if (this.config.applyModel) await this.applyModel(agent, memory)
  }

  /**
   * Switch the blank session to the remembered preset, unless the creation
   * request named a different preset on purpose (Creator mode, for example).
   * @param {any} agent - blank agent.
   * @param {any} memory - workspace record.
   */
  async applyPreset(agent, memory) {
    if (memory.agentPreset === undefined) return
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return
    try {
      const fallback = presets.defaultId
      const running = presets.presetForSession(agent.session)
      if (typeof fallback === 'string' && running !== null && running !== fallback) {
        this.log(`kept explicitly requested preset "${running}"`)
        return
      }
      const applied = await presets.select(agent, memory.agentPreset)
      this.log(`applied preset "${applied}"`)
    } catch (error) {
      this.warn(`preset "${memory.agentPreset}" not applied: ${describeError(error)}`)
    }
  }

  /**
   * Record the remembered model selection on the blank session. Validation
   * happens first: a provider that is signed out or a model that left the
   * catalog leaves the deployment default in place instead of failing a turn.
   * @param {any} agent - blank agent.
   * @param {any} memory - workspace record.
   */
  async applyModel(agent, memory) {
    if (memory.provider === undefined || memory.model === undefined) return
    const llm = this.ctx.get('llm')
    if (llm === undefined) return
    /** @type {{ provider: string, model: string, reasoningEffort?: string }} */
    const target = { provider: memory.provider, model: memory.model }
    if (memory.reasoningEffort !== undefined) target.reasoningEffort = memory.reasoningEffort
    if (sameSelection(agent.model.current(), target)) return
    try {
      await llm.resolveCallConfig(target)
      agent.model.select(target)
      this.log(`applied model ${describeSelection(target)}`)
    } catch (error) {
      this.warn(`model "${memory.provider}/${memory.model}" not applied: ${describeError(error)}`)
    }
  }

  /**
   * Whether the session has not started a turn yet — the preset registry's own
   * blank predicate, so a change is legal exactly when it is accepted.
   * @param {any} session - session to inspect.
   */
  isBlank(session) {
    const agents = this.ctx.get('agents')
    if (agents === undefined) return false
    const boundary = agents.turnBoundaryOf(session)
    return boundary.openTurnStartSeq === null && boundary.lastTurn === 0
  }

  /**
   * Resolve the workspace identity for one session, or undefined when this
   * session must not participate (subagent, skipped fork, no directory).
   * @param {any} session - session to classify.
   * @returns {{ key: string, cwd: string } | undefined} storage key and display path.
   */
  scopeOf(session) {
    const header = session?.header
    if (header === undefined) return undefined
    if (header.origin === 'subagent') return undefined
    if (this.config.skipForks && (header.isSeeded === true || header.parentSession !== undefined)) return undefined
    const cwd = header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    return { key: workspaceKey(cwd), cwd }
  }

  log(message) {
    if (this.config.verbose) this.ctx.logger.info(`remember-workspace-settings: ${message}`)
  }

  warn(message) {
    this.ctx.logger.warn(`remember-workspace-settings: ${message}`)
  }
}

/**
 * Stable storage key for a working directory. `resolve` collapses different
 * spellings of the same absolute path; Windows comparisons are case-insensitive.
 * @param {string} cwd - session working directory.
 * @returns {string} table key.
 */
function workspaceKey(cwd) {
  const absolute = resolvePath(cwd)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Compare the fields a workspace record actually remembers.
 * @param {any} a - one record.
 * @param {any} b - another record.
 * @returns {boolean} true when nothing worth storing changed.
 */
function sameMemory(a, b) {
  if (a.path !== b.path) return false
  return REMEMBERED_FIELDS.every(field => a[field] === b[field])
}

/**
 * Compare a complete selection.
 * @param {any} a - current selection, possibly undefined.
 * @param {any} b - target selection.
 * @returns {boolean} true when both name the same provider, model, and effort.
 */
function sameSelection(a, b) {
  return a !== undefined && a.provider === b.provider && a.model === b.model
    && (a.reasoningEffort ?? undefined) === (b.reasoningEffort ?? undefined)
}

/** @param {unknown} error */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {any} memory */
function describeMemory(memory) {
  const parts = []
  if (memory.agentPreset !== undefined) parts.push(`preset=${memory.agentPreset}`)
  if (memory.provider !== undefined && memory.model !== undefined) parts.push(`model=${describeSelection(memory)}`)
  return parts.join(' ') || '(empty)'
}

/** @param {{ provider: string, model: string, reasoningEffort?: string }} selection */
function describeSelection(selection) {
  return selection.reasoningEffort === undefined
    ? `${selection.provider}/${selection.model}`
    : `${selection.provider}/${selection.model}@${selection.reasoningEffort}`
}