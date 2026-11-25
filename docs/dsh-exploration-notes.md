# DSH 探索笔记

本文件记录 `dsh-remember-workspace-settings` 依赖的 DeepSeek Harness（DSH）平台行为。这些结论来自 DSH 源码，而不是插件代码或公开文档，是插件设计成立的前提；修改插件或升级 DSH 时先读这里。

> 版本基线：DSH **0.2.2-rc.5**。源码路径相对于 DSH 安装树中的 `@deepseek-ai/` 依赖包目录（通常为 `@deepseek-ai/dsh/node_modules/@deepseek-ai/`），行号只对该版本有效。升级 DSH 后按 §10 复核，不要直接沿用结论。
>
> 相关文档：[设计说明](DESIGN.md) · [测试与发布](test.md) · [项目介绍](../README.md)

## 1. 创建会话没有模型参数

`SessionCreateRequest` 只有以下字段（`dsh-api-session-controller/src/types.ts:268-277`）：

| 字段 | 含义 |
|---|---|
| `workspaceId` | 会话加入的 Workspace；与 `cwd` 二选一 |
| `cwd` | 会话拥有的工作目录；未指定 Workspace 时使用 |
| `sessionId` | 可复用的空白会话，或新会话的标识 |
| `agentPreset` | 会话运行的预设；省略时使用配置默认值 |

没有 `provider` / `model` / `reasoningEffort`。也就是说：**预设可以在创建时指定，模型只能等会话存在之后再写。**

Host 侧的创建路径进一步决定了应用时机：

- **复用进程内空白会话**：`reuseLive()` 检查可复用且仍空白，目标预设与当前不同时调用 `presets.select()`（`dsh-api-session-controller/src/agent.ts:383-401`）。
- **复用已落盘的空白会话**：确认日志里没有 `turn/start` 后，用 `reuseSetup()` 重新组装；目标预设与记录值不同时 append `agent-preset/selected`（同文件 `:404-414`）。
- **新建会话**：`composeAgent()` 先 `presets.mount()`（同文件 `:261-274`），会话 meta 带上 `agentPreset`（同文件 `:436-450`）。
- **模型**：`agentOptions()` 用 live getter 读取 `agentDefaultModel.currentSelection()`（同文件 `:453-461`）。没有记录过模型选择的会话会一直跟随全局默认值。

结论：插件必须在会话创建完成之后、第一条消息之前写入模型；这个窗口就是下一节的 `agent/created`。

## 2. `agent/created` 是唯一的应用窗口

`agent/created` 由 `ctx.serial` 派发并被 await（`dsh-agent/src/index.ts:551-573`）：

```ts
await this.ctx.serial(entry.carrier, 'agent/created', {
  agent: entry.agent,
  source,
  ...(signal === undefined ? {} : { signal }),
})
```

创建顺序（`dsh-agent-loop/lib/index.js:1582-1611`，整段包在 `agent.runMaintenance()` 里）：

```text
appendUnstoredSuffix → sessions.enter → sessions.announce → setup(agentCtx)
→ commit → agents.enter → agents.announce('agent/created') → 释放排队输入
```

由此得到三个事实：

1. **触发时 agent 已在 registry 里。** `agents.turnBoundaryOf()`、`agentPresets.select(agent, …)` 都可以用。
2. **监听器是 serial 且被 await。** 监听器里的写入发生在创建 promise resolve 之前；正常客户端拿到 `session/create` 响应时值已改好，随后发送的首条 prompt 不会抢跑。插件仍不能假定所有调用方都等待响应。
3. **监听器抛错会让整个会话创建失败。** 插件的应用逻辑必须整段 try/catch，绝不外抛。

这是唯一同时满足“agent 已就绪、会话仍空白、创建响应尚未返回”的窗口。其他事件要么 agent 还不存在，要么已经可能有 turn。

## 3. `agentPresets.select()` 只能用于空白会话

`select(agent, agentPreset)`（`dsh-agent-preset-registry/src/index.ts:364-383`）的行为：

- 按 agent 串行（`this.switches`），并发调用天然合流；
- 用 `turnBoundaryOf(session)` 判断空白：`openTurnStartSeq !== null || lastTurn > 0` 时抛 `agent-preset/locked`；
- 目标预设与当前记录的预设、当前 generation 都一致时 no-op，不写事件；
- 否则 `recompose → mount → bind`，再 append `agent-preset/selected`。

空白判定与 Host 创建路径中的 `isBlank()` 一致（`dsh-api-session-controller/src/agent.ts:416-420`）。插件仍然自己先判断空白，避免对已开始的会话发起必然失败的调用；真正决定是否合法的是 registry。

补充：`agentPresets.defaultId` 返回 `config.selectedDefault`（Settings 里改的默认）或配置的 `default`；`presetForSession()` 返回会话实际记录的预设，包括已从 roster 删除的历史值（同文件 `:81-91`）。

## 4. 模型写入：`agent.model.select` 与 `session/selectModel`

| 调用方式 | 写会话日志 | 改全局默认 | 适用 |
|---|---|---|---|
| `session/selectModel`（Remote） | 是 | 是（后台） | GUI 用；插件不要用 |
| `agent.model.select(selection)` | 是 | 否 | 插件用这个 |

`agent.model.select()` 只 append `model/selection`（`dsh-agent/src/model-selection.ts:112-115`）：

```ts
select(selection: Readonly<ModelSelection>): void {
  if (sameModelSelection(this.recordedSelection(), selection)) return
  this.session.append('model/selection', toSelection(selection.provider, selection.model, selection.reasoningEffort))
}
```

两个细节：

- 它只和**已记录值**比较；没有记录时会无条件 append，哪怕选择等于当前 options。所以插件在应用前先比 `agent.model.current()`，避免多余事件。
- `session/selectModel` 在记录会话选择之后，还会后台调用 `agentDefaultModel.saveSelection(selected)`（`dsh-api-session-controller/src/commands.ts:166-184`）。**禁止**用这个入口应用记忆，否则会把部署全局默认改掉。

还有一层校验差异：`session/selectModel` 在 `resolveCallConfig` 之前调用 `requireModel` → `modelAvailable`，按当前 provider catalog 判断模型是否可选（`commands.ts:166-184`、`:415-420`、`catalog.ts:81-91`）。插件没有走这个 remote，只调用 `resolveCallConfig`，所以不检查登录凭证，也不做同等的目录可选性检查；失败只跳过模型这一半。

GUI 的模型选择器走 `session/selectModel`，因此它本身会更新全局默认——那是 DSH 的行为，不是这个插件做的。由此还有一个验证上的推论：新会话初始模型恰好等于记忆值时，插件不写 `model/selection` 是正确行为；判断是否应用要看首轮 `request/header`。

## 5. 记录 preset 用 `turn/start`，不用 `agent-preset/selected`

复用空白会话时，Host 的 `session/create` 会先用目标预设（未显式指定时就是配置默认预设）重新组装，并在需要时写一条 `agent-preset/selected`（`dsh-api-session-controller/src/agent.ts:404-414`）。如果插件照这条事件记录：

- 打开一个已有空白会话就会覆盖工作区记忆；
- 而且“Host 写入”和“插件应用”之间存在竞态。

正确做法是在 `turn/start` 时读 `agentPresets.presetForSession(session)`，记录**这一轮实际跑的预设**。这样也自然满足“只记录真正用过的预设”的产品语义：只是点了模式但没发消息，不算。

模型则监听 `model/selection`：这是用户每次选模型都会提交的完整选择，且模型切换不会像预设那样在创建时被 Host 重置。

## 6. 默认预设 = 无偏好

`defaultId` 是当前配置默认预设。若某一轮 `turn/start` 时实际运行的就是 `defaultId`，插件把记录的 `agentPreset` 清掉，而不是写入该 id。

原因：默认预设只是一个“当前配置”，会随 Settings 变化。把默认值钉进工作区记忆会让该工作区永远停在旧默认上；清掉字段后，它继续跟随以后的默认值。

这条是产品语义，不是 DSH 的强制行为，但依赖 `presets.defaultId` 与 `presetForSession()` 的稳定语义。

## 7. fork 与子代理判定

- 子代理：`header.origin === 'subagent'`。
- fork：现代 fork 用 `header.isSeeded === true`，通常不带 `parentSession`；旧格式可能仍带 `header.parentSession`。插件把两者都视作 fork。
- 默认两者都跳过；`skipForks: false` 只让 fork 参与，子代理始终不参与。

原因：子代理与 fork 是派生会话，它们的模型策略不应污染原工作区的启动记忆。

## 8. 持久化：`ctx.storageDomain`

插件用 `@deepseek-ai/dsh-storage-domain` 的 `defineDomain` + `domainTable` 声明自己的存储域：

```js
const domainSpec = defineDomain({
  name: 'workspace_launch_defaults',
  version: 1,
  tables: { workspaces: domainTable(recordSchema) },
})
```

关键事实：

- **domain 名同时是 unit 名。** JSON 后端默认 `single` 布局把整个 unit 写成一个 `<name>.json`；基础 profile 把存储根配成 `$DSH_HOME/storages`（`dsh-base/cordis.patch.yml:179-190`），所以默认落盘到 `$DSH_HOME/storages/workspace_launch_defaults.json`。**domain 名不能改名**，否则旧数据不会被读到。
- **表 key 是规范化后的绝对 cwd。** `path.resolve(cwd)`，Windows 上再 `toLowerCase()`。`resolve` 只折叠相对路径和 `..`，不做 `realpath`，所以 symlink 指向同一目录时仍会各自成一份记忆。记录里的 `path` 保留会话创建时的写法，只用于显示。
- **为什么用 cwd 而不是 `workspaceId`。** `session.header.cwd` 在创建会话时稳定且有值；删除 Workspace 注册项不应该丢掉记忆。
- **打开失败要降级。** 文件损坏、domain 版本不匹配或后端不可用时，插件记录一条 warning 并以“无记忆”状态继续运行，不阻塞 DSH 启动。
- **读是内存中的同步读，写是持久化后再返回。** domain 自身有按域的写链；插件再包一层 `writeChain`，把同一 key 的“读-改-写”串行化，避免 preset 与 model 事件相邻到达时互相覆盖。
- 存储域是 Host 侧状态，不写会话日志、不进入模型上下文；插件通过 `ctx.effect()` 在插件卸载时 `domain.close()`。

如果某个 profile 改掉了 storage-json 的路由或布局，上面的默认路径会随之变化；域版本与兼容规则见 `@deepseek-ai/dsh-storage-domain` 的文档。

## 9. 打包与加载：四个裸导入必须列在 `peerDependencies`

以本地目录安装时，Loader 走 **linked layer**。`routeLinked()` 只对**插件自身 `peerDependencies` 里列出的名字**做安装树拦截；`readPeerNames()` 只读这一个字段（`dsh-app-boot/lib/worker/profile-resolution-bootstrap.js:131-138`、`:460-514`）。

因此：

- 必须声明 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-storage-domain`、`zod`。漏掉任何一个，该裸导入会回落到 Node 原生解析并直接 `ERR_MODULE_NOT_FOUND`，插件根本加载不起来。
- **`dependencies` 必须为空。** 真依赖会让包管理器在插件目录下再装一份 cordis / zod，破坏“整个进程共享同一实例”的前提。
- **版本闸门只检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer**，且用 `includePrerelease: true`（`dsh-app-boot/src/plugin-compatibility.ts:51-74`）。所以 `@deepseek-ai/dsh-storage-domain: ">=0.2.0"` 能通过 0.2.2-rc.5；不要用 `~0.2.2` 这类会卡住预发布版的范围。cordis / schemastery / zod 不在闸门内。
- bundle 通过 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者只 `insert` 一行插件行。

## 10. 升级 DSH 后复核清单

DSH 升级后，先复核以下机制，再改插件行为：

1. `SessionCreateRequest` 是否仍然没有 model 字段（`dsh-api-session-controller/src/types.ts`）。
2. `agent/created` 是否仍然 serial、被 await，且发生在会话仍空白、创建响应返回之前（`dsh-agent/src/index.ts`、`dsh-agent-loop/lib/index.js`）。
3. `agentPresets.select()` 的空白判定、签名与默认值语义是否变化（`dsh-agent-preset-registry/src/index.ts`）。
4. `agent.model.select()` 是否仍然只写会话日志、不改全局默认；`session/selectModel` 是否仍然会写全局默认（`dsh-agent/src/model-selection.ts`、`dsh-api-session-controller/src/commands.ts`）。
5. `session/event` 是否仍然派发 `turn/start` 与 `model/selection`，事件数据字段是否变化。
6. `storageDomain.open()` / `domainTable()` 的 API、domain 版本与磁盘布局是否兼容。
7. 版本闸门是否仍然只检查 dsh 系 peer、是否仍接受预发布版；linked layer 是否仍只按 `peerDependencies` 拦截裸导入。
8. 跑 `node test/logic.mjs`；如果它因 API 变化失败，先确认变化点，再决定改测试还是改插件。

## 11. 证据索引

| 源码位置 | 用途 |
|---|---|
| `dsh-api-session-controller/src/types.ts:268-277` | 创建请求字段 |
| `dsh-api-session-controller/src/agent.ts:261-274` | `composeAgent()` 组装预设 |
| `dsh-api-session-controller/src/agent.ts:383-420` | 复用空白会话与空白判定 |
| `dsh-api-session-controller/src/agent.ts:436-461` | 新建会话与 live 模型 getter |
| `dsh-api-session-controller/src/commands.ts:166-184` | `session/selectModel` 写全局默认 |
| `dsh-agent/src/index.ts:551-573` | `agent/created` 的 serial 派发 |
| `dsh-agent-loop/lib/index.js:1582-1611` | 会话/agent 创建顺序 |
| `dsh-agent-preset-registry/src/index.ts:81-91` | `defaultId` / `presetForSession()` |
| `dsh-agent-preset-registry/src/index.ts:364-383` | `agentPresets.select()` |
| `dsh-agent/src/model-selection.ts:112-115` | `agent.model.select()` |
| `dsh-app-boot/lib/worker/profile-resolution-bootstrap.js:131-138,460-514` | linked layer 的 peer 拦截 |
| `dsh-app-boot/src/plugin-compatibility.ts:51-74` | 插件版本闸门 |
| `dsh-base/cordis.patch.yml:179-190` | 存储根与 JSON/domain 后端 |
