# dsh-remember-workspace-settings

按工作区记住 Agent 设置，包含预设（preset）、模型（provider + model + reasoning-effort）。

用户在工作区内新建对话发送第一条消息时，Agent 设置会被保存。下次在同一个工作区新建对话时，自动应用 Agent 设置。

> 已知问题：DeepSeek Harness 复用空白对话机制会造成一些问题，Host 会直接复用仍存活的空白对话并把预设切到请求/默认值，插件不会再次应用设置，会话首条消息会把 Host 当时的实际值记回工作区，可能覆盖原偏好。新建对话或冷恢复的空白对话不受影响。

## 文档

- [设计说明](docs/design.md)：设计依据、行为边界、安装与配置、数据位置、代码地图与开发约定
- [测试与发布](docs/test.md)：测试原理、运行方式、修改后的验证与发布前检查
- [DeepSeek Harness 探索笔记](docs/dsh-exploration-notes.md)：源码核实过的 DSH 平台机制、版本基线与升级复核清单
