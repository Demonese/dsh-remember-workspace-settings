# 设计说明

本文说明 `dsh-remember-workspace-settings` 为什么这样实现：DSH 的哪些机制决定了插件的形状、最终设计如何落地，以及哪些边界情况是刻意处理的。目标读者是想修改行为、移植到新 DSH 版本或审查设计的维护者。

> 版本基线：DSH **0.2.2-rc.5**。文中的源码引用与行号只对该版本有效；DSH 迭代较快，升级后请按 §7 复核。

## 1. 问题

在 preset 与模型这两个维度上，DSH 只保留两套**全局**默认，以及每个会话自己的选择记录：

| 维度 | 存储位置 | 作用域 |
|---|---|---|
| 默认 preset | `agent-preset-registry` 行的 `selectedDefault`（写进 profile patch） | 全进程一个 |
| 默认模型 | `agent-default-model` 行的 `provider / model / reasoningEffort` | 全进程一个 |
| 单会话 preset | 会话日志的 `agent-preset/selected` | 单个会话 |
| 单会话模型 | 会话日志的 `model/selection` | 单个会话 |

两个细节决定了需求的形状：

1. **换模型会顺手改全局默认。** GUI 的模型选择走 `session/selectModel`，它在记录会话选择之后还会后台调用 `agentDefaultModel.saveSelection(selected)`。所以"上次用的模型"确实被记住了，但记住的是**全局**的：在 A 工作区换了模型，B 工作区的新会话也会跟着用。
2. **换 preset 不会改全局默认。** UI 上换模式只写会话日志，`selectedDefault` 只在 Settings 里改。所以新会话永远回到配置里的那个默认 preset。

目标因此是：把这两套全局记忆降维成**按工作目录**的记忆，并补上 preset 那条缺失的路径。

## 2. 关键机制

### 2.1 创建会话

创建请求里只有 preset，没有模型：

```ts
// dsh-api-session-controller/src/types.ts:268-277
export interface SessionCreateRequest {
  readonly workspaceId?: WorkspaceId
  readonly cwd?: string
  readonly sessionId?: SessionId
  /** Preset the Session runs, replacing a reused Session's recorded preset; the configured default when omitted. */
  readonly agentPreset?: string
}
```

Host 侧的行为：

- **复用空白会话**时，`createSession()` 会先用目标 preset 重新组装（`dsh-api-session-controller/src/agent.ts:383-401`）；
- **新建会话**时，在 `setup` 里 `presets.mount()`，并在发布前 append `agent-preset/selected`（同文件 `:404-414`）；
- **模型**来自 live getter：`agentOptions()` 每次读 `agentDefaultModel.currentSelection()`（同文件 `:453-461`）——没记录过选择的会话会跟着全局默认漂移。

### 2.2 `agent/created` 是唯一的应用窗口

```ts
// dsh-agent/src/index.ts:551-573（announce）
await this.ctx.serial(entry.carrier, 'agent/created', { agent: entry.agent, source, ... })
```

创建顺序（`dsh-agent-loop/lib/index.js:1582-1611`，整段包在 `agent.runMaintenance()` 里）：

```
appendUnstoredSuffix → sessions.enter → sessions.announce → setup(agentCtx)
→ commit → agents.enter → agents.announce('agent/created') → 释放排队输入
```

由此得到三个事实：

1. **触发时 agent 已在 registry 里**，`agents.turnBoundaryOf()`、`agentPresets.select(agent, …)` 都能用；
2. **监听器是 serial 且被 await**，所以监听器里的写入发生在 creation resolve 之前，客户端拿到的 `session/create` 响应已经是改好的值，第一条 prompt 也不会抢跑；
3. **监听器抛错会让整个会话创建失败**。插件必须整段 try/catch，绝不外抛。

### 2.3 空白会话可以换 preset

```ts
// dsh-agent-preset-registry/src/index.ts:364-383
async select(agent: Agent, agentPreset: string): Promise<string> {
  // ...
  const boundary = this.owner.agents.turnBoundaryOf(agent.session)
  if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) {
    throw new RemoteError('agent-preset/locked', 'This session has already started', ...)
  }
  // 相同值直接返回；否则 recompose 后 append agent-preset/selected
}
```

可利用的性质：

- 按 agent 串行，和 UI 的并发调用天然合流；
- 已经开过 turn 就拒绝（`agent-preset/locked`），所以只能用于空白会话——这正好是目标窗口；
- 已经跑的就是目标 preset 时 no-op；
- 换 preset 走 `recompose → mount → bind` 的 rebind 路径，和 live agent 换模式是同一条路。

### 2.4 模型侧：绕开 remote

| 调用方式 | 写会话日志 | 改全局默认 | 适用 |
|---|---|---|---|
| `session/selectModel`（Remote） | 是 | 是（后台） | GUI 用；插件不要用 |
| `agent.model.select(selection)` | 是 | 否 | 插件用这个 |

```ts
// dsh-agent/src/model-selection.ts:112-115
select(selection: Readonly<ModelSelection>): void {
  if (sameModelSelection(this.recordedSelection(), selection)) return
  this.session.append('model/selection', toSelection(...))
}
```

它只和**已记录值**比较；没有记录时会无条件 append（哪怕等于当前 options）。所以插件先比 `agent.model.current()` 再决定要不要写，避免多余事件。

### 2.5 记录 preset 用 `turn/start`，不用 `agent-preset/selected`

复用空白会话时，Host 的 `session/create` 会先用配置默认预设重新组装并写一条 `agent-preset/selected`。如果照这条事件记录，会覆盖工作区记忆，而且写入与应用之间存在竞态。

正确做法是在 `turn/start` 时读 `agentPresets.presetForSession(session)`，记录"这一轮实际跑的预设"。这样也自然满足"只记录真正用过的预设"的产品语义。

模型则监听 `model/selection`：这是用户每次选模型都会提交的完整选择，且模型切换不会像预设那样在创建时被 Host 重置。

### 2.6 持久化

插件使用 `@deepseek-ai/dsh-storage-domain` 的 `defineDomain` + `domainTable`：

```js
const domainSpec = defineDomain({
  name: 'workspace_launch_defaults',
  version: 1,
  tables: { workspaces: domainTable(recordSchema) },
})
```

- domain 名同时是磁盘文件名，**不能改名**；
- 表 `workspaces` 的 key 是规范化后的绝对 cwd：`path.resolve(cwd)`，Windows 上再 `toLowerCase()`；
- 落盘位置是 `$DSH_HOME/storages/workspace_launch_defaults.json`（`$DSH_HOME` 默认 `~/.dsh`）；
- 选择 cwd 而不是 `workspaceId`：`session.header.cwd` 是创建会话时稳定且有值的标识，删掉 Workspace 注册项不应该丢记忆。

## 3. 最终设计

```
┌──────────────────── Host 插件 remember-workspace-settings ────────────────────┐
│                                                                               │
│  storageDomain("workspace_launch_defaults")                                   │
│      └─ table("workspaces")  key = 规范化 cwd                                  │
│                                                                               │
│  remember:  session/event ── turn/start ────────→ 读 presetForSession          │
│             session/event ── model/selection ───→ provider/model/effort        │
│                              └───────────────→ put(key, mergedRecord)          │
│                                                                               │
│  recall:    agent/created ── 空白 && 非 subagent && 非 fork                     │
│                 ├─ agentPresets.select(agent, 记忆 preset)（仅当前=默认时）     │
│                 └─ resolveCallConfig → agent.model.select(记忆 selection)      │
└───────────────────────────────────────────────────────────────────────────────┘
```

记录形状：

```js
{
  path: '/home/you/projects/demo',   // 显示用，保留会话创建时的写法
  agentPreset: 'ptc',                // 可选；默认预设等于没有偏好
  provider: 'your-provider',         // 与 model 成对出现
  model: 'your-model',
  reasoningEffort: 'high',           // 可选
  updatedAt: 1764000000000,          // epoch ms
}
```

应用顺序是先 preset、后 model；两半各自 try/catch，一半失败不影响另一半。

## 4. 关键决定

- **同一 key 的读-改-写串行化（`writeChain`）。** 预设事件和模型事件可能几乎同时到达；串行化避免两次读拿到同一份旧记录、后写覆盖先写。
- **`undefined` 表示删除字段。** 清除推理强度会回到适配器默认；清除预设表示"没有偏好"。字段全空时删除整条记录，不留空壳。
- **默认预设 = 无偏好。** 用默认预设跑的一轮清掉 `agentPreset`，让工作区继续跟随 Settings 里默认值的变化，而不是被钉死在旧值。
- **显式预设让位。** 创建请求显式点名了非默认 preset（Creator 等流程）时，`applyPreset` 不覆盖；只有"按默认创建"的会话才套用记忆值。
- **模型先校验再写。** `llm.resolveCallConfig(target)` 与 `session/selectModel` 使用同一个校验入口；provider 未登录、模型下线或 effort 不支持时只跳过模型这一半并 warn。
- **不写重复事件。** 应用前先比 `agent.model.current()`；记录时比较除 `updatedAt` 外的字段。注意 `agent.model.select` 只和已记录值比较，没有记录时会无条件 append，所以应用侧的去重必须自己做。
- **绝不改全局默认。** 只调用 `agent.model.select()`；`session/selectModel` 会顺手 `agentDefaultModel.saveSelection`，禁止使用。
- **绝不外抛。** `agent/created` 的监听器抛错会让整个会话创建失败，所以应用逻辑整段捕获；`session/event` 的记录逻辑同样捕获，坏记录不能影响正在进行的对话。
- **跳过子代理与 fork。** 子代理的模型策略不应污染工作区记忆；fork 默认跳过（`skipForks` 可关）。

## 5. 边界情况

| 场景 | 行为 | 依据 |
|---|---|---|
| 子代理会话 | 既不记录也不应用 | `header.origin === 'subagent'` |
| fork 会话 | 默认跳过；`skipForks: false` 时参与 | `header.isSeeded === true`（现代 fork）或 `parentSession` |
| 打开有历史的会话 | 不应用 | `openTurnStartSeq === null && lastTurn === 0` |
| 复用同一个空白会话 | 重复应用同一值 → 无副作用 | `presets.select` 与 `model.select` 的相等判定 |
| 记忆里的 preset 被删/改名 | 保留当前预设，warn | `select` 抛 `agent-preset/not-found` / `invalid` |
| provider 未登录 / 模型下线 | 只跳过模型，preset 照常 | `resolveCallConfig` 抛错 |
| 用户在空白会话里手动改 preset/model | 模型立即记录；预设在下一轮 `turn/start` 记录 | `turn/start` 与 `model/selection` 都会进 remember |
| 多窗口 / 多进程同时写 | 同进程内单一写链；跨进程后写覆盖 | JSON 存储后端是单进程写链 |
| 工作区改名/移动 | 变成一份新记忆，旧记录保留 | 按 cwd 作 key 的固有限制 |
| 目录大小写 / symlink 差异 | `resolve` + Windows 小写 | `workspaceKey()` |
| git worktree | 每个 worktree 各自一份记忆 | worktree 的 cwd 不同 |
| 首次应用的重挂载 | 一次额外 mount/unmount，通常只表现为"打开稍慢" | 发生在 creation resolve 前 |
| 插件自身抛错 | 不影响会话创建 | 全量 try/catch |

## 6. 打包与加载

这是一个 **Host-only bundle**：没有 client 半、没有构建步骤、没有安装脚本。`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 只 `insert` 一行。

两个容易被忽略的约束：

1. **以本地目录（linked layer）安装时，4 个裸导入必须列在插件自己的 `peerDependencies` 里。** Loader 的 `routeLinked()` 只对 `peerDependencies` 中列出的名字做安装树拦截；漏掉的名字会回落到 Node 原生解析并 `ERR_MODULE_NOT_FOUND`。需要的是 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-storage-domain`、`zod`。
2. **`dependencies` 必须为空。** 真依赖会让包管理器在插件目录下再装一份 cordis / zod，破坏"整个进程共享同一实例"的前提。

版本闸门只检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer，且带 `includePrerelease: true`。所以 `@deepseek-ai/dsh-storage-domain: ">=0.2.0"` 能通过预发布版；不要用 `~0.2.2` 这类会卡住预发布版的范围。

## 7. 升级 DSH 后检查清单

DSH 升级后，先复核以下机制再改行为：

1. `SessionCreateRequest` 是否仍然没有 model 字段（`dsh-api-session-controller/src/types.ts`）。
2. `agent/created` 是否仍然 serial、被 await，且发生在会话仍空白、创建响应返回之前（`dsh-agent/src/index.ts`、`dsh-agent-loop/lib/index.js`）。
3. `agentPresets.select()` 的空白判定与签名是否变化（`dsh-agent-preset-registry/src/index.ts`）。
4. `agent.model.select()` 是否仍然只写会话日志、不改全局默认（`dsh-agent/src/model-selection.ts`）。
5. `session/event` 是否仍然派发 `turn/start` 与 `model/selection`，事件数据字段是否变化。
6. `storageDomain.open()` / `domainTable()` 的 API、domain 版本与磁盘布局是否兼容。
7. 版本闸门是否仍然只检查 dsh 系 peer、是否仍接受预发布版。
8. 跑 `node test/logic.mjs`；如果它因 API 变化失败，先确认变化点，再决定改测试还是改插件。