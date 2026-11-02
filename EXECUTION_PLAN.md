# WorkBuddy 安装校验阻断修复执行计划

> **交给 WorkBuddy 执行**：项目目录为 `E:\code\workbuddy共存`。先阅读本计划、`README.md`、`docs/SECURITY.md`、`docs/USER_GUIDE.md`，再运行 `git status --short`。保留已有改动；不执行 `npm ci`；不提交、不发布；不删除或覆盖用户现有客户端。

**目标：**用户在国内版或国际版入口选择安装包后，管理器不再因 Authenticode 的 `NotSigned`、证书指纹变化或缺少虚拟机证据而阻止安装/更新；按用户选择的产品识别包内容，完成解包、部署、自动登记和桌面快捷方式创建。

**架构：**安装和更新采用管理器解包部署，不启动所选 `.exe` 安装器。签名只可作为诊断信息，不能作为安装/更新的硬性门槛。继续保留产品身份、应用树完整性、归档安全、磁盘空间、目标路径隔离、事务回滚等直接保护部署正确性的检查。

**技术栈：**沿用当前 TypeScript、Electron、Node.js、Vitest、现有 IPC、归档解析、文件事务、路径守卫及快捷方式适配器；不新增依赖，除非现有实现无法满足且先证明必要性。

## 已知故障证据

- 用户在 0.6.0 选择安装包后得到：`安装包未通过校验：Authenticode 状态为 NotSigned，签名无效的安装包不允许启动`。
- 当前源码 `src/core/assisted.ts` 的 `evaluateAssistedPackage()` 将非 `Valid` 签名直接拒绝；`src/main/services/appService.ts` 的安装/更新仍调用该校验并返回 `E_SIGNATURE_INVALID`。
- 同一电脑导出的诊断仍包含 `mode: read-only`、虚拟机证据包 blocker、在线来源未配置、`assisted: null`。这与 0.6.0“移除证据门”的执行报告不一致，必须检查实际构建入口与打包产物，不能假定用户启动的是最新代码。
- 用户选择的包是其自行从官方渠道下载的文件。管理器不得因签名状态替用户作决定；也不得伪称 `NotSigned` 就代表用户选择错误。

## 全局规则

- 用户明确选择目标产品卡片，所选包用于该产品；包元数据若能识别出另一个产品，才以“所选国内/国际版与包内产品不一致”阻止并说明原因。
- Authenticode 状态、证书主题、证书指纹、信任基线、`signer-trust.json` 均不得决定安装/更新是否继续，也不得要求导入证据包或额外批准发布者。
- 签名结果可以写入脱敏诊断作为观察字段；`NotSigned`、`Unknown`、证书换签不得转成安装失败。
- 仍必须拒绝：归档路径穿越/链接攻击、产品明确不匹配、缺少主程序或应用代码、版本无法建立目标目录、磁盘空间不足、目标越界、活动文件占用导致无法安全替换。
- 不运行用户选择的 `.exe` 安装器，不传静默参数；只使用现有解包部署管线。
- 安装/更新成功必须自动更新管理器实例登记并复扫，维持稳定 `instanceId`；安装后创建桌面快捷方式。无需用户执行“纳入管理”。
- 不更改国内版/国际版数据目录，不删除用户数据，不修改客户端更新配置，不猜在线下载直链。

---

## Task 1：解除 Authenticode 对安装和更新的硬阻断

**Files:**
- Modify: `src/core/assisted.ts`
- Modify: `src/core/packageVerifier.ts`
- Modify: `src/main/services/appService.ts`
- Modify: `src/core/contracts.ts`（仅在需调整安装预检结果类型时）
- Test: `tests/unit/assisted.test.ts`
- Test: `tests/unit/packageVerifier.test.ts`
- Test: `tests/unit/managedInstall.test.ts`
- Test: `tests/unit/updateUninstall.test.ts`

- [ ] 先补测试：包签名为 `NotSigned`，但产品身份、版本、完整应用树和归档结构有效时，安装预检通过并可进入部署。
- [ ] 补测试：签名为 `Unknown` 或包证书指纹与历史记录不同，不阻止安装/更新。
- [ ] 补测试：包明确属于另一产品时仍拒绝，错误文案指明产品不匹配，而不是签名失败。
- [ ] 补测试：恶意/损坏归档、路径穿越、缺主程序、缺 `resources/app.asar` 或版本缺失仍拒绝，且不创建最终目标目录。
- [ ] 从安装和更新调用链移除 `evaluateAssistedPackage()` 的签名授权职责；保留的签名读取只能用于诊断显示。
- [ ] 从 `verifyPackage()` 移除“签名必须 Valid/发布者必须匹配/指纹必须一致”作为部署前置条件；检查其所有调用方，确保没有第二个隐藏签名门。
- [ ] 清理首次安装的 `approveSigner` 分支及 signer trust 的操作级依赖；旧 `signer-trust.json` 可以忽略兼容，不得删除用户文件。
- [ ] 卸载官方卸载器如仍以签名状态硬阻止，也要改成精确匹配路径、文件名、产品和卸载登记后再执行；不接受签名字段单独否决。不得因此放开命令行解释器、任意路径或跨产品卸载。
- [ ] 更新/安装错误文案不得再出现“签名无效的安装包不允许启动”或“证据包未导入”。

## Task 2：移除旧只读证据门与过时诊断状态

**Files:**
- Modify: `src/core/evidence.ts`
- Modify: `src/core/capabilities.ts`（若实际文件名/职责不同，定位能力状态来源后修改真实源头）
- Modify: `src/core/diagnostics.ts`
- Modify: `src/main/services/appService.ts`
- Modify: `src/renderer/renderer.ts`
- Modify: `src/shared/*`（只在需要迁移旧诊断 schema 时）
- Test: `tests/unit/capabilities.test.ts`
- Test: `tests/unit/diagnostics.test.ts`
- Test: `tests/e2e/*`

- [ ] 找出为什么 0.6.0 诊断仍输出 `mode: read-only`、虚拟机证据 blocker、`assisted: null`；修复实际数据源，不只隐藏界面文字。
- [ ] capability 不再由虚拟机证据包决定；移除安装/更新/卸载流程中无实际作用的 `read-only` 状态字段，或改为准确反映可执行能力。
- [ ] diagnostics 不再输出“官方在线来源未配置”作为安装问题；本计划不实现在线更新，用户从官网手动下载后选择本地包。
- [ ] 更新诊断 schema 与 UI，让其报告当前实际版本、构建模式、安装/更新可用状态和最近操作结果；旧诊断文件可读取但不能让当前 UI 回退到旧模式。
- [ ] 自动化断言：用户导出的新诊断不含“尚未导入虚拟机证据包”阻断安装/更新的信息；新界面不显示只读证据门提示。

## Task 3：确认运行的是刚构建的正确版本

**Files:**
- Modify: `package.json`
- Modify: `scripts/build.mjs`、`scripts/e2e.mjs`、`scripts/scan-report.mjs`（按当前脚本实际需要）
- Modify: `src/main/index.ts`
- Test: `tests/e2e/*`

- [ ] 搜索并核对 `package.json` 版本、应用版本常量、`dist/`、`win-unpacked`、`release-portable` 的构建链，确保都来自当前源码。
- [ ] 每次 build 后清理或覆盖旧 `dist`，禁止打包脚本复用过期 renderer/main bundle。
- [ ] 诊断增加 `buildId` 或源码构建时间及 `portable`/`packaged` 状态，明确区分 `win-unpacked`、portable 与开发运行。
- [ ] `e2e` 启动刚生成的构建目录，断言版本、安装能力和签名无阻断；不能只测试旧 `dist` 或 mock UI。
- [ ] 复现用户的 `win-unpacked` 启动方式，并单独验证最终携带版；产物启动后诊断必须与当前源码行为一致。
- [ ] 不将 `ELECTRON_RUN_AS_NODE` 注入问题误判为应用功能通过；运行打包 exe 前清除冲突环境变量。

## Task 4：用用户这类包完成端到端回归

**Files:**
- Modify: `tests/integration/officialInstall.real.test.ts`
- Modify: `tests/integration/officialDeploy.real.test.ts`
- Modify: `docs/TEST_MATRIX.md`
- Modify: `docs/FEATURE_GAP.md`

- [ ] 取得并使用发生问题的同一安装包，或同版本、同发布渠道的官方包；记录 SHA-256 和签名状态仅作测试描述，不将签名状态用于通过/失败判定。
- [ ] 在隔离临时目录执行完整安装：选择产品 → 检测包结构/版本 → 解包 → 完整树校验 → 部署 → 自动登记 → 创建桌面快捷方式 → 复扫。
- [ ] 验证最终实例行立即具备启动、更新、卸载，不需要重启、重扫按钮或手工登记。
- [ ] 对更新至少验证成功与中途失败回滚；另一产品和同产品其他副本的路径与文件哈希保持不变。
- [ ] 对卸载验证目标目录移除、管理登记更新、用户数据保留、另一产品/副本不变。
- [ ] 若没有用户问题中的原包，明确标记“该原包未复测”，但必须用现存官方包做真实部署；不得把跳过测试计为通过。

## Task 5：验证、更新版本并产出携带版

**Files:**
- Modify: `package.json`（通过测试后升至 `0.6.1`）
- Modify: `README.md`
- Modify: `docs/USER_GUIDE.md`
- Modify: `docs/TEST_MATRIX.md`

- [ ] 运行并记录真实结果：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
$env:NODE_OPTIONS = $null
npm run typecheck
npm test -- --run
npm run build
npm run e2e
npm run scan:report
```

- [ ] 增加包签名状态矩阵：Valid、NotSigned、Unknown、证书换签；四种状态均不能单独阻断安装/更新。
- [ ] 只生成携带版，不生成 NSIS/zip；用当前 build 重新打包，不复用旧产物。
- [ ] 复制最终携带版到新的临时目录运行，检查 `buildId`、portable 状态、安装页、诊断导出和错误日志位置。
- [ ] 验收报告必须说明：NotSigned 官方包是否完成安装、自动登记和快捷方式；真实更新/卸载结果；构建标识；测试通过/失败；SHA-256；仍未交付事项。

## 完成标准

- [ ] `Authenticode: NotSigned` 不再阻止用户选择的包进入安装/更新；错误不再出现“签名无效不允许启动”。
- [ ] 产品明确不匹配、版本无法识别、应用树不完整、路径越界、归档危险仍会以具体原因拒绝。
- [ ] 新诊断不再将 0.6.0 报告中的旧“只读/虚拟机证据”作为当前状态；诊断 buildId 与运行产物一致。
- [ ] 官方包完成真实隔离安装，完成后自动登记并创建桌面快捷方式；更新和卸载针对目标实例真实生效。
- [ ] 国内版、国际版及同产品多副本相互隔离，用户数据保留。
- [ ] 所有测试结果如实区分真实包、隔离目录、mock 和跳过项。

## WorkBuddy 汇报格式

只汇报事实：代码中移除的签名拦截点；Valid/NotSigned/Unknown/换证测试结果；用户问题原包是否实测；安装后自动登记与快捷方式结果；更新/卸载真实隔离测试；新构建标识与产物 SHA-256；命令通过/失败；仍未完成事项。不要把按钮出现、单元测试或跳过的官方包用例写成真实安装已通过。

---

## 执行状态（2026-10-19 20:40，v0.6.1）

| Task | 状态 | 说明 |
| --- | --- | --- |
| 1 解除 Authenticode 硬阻断 | **完成** | `packageVerifier` / `evaluateAssistedPackage` / 安装 / 更新 / 卸载器 / 启动 六处签名门全部移除；签名只写诊断；`approveSigner` 与 signer-trust 操作依赖删除；产品不匹配、归档危险、应用树不完整、版本缺失仍拒绝 |
| 2 移除证据门与过时诊断 | **完成** | `deriveCapabilities` 不再依赖证据（恒 `full`、无 blocker）；诊断 schema v3 输出 `build` + `deployment` + `lastOperation`，不再输出 read-only/证据包/在线源 |
| 3 确认运行正确构建 | **完成** | 构建前清空 `dist/`；注入 `buildId`/`buildTime`；`getState`/诊断/E2E 均带构建标识；`npm run e2e` 先构建；win-unpacked 与携带版冒烟均确认 `0.6.1` + 同一 `buildId` |
| 4 用用户这类包端到端回归 | **未完成** | 本机无 WorkBuddy 官方安装包（Downloads/桌面/artifacts 均无），`official*.real.test.ts` 跳过；**用户问题原包未复测** |
| 5 验证、升版本、产携带版 | **部分完成** | typecheck / 257 测试 / build / e2e / scan:report 均通过；已升 `0.6.1` 并只产出 `release-portable/*-portable.exe`；真实包安装/更新/卸载未验证 |

**未完成事项：** 真实 NotSigned 官方包的端到端安装（含自动登记、快捷方式）、真实包更新与卸载、仅 C 盘/C+D 盘实机。

**环境事件：** 测试临时目录累积 27 GB 导致 C 盘写满、测试批量失败；清理 `%TEMP%\wb-*` 后恢复。
