# 测试与发布

本文说明 `dsh-remember-workspace-settings` 的测试方式、逻辑单测覆盖了什么、修改代码后必须执行哪些验证，以及发布前的检查清单。

> 版本基线：DSH **0.2.2-rc.5**。单测会从指定的 DSH 安装树解析平台包，并校验当前 peer 范围能通过该版本的兼容性闸门；升级 DSH 后的复核见 [DSH 探索笔记](dsh-exploration-notes.md) 第 10 节。
>
> 相关文档：[项目介绍](../README.md) · [设计说明](DESIGN.md) · [DSH 探索笔记](dsh-exploration-notes.md)

## 1. 测试策略

`test/logic.mjs` 是**不需要安装插件**的逻辑单测：

- 用 `module.registerHooks` 把插件的 4 个裸导入（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-storage-domain`、`zod`）重定向到运行中的 DSH 安装树；
- 用 `Object.create(Plugin.prototype)` 创建插件实例，注入 fake `ctx`、`config` 与内存表；
- 直接调用 `scopeOf`、`writeRecord`、`rememberPreset`、`applyPreset`、`applyModel`、`applyDefaults` 等方法；
- 用 `node:assert/strict` 顺序执行检查，不依赖测试框架。

因此它能在未安装状态下验证合并、删除、偏好规则、显式预设让位、模型校验与端到端应用，也能检查 bundle 清单的基本不变量。

它**不替代**真实 Host 集成测试：不启动 DSH，不验证真实 linked layer 加载、`agent/created` 时序、存储落盘或 GUI 行为。完整的“发消息 → 新建会话 → 检查预设/模型”验收步骤见 [设计说明 §6.2](DESIGN.md#62-用法与验证)。

## 2. 运行测试

### 2.1 环境要求

- Node **22.15+**（需要 `module.registerHooks`）；
- 一份提供上述 4 个 peer 包的 DSH 安装（开发基线 0.2.2-rc.5）；
- `DSH_INSTALL_DIR` 可选，指向 `@deepseek-ai/dsh` 包目录。不设置时，测试会从自身模块路径尝试解析 `@deepseek-ai/dsh`。

### 2.2 命令

```sh
node test/logic.mjs
# 或使用 package.json 里的脚本
npm test
```

指定 DSH 安装目录：

```sh
# macOS / Linux
DSH_INSTALL_DIR=/path/to/node_modules/@deepseek-ai/dsh node test/logic.mjs
```

```powershell
# Windows PowerShell
$env:DSH_INSTALL_DIR = 'C:\path\to\node_modules\@deepseek-ai\dsh'
node test/logic.mjs
```

### 2.3 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 全部检查通过；最后输出 `N checks passed` |
| `1`（或其他非零） | 某个断言失败，或 Node 太旧导致导入 `module.registerHooks` 时直接失败 |
| `2` | 跳过：找不到 DSH 安装，或 `DSH_INSTALL_DIR` 指向的清单不存在 |

Node 22.15+ 是硬要求：`registerHooks` 是静态命名导入，低版本 Node 会在模块链接阶段报错并以 `1` 退出，不会走到跳过分支。

退出码 `2` 是**跳过**而不是通过。CI 或发布检查应确保它实际执行到 `0`。

## 3. 测试内容

| 检查 | 覆盖 |
|---|---|
| Service init symbol | `cordis` 导出 `Service.init`；插件实现了 `[Service.init]`；Service 类没有同时导出 `apply` |
| Config defaults | 7 个配置项的默认值正确；错误类型（如 `verbose: 'yes'`）会被拒绝 |
| `scopeOf` | 工作目录键、子代理跳过、fork 跳过、`skipForks: false`、缺少 `cwd` 时跳过 |
| `writeRecord` | 合并字段、`undefined` 清除字段、空记录删除、内容未变化时不写 |
| `rememberPreset` | 非默认预设被记录；默认预设清空 `agentPreset` |
| `applyPreset` | 显式请求的预设让位；默认创建的会话套用记忆；没有记录预设的会话套用记忆 |
| `applyModel` | 相同选择不重写也不校验；不同选择写入；校验失败只跳过并 warn 一次 |
| `applyDefaults` | 只处理空白会话；有记忆才动作；没有记忆时无副作用 |
| 打包清单 | `dsh.bundle.patch` 指向 `cordis.patch.yml`；`dependencies` 为空；4 个 peer 存在；patch 名称、locale 标题/描述、`icon.svg` 存在 |
| 版本兼容闸门 | `@deepseek-ai/dsh-storage-domain` 的 peer 范围能通过当前安装版本的兼容性检查（`includePrerelease`） |

### 3.1 测试替身

- `fakeTable()`：用 `Map` 模拟 domain table，记录 `put` / `delete` 次数，用来断言“未变化不写”。
- `host()`：创建以 `Plugin.prototype` 为原型的对象，填入 `config`、`table`、`writeChain`、`warns` 和 fake `ctx`。
- `blankAgents` / `startedAgents`：分别返回“未开始”与“已开始”的 `turnBoundaryOf` 结果。
- `session(header)`：只提供插件读取的 `header` 字段。
- `resolve('fixture-*')`：平台中立的 fixture 工作目录；测试不会触碰文件系统。
- `keyFor()`：在 Windows 上把 fixture 路径转小写，匹配 `workspaceKey()` 的行为。

### 3.2 未被单测覆盖的部分

- linked layer 的真实解析与插件加载（仅检查 `peerDependencies` 声明）；
- 真实会话创建、`agent/created` 的 serial 时序与客户端响应顺序；
- storage domain 的真实落盘、损坏文件恢复与版本迁移；
- 真实 provider 的登录状态与模型目录（`resolveCallConfig` 被 mock）；
- Web GUI 的模型选择器及其对全局默认的副作用。

这些需要按 [设计说明 §6.2](DESIGN.md#62-用法与验证) 做手工验收，或在真实 Host 上做集成测试。

## 4. 修改后必须执行的验证

改 `index.js` 后至少跑：

```sh
# 1. 语法
node --check index.js

# 2. 清单 / 文案
node -e "for (const f of ['package.json','locale/en.json','locale/zh.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
# icon.svg 用任意 XML 解析器过一遍

# 3. 逻辑单测（不需要安装插件）
node test/logic.mjs
```

对应的检查点：

- 第 1 步保证 ESM 语法与 import 结构可解析；
- 第 2 步保证 bundle 清单和 locale JSON 没有语法错误；`icon.svg` 用任意 XML 解析器验证；
- 第 3 步覆盖第 3 节列出的逻辑与打包不变量。找不到安装时用 `DSH_INSTALL_DIR` 指定 `@deepseek-ai/dsh` 包目录。

如果改动涉及以下内容，还要同步更新对应测试或文档：

| 改动 | 需要同步 |
|---|---|
| `Config` 字段或默认值 | `test/logic.mjs` 的 Config 检查、[设计说明 §6.3](DESIGN.md#63-配置)、locale 文案 |
| 事件监听或应用逻辑 | 对应的 remember/apply 检查、[设计说明 §4](DESIGN.md) |
| `package.json` 的 bundle/peer | 打包清单检查、[设计说明 §7](DESIGN.md) |
| 测试命令或退出码 | 本文第 2 节 |
| 行为边界 | [设计说明 §5](DESIGN.md)、README 功能描述、locale 文案 |

## 5. 发布前检查

- README 的功能介绍与当前实现一致；[设计说明](DESIGN.md) 的安装、配置、数据位置与当前代码一致。
- 本文的命令、退出码与覆盖范围与 `test/logic.mjs` 一致。
- `locale/{en,zh}.json` 只描述已实现、已验证的行为。
- `package.json` 的 `files` 覆盖运行所需文件；用 `npm pack --dry-run` 检查实际打包清单。
- README 链接 `docs/`，`files` 已包含 `docs/*.md`；用 `npm pack --dry-run` 确认 README 与三份文档都进入发布包，否则包内链接会失效。
- 不把本机 profile、用户名、真实 provider/model 或绝对安装路径写进文档与测试默认值。
- 不向会话日志追加自定义事件类型（DSH 硬规则）。
- `dependencies` 保持为空；4 个 peer 不缺失；peer 范围能通过当前 DSH 的兼容性闸门（逻辑单测会检查）。
- 涉及行为变化时，`locale`、README、设计说明与测试文档一起更新。

## 6. 维护测试

- 新检查用 `check(label, body)` 或 `checkAsync(label, body)` 添加；标签沿用英文，便于和代码/错误信息对应。
- 测试替身只实现插件实际读取的字段；新增 Service 依赖时在 `host()` 的 `services` 里补 fake。
- 打包断言与 `package.json` / `cordis.patch.yml` / `locale` 的真实结构保持同步。
- fixture 路径保持平台中立，不写入真实用户目录或安装路径。
- DSH 升级后若测试因 API 变化失败，先从 [DSH 探索笔记](dsh-exploration-notes.md) 的复核清单确认真实变化，再决定改测试还是改插件；不要为了让测试通过而掩盖平台语义变化。
