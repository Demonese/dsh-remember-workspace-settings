# dsh-remember-workspace-settings

按工作目录记住上次**实际使用**的 Agent 预设，以及最后一次选择的 **provider / model / reasoning-effort**，并把它重新应用到该工作区下一个空白会话。

*A Host-only DSH plugin that remembers the preset and model used in each working directory and re-applies them to that directory's next blank session.*

## 功能

- **按工作目录记忆**：每个工作区保存自己的预设与模型选择，互不影响。
- **预设以“实际使用”为准**：只有在某个预设下真正开始了一轮对话才会记录；只是点选模式但没发消息，不算。
- **默认预设等于没有偏好**：在默认预设上跑过一轮会清除该工作区的预设记忆，继续跟随 Settings 里的默认值变化。
- **模型应用前先解析调用配置**：无 adapter、模型信息不可用或推理强度不支持时，只跳过模型这一半并 warn，预设照常应用；登录状态与目录可选性不在这一步检查。
- **只改空白会话**：已经开过对话的会话不会被改动；创建时显式指定的预设（例如 Creator）会优先保留。
- **子代理与 fork 默认跳过**：避免派生会话污染工作区记忆。
- **记忆不入会话日志，也不碰全局默认**：记忆保存在插件自己的存储域；应用时只写 DSH 正常的会话事件（`agent-preset/selected` / `model/selection`），不追加自定义事件，也不进入模型上下文。
- **Host-only bundle**：没有 client 半、没有构建步骤，也没有需要随包安装的运行时依赖（平台包由 DSH 提供）。

## 文档

| 文档 | 内容 |
|---|---|
| [设计说明](docs/DESIGN.md) | 设计依据、行为边界、安装与配置、数据位置、代码地图与开发约定 |
| [测试与发布](docs/test.md) | 测试原理、运行方式、修改后的验证与发布前检查 |
| [DSH 探索笔记](docs/dsh-exploration-notes.md) | 源码核实过的 DSH 平台机制、版本基线与升级复核清单 |

安装、配置与数据位置见[设计说明](docs/DESIGN.md)。

## 许可证

[MIT](LICENSE) © 2026 chuikingshek
