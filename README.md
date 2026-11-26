# dsh-remember-workspace-settings

按工作目录记住新建对话**首条消息实际使用**的 Agent 预设，以及当时的 **provider / model / reasoning-effort**（包括默认 preset 和跟随的全局默认模型），并把它重新应用到该工作区下一次新建或冷恢复（会话已落盘、进程内没有 live agent 时重新打开）的空白会话。

*A Host-only DSH plugin that remembers the preset and model a new conversation actually used at its first message in each working directory, and re-applies them to that directory's next newly created or cold-resumed blank session.*

## 功能

- **按工作目录记忆**：每个工作区保存自己的预设与模型，互不影响；没有记忆的工作区仍使用全局默认。
- **以首条消息为准**：新建对话发送第一条消息时，记录该消息实际使用的预设和模型；只是选好但没发消息不算，首条消息之后再改也不重写工作区记忆。
- **默认值也会记住**：默认 preset 和当时跟随的全局默认模型同样写入。工作区会钉住首条消息的值，Settings 里改默认 preset/模型不会影响已有记忆的工作区。
- **模型应用前先解析调用配置**：无 adapter、模型信息不可用或推理强度不支持时，只跳过模型这一半并 warn，预设照常应用；登录状态与目录可选性不在这一步检查。
- **只改空白会话**：已经开过对话的会话不会被改动；创建时显式指定的**非默认**预设（例如 Creator）会优先保留，显式指定默认预设与按默认创建不可区分，仍会被记忆覆盖。
- **进程内 live 空白复用不在覆盖范围**：Host 会直接复用仍存活的空白会话并把 preset 切到请求/默认值，插件不会再次应用记忆；该会话首条消息会把 Host 当时的实际值记回工作区，可能覆盖原偏好。只有新建或冷恢复的空白会话才走记忆应用。
- **子代理与 fork 默认跳过**：避免派生会话污染工作区记忆。
- **记忆不入会话日志，也不碰全局默认**：记忆保存在插件自己的存储域；应用时只写 DSH 正常的会话事件（`agent-preset/selected` / `model/selection`），不追加自定义事件，也不进入模型上下文。
- **Host-only bundle**：没有 client 半、没有构建步骤，也没有需要随包安装的运行时依赖（平台包由 DSH 提供）。

## 升级

从 1.0 升级时存储结构不变，旧记录继续有效。旧版本没有记录默认 preset 的工作区，会在下一次新对话首条消息时补记实际 preset；从未记录过模型的工作区，会在同一时刻记录当时的全局默认模型。若这个全局默认已经被其他工作区改过，需要在该工作区重新选一次模型。

## 文档

| 文档 | 内容 |
|---|---|
| [设计说明](docs/DESIGN.md) | 设计依据、行为边界、安装与配置、数据位置、代码地图与开发约定 |
| [测试与发布](docs/test.md) | 测试原理、运行方式、修改后的验证与发布前检查 |
| [DSH 探索笔记](docs/dsh-exploration-notes.md) | 源码核实过的 DSH 平台机制、版本基线与升级复核清单 |

安装、配置与数据位置见[设计说明](docs/DESIGN.md)。

## 许可证

[MIT](LICENSE) © 2026 chuikingshek
