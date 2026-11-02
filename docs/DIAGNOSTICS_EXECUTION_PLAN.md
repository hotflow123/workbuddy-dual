# 诊断报告可信度修复执行计划

> **交给 WorkBuddy 执行**：项目目录为 `E:\code\workbuddy共存`。这是独立的诊断修复计划；不要覆盖或中断正在执行的安装路径计划。先检查 `git status --short`，保留已有改动。不执行 `npm ci`，不提交、不发布，不对真实客户端执行安装、更新或卸载。

**目标：**用户点击“导出诊断”时，报告必须反映导出时的真实扫描状态、管理器登记实例、最新操作和安装失败日志；不得出现“已安装多次但报告未发现”“刚导出却使用旧扫描时间”“功能可用但旧字段称只读”等矛盾。

**技术栈：**沿用 TypeScript、Electron、Node.js、Vitest、当前 `AppService`、`FileJournalStore`、`FileErrorLog`、扫描器和脱敏工具；不新增依赖。

## 已核实的问题

- `AppService.exportDiagnostics()` 直接使用内存中的 `this.scanResult`，没有先调用 `scan()`；因此报告时间新、扫描时间旧。
- `buildDiagnostics()` 的 `lastOperation` 只取 `input.operations[0]`。若 journal 顺序不保证最新，或失败发生在 journal 建立之前，报告就会显示 `null`。
- `FileErrorLog` 有 `list()`，但只返回文件名；没有读取和解析最新错误内容的接口，诊断导出也没有包含 `state/errors` 内容。
- 当前报告把 `capability`、`availability`、旧 `assisted` 和 `scan.readOnly` 同时导出，来源口径不同，可能出现部署能力为 true、可用性却称辅助/只读的冲突。
- 用户 14:49 导出的报告仍显示扫描时间 14:29、两版未发现、操作和错误均为空，不能用来判断重复安装或安装失败原因。

## 全局约束

- 导出前必须执行一次新的只读扫描；扫描失败时在报告中明确标记失败和原因，不得静默沿用旧结果。
- 管理器登记文件中的实例是“本工具已管理实例”的事实来源；扫描结果是当前磁盘发现的事实来源。两者分开呈现，再按规范化路径关联，不能互相覆盖或把其中一个误称为全部安装。
- 最新错误日志与事务 journal 是两个来源：都要读取；没有 journal 不得推断没有操作。
- 所有路径继续脱敏；错误内容不得包含完整个人路径、用户名、命令行、令牌、密码或聊天数据。
- 新报告使用明确的新 schema 版本；旧 schema 报告不应被新 UI/新导出误当成当前报告。
- 只修诊断和日志读取，不在此计划中改安装路径、签名策略、部署/卸载算法或客户端数据。

---

## Task 1：增加可读取的脱敏错误日志接口

**Files:**
- Modify: `src/main/errorLog.ts`
- Modify: `src/main/services/appService.ts`
- Test: `tests/unit/errorLog.test.ts`

- [ ] 为 `ErrorLogPort` 增加读取最近错误记录的方法，返回已解析的结构化记录，而不只是文件名。
- [ ] `FileErrorLog` 按文件名时间倒序读取最近 20 条 JSON；忽略损坏文件但返回损坏计数，不让一个坏日志阻断全部诊断。
- [ ] 解析时验证 schemaVersion 和必需字段；未知字段丢弃，路径字段保持已脱敏格式。
- [ ] 写入文件名增加唯一后缀（例如操作号或随机短 ID），避免同一毫秒同类型操作覆盖前一条错误。
- [ ] 测试：成功读取最新错误、最多读取 20 条、损坏文件可容错、敏感字段不泄漏、同时间错误文件不互相覆盖。

## Task 2：导出前刷新并合并真实安装状态

**Files:**
- Modify: `src/main/services/appService.ts`
- Modify: `src/core/diagnostics.ts`
- Modify: `src/core/contracts.ts`（如需新增诊断专用类型）
- Test: `tests/unit/diagnostics.test.ts`
- Test: `tests/unit/appService.test.ts` 或现有对应 service 测试

- [ ] `exportDiagnostics()` 开始时调用真实 `scan()`；成功则使用本次结果，失败则继续导出但明确写入 `scan.status="failed"`、失败码和脱敏原因，不准回退到旧扫描结果并伪装为新鲜数据。
- [ ] 导出同时读取当前 `instances.json` 登记实例，并单独输出 `managedInstances`：产品、版本、状态、脱敏路径、来源/登记时间（若已有），不输出原始个人路径。
- [ ] 扫描结果与管理登记按规范化路径关联，输出 `scanToManaged` 状态：`matched`、`discovered-not-managed`、`managed-not-found-on-disk`、`identity-conflict`。
- [ ] 用户重复安装但扫描为空时，报告至少能显示登记实例及其路径摘要；如果登记也为空，则必须明确报告“当前管理器登记为空”，不能暗示以前从未安装过。
- [ ] `generatedAt`、`scan.scannedAt`、最后操作/错误时间必须分别输出；导出时新扫描时间不得早于本次导出启动时间，除非扫描明确失败。
- [ ] 测试：导出触发扫描；旧缓存不会冒充新扫描；登记有实例但扫描缺失时显示 `managed-not-found-on-disk`；扫描发现未登记目录时显示 `discovered-not-managed`。

## Task 3：统一最近操作与失败状态

**Files:**
- Modify: `src/core/diagnostics.ts`
- Modify: `src/main/services/appService.ts`
- Modify: `src/main/errorLog.ts`
- Test: `tests/unit/diagnostics.test.ts`
- Test: `tests/unit/errorLog.test.ts`

- [ ] 将事务 journal 与错误日志作为独立数组输出：`recentOperations`、`recentErrors`，每个最多 20 条，按时间倒序。
- [ ] 顶层 `lastOperation` 由两类记录按时间合并计算；错误日志记录必须可成为最近操作，即使事务 journal 中没有记录。
- [ ] `lastOperation` 至少包含 kind、product、state、stage、failureCode、failureMessage、timestamp、rolledBack；无记录时明确为 `null` 并输出 `historyStatus`，说明是“无历史记录”还是“日志读取失败”。
- [ ] 安装过程中在选择包、校验、解包、部署、登记、快捷方式各阶段已有的错误必须落入错误日志；写日志失败要返回/显示日志写入失败提示，不能声称已经记录。
- [ ] 测试：journal 为空但存在 install error 时 `lastOperation` 指向该 error；错误时间晚于 journal 时取 error；journal 更晚则取 journal；时间解析异常时排序稳定且显式标记。

## Task 4：删除诊断中互相矛盾的旧状态字段

**Files:**
- Modify: `src/core/diagnostics.ts`
- Modify: `src/core/capabilities.ts`
- Modify: `src/core/assisted.ts`（仅删除诊断导出所需的遗留映射，不重构无关代码）
- Modify: `src/renderer/renderer.ts`
- Test: `tests/unit/diagnostics.test.ts`
- Test: `tests/e2e/*`

- [ ] 新诊断使用 schemaVersion 4。
- [ ] 移除旧 `availability` 的“辅助/仅指引”状态和旧 `assisted` 字段；不再导出过时的“证据门/在线来源未配置”作为安装可用性结论。
- [ ] 删除或重定义 `scan.readOnly`：扫描只读是扫描属性，不代表整个产品处于只读模式；字段名必须避免混淆。
- [ ] 统一用 `deploymentCapabilities` 表示真实实现能力，用 `lastOperation`/`recentErrors` 表示最近执行结果；任何“可用”状态都必须由当前代码能力推导，不从旧证据配置读取。
- [ ] Renderer 诊断弹窗与导出字段使用相同 schema 和状态映射；不允许 UI 说可安装、导出报告却说只读/辅助安装。
- [ ] E2E 断言：新诊断不包含旧 `availability`/`assisted` 状态；安装/更新/卸载能力与当前 UI 一致；没有“证据包阻断安装”文案。

## Task 5：确认运行构建与诊断来自同一版本

**Files:**
- Modify: `scripts/build.mjs`
- Modify: `scripts/e2e.mjs`
- Modify: `src/main/index.ts`
- Test: `tests/e2e/*`

- [ ] 每次 build 清理/重建 `dist`，将 buildId、buildTime、appVersion 注入主进程和 renderer，诊断与窗口显示同一组值。
- [ ] 导出报告增加 `diagnosticsBuildId`（应与运行状态 build.id 完全一致）及 `diagnosticsSchemaVersion`。
- [ ] E2E 启动刚构建的程序并实际点击“导出诊断”，读取导出 JSON 检查，不只调用纯函数或检查静态 renderer 文案。
- [ ] 对 `win-unpacked` 与 portable 产物分别运行并导出诊断，确认 packaged/portable 值、buildId 和 schema 正确。
- [ ] 若发现旧构建或缓存数据，报告明确显示构建标识；不能把旧二进制生成的数据称作当前源码状态。

## Task 6：回归验证与交付

**Files:**
- Modify: `docs/TEST_MATRIX.md`
- Modify: `docs/USER_GUIDE.md`
- Modify: `README.md`

- [ ] 运行：

```powershell
npm run typecheck
npm test -- --run
npm run build
npm run e2e
npm run scan:report
```

- [ ] 用合成数据覆盖以下报告：从未安装；已登记且扫描命中；已登记但扫描缺失；扫描发现但未登记；安装失败且无 journal；journal 成功/失败；错误日志损坏；日志目录不可读。
- [ ] 在本机已安装多份的环境导出一份报告，确认报告列出管理器登记实例、扫描实例、路径关联和最新操作/错误；不能只看到管理器自身进程。
- [ ] 报告测试类型：纯单元测试、临时目录集成测试、当前机器真实扫描分别标注，不互相冒充。
- [ ] 文档说明非 portable 与 portable 的错误日志位置；非 portable 路径从 `app.getPath("userData")/state/errors` 得出，不硬编码用户名目录。
- [ ] 不在本计划内删除旧用户数据、清空实例登记或清理错误日志。

## 完成标准

- [ ] 导出动作触发新扫描，时间戳准确；扫描失败会如实标出，不复用旧结果。
- [ ] 报告分别列出扫描发现和自动管理登记的实例，并能指出两者不一致的具体原因。
- [ ] 已发生安装失败时，报告能显示最近失败阶段、错误码和脱敏错误信息；没有事务 journal 也不能变成 `lastOperation: null`。
- [ ] 当前实现不再输出过时的辅助安装/证据门状态，部署能力、UI 和诊断一致。
- [ ] 新 schema/buildId 可确认报告由正在运行的二进制生成；旧报告不会被误认为新报告。
- [ ] 脱敏测试证明不含完整用户路径、用户名、令牌、密码和原始命令行。

## WorkBuddy 汇报格式

汇报诊断 schema 版本；导出前是否刷新扫描；管理登记/扫描关联结果；最近 journal 和错误日志读取结果；过时字段删除情况；buildId/schema 一致性；单测、集成测试、E2E 和本机真实导出各自结果；报告中实际展示的最新失败；未完成事项。不得仅以序列化单元测试通过声称诊断已修复。
