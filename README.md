# dsh-remember-workspace-settings

按工作目录记住上次**实际使用**的 Agent 预设，以及最后一次选择的 **provider / model / reasoning-effort**，并把它重新应用到该工作区下一个空白会话。

*A Host-only DSH plugin that remembers the preset and model used in each working directory and re-applies them to that directory's next blank session.*

---

## 它做什么

在 preset 与模型这两个维度上，DSH 自己只保留两套**全局**默认：`agent-default-model` 的模型默认值，以及 `agent-preset-registry` 的预设默认值。这个插件把"上次用的选择"降维到**工作目录**：

- 在某个工作区里换过预设并真正开始对话，或换过模型，插件把这次选择记到该目录名下；
- 之后在这个目录里新建/打开空白会话时，插件在会话开始前把预设与模型改回记忆值；
- 不同工作区互不影响。

记忆本身只存在插件自己的存储域里，不写入会话日志，也不会进入模型上下文。应用记忆时写的是 DSH 正常的会话事件，插件不追加自定义事件类型。

## 安装

需要一台安装了 DSH 的机器，以及提供 `storageDomain` Service 的 DSH 版本（开发时使用 0.2.2-rc.5；peer 要求 `@deepseek-ai/dsh-storage-domain >= 0.2.0`）。

1. 克隆或下载本仓库到任意目录。
2. 在 DSH Web GUI 打开 **Plugins** 页，选择 **Add plugin**，指向本仓库目录；或者让 agent 调用 `plugin_manager` 的 `install_bundle`，`target` 填本目录的绝对路径。
3. 安装后新建会话即可生效；已经打开的会话不会被改动。

这是一个 Host-only bundle：没有 client 半、没有构建步骤，也不需要先安装依赖。首次安装通常无需重启；升级时用同一入口安装更新后的目录，若 Plugins 页提示需要重启，按提示操作。卸载在 Plugins 页移除 bundle，已保存的记忆不会自动删除。

## 用法

装好即生效，不需要任何界面操作：正常地在 Web GUI 里换模式、换模型即可。想让它消失，停用插件即可（已保存的值会保留）。

验证方法：

1. 在 A 工作区把模型换成 X、模式换成 P，**并发送一条消息**（预设以"实际跑过一轮"为准）；
2. 在 A 工作区新建会话 → 应直接是 P + X；
3. 切到 B 工作区新建会话 → 应仍是 B 自己的选择，或全局默认。

## 配置

在 **Plugins** 页找到 `remember-workspace-settings` 行，或直接编辑 profile 的 `cordis.patch.yml` 里该行的 `config`：

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后既不记录也不应用 |
| `applyPreset` | `true` | 是否把记忆的预设应用到空白会话 |
| `applyModel` | `true` | 是否把记忆的模型/推理强度应用到空白会话 |
| `rememberPreset` | `true` | 是否把"实际运行的预设"记入工作区记忆 |
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

## 数据位置

```
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

**重置某个工作区**：停掉 DSH，删除该 JSON 里对应的键（或整个文件），再启动。文件损坏或版本不匹配时，插件会记录一条 warning 并以"无记忆"状态继续运行，不会阻塞 DSH 启动。

## 行为边界

- **预设以"实际使用"为准。** 只有在某个预设下真正开始了一轮对话，它才会成为该工作区的记忆值；只是点了一下模式但没发消息，不算。模型则按最后一次选择立即记录（模型的切换不会像预设那样被 Host 在创建时重置）。
- **"用默认预设"等于没有偏好。** 如果某一轮用的是 Settings 里的默认预设，插件会清掉该工作区的预设记忆，于是它继续跟随以后默认值的变化，而不是被钉死在旧值上。
- **显式指定的预设优先。** 创建会话时请求里点名了某个预设（例如 Creator 流程的 `cordis`）时，插件不会覆盖它；只有"按默认预设创建"的会话才套用记忆值。
- **只碰空白会话。** 已经开过第一轮对话的会话不会被改动；Host 的 `agentPresets.select` 本身就只允许用于空白会话。
- **忽略子代理会话**（`origin: 'subagent'`）与 fork（可配置），避免子代理的模型策略污染工作区记忆。
- **模型会先校验。** 记忆里的 provider 未登录、模型已下线或推理强度不被支持时，只跳过模型这一半，预设照常应用，并记录一条 warning。
- **插件不改全局默认。** 插件用 `agent.model.select()` 写会话日志，不会像 `session/selectModel` 那样顺手改写 `agent-default-model`。注意：GUI 自己的模型选择器会走 `session/selectModel`，因而会更新全局默认——那是 DSH 的行为，不是这个插件做的。
- **会多一次组合挂载。** 打开一个已有空白会话的工作区时，Host 会先用配置的默认预设组装它，插件随后切到记忆值，因此比不用插件多一次预设重挂载（空白会话上成本很小）。
- **Creator 的连带效果。** 在某个工作区用 Creator 模式跑过一轮后，该工作区下次新建会话也会是 Creator 模式——这就是"上次使用"的语义；切回默认预设跑一轮即可清除该偏好。
- **多窗口/多进程**：同一进程内以最后一次写入为准；跨进程同时写同一 JSON 文件时后写覆盖（JSON 存储后端是单进程写链）。
- **工作目录改名或移动**会被当成一个新工作区，旧记录保留在文件里。

## 已知限制

- 模型没有"创建时参数"，应用时机是会话刚创建、尚未开始；如果某个流程在创建会话的同时立刻发送第一条消息，理论上可能抢在应用之前（正常 GUI 流程不会）。
- 预设只在"开始对话"时记录，所以在空白会话里选好模式却没发消息就切换工作区，这次选择不会被记住。
- 没有设置页；查看/清除记忆需要直接编辑上面的 JSON 文件。

## 开发与验证

| 文件 | 作用 |
|---|---|
| `index.js` | 插件的全部逻辑（Service 类默认导出） |
| `package.json` | bundle 清单：`dsh.bundle.patch`、exports、files、peerDependencies |
| `cordis.patch.yml` | 安装时 `insert` 的插件行 |
| `locale/{en,zh}.json` | Plugin Manager 的标题与描述 |
| `icon.svg` | 36×36 图标 |
| `test/logic.mjs` | 逻辑单测；不需要把插件装进 profile |
| `docs/DESIGN.md` | 设计依据、DSH 机制与边界情况 |
| `AGENTS.md` | 维护者与 agent 会话的工作约定 |

跑单测（Node 22.15+）：

```sh
# macOS / Linux
DSH_INSTALL_DIR=/path/to/node_modules/@deepseek-ai/dsh node test/logic.mjs
```

```powershell
# Windows PowerShell
$env:DSH_INSTALL_DIR = 'C:\path\to\node_modules\@deepseek-ai\dsh'
node test/logic.mjs
```

`DSH_INSTALL_DIR` 指向 DSH 的 `@deepseek-ai/dsh` 包目录；不设置时会尝试从当前模块路径解析，解析不到则以退出码 2 跳过并给出提示。测试会把插件的 4 个裸导入重定向到该安装树里的副本，然后用 fake `ctx` / table 调用插件方法，因此不需要先安装插件。

改 `index.js` 后至少跑：

```sh
node --check index.js
node -e "for (const f of ['package.json','locale/en.json','locale/zh.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
node test/logic.mjs
```

## 许可证

[MIT](LICENSE) © 2026 chuikingshek