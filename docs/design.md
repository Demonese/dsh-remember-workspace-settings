# 设计说明

本文说明 `dsh-remember-workspace-settings` 为什么这样实现：DSH 的哪些机制决定了插件的形状、最终设计如何落地、哪些边界情况是刻意处理的，以及代码地图与开发约定。安装、配置与数据位置见 [安装、配置与数据](install-and-config.md)。目标读者是想修改行为、移植到新 DSH 版本或审查设计的维护者。

| 文档 | 内容 |
|---|---|
| [项目介绍](../README.md) | 基本功能介绍与文档入口 |
| [安装、配置与数据](install-and-config.md) | 安装步骤、用法验证、配置项、数据位置与重置 |
| **设计说明**（本文） | 设计依据、行为边界、代码地图与开发约定 |
| [测试与发布](test.md) | 测试原理、运行方式、修改后的验证与发布检查 |
| [DSH 探索笔记](dsh-exploration-notes.md) | 源码核实过的 DSH 平台机制、版本基线与升级复核清单 |

> 版本基线：DSH **0.2.2-rc.5**（源码复核基线：release merge `9c2670d`）。DSH 机制与源码证据集中在 [DSH 探索笔记](dsh-exploration-notes.md)，本文只保留设计所需的摘要；升级 DSH 后先按笔记中的清单复核，再改插件行为。

## 1. 问题与目标

在 preset 与模型这两个维度上，DSH 只保留两套**全局**默认，以及每个会话自己的选择记录：

| 维度 | 存储位置 | 作用域 |
|---|---|---|
| 默认 preset | `agent-preset-registry` 行的 `selectedDefault`（写进 profile patch） | 全进程一个 |
| 默认模型 | `agent-default-model` 行的 `provider / model / reasoningEffort` | 全进程一个 |
| 单会话 preset | 会话日志的 `agent-preset/selected` | 单个会话 |
| 单会话模型 | 会话日志的 `model/selection`；没有记录时由 `agentOptions` 提供全局默认 | 单个会话（无记录时跟随全进程默认） |

两个细节决定了需求的形状：

1. **换模型会顺手改全局默认。** GUI 的模型选择走 `session/selectModel`，它在记录会话选择之后还会后台调用 `agentDefaultModel.saveSelection(selected)`。所以“上次用的模型”确实被记住了，但记住的是**全局**的：在 A 工作区换了模型，B 工作区的新会话也会跟着用。
2. **换 preset 不会改全局默认。** UI 上换模式只写会话日志，`selectedDefault` 只在 Settings 里改。所以在没有本插件时，未显式指定 preset 的新会话会回到配置里的那个默认 preset；显式指定的非默认 preset 仍按请求运行。

目标因此是：在**新对话发送第一条用户消息时**，把该对话实际使用的 preset 与 model（provider + model + reasoning effort）记到工作目录；下次在同一工作目录新建或冷恢复空白会话时，再应用这组值。默认 preset 和全局默认模型同样是“实际使用”的值，也要记录。

设计原则：

- 记忆属于工作目录，不属于会话或整个部署；
- 以新对话首条消息实际使用的值为准，包括默认 preset 和当前生效的全局默认模型；同一会话后续再改 preset/model 不重写工作区记忆；
- 只改尚未开始对话的会话，不干扰进行中的对话；
- 只使用 DSH 正常的会话事件与 Service API，不追加自定义事件类型；
- 任何失败都降级处理，绝不阻塞会话创建。

## 2. 设计概览

```text
┌──────────────────── Host 插件 remember-workspace-settings ────────────────────┐
│                                                                               │
│  storageDomain("workspace_launch_defaults")                                   │
│      └─ table("workspaces")  key = 规范化 cwd                                  │
│                                                                               │
│  remember:  session/event ── turn/start（turn === 1）                           │
│                 ├─ presetForSession                                              │
│                 ├─ agent.model.current()                                        │
│                 └─ put(key, mergedRecord)                                       │
│                                                                               │
│  recall:    agent/created ── 空白 && 非 subagent && 非 fork                     │
│                 ├─ agentPresets.select(agent, 记忆 preset)（当前为默认/未记录时）│
│                 └─ resolveCallConfig → agent.model.select(记忆 selection)      │
└───────────────────────────────────────────────────────────────────────────────┘
```

图中的 recall 只覆盖新建/冷恢复路径；live blank 复用不派发 `agent/created`，不会进入 recall。remember 只记录新会话的 `turn/start`（`turn === 1`）；live 复用后的首轮也会被记录，见 §5。

记录形状：

```js
{
  path: '/home/you/projects/demo',   // 显示用，保留会话创建时的写法
  agentPreset: 'ptc',                // 首条消息实际使用的 preset；可能是默认 preset
  provider: 'your-provider',         // 与 model 成对出现；没有可读 selection 时缺失
  model: 'your-model',
  reasoningEffort: 'high',           // 可选
  updatedAt: 1764000000000,          // epoch ms
}
```

应用顺序是先 preset、后 model；两半各自 try/catch，一半失败不影响另一半。

## 3. DSH 机制依据

下表是设计所依赖的平台事实。完整源码位置与调用链见 [DSH 探索笔记](dsh-exploration-notes.md)，这里只列结论和对插件的约束。

| 机制 | 结论 | 对设计的约束 |
|---|---|---|
| 会话创建请求 | 只有 `workspaceId / cwd / sessionId / agentPreset`，没有模型字段 | preset 可在创建时给；模型只能在会话存在之后写 |
| `agent/created` | serial、被 await；新建和冷恢复时在 agent 进入 registry 后、创建响应返回前触发；冷恢复有历史的会话（`agents.resume`）也会触发，事件本身不保证空白 | 新建/冷恢复路径的应用窗口；监听器必须自行用 `isBlank` 过滤（冷恢复的历史会话可能已有 turn）；抛错会让整个创建失败，必须整段 catch |
| `agentPresets.select()` | 只能用于空白会话；相同值 no-op；按 agent 串行；成功时 append `agent-preset/selected` | 可以安全地重复应用记忆；已开始的会话由 registry 拒绝 |
| `agent.model.select()` | 只 append `model/selection`，不改全局默认 | 应用模型用这个低层写入，不能用 `session/selectModel` |
| `agentPresets.presetForSession()` | 返回会话实际记录的 preset，包括默认 preset | 首条消息按这个值记录，不再把默认值转换成“无偏好” |
| `agent.model.current()` | 返回会话已记录的模型选择；没有记录时返回 live options（即全局默认） | 首条消息记录“实际生效”的 provider/model/effort，包括跟随全局默认的情况 |
| `turn/start` | 新会话的 `turn === 1` 时，preset 已确定，模型选择也已可读 | 记录首条消息用 `turn/start`，只处理 `turn === 1`；不用 `model/selection` 或 `agent-preset/selected` 作为记录源 |
| `ctx.storageDomain` | 提供 schema 校验、同步读、持久写和按域写链 | 插件用独立 domain 存记忆；记忆本身不写会话日志、不进入模型上下文 |
| 会话 header | 子代理 `origin === 'subagent'`；fork 用 `isSeeded`（旧格式可能带 `parentSession`） | 子代理始终跳过，fork 默认跳过 |
| linked layer | 从插件目录向上逐层读取 `peerDependencies`，命中即拦截到安装树；插件自身 manifest 的声明是实际生效的那一份 | 四个运行时包必须列 peer，`dependencies` 不得声明（空对象也会被测试拒绝） |

## 4. 关键实现决定

- **同一 key 的读-改-写串行化（`writeChain`）。** 不同会话的首条消息可能几乎同时到达；串行化避免两次读拿到同一份旧记录、后写覆盖先写。写链失败只 warn，不阻断后续写入。
- **首条消息一次性记录 preset 与 model。** 只在 `turn/start` 且 `turn === 1` 时读 `presetForSession()` 与 `agent.model.current()`，把两半合并成一次 `put`；首条消息之后再改 preset/model 不重写工作区记忆。
- **记录实际值，包括默认值。** 默认 preset 和跟随全局默认的模型都是新对话实际使用的值，照常写入。这样工作区会“钉住”当次首条消息的选择；Settings 里改默认 preset/模型不会影响已经有记忆的工作区。
- **`undefined` 表示未知或“无显式 effort”。** 首条消息时如果读不到 preset/model（例如没有 preset roster、agent 不可用），只跳过对应的一半，不用 `undefined` 去清掉旧记录；如果读到了 model 但 `reasoningEffort` 缺失，表示回到适配器默认，写入时清掉旧 effort。`writeRecord` 仍保留“显式 undefined 删除字段”的内部语义。
- **显式预设让位（仅限非默认）。** 创建请求显式点名了非默认 preset（Creator 等流程）时，`applyPreset` 不覆盖；显式点名默认 preset 与按默认创建在 header/projection 上不可区分，仍会被记忆覆盖；运行时没有记录 preset 的会话会接受记忆值。该会话首条消息会把实际运行的 preset 记回工作区。
- **模型先比当前选择，再解析调用配置，最后写。** 相同选择直接跳过（连校验也不做）；不同选择才通过 `llm.resolveCallConfig(target)` 验证 provider 有已注册 adapter、模型信息可解析、显式 reasoning effort 被支持；它不检查登录凭证或目录可选性（`session/selectModel` 才额外做 `requireModel` / `modelAvailable`）。失败只跳过模型这一半并 warn。
- **不写重复事件。** 应用前先比 `agent.model.current()`；记录时比较除 `updatedAt` 外的字段。注意 `agent.model.select` 只和已记录值比较，没有记录时会无条件 append，所以应用侧的去重必须自己做。
- **绝不改全局默认。** 只调用 `agent.model.select()`；`session/selectModel` 会顺手 `agentDefaultModel.saveSelection`，禁止使用。
- **绝不外抛。** `agent/created` 的监听器抛错会让整个会话创建失败，所以应用逻辑整段捕获；`session/event` 的记录逻辑同样捕获，坏记录不能影响正在进行的对话。
- **跳过子代理与 fork。** 子代理的模型策略不应污染工作区记忆；fork 默认跳过（`skipForks` 可关）。
- **日志分级。** `verbose` 默认 false，只输出 warning；排查时可打开，查看每次应用/记录的具体值。

## 5. 边界情况与已知取舍

本节把“复用”分成两种：**冷恢复**（会话已落盘、当前进程没有 live agent，重新打开时走 `agents.resume`）和 **live 复用**（进程内仍存活的空白会话被 `session/create` 直接拿回）。

| 场景 | 行为 | 依据 |
|---|---|---|
| 子代理会话 | 既不记录也不应用 | `header.origin === 'subagent'` |
| fork 会话 | 默认跳过；`skipForks: false` 时参与 | `header.isSeeded === true`（现代 fork）或 `parentSession` |
| 打开有历史的会话 | 不应用 | 仅当 `openTurnStartSeq === null && lastTurn === 0`（空白）时应用；有历史时该条件为假 |
| 复用已落盘的空白会话（冷恢复） | 按 §4 规则重新应用记忆（显式非默认请求除外）；重复应用同一值 → 无副作用 | `agents.resume` → `agent/created`；`presets.select` 与 `model.select` 的相等判定 |
| 复用进程内仍存活的空白会话（live） | Host 直接 `presets.select` 到请求/默认值，不触发 `agent/created`；插件不重新应用记忆。该会话首条消息会把 Host 当时的实际 preset/model 记回工作区，可能覆盖原偏好 | `reuseLive()`；见探索笔记 §1/§2 |
| 记忆里的 preset 被删/改名 | 保留当前预设，warn | `select` 抛 `agent-preset/not-found` / `invalid` |
| 模型没有 adapter / 元信息不可用 / effort 不支持 | 只跳过模型，preset 照常 | `resolveCallConfig` 抛错 |
| provider 未登录 / 模型不在目录中 | 不保证拦截；可能先应用，真实请求时才失败 | 这里只调 `resolveCallConfig`，不做 `requireModel` / `modelAvailable` |
| 用户在空白会话里手动改 preset/model | 随首条消息一起记录；首条消息之后再改不重写工作区记忆 | `turn/start`（`turn === 1`）读取 `presetForSession()` 与 `agent.model.current()` |
| Settings 修改全局默认 preset/model | 已有记忆的工作区继续用记忆值；没有记忆的工作区用新默认 | 记录的是首条消息实际值 |
| 多窗口 / 多进程同时写 | 同进程内单一写链；跨进程没有文件锁，后写者按整份内存快照重写 unit 文件，可能覆盖其他进程的写入/删除 | storage-domain 的按域写链只在进程内；storage-json 只做原子整文件替换 |
| 工作区改名/移动 | 变成一份新记忆，旧记录保留 | 按 cwd 作 key 的固有限制 |
| 目录大小写差异 | Windows 下键转小写 | `workspaceKey()` |
| symlink 指向同一目录 | 不做 `realpath`，按传入 cwd 的绝对路径分别记忆 | `workspaceKey()` |
| git worktree | 每个 worktree 各自一份记忆 | worktree 的 cwd 不同 |
| 首次应用的重挂载（新建/冷恢复） | 记忆 preset 存在且与 Host 目标不同时多一次 mount/unmount；没有 preset 记忆或值相同（包括记忆默认 = Host 默认）时为 0 | 发生在 creation resolve 前；live 复用不触发插件 |
| 插件自身抛错 | 不影响会话创建 | 全量 try/catch |
| 存储文件损坏 / 版本不匹配 / 记录不符合 schema | 记录 warning，以“无记忆”状态继续 | `storageDomain.open()` 失败被捕获；默认不跳过坏记录 |

其中需要特别理解的取舍：

- **会多一次组合挂载。** 当记忆里确实有 preset、且与 Host 当前目标不同时，按默认预设冷恢复一个已有空白会话会先用默认预设组装它，插件随后切到记忆值，因此比不用插件多一次预设重挂载（空白会话上成本很小）。这是 Host 创建路径决定的，Host-only 方案绕不开。live 复用不触发 `agent/created`，不会发生这次插件侧重挂载；没有 preset 记忆或值相同时也不会有额外重挂载。
- **首条消息时记录实际 preset，包括默认 preset。** 空白会话里选好模式但没发消息，不会被记住；首条消息之后再改 preset/model 也不会重写工作区记忆。工作区因此会“钉住”其最近一次新对话首条消息使用的值；Settings 改全局默认不会再影响已有记忆的工作区，想跟随新默认需删除该工作区记录或用新默认重发一条首条消息。
- **模型没有“创建时参数”。** 应用时机是会话刚创建、尚未开始。正常客户端等待 `session/create` 响应后才发第一条消息，此时新建/冷恢复路径的应用已经完成；live 复用不派发 `agent/created`，插件不会重新应用。只有绕过创建响应、在创建尚未 resolve 时直接用同一 sessionId 发消息的流程才理论上有窗口。
- **GUI 的模型选择会改全局默认。** 这是 `session/selectModel` 的行为；插件自身不改。工作区记忆在首条消息时已经记下实际模型（包括当时跟随的全局默认），所以下一次新建/冷恢复会应用记忆；已有记忆的工作区不再被其他工作区换模型影响。没有记忆的工作区（还没发过首条消息）仍跟随全局默认。
- **live 复用可能覆盖记忆。** Host 在 `reuseLive()` 里可能先把 blank 会话的 preset 切到请求/默认值；插件不会重新应用记忆，该会话首条消息会把 Host 当时的值记回工作区。也就是说，打开一个未发消息的空白会话后如果 Host 重置了 preset，再发首条消息会把原工作区偏好覆盖。这个路径没有 `agent/created`，Host-only 方案无法可靠区分“Host 重置”和“用户主动选择”。
- **没有设置页。** 查看/清除记忆需要直接编辑存储 JSON（见[数据位置与重置](install-and-config.md#4-数据位置与重置)）；清除后该工作区回到全局默认。
- **Creator 的连带效果。** 在某个工作区用 Creator（`cordis`）新对话并发首条消息后，该工作区下次新建或冷恢复的空白会话也会是 Creator 模式——这是“最近一次新对话首条消息”的语义；要切回，用目标 preset 新建对话并发首条消息，而不是在旧会话里改。若该空白仍是 live 会话并被再次复用，Host 可能先切到请求/默认预设，首条消息会把该值记回。

## 6. 打包与加载

这是一个 **Host-only bundle**：没有 client 半、没有构建步骤、没有安装脚本。`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 只 `insert` 一行。

运行时包由 DSH 安装树提供：本插件的 4 个裸导入必须列在插件自己的 `peerDependencies` 里，`dependencies` 不得声明（空对象也会被测试拒绝）；否则 linked layer 可能解析不到，或装出第二份 cordis / zod。版本闸门与源码依据见 [DSH 探索笔记](dsh-exploration-notes.md) 第 9 节。

## 7. 代码地图与开发约定

### 7.1 文件职责

| 文件 | 作用 |
|---|---|
| `index.js` | 插件的全部逻辑（Service 类默认导出） |
| `package.json` | bundle 清单：`dsh.bundle.patch`、exports、files；未声明 `dependencies`，4 个裸导入列在 `peerDependencies` |
| `cordis.patch.yml` | 安装时 `insert` 一行 `remember-workspace-settings` |
| `locale/{en,zh}.json` | Plugin Manager 的标题/描述（未声明 `meta.detail`，详情页回落到 README） |
| `icon.svg` | 36×36 图标（文件夹 + 时钟，无文字） |
| `README.md` | 面向用户的基本功能介绍与文档入口 |
| `AGENTS.md` | 维护者/agent 会话的文档索引 |
| `docs/design.md` | 设计依据、行为边界、代码地图与开发约定 |
| `docs/install-and-config.md` | 安装步骤、用法验证、配置项、数据位置与重置 |
| `docs/test.md` | 测试原理、验证步骤与发布检查 |
| `docs/dsh-exploration-notes.md` | DSH 平台机制、源码证据与升级复核清单 |
| `test/logic.mjs` | 可复跑的逻辑单测（不需要把插件装进 profile） |
| `LICENSE` | MIT 许可证 |

### 7.2 开发约定

- 与用户交流、README、文档用中文；代码与注释用英文。
- 不自行安装/卸载插件、不改 profile 的 `package.json` / `cordis.patch.yml`；这些由 `plugin_manager` 或用户操作。
- 不向会话日志追加自定义事件类型（DSH 的硬规则）。
- 不修改 storage domain 名 `workspace_launch_defaults`；它同时是磁盘 unit 名。
- 改 `index.js` 后必须按 [测试与发布](test.md) 执行验证。
- README 只保留基本功能介绍；设计、安装配置、测试、DSH 机制分别落在对应文档，避免内容回流和重复。
- 不把本机 profile、用户名、真实 provider/model 或绝对安装路径写进文档与测试默认值。
- `locale/{en,zh}.json` 只描述已实现、已验证的行为。

## 8. 升级与维护

- 升级 DSH 后，先按 [DSH 探索笔记](dsh-exploration-notes.md) 第 10 节逐项复核，不要假设旧 API 语义仍然成立。
- 运行 `node test/logic.mjs`；如果因 API 变化失败，先确认变化点，再决定改测试还是改插件。
- 行为变化时同步更新本文件、[安装、配置与数据](install-and-config.md)、[测试与发布](test.md)、README 的功能描述与 `locale` 文案。
- 发布前按 [测试与发布](test.md) 的检查清单核对[安装、配置与数据](install-and-config.md)与打包内容。
