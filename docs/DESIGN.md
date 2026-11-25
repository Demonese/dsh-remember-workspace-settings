# 设计说明

本文说明 `dsh-remember-workspace-settings` 为什么这样实现：DSH 的哪些机制决定了插件的形状、最终设计如何落地、哪些边界情况是刻意处理的，以及安装、配置与数据位置。目标读者是想修改行为、移植到新 DSH 版本或审查设计的维护者。

| 文档 | 内容 |
|---|---|
| [项目介绍](../README.md) | 基本功能介绍与文档入口 |
| **设计说明**（本文） | 设计依据、行为边界、安装配置、代码地图与开发约定 |
| [测试与发布](test.md) | 测试原理、运行方式、修改后的验证与发布检查 |
| [DSH 探索笔记](dsh-exploration-notes.md) | 源码核实过的 DSH 平台机制、版本基线与升级复核清单 |

> 版本基线：DSH **0.2.2-rc.5**。DSH 机制与源码证据集中在 [DSH 探索笔记](dsh-exploration-notes.md)，本文只保留设计所需的摘要；升级 DSH 后先按笔记中的清单复核，再改插件行为。

## 1. 问题与目标

在 preset 与模型这两个维度上，DSH 只保留两套**全局**默认，以及每个会话自己的选择记录：

| 维度 | 存储位置 | 作用域 |
|---|---|---|
| 默认 preset | `agent-preset-registry` 行的 `selectedDefault`（写进 profile patch） | 全进程一个 |
| 默认模型 | `agent-default-model` 行的 `provider / model / reasoningEffort` | 全进程一个 |
| 单会话 preset | 会话日志的 `agent-preset/selected` | 单个会话 |
| 单会话模型 | 会话日志的 `model/selection` | 单个会话 |

两个细节决定了需求的形状：

1. **换模型会顺手改全局默认。** GUI 的模型选择走 `session/selectModel`，它在记录会话选择之后还会后台调用 `agentDefaultModel.saveSelection(selected)`。所以“上次用的模型”确实被记住了，但记住的是**全局**的：在 A 工作区换了模型，B 工作区的新会话也会跟着用。
2. **换 preset 不会改全局默认。** UI 上换模式只写会话日志，`selectedDefault` 只在 Settings 里改。所以新会话永远回到配置里的那个默认 preset。

目标因此是：把这两套全局记忆降维成**按工作目录**的记忆，并补上 preset 那条缺失的路径。

设计原则：

- 记忆属于工作目录，不属于会话或整个部署；
- 只记录真正发生过的选择，不记录“可能想用”的状态；
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
│  remember:  session/event ── turn/start ────────→ 读 presetForSession          │
│             session/event ── model/selection ───→ provider/model/effort        │
│                              └───────────────→ put(key, mergedRecord)          │
│                                                                               │
│  recall:    agent/created ── 空白 && 非 subagent && 非 fork                     │
│                 ├─ agentPresets.select(agent, 记忆 preset)（当前为默认/未记录时）│
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

## 3. DSH 机制依据

下表是设计所依赖的平台事实。完整源码位置与调用链见 [DSH 探索笔记](dsh-exploration-notes.md)，这里只列结论和对插件的约束。

| 机制 | 结论 | 对设计的约束 |
|---|---|---|
| 会话创建请求 | 只有 `workspaceId / cwd / sessionId / agentPreset`，没有模型字段 | preset 可在创建时给；模型只能在 `agent/created` 之后写 |
| `agent/created` | serial、被 await，发生在 agent 已进入 registry、会话仍空白、创建响应返回之前 | 这是唯一安全的应用窗口；监听器抛错会让整个会话创建失败，必须整段 catch |
| `agentPresets.select()` | 只能用于空白会话；相同值 no-op；按 agent 串行；成功时 append `agent-preset/selected` | 可以安全地重复应用记忆；已开始的会话由 registry 拒绝 |
| `agent.model.select()` | 只 append `model/selection`，不改全局默认 | 应用模型用这个低层写入，不能用 `session/selectModel` |
| `turn/start` | 记录这一轮实际运行的 preset 的可靠时机 | 记录 preset 用 `turn/start`，不用创建阶段的 `agent-preset/selected` |
| `ctx.storageDomain` | 提供 schema 校验、同步读、持久写和按域写链 | 插件用独立 domain 存记忆；记忆本身不写会话日志、不进入模型上下文 |
| 会话 header | 子代理 `origin === 'subagent'`；fork 用 `isSeeded`（旧格式可能带 `parentSession`） | 子代理始终跳过，fork 默认跳过 |
| linked layer | 裸导入只有列在插件自身 `peerDependencies` 里才会被安装树拦截 | 四个运行时包必须列 peer，`dependencies` 必须为空 |

## 4. 关键实现决定

- **同一 key 的读-改-写串行化（`writeChain`）。** 预设事件和模型事件可能几乎同时到达；串行化避免两次读拿到同一份旧记录、后写覆盖先写。写链失败只 warn，不阻断后续写入。
- **`undefined` 表示删除字段。** 清除推理强度会回到适配器默认；清除预设表示“没有偏好”。字段全空时删除整条记录，不留空壳。
- **默认预设 = 无偏好。** 用默认预设跑的一轮清掉 `agentPreset`，让工作区继续跟随 Settings 里默认值的变化，而不是被钉死在旧值。
- **显式预设让位。** 创建请求显式点名了非默认 preset（Creator 等流程）时，`applyPreset` 不覆盖；只有“按默认创建”的会话才套用记忆值。没有记录预设的会话会接受记忆值。
- **模型先解析调用配置再写。** `llm.resolveCallConfig(target)` 只验证 provider 有已注册 adapter、模型信息可解析、显式 reasoning effort 被支持；它不检查登录凭证或目录可选性（`session/selectModel` 才额外做 `requireModel` / `modelAvailable`）。失败只跳过模型这一半并 warn。
- **不写重复事件。** 应用前先比 `agent.model.current()`；记录时比较除 `updatedAt` 外的字段。注意 `agent.model.select` 只和已记录值比较，没有记录时会无条件 append，所以应用侧的去重必须自己做。
- **绝不改全局默认。** 只调用 `agent.model.select()`；`session/selectModel` 会顺手 `agentDefaultModel.saveSelection`，禁止使用。
- **绝不外抛。** `agent/created` 的监听器抛错会让整个会话创建失败，所以应用逻辑整段捕获；`session/event` 的记录逻辑同样捕获，坏记录不能影响正在进行的对话。
- **跳过子代理与 fork。** 子代理的模型策略不应污染工作区记忆；fork 默认跳过（`skipForks` 可关）。
- **日志分级。** `verbose` 默认 false，只输出 warning；排查时可打开，查看每次应用/记录的具体值。

## 5. 边界情况与已知取舍

| 场景 | 行为 | 依据 |
|---|---|---|
| 子代理会话 | 既不记录也不应用 | `header.origin === 'subagent'` |
| fork 会话 | 默认跳过；`skipForks: false` 时参与 | `header.isSeeded === true`（现代 fork）或 `parentSession` |
| 打开有历史的会话 | 不应用 | `openTurnStartSeq === null && lastTurn === 0` |
| 复用同一个空白会话 | 重复应用同一值 → 无副作用 | `presets.select` 与 `model.select` 的相等判定 |
| 记忆里的 preset 被删/改名 | 保留当前预设，warn | `select` 抛 `agent-preset/not-found` / `invalid` |
| 模型没有 adapter / 元信息不可用 / effort 不支持 | 只跳过模型，preset 照常 | `resolveCallConfig` 抛错 |
| provider 未登录 / 模型不在目录中 | 不保证拦截；可能先应用，真实请求时才失败 | 这里只调 `resolveCallConfig`，不做 `requireModel` / `modelAvailable` |
| 用户在空白会话里手动改 preset/model | 模型立即记录；预设在下一轮 `turn/start` 记录 | `turn/start` 与 `model/selection` 都会进 remember |
| 多窗口 / 多进程同时写 | 同进程内单一写链；跨进程后写覆盖 | JSON 存储后端是单进程写链 |
| 工作区改名/移动 | 变成一份新记忆，旧记录保留 | 按 cwd 作 key 的固有限制 |
| 目录大小写差异 | Windows 下键转小写 | `workspaceKey()` |
| symlink 指向同一目录 | 不做 `realpath`，按传入 cwd 的绝对路径分别记忆 | `workspaceKey()` |
| git worktree | 每个 worktree 各自一份记忆 | worktree 的 cwd 不同 |
| 首次应用的重挂载 | 一次额外 mount/unmount，通常只表现为“打开稍慢” | 发生在 creation resolve 前 |
| 插件自身抛错 | 不影响会话创建 | 全量 try/catch |
| 存储文件损坏 / 版本不匹配 | 记录 warning，以“无记忆”状态继续 | `storageDomain.open()` 失败被捕获 |

其中需要特别理解的取舍：

- **会多一次组合挂载。** 按默认预设打开一个已有空白会话的工作区时，Host 会先用默认预设组装它，插件随后切到记忆值，因此比不用插件多一次预设重挂载（空白会话上成本很小）。这是 Host 创建路径决定的，Host-only 方案绕不开。
- **预设只按“实际跑过”记录。** 空白会话里选好模式但没发消息，不会被记住。这是有意的：记忆应当反映真实使用，而不是界面上的临时状态。
- **模型没有“创建时参数”。** 应用时机是会话刚创建、尚未开始。正常客户端等待 `session/create` 响应后才发第一条消息，此时应用已经完成；只有绕过创建响应、在创建尚未 resolve 时直接用同一 sessionId 发消息的流程才理论上有窗口。
- **GUI 的模型选择会改全局默认。** 这是 `session/selectModel` 的行为；插件自身不改。因此“新会话初始模型恰好等于记忆值”时没有写入事件是正常现象。
- **没有设置页。** 查看/清除记忆需要直接编辑存储 JSON；清除后该工作区回到全局默认。
- **Creator 的连带效果。** 在某个工作区用 Creator 模式跑过一轮后，该工作区下次新建会话也会是 Creator 模式——这就是“上次使用”的语义；切回默认预设跑一轮即可清除该偏好。

## 6. 安装、配置与数据

### 6.1 安装

需要一台安装了 DSH 的机器，以及提供 `storageDomain` Service 的 DSH 版本（开发时使用 0.2.2-rc.5；peer 要求 `@deepseek-ai/dsh-storage-domain >= 0.2.0`）。

1. 克隆或下载本仓库到任意目录。
2. 在 DSH Web GUI 打开 **Plugins** 页，选择 **Add plugin**，指向本仓库目录；或者让 agent 调用 `plugin_manager` 的 `install_bundle`，`target` 填本目录的绝对路径。
3. 安装后新建会话即可生效；已经打开的会话不会被改动。

这是一个 Host-only bundle：没有 client 半、没有构建步骤，也不需要先安装依赖。首次安装通常无需重启；升级时用同一入口安装更新后的目录，若 Plugins 页提示需要重启，按提示操作。卸载在 Plugins 页移除 bundle，已保存的记忆不会自动删除。

### 6.2 用法与验证

装好即生效，不需要任何界面操作：正常地在 Web GUI 里换模式、换模型即可。想让它消失，停用插件即可（已保存的值会保留）。

验证方法：

1. 在 A 工作区把模型换成 X、模式换成 P，**并发送一条消息**（预设以“实际跑过一轮”为准）；
2. 在 A 工作区新建会话 → 应直接是 P + X；
3. 切到 B 工作区新建会话 → 应仍是 B 自己的选择，或全局默认。

### 6.3 配置

在 **Plugins** 页找到 `remember-workspace-settings` 行，或直接编辑 profile 的 `cordis.patch.yml` 里该行的 `config`：

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后既不记录也不应用 |
| `applyPreset` | `true` | 是否把记忆的预设应用到空白会话 |
| `applyModel` | `true` | 是否把记忆的模型/推理强度应用到空白会话 |
| `rememberPreset` | `true` | 是否把“实际运行的预设”记入工作区记忆 |
| `rememberModel` | `true` | 是否把模型变更记入工作区记忆 |
| `skipForks` | `true` | fork 出来的会话不参与（既不应用也不记录） |
| `verbose` | `false` | 每次应用/记录都写一条 info 日志（排查时打开） |

示例：

```yaml
- insert:
    - id: remember-workspace-settings
      name: dsh-remember-workspace-settings
      config:
        verbose: true
```

### 6.4 数据位置与重置

```text
$DSH_HOME/storages/workspace_launch_defaults.json
```

`$DSH_HOME` 默认是 `~/.dsh`（Windows 上是 `%USERPROFILE%\.dsh`），可以用 `DSH_HOME` 环境变量覆盖。

一个工作目录一条记录：

```json
{
  "path": "/home/you/projects/demo",
  "agentPreset": "ptc",
  "provider": "your-provider",
  "model": "your-model",
  "reasoningEffort": "high",
  "updatedAt": 1764000000000
}
```

存储键是规范化后的绝对工作目录：`path.resolve(cwd)`，Windows 上再转小写；记录里的 `path` 保留会话创建时的写法，便于阅读。

**重置某个工作区**：停掉 DSH，删除该 JSON 里对应的键（或整个文件），再启动。文件损坏或版本不匹配时，插件会记录一条 warning 并以“无记忆”状态继续运行，不会阻塞 DSH 启动。

## 7. 打包与加载

这是一个 **Host-only bundle**：没有 client 半、没有构建步骤、没有安装脚本。`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 只 `insert` 一行。

运行时包由 DSH 安装树提供：4 个裸导入必须列在插件自己的 `peerDependencies` 里，`dependencies` 必须为空；否则 linked layer 可能解析不到，或装出第二份 cordis / zod。版本闸门与源码依据见 [DSH 探索笔记](dsh-exploration-notes.md) 第 9 节。

## 8. 代码地图与开发约定

### 8.1 文件职责

| 文件 | 作用 |
|---|---|
| `index.js` | 插件的全部逻辑（Service 类默认导出） |
| `package.json` | bundle 清单：`dsh.bundle.patch`、exports、files；`dependencies` 为空，4 个裸导入列在 `peerDependencies` |
| `cordis.patch.yml` | 安装时 `insert` 一行 `remember-workspace-settings` |
| `locale/{en,zh}.json` | Plugin Manager 的标题/描述（未声明 `meta.detail`，详情页回落到 README） |
| `icon.svg` | 36×36 图标（文件夹 + 时钟，无文字） |
| `README.md` | 面向用户的基本功能介绍与文档入口 |
| `AGENTS.md` | 维护者/agent 会话的文档索引 |
| `docs/DESIGN.md` | 设计依据、行为边界、安装配置与开发约定 |
| `docs/test.md` | 测试原理、验证步骤与发布检查 |
| `docs/dsh-exploration-notes.md` | DSH 平台机制、源码证据与升级复核清单 |
| `test/logic.mjs` | 可复跑的逻辑单测（不需要把插件装进 profile） |
| `LICENSE` | MIT 许可证 |

### 8.2 开发约定

- 与用户交流、README、文档用中文；代码与注释用英文。
- 不自行安装/卸载插件、不改 profile 的 `package.json` / `cordis.patch.yml`；这些由 `plugin_manager` 或用户操作。
- 不向会话日志追加自定义事件类型（DSH 的硬规则）。
- 不修改 storage domain 名 `workspace_launch_defaults`；它同时是磁盘 unit 名。
- 改 `index.js` 后必须按 [测试与发布](test.md) 执行验证。
- README 只保留基本功能介绍；设计、测试、DSH 机制分别落在对应文档，避免内容回流和重复。
- 不把本机 profile、用户名、真实 provider/model 或绝对安装路径写进文档与测试默认值。
- `locale/{en,zh}.json` 只描述已实现、已验证的行为。

## 9. 升级与维护

- 升级 DSH 后，先按 [DSH 探索笔记](dsh-exploration-notes.md) 第 10 节逐项复核，不要假设旧 API 语义仍然成立。
- 运行 `node test/logic.mjs`；如果因 API 变化失败，先确认变化点，再决定改测试还是改插件。
- 行为变化时同步更新本文件、[测试与发布](test.md)、README 的功能描述与 `locale` 文案。
- 发布前按 [测试与发布](test.md) 的检查清单核对安装、配置、数据位置与打包内容。
