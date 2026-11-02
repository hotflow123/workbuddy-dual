# 安装目录误判占用修复执行计划

> **交给 WorkBuddy 执行**：项目目录 `E:\code\workbuddy共存`。本计划针对另一台电脑将 `D:\` 误识别为 WorkBuddy 安装实例、从而拒绝用户选择的 `D:\workbuddyCN`。先读本计划和项目 `AGENTS.md`，检查 `git status --short`；保留现有改动，不运行 `npm ci`，不提交、不发布，不操作用户现有客户端。

**目标：**修复进程扫描把盘符根目录误报为 WorkBuddy 安装的缺陷，并保证任何扫描线索都不能让有效的子目录安装目标被盘符根记录误拦截。

**架构：**先修正进程路径来源与路径规范化，再在扫描器和安装目标占用判定处做防御性过滤。只有有效的 WorkBuddy 安装目录才可成为“已占用目录”；驱动器根目录永远不是安装实例。用户选的 `D:\workbuddyCN` 必须可安装，若该目录自身已存在有效实例才拒绝。

**技术栈：**沿用 TypeScript、Electron、Node.js、Vitest 和现有扫描/路径守卫；不新增依赖。

## 已知证据与根因范围

- 用户报告安装目标是新建的 `D:\workbuddyCN`，错误却是 `该目录已被现有实例占用：D:\`。
- 同一诊断中 `scan.records` 出现一条未识别记录，脱敏路径 `drive: D:\, leaf: D:, depth: 1`，`locationSource: process`；因此错误来自进程线索被当作安装目录，并进入 `occupiedDirectories`。
- `src/core/scanner.ts` 当前对进程路径直接调用 `path.dirname(item.path)`，没有先确认路径是客户端主程序的完整可执行文件路径，也没有排除盘符根目录。
- `src/main/adapters/processes.ts` 目前接受任意以 `X:\` 开头的 `ExecutablePath`，进程名只用于线索，没有验证路径末端文件名与产品进程名匹配。
- `src/main/services/appService.ts` 将扫描记录的 `installLocation` 合并为占用目录；`src/core/pathGuard.ts` 对占用目录做祖先/后代冲突比较，盘符根目录因此拦截该盘所有安装目标。
- 不要只在 UI 隐藏该记录，也不要把 `D:\` 加入例外白名单；必须修复数据源并加安装入口防御。

## 全局约束

- `C:\`、`D:\` 等盘符根目录绝不能成为扫描安装记录、自动管理实例或安装占用目录。
- 对真实客户端进程，只从可信的绝对可执行文件路径推导其父目录；路径末端应是对应产品主程序名，不接受盘符根、目录路径、卸载器、修复器、管理器自身或临时解包目录。
- 进程路径异常时跳过该线索并记录简明原因，不得将父盘根目录降级成候选实例。
- 目标路径 `D:\workbuddyCN` 在目录不存在、父目录可写且没有同路径有效实例时必须通过；不能因该盘其他位置有 WorkBuddy 实例而拒绝安装到并列目录。
- 保留同路径冲突保护：目标等于已发现实例或目标是有效实例的父目录时仍拒绝，不能误删/覆盖其他实例。
- 不关闭所有路径保护、不放行系统目录/UNC/设备路径、不改变安装包解包、安全和回滚行为。
- 不以单元测试、mock 或旧 build 的结果宣称另一台电脑已驗收；记录实际构建标识及 portable 产物哈希。

---

## Task 1：复现并修正进程路径候选

**Files:**
- Modify: `src/main/adapters/processes.ts`
- Modify: `src/core/scanner.ts`
- Modify: `src/core/knownProducts.ts`（只在需取得产品可执行文件名时）
- Test: `tests/unit/scanner.test.ts`
- Test: 新增 `tests/unit/processes.test.ts`（若适配器需抽出纯解析函数）

- [ ] 先添加回归用例：进程记录 `{ path: "D:\\", name: "WorkBuddy.exe" }` 不产生安装记录、不增加 `process` 来源线索。
- [ ] 添加用例：目录路径、相对路径、无盘符路径、路径末尾不是 `.exe`、`Uninstall WorkBuddy.exe`、`RepairApp.exe`、管理器进程都不能变成客户端安装记录。
- [ ] 添加正例：`D:\\Apps\\WorkBuddy\\WorkBuddy.exe` 推导为 `D:\\Apps\\WorkBuddy`；`H:\\Apps\\WorkBuddyAI\\WorkBuddyAI.exe` 推导为国际版目录。
- [ ] 将进程输出解析与系统查询分离为可单测的纯函数；路径解析使用 `path.win32`，不能依赖测试主机操作系统的 `path` 语义。
- [ ] 仅接收绝对盘符路径，确认 basename 与对应产品主程序名一致；若产品映射不唯一，只保留线索并走现有产品身份判定，不可凭名称创建错误产品记录。
- [ ] 扫描器二次确认由可执行文件父目录得出的目录不是盘符根、临时操作目录或管理器目录，再调用 `ensureRecord`。
- [ ] 重跑 `tests/unit/processes.test.ts` 与 `tests/unit/scanner.test.ts`，确认新正反例通过。

## Task 2：安装占用判断的纵深防御

**Files:**
- Modify: `src/main/services/appService.ts`
- Modify: `src/core/pathGuard.ts`
- Test: `tests/unit/pathGuard.test.ts`
- Test: `tests/unit/managedInstall.test.ts`

- [ ] 给占用目录入口添加规范化过滤：空值、相对路径、盘符根、无效路径记录不得加入 `occupiedDirectories`。
- [ ] `validateInstallTarget()` 在使用 `occupiedDirectories` 前再次拒绝/忽略盘符根数据，避免旧实例登记或异常调用方重新引入同一堵塞；不要因此忽略正常安装目录。
- [ ] 添加核心回归测试：`occupiedDirectories: ["D:\\"]` 时，目标 `D:\\workbuddyCN` 不因盘符根被判定占用；盘符根本身仍被“不能安装到磁盘根目录”拒绝。
- [ ] 添加隔离测试：已有实例 `D:\\Apps\\WorkBuddy` 时，新建目标 `D:\\workbuddyCN` 允许；目标 `D:\\Apps\\WorkBuddy` 或其父目录仍按既有规则拒绝。
- [ ] 服务层测试：扫描报告中混入 `D:\\` 异常记录后，安装目标 `D:\\workbuddyCN` 仍能进入部署；已有同路径有效客户端时拒绝覆盖。
- [ ] 验证其他冲突规则、C/D 多盘路径、单盘 C 盘目标均未回归。

## Task 3：修正诊断，避免错误记录伪装成实例

**Files:**
- Modify: `src/core/diagnostics.ts`
- Modify: `src/renderer/renderer.ts`（仅调整异常候选显示）
- Test: `tests/unit/diagnostics.test.ts`

- [ ] 盘符根进程异常应显示为“无效进程路径，已忽略”，不能显示在“已发现实例/其他候选”并参与安装占用。
- [ ] 诊断中分别保留“原始线索被忽略”的计数和原因，不导出完整命令行或敏感内容。
- [ ] 修复实例登记不可读时的状态说明：报告不得同时给出“没有历史记录”和“实例登记文件不可读”；标注不可读与回退来源，不能将内存列表冒充磁盘登记。
- [ ] 断言诊断中不存在 `installLocation = D:\\` 的 WorkBuddy 安装记录或 scan-to-managed 关联。

## Task 4：跨盘安装回归与打包验收

**Files:**
- Modify: `scripts/e2e.mjs`、`src/main/index.ts`（如需注入测试扫描结果）
- Modify: `docs/TEST_MATRIX.md`
- Modify: `package.json`、`package-lock.json`（验收通过后递增 patch 版本）

- [ ] 新增自动化 E2E 回归：注入异常 `D:\\` 进程线索，并断言路径守卫对字面目标 `D:\\workbuddyCN` 放行；实际文件部署只使用自动创建的唯一临时目录。若测试机有 D 盘，可额外在 D 盘唯一临时目录做真实部署并在 `finally` 清理；没有 D 盘时明确记为未实测，不伪造结果。
- [ ] E2E 探针失败必须使进程退出非零；不得出现“安装探针失败但 E2E 仍通过”。
- [ ] 验收过程始终 `try/finally` 清理本次新建的临时目录；只删除本次生成且路径已核对的目录，不递归清理通配符或用户 `%TEMP%`。
- [ ] 运行：

```powershell
npm run typecheck
npm test -- --run
npm run build
npm run e2e
npm run scan:report
npm run dist:portable
npm run verify:package
```

- [ ] 用新 portable 产物在隔离位置启动，核对 buildId、版本和内置 7-Zip 完整性；用测试探针覆盖“异常进程路径 + D 盘子目录可安装”，然后检查自动登记、快捷方式与临时 staging 清理。
- [ ] 不在用户现有 `D:\workbuddyCN` 上自动安装；真实电脑复测由用户手动选择目标目录。
- [ ] 记录 portable 文件名、SHA-256、测试数量、失败/跳过项；不生成 NSIS/安装版。

## 完成标准

- [ ] 盘符根目录不再出现在识别实例、实例自动登记、安装占用目录中。
- [ ] `D:\\workbuddyCN` 不会再因错误的 `D:\\` 记录而被拒绝。
- [ ] 正常已安装实例仍可被发现，多个 WorkBuddy 副本各自独立，目标冲突保护继续有效。
- [ ] 诊断能说明无效进程路径被忽略，并准确报告实例登记不可读状态。
- [ ] 全套测试、E2E 回归、携带版完整性检查通过；没有把 mock/单测描述成跨电脑实测。

## WorkBuddy 汇报格式

只汇报：复现输入与根因；修改文件；盘符根/真实客户端进程的回归结果；`D:\\workbuddyCN` 的隔离目标测试结果；E2E 与全套测试结果；实例登记不可读诊断修复情况；新版本、构建标识、portable SHA-256；仍未完成事项。不要把“代码未写死盘符”当作跨盘验证。
