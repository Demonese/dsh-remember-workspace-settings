# DeepSeek Harness 探索笔记

> DeepSeek Harness 版本：0.2.2-rc.5

该文档记录该插件依赖的 DeepSeek Harness（以下简称 DSH）平台行为，结论来自 DSH 源码，是插件设计成立的前提。修改插件或升级 DSH 时先读这里。

## DSH 源代码仓库和发行版包

源码核对以源代码仓库下的 `packages/<group>/<package>/src` 为准。

安装树中的 `@deepseek-ai/<package>/src` 是同版本副本，仅供参考，不作为核对依据。

正文与证据索引里的包名简写（如 `dsh-api-session-controller/src/...`）对应源代码仓库下的 `packages/<group>/<package>/src/...`，行号只对该版本有效。

升级 DSH 后需要按 §10 复核。

## 1. 创建会话没有模型参数

`SessionCreateRequest` 只有以下字段（`dsh-api-session-controller/src/types.ts:268-277`）：

| 字段 | 含义 |
|---|---|
| `workspaceId` | 会话加入的 Workspace；与 `cwd` 二选一 |
| `cwd` | 会话拥有的工作目录；未指定 Workspace 时使用 |
| `sessionId` | 可复用的空白会话，或新会话的标识 |
| `agentPreset` | 会话运行的预设；显式指定时会替换复用会话已记录的预设；省略时使用配置默认值 |

没有 `provider` / `model` / `reasoningEffort`。也就是说：**预设可以在创建时指定，模型只能等会话存在之后再写。**

Host 侧的创建路径进一步决定了应用时机：

- **复用进程内空白会话**：`reuseLive()` 检查可复用且仍空白，目标预设与当前不同时直接调用 `presets.select()`；它不调用 `agents.create()` / `agents.resume()`，因此**不会派发 `agent/created`**（`dsh-api-session-controller/src/agent.ts:383-401`）。
- **复用已落盘的空白会话（冷恢复）**：确认日志里没有 `turn/start`（同文件 `:352-362`）后，用 `reuseSetup()` 重新组装；目标预设与记录值不同时 append `agent-preset/selected`（同文件 `:404-414`）；随后的 `agents.resume()` 会派发 `agent/created`。
- **新建会话**：`composeAgent()` 先 `resolve` 预设，setup 先 `installModelSelection` 再 `presets.mount()`（同文件 `:261-274`），会话 meta 带上 `agentPreset`（同文件 `:436-450`）。
- **模型**：`agentOptions()` 用 live getter 读取 `agentDefaultModel.currentSelection()`（同文件 `:453-461`）。在首轮 `request/header` 写入之前，没有记录模型选择的会话跟随全局默认；首轮请求把 selection 记为 `lastUsed` 后固定。

结论：插件必须在 Agent/Session 已存在之后、创建 promise resolve 之前（也就是第一条消息之前）写入模型；新建/冷恢复路径的窗口是下一节的 `agent/created`。live 复用没有这个事件，插件无法在这条路径应用。

## 2. `agent/created` 是新建/冷恢复路径的应用窗口

`agent/created` 由 `ctx.serial` 派发并被 await（`dsh-agent/src/index.ts:551-573`）。它不只属于 `session/create`：`agents.create()` 和 `agents.resume()` 都会走 `initializeAgent()`，在 agent 进入 registry 后 announce；因此新建会话，以及冷恢复（无论空白还是有历史）都会触发（`source` 可能是 `startup` / `resume` 等）。事件本身**不保证**会话仍空白，插件必须自己用 `isBlank` 过滤。

```ts
await this.ctx.serial(entry.carrier, 'agent/created', {
  agent: entry.agent,
  source,
  ...(signal === undefined ? {} : { signal }),
})
```

创建顺序（`dsh-agent-loop/src/index.ts:622-642`，整段包在 `agent.runMaintenance()` 里）：

```text
appendUnstoredSuffix → sessions.enter → sessions.announce → setup(agentCtx)
→ commit → agents.enter → agents.announce('agent/created')
→ runMaintenance 收尾后释放排队输入
```

排队输入的释放发生在 `runMaintenance` 的 finally（`dsh-agent-loop/src/agent.ts:204-225`），不在 `announce` 调用本身。

由此得到四个事实：

1. **触发时 agent 已在 registry 里。** `agents.turnBoundaryOf()`、`agentPresets.select(agent, …)` 都可以用。
2. **监听器是 serial 且被 await。** 新建/冷恢复路径的写入发生在创建 promise resolve 之前；正常客户端拿到 `session/create` 响应时值已改好，随后发送的首条 prompt 不会抢跑。插件仍不能假定所有调用方都等待响应。
3. **监听器抛错会让整个会话创建失败。** 插件的应用逻辑必须整段 try/catch，绝不外抛。
4. **live 复用不会触发 `agent/created`。** 当 `ctx.agents.get(sessionId)` 命中且仍空白时，`session/create` 走 `reuseLive()`，直接返回 live agent（或先 `presets.select()` 到请求/默认预设），不会 `agents.create()` / `agents.resume()`。插件只在 `agent/created` 应用，因此这条路径不会重新应用记忆；Host 的 `presets.select` 还可能把 preset 设成请求/默认预设，该会话首条消息会把 Host 当时的实际值记回工作区，可能覆盖原偏好。

所以“下一个空白会话”必须限定为“下一次新建或冷恢复的空白会话”；live 复用的 preset 由 Host 直接处理，插件无法覆盖，但该会话首条消息会把 Host 当时的实际值记回工作区。其他事件要么 agent 还不存在，要么已经可能有 turn。

## 3. `agentPresets.select()` 只能用于空白会话

`select(agent, agentPreset)`（`dsh-agent-preset-registry/src/index.ts:364-383`）的行为：

- 按 agent 串行（`this.switches`），并发调用天然合流；
- 用 `turnBoundaryOf(session)` 判断空白：`openTurnStartSeq !== null || lastTurn > 0` 时抛 `agent-preset/locked`；
- 目标预设与当前记录的预设、当前 generation 都一致时 no-op，不写事件；
- 否则 `recompose → mount → bind`，再 append `agent-preset/selected`。

空白判定与 Host 创建路径中的 `isBlank()` 一致（`dsh-api-session-controller/src/agent.ts:416-420`）。插件仍然自己先判断空白，避免对已开始的会话发起必然失败的调用；真正决定是否合法的是 registry。

补充：Host 的 `reuseLive()` 也会直接调用 `select()` 把 live blank 切到请求/默认预设；这条路径不经过 `agent/created`，插件不会感知，也不会重新应用记忆。

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

GUI 的模型选择器走 `session/selectModel`，因此它本身会更新全局默认——那是 DSH 的行为，不是这个插件做的。插件应用记忆时只调用 `agent.model.select()`；如果记忆值等于当前选择，就不写事件。记录侧不再依赖 `model/selection`，而是在首条消息的 `turn/start` 读取 `agent.model.current()`，所以“用户没有点过模型选择器、一直跟随全局默认”的工作区也能被记录。

## 5. 记录首条消息用 `turn/start`，不用 `agent-preset/selected` 或 `model/selection`

冷恢复空白会话时，Host 的 `session/create` 会先用目标预设（未显式指定时就是配置默认预设）重新组装，并在需要时写一条 `agent-preset/selected`（`dsh-api-session-controller/src/agent.ts:404-414`）。live 复用则由 `reuseLive()` 直接 `select()` 到请求/默认预设（同文件 `:383-401`）；它不经过 `reuseSetup`/创建期 setup，目标不同时仍由 registry 的 `select` 执行 `recompose → mount`，只是不派发 `agent/created`。如果插件照 `agent-preset/selected` 事件记录：

- 冷恢复或打开一个已有空白会话（且 Host 目标与 recorded preset 不同）就会覆盖工作区记忆；
- live 复用会让 Host 把 preset 设成请求/默认预设；显式指定的非默认 preset 会被保留，插件仍没有应用机会；
- 而且“Host 写入”和“插件应用”之间存在竞态。

正确做法是在 `turn/start` 且 `turn === 1` 时读 `agentPresets.presetForSession(session)` 与 `agent.model.current()`，记录**首条消息实际使用的 preset 和模型**。这样：

- 只是点选模式/模型但没发首条消息，不算；
- 用户没有点过模型选择器、一直跟随全局默认时，也能记录 effective selection；
- 旧会话里再改 preset/model 不会重写工作区记忆；
- 不会把 Host 在冷恢复/live 复用时写入的 `agent-preset/selected` 误当成记录源。

`agent.model.current()` 在没有会话记录时返回 live options（即全局默认），所以“首条消息时实际使用的模型”总能读到；`presetForSession()` 返回实际记录的 preset，包括默认 preset。

## 6. 记录实际 preset（包括默认）

`defaultId` 是当前配置默认 preset；`presetForSession()` 返回会话实际记录的 preset（包括默认值和已从 roster 删除的历史值，`dsh-agent-preset-registry/src/index.ts:81-91`）。插件在首条消息时直接记录这个值，不再把默认值转成“无偏好”。

原因：

- 用户要求“新对话首条消息时把预设存下来”，默认 preset 也是当次实际使用的值；
- 工作区因此会钉住自己的 preset；Settings 改默认不会影响已有记忆的工作区；
- 想跟随新默认，删除该工作区记录，或用新默认重发一条首条消息。

这是产品语义，不是 DSH 的强制行为，依赖 `presetForSession()` 的稳定语义。注意 live 复用会让 Host 把 preset 设成请求/默认预设；插件不会重新应用记忆，该会话首条消息会把 Host 当时的实际值记回工作区（见 §2 事实 4）。

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
- **schema 校验发生在 open/读边界，不在 `put` 写入时。** `storage-domain` 在 `open` 的 `loadAll` 阶段按 zod schema 校验记录；默认（未声明 `invalidRecords`）下，一条 schema-invalid 记录会让整个 domain 打开失败，而不是只丢那一条。插件没有声明 `invalidRecords: 'backup-and-skip'`，所以坏记录会走上面的“无记忆”降级路径。
- **读是内存中的同步读，写是持久化后再返回。** domain 自身有按域的写链；插件再包一层 `writeChain`，把同一 key 的“读-改-写”串行化，避免不同会话的首条消息几乎同时到达时互相覆盖。
- 存储域是 Host 侧状态，不写会话日志、不进入模型上下文；插件通过 `ctx.effect()` 在插件卸载时 `domain.close()`。

如果某个 profile 改掉了 storage-json 的路由或后端，上面的默认路径会随之变化；布局由 domain spec 决定（本插件未设置，默认 `single`），profile 不能改。域版本与兼容规则见 `@deepseek-ai/dsh-storage-domain` 的文档。

## 9. 打包与加载：四个裸导入必须列在 `peerDependencies`

以本地目录安装时，Loader 走 **linked layer**。`routeLinked()` 从插件目录向上逐层读取祖先目录的 `package.json`，命中 `peerDependencies` 即把裸导入拦截到安装树；对本插件的裸导入，插件根 manifest 是最先生效的一份声明，祖先目录若也声明 peer 同样会参与拦截（`dsh-app-boot/src/profile-resolution/resolver.ts:243`、`:636-647`）。

因此：

- 必须声明 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-storage-domain`、`zod`。插件根 manifest 未声明且祖先目录也未声明时，该裸导入才会回落到 Node 原生解析：没有本地副本时直接 `ERR_MODULE_NOT_FOUND`，有本地副本时则可能装出第二份实例，插件加载不起来或共享实例前提被破坏。
- **`dependencies` 不得声明（空对象也会被测试拒绝）。** 真依赖会让包管理器在插件目录下再装一份 cordis / zod，破坏“整个进程共享同一实例”的前提。
- **版本闸门先看 `engines.dsh`，没有才检查 dsh 系 peer。** manifest 自带 `engines.dsh` 时该范围单独决定并忽略 `peerDependencies`；否则遍历 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer，且用 `includePrerelease: true`（`dsh-app-boot/src/plugin-compatibility.ts:51-74`）。本插件没有声明 `engines.dsh`，所以走 peer 分支：`@deepseek-ai/dsh-storage-domain: ">=0.2.0"` 能通过 0.2.2-rc.5；不要用 `~0.2.2` 这类会卡住预发布版的范围。cordis / schemastery / zod 不在闸门内。
- bundle 通过 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者只 `insert` 一行插件行。

## 10. 升级 DSH 后复核清单

DSH 升级后，先复核以下机制，再改插件行为：

1. `SessionCreateRequest` 是否仍然没有 model 字段（`dsh-api-session-controller/src/types.ts`）。
2. `agent/created` 是否仍然 serial、被 await；新建/冷恢复是否派发、resume 是否也会派发、live 复用是否仍然不派发（`dsh-agent/src/index.ts`、`dsh-agent-loop/src/index.ts`、`dsh-api-session-controller/src/agent.ts`）。
3. `agentPresets.select()` 的空白判定、签名与默认值语义是否变化（`dsh-agent-preset-registry/src/index.ts`）。
4. `agent.model.select()` 是否仍然只写会话日志、不改全局默认；`session/selectModel` 是否仍然会写全局默认（`dsh-agent/src/model-selection.ts`、`dsh-api-session-controller/src/commands.ts`）。
5. `session/event` 是否仍然派发 `turn/start`，新会话的 `turn` 是否从 1 开始，以及首轮时 `agent.model.current()` 是否已能返回实际 selection（插件不再依赖 `model/selection` 作为记录源）。
6. `storageDomain.open()` / `domainTable()` 的 API、domain 版本与磁盘布局是否兼容。
7. 版本闸门是否仍然 `engines.dsh` 优先且独占、未声明时才检查 dsh 系 peer、是否仍接受预发布版；linked layer 是否仍按祖先目录的 `peerDependencies` 拦截裸导入。
8. 跑 `node test/logic.mjs`；如果它因 API 变化失败，先确认变化点，再决定改测试还是改插件。
9. `reuseLive()` 是否仍然直接返回 live blank / 直接 `select()`，不派发 `agent/created`；如果 DSH 新增 live 复用事件，插件可以考虑在那里应用记忆。
10. session header 的 `origin` / `isSeeded` / `parentSession` / `cwd` 字段与 fork/subagent 判定是否变化（`dsh-session` 的 header 类型）。
11. `agent.model.current()` 的 live options、`agentDefaultModel.currentSelection()`、首轮 `request/header` 固定 selection 的语义是否变化（`dsh-api-session-controller/src/agent.ts`、`dsh-agent/src/model-selection.ts`）。
12. `resolveCallConfig` 的校验边界（adapter 注册 / 模型信息 / 显式 effort；不查凭证与目录）是否变化（`dsh-llm/src/index.ts`）。
13. storage-domain 的 schema 校验边界、`invalidRecords` 默认行为、single-unit 文件封装（`unit` / `global` / `tables`）是否变化（`dsh-storage-domain`、`dsh-storage-json`）。

## 11. 证据索引

| 源码位置 | 用途 |
|---|---|
| `dsh-api-session-controller/src/types.ts:268-277` | 创建请求字段 |
| `dsh-api-session-controller/src/agent.ts:261-274` | `composeAgent()` 组装预设 |
| `dsh-api-session-controller/src/agent.ts:338-343,383-401` | live blank 复用与 `reuseLive()`（不派发 `agent/created`） |
| `dsh-api-session-controller/src/agent.ts:352-362,404-414` | 冷恢复的 `turn/start` 检查与 `reuseSetup()` |
| `dsh-api-session-controller/src/agent.ts:416-420` | `isBlank()` 空白判定 |
| `dsh-api-session-controller/src/agent.ts:436-461` | 新建会话、meta 与 live 模型 getter |
| `dsh-api-session-controller/src/commands.ts:166-184` | `session/selectModel` 写全局默认 |
| `dsh-api-session-controller/src/commands.ts:415-420` | `requireModel` / `modelAvailable` 目录检查 |
| `dsh-api-session-controller/src/catalog.ts:81-91` | `modelAvailable` 的目录判定 |
| `dsh-agent/src/index.ts:551-573` | `agent/created` 的 serial 派发 |
| `dsh-agent-loop/src/index.ts:622-642` | 会话/agent 创建顺序 |
| `dsh-agent-loop/src/agent.ts:204-225` | `runMaintenance` 收尾释放排队输入 |
| `dsh-agent-preset-registry/src/index.ts:81-91` | `defaultId` / `presetForSession()` |
| `dsh-agent-preset-registry/src/index.ts:364-383` | `agentPresets.select()` |
| `dsh-agent/src/model-selection.ts:105-115` | `agent.model.current()` / `select()` |
| `dsh-llm/src/index.ts:903-923` | `resolveCallConfig()` 的校验边界 |
| `dsh-session/src/types.ts:107-122` | session header 的 origin/isSeeded/parentSession 等字段 |
| `dsh-storage-domain/src/index.ts:119-141`、`domain.ts:166-167,283-301` | `open`/`loadAll` 的 schema 校验与按域写链 |
| `dsh-storage-json/src/format.ts:28-38`、`single-unit.ts:34` | single-unit 文件封装与落盘路径 |
| `dsh-app-boot/src/profile-resolution/resolver.ts:243,636-647` | linked layer 的 peer 拦截 |
| `dsh-app-boot/src/plugin-compatibility.ts:51-74` | 插件版本闸门（`engines.dsh` 优先） |
| `dsh-base/cordis.patch.yml:179-190` | 存储根与 JSON/domain 后端 |

这是一份主要证据索引，不是正文引用的穷举；升级复核时以 §10 的检查项和源码为准。
