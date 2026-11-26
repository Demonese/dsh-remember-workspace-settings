# 安装、配置与数据

本文说明 `dsh-remember-workspace-settings` 的安装方式、安装后的验证步骤、可调配置，以及记忆数据的位置与重置方法。面向安装和使用插件的用户，以及需要清理或排查记忆的维护者；设计依据与实现细节见 [设计说明](design.md)。

> 相关文档：[项目介绍](../README.md) · [设计说明](design.md) · [测试与发布](test.md) · [DSH 探索笔记](dsh-exploration-notes.md)

## 1. 安装

需要一台已经安装 DSH 的机器，并且 DSH 版本需提供 `storageDomain` Service。本插件在 DSH 0.2.2-rc.5 上开发验证，`peerDependencies` 要求 `@deepseek-ai/dsh-storage-domain >= 0.2.0`。

1. 克隆或下载本仓库到任意目录。
2. 在 DSH Web GUI 打开 **Plugins** 页，选择 **Add plugin**，指向本仓库目录；或者让 agent 调用 `plugin_manager` 的 `install_bundle`，`target` 填本目录的绝对路径。
3. 安装后新建会话即可生效；已经打开的会话不会被改动。

这是一个 Host-only bundle：没有 client 半、没有构建步骤，也不需要先安装依赖。首次安装通常无需重启；升级时用同一入口安装更新后的目录，若 Plugins 页提示需要重启，按提示操作。卸载在 Plugins 页移除 bundle，已保存的记忆不会自动删除。

## 2. 用法与验证

装好即生效，不需要任何界面操作：新建对话时选好模式/模型，再发送第一条消息；插件记录的是这条消息实际使用的值。不想再用时停用插件即可（已保存的值会保留）。

验证方法：

1. 在 A 工作区新建会话，选好模式 P、模型 X（P/X 是默认值也可以），**发送第一条消息**；插件记录的是这条消息实际使用的值；
2. 在 A 工作区再新建会话 → 应直接是 P + X，即使 Settings 里的默认值已经改过；
3. 切到 B 工作区新建会话 → 应仍是 B 自己的记忆；B 从未发过首条消息时使用全局默认。

从旧版本升级时存储结构不变，旧记录继续有效。旧版本没有记录默认 preset 的工作区，会在下一次新对话首条消息时补记实际 preset；从未记录过模型的工作区，会在同一时刻记录当时的全局默认模型。若这个全局默认已经被其他工作区改过，需要在该工作区重新选一次模型。

## 3. 配置

在 **Plugins** 页找到 `remember-workspace-settings` 行，或直接编辑 profile 的 `cordis.patch.yml` 里该行的 `config`：

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后既不记录也不应用 |
| `applyPreset` | `true` | 是否把记忆的预设应用到新建/冷恢复的空白会话 |
| `applyModel` | `true` | 是否把记忆的模型/推理强度应用到新建/冷恢复的空白会话 |
| `rememberPreset` | `true` | 是否在新建会话首条消息时记录实际 preset（包括默认 preset） |
| `rememberModel` | `true` | 是否在新建会话首条消息时记录实际 provider/model/effort（包括跟随的全局默认） |
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

## 4. 数据位置与重置

```text
$DSH_HOME/storages/workspace_launch_defaults.json
```

`$DSH_HOME` 默认是 `~/.dsh`（Windows 上是 `%USERPROFILE%\.dsh`），可以用 `DSH_HOME` 环境变量覆盖。

文件是 storage-json 的 single-unit 文档，记录挂在 `tables.workspaces` 下，一个工作目录一条：

```json
{
  "unit": { "name": "workspace_launch_defaults", "version": 1 },
  "global": null,
  "tables": {
    "workspaces": {
      "/home/you/projects/demo": {
        "path": "/home/you/projects/demo",
        "agentPreset": "ptc",
        "provider": "your-provider",
        "model": "your-model",
        "reasoningEffort": "high",
        "updatedAt": 1764000000000
      }
    }
  }
}
```

存储键是规范化后的绝对工作目录：`path.resolve(cwd)`，Windows 上再转小写；记录里的 `path` 保留会话创建时的写法，便于阅读。`agentPreset` 是该工作区最近一次新对话首条消息实际使用的 preset，可能就是默认 preset；`provider / model / reasoningEffort` 是同一时刻实际生效的模型选择，跟随全局默认时也会写入。

**重置某个工作区**：停掉 DSH，删除 `tables.workspaces` 里对应的键（或整个文件），再启动。文件损坏或版本不匹配时，插件会记录一条 warning 并以“无记忆”状态继续运行，不会阻塞 DSH 启动。
