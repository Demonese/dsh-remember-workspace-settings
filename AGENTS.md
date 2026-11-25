# dsh-remember-workspace-settings

DeepSeek Harness（DSH）Host 插件：按工作目录记住 Agent 预设与 provider / model / reasoning-effort，并在该工作区下一个空白会话里重新应用。

本文件面向维护者和后续 agent 会话，记录代码地图、不能从代码表面推导的 DSH 平台约束，以及修改后必须执行的验证。用户文档见 [`README.md`](README.md)，设计依据见 [`docs/DESIGN.md`](docs/DESIGN.md)。

> 版本基线：DSH 0.2.2-rc.5。下文的源码引用与行号只对该版本有效；升级 DSH 后先复核这些机制，再改插件行为。

## 文件职责

| 文件 | 作用 |
|---|---|
| `index.js` | 插件的全部逻辑（Service 类默认导出） |
| `package.json` | bundle 清单：`dsh.bundle.patch`、exports、files；`dependencies` 为空，4 个裸导入列在 `peerDependencies`（见结论 9） |
| `cordis.patch.yml` | `insert` 一行 `remember-workspace-settings` |
| `locale/{en,zh}.json` | Plugin Manager 的标题/描述（未声明 `meta.detail`，详情页回落到 README） |
| `icon.svg` | 36×36 图标（文件夹 + 时钟，无文字） |
| `README.md` | 面向用户：安装、用法、配置、数据位置、行为边界 |
| `test/logic.mjs` | 可复跑的逻辑单测（不需要把插件装进 profile） |
| `docs/DESIGN.md` | 设计依据、DSH 机制、边界情况与升级检查清单 |

## 不可重新推导的结论（均已在 DSH 源码中核实）

1. **创建会话没有模型参数。** `SessionCreateRequest` 只有 `workspaceId / cwd / sessionId / agentPreset`（`dsh-api-session-controller/src/types.ts:268-277`）。preset 可在创建时给，模型只能在会话存在后写。
2. **唯一的应用窗口是 `agent/created`。** 它由 `ctx.serial` 派发、被 await，触发时 agent 已在 registry、会话仍空白、客户端还没拿到创建响应。**监听器抛错会让整个会话创建失败** → 整段 try/catch，绝不外抛（`dsh-agent/src/index.ts:551-573`、`dsh-agent-loop/lib/index.js:1582-1611`）。
3. **`agentPresets.select(agent, id)` 只能用于空白会话。** 已开过 turn 抛 `agent-preset/locked`；相同值 no-op；内部按 agent 串行；成功时 append `agent-preset/selected`（`dsh-agent-preset-registry/src/index.ts:364-383`）。空白判定与 registry 一致：`turnBoundaryOf(session).openTurnStartSeq === null && lastTurn === 0`。
4. **`agent.model.select(sel)` 只 append `model/selection`，不动全局默认**（`dsh-agent/src/model-selection.ts:112-115`）。**禁止**改用 `session/selectModel` remote：它会顺手 `agentDefaultModel.saveSelection`，把全局默认改掉（`dsh-api-session-controller/src/commands.ts:178-184`）。
5. **记录 preset 不能用 `agent-preset/selected`。** 复用空白会话时，Host 的 `session/create` 会先用配置默认预设重新组装并写这条事件（`agent.ts:383-414`）；照它记录会覆盖记忆，且写入与应用之间存在竞态。正确做法：在 `turn/start` 读 `presets.presetForSession(session)`，记录"这一轮实际跑的预设"。
6. **默认预设 = 无偏好。** 用默认预设跑的一轮要清掉 `agentPreset` 字段，让该工作区继续跟随 Settings 里默认值的变化，而不是被钉死在旧值。
7. **fork 判定用 `header.isSeeded === true`**（现代 fork 不带 `parentSession`）；子代理是 `header.origin === 'subagent'`。两者都要跳过。
8. **持久化用 `ctx.storageDomain`。** domain `workspace_launch_defaults`、version 1、表 `workspaces`、key = `path.resolve(cwd)`（win32 再小写），落盘 `$DSH_HOME/storages/workspace_launch_defaults.json`（`$DSH_HOME` 默认 `~/.dsh`）。domain 名同时是文件名，**不能改名**。
9. **四个裸导入必须声明为 `peerDependencies`，但 `dependencies` 必须为空。** 以本地目录（Loader 的 **linked layer**）安装时，`routeLinked()` 只对**插件自身 `peerDependencies` 里列出的名字**做安装树拦截（`readPeerNames()` 只读这一个字段），没列出的裸导入会回落到 Node 原生解析并直接 `ERR_MODULE_NOT_FOUND`——插件根本加载不起来。需要声明：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-storage-domain`、`zod`。证据：`dsh-app-boot/lib/worker/profile-resolution-bootstrap.js:131-138`（只读 peerDependencies）、`:460-514`（routeLinked 的 peer 拦截）。
   - **版本闸门只检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer**，且用 `includePrerelease: true`（`dsh-app-boot/src/plugin-compatibility.ts:51-74`）。所以 `@deepseek-ai/dsh-storage-domain: ">=0.2.0"` 能通过 0.2.2-rc.5；**不要**用 `~0.2.2` 这类会卡住预发布版的范围。cordis / schemastery / zod 不在闸门内。
   - 仍不能写 `dependencies`：真依赖会让 pnpm 装出第二份 cordis / zod，破坏"共享安装树里同一实例"的前提。

## 关键实现决定

- 同一 key 的读-改-写串行化（`writeChain`），避免相邻的 preset/model 事件互相覆盖。
- `writeRecord` 把 `undefined` 解释为"删除该字段"；字段全空时删除整条记录，不留空壳。
- `applyPreset` 只在"创建时记录的预设 == 当前配置默认预设"时才覆盖，保护 Creator 等显式指定 `agentPreset` 的流程。
- `applyModel` 先 `llm.resolveCallConfig(target)` 校验（provider 未登录/模型下线/effort 不支持会抛），失败只跳过模型这一半并 warn。
- GUI 的模型选择走 `session/selectModel`，会同时改部署默认（`agentDefaultModel.saveSelection`）。所以"新会话初始模型恰好等于记忆值"时插件不写 `model/selection` 是正确行为，不是没应用；判断是否应用看首轮 `request/header`。
- 日志：`verbose` 默认 false，只输出 warning。

## 已知取舍

- 打开已有空白会话的工作区时，Host 先用默认预设组装一次、插件再切到记忆值 → 多一次预设重挂载。这是 Host 创建路径决定的，Host-only 方案绕不开。
- 预设只按"实际跑过"记录：空白会话里选好模式但没发消息，不会被记住。
- 没有设置页；清除记忆靠编辑 JSON 文件。

## 修改后必须跑的验证

```sh
# 1. 语法
node --check index.js

# 2. 清单 / 文案
node -e "for (const f of ['package.json','locale/en.json','locale/zh.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
# icon.svg 用任意 XML 解析器过一遍

# 3. 逻辑单测（不需要安装插件）
node test/logic.mjs
```

`test/logic.mjs` 用 `module.registerHooks` 把 4 个裸标识符映射到 DSH 安装树的绝对路径，然后 `Object.create(Plugin.prototype)` 注入 fake `ctx` / `table` 调方法，因此可以在未安装状态下验证合并、删除、偏好规则、显式预设让位、模型校验与端到端应用。找不到安装时用 `DSH_INSTALL_DIR` 指定 `@deepseek-ai/dsh` 包目录。

## 发布前检查

- README 的安装、配置、数据位置与当前代码一致。
- `locale/{en,zh}.json` 只描述已实现、已验证的行为。
- `package.json` 的 `files` 覆盖运行所需文件；用 `npm pack --dry-run` 检查实际打包清单。
- 不把本机 profile、用户名、真实 provider/model 或绝对安装路径写进文档与测试默认值。

## 约定

- 与用户交流、README、文档用中文；代码与注释用英文。
- 不自行安装/卸载插件、不改 profile 的 `package.json` / `cordis.patch.yml`；这些由 `plugin_manager` 或用户操作。
- 不向会话日志追加自定义事件类型（DSH 的硬规则）。
- 改 `index.js` 后必须重跑上面三步验证。