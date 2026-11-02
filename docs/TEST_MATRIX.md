# 验证矩阵与证据基线

> 规则：**没有证据的条目一律写"未验证"**，不得因为命令能启动、窗口能打开就标记成功。
> 每个破坏性场景必须在可重置虚拟机快照中执行，禁止在日常使用的宿主机上运行官方安装器/卸载器。

## 1. 采集环境

### 1.1 本轮开发环境（仅用于构建、单元测试、界面冒烟）

| 项目 | 值 | 采集时间 |
| --- | --- | --- |
| 操作系统 | Microsoft Windows 10 专业工作站版，10.0.19045，x64 | 2026-10-18 |
| 账户 | 本地管理员账户（用户名已脱敏） | 2026-10-18 |
| Node.js | v22.22.2（托管运行时） | 2026-10-18 |
| npm | 10.9.7 | 2026-10-18 |
| Electron | 33.4.11 | 2026-10-18 |
| electron-builder | 25.1.8 | 2026-10-18 |
| TypeScript | 5.9.3 | 2026-10-18 |
| Vitest | 2.1.9 | 2026-10-18 |
| esbuild | 0.24.2 | 2026-10-18 |
| 磁盘剩余（E:） | 425.3 GB | 2026-10-18 |

### 1.2 可重置验证环境：**不可用（阻断）**

| 检查项 | 结果 | 命令/来源 | 时间 |
| --- | --- | --- | --- |
| Windows Sandbox 功能 | `Disabled` | `Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM` | 2026-10-18 17:56 |
| Hyper-V PowerShell 模块 | 不存在（`Get-VM` 不可用） | `Get-Command Get-VM` | 2026-10-18 17:56 |
| 其他虚拟机工具 | 未安装 | 环境盘点 | 2026-10-18 17:56 |

**结论：Task 2（隔离虚拟机验证官方安装器与共存前提）无法执行，验证门未通过。**
因此 Task 7（一键安装）、Task 8（一键卸载/更新）的自动化能力保持关闭，MVP 按计划降级为"只读检测 + 官方安装说明"。

### 1.3 已知执行限制

| 限制 | 影响 | 处理方式 |
| --- | --- | --- |
| 开发沙箱禁止启动 `reg.exe`（Program Blacklist） | 本机无法实测注册表读取链路，扫描结果为"spawn EPERM"并作为跳过项展示 | 用固定文本样例对解析器做单元测试（`tests/unit/registry.test.ts`）；真机读取需在普通 Windows 环境复测 |
| 宿主环境注入 `ELECTRON_RUN_AS_NODE` | 直接启动 electron 会以纯 Node 运行并报 `app` 未定义 | `scripts/e2e.mjs` 启动前移除该变量；分发安装包不受影响 |
| 无 GPU 进程 | Electron 启动崩溃 | 仅冒烟测试加 `--disable-gpu --no-sandbox`，正常运行时保持默认安全设置 |
| Vitest 默认缓存写入系统临时目录被拦截 | 测试文件偶发加载失败（`EPERM ... \Temp\...\ssr\...`） | `vitest.config.ts` 设 `cacheDir: ".vitest-cache"`，连续 3 次运行 86/86 稳定通过 |

## 2. 证据表（Task 2 目标）

所有字段当前为 **未验证**：本轮未下载、未执行任何官方安装包，也未取得签名信息。

| 字段 | 国内版 WorkBuddy | 国际版 WorkBuddy AI |
| --- | --- | --- |
| 候选版本 | 5.8.3（**未验证**，仅历史记录） | 5.8.4（**未验证**，仅历史记录） |
| 官方页面 URL | 未采集 | 未采集 |
| 官方版本 API | 未采集 | 未采集 |
| 下载 URL 主机 | 未采集 | 未采集 |
| 包 SHA-256 | 未采集 | 未采集 |
| Authenticode `Status` | 未采集 | 未采集 |
| 证书主题 / 指纹 / 有效期 | 未采集 | 未采集 |
| 安装后 `applicationName` | 未采集（历史记录：`WorkBuddy`，未复现） | 未采集（历史记录：`WorkBuddy AI`，未复现） |
| 安装后 `dataFolderName` | 未采集（历史记录：`.workbuddy`，未复现） | 未采集（历史记录：`.workbuddy-ai`，未复现） |
| 安装器范围（当前用户/所有用户） | 未验证 | 未验证 |
| 自定义路径参数 | 未验证 | 未验证 |
| 无人值守能力 | 未验证 | 未验证 |
| 注册表卸载项 | 未验证 | 未验证 |
| 快捷方式 / 协议关联 / 启动项 | 未验证 | 未验证 |
| 数据目录 | 未验证 | 未验证 |
| 启动进程可执行路径 | 未验证 | 未验证 |
| 内置更新触发条件 | 未验证 | 未验证 |
| 内置更新是否可安全接管 | 未验证 | 未验证 |
| 卸载器参数 / 是否保留用户数据 | 未验证 | 未验证 |
| 证据时间 | — | — |

**缺失项汇总（停在验证门，不推测补齐）：** 官方下载来源、安装包哈希、签名发布者、安装器参数、安装/卸载对另一产品的影响。

## 3. 端到端测试矩阵

图例：`通过` = 有可复现证据；`未验证` = 未执行；`阻断` = 因环境缺失无法执行。

### 3.1 安装器与共存（需虚拟机，Task 2/7）

| 编号 | 场景 | 期望 | 结果 |
| --- | --- | --- | --- |
| E2E-01 | 干净快照安装国内版到自定义路径 | 安装成功、身份字段符合证据 | 阻断（无 VM） |
| E2E-02 | 干净快照安装国际版到自定义路径 | 同上 | 阻断（无 VM） |
| E2E-03 | 先国内版后国际版 | 两目录、两数据目录、两快捷方式互不覆盖 | 阻断（无 VM） |
| E2E-04 | 先国际版后国内版（反向顺序） | 同上 | 阻断（无 VM） |
| E2E-05 | 两版同时启动 | 两个进程可执行路径与产品身份匹配 | 阻断（无 VM） |
| E2E-06 | 升级其中一版后另一版仍可启动 | 另一版不受影响 | 阻断（无 VM） |
| E2E-07 | 官方卸载一版 | 另一版仍可启动，用户数据保留 | 阻断（无 VM） |
| E2E-08 | 安装器是否覆盖另一产品安装位置 | 不覆盖；若覆盖则登记为阻断项 | 阻断（无 VM） |
| E2E-09 | 启动期内置更新触发条件 | 记录触发条件与可逆控制手段 | 阻断（无 VM） |

### 3.2 管理器自身（可在普通环境执行）

| 编号 | 场景 | 期望 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| UI-01 | 五个页签渲染 | 两个产品卡片、两行安装行 | 通过 | `artifacts/e2e-*.png`（本地，不入库） |
| UI-02 | 只读模式提示 | 顶部横幅列出阻断原因，写操作按钮禁用 | 通过 | 同上 |
| UI-03 | 扫描失败降级 | 注册表读取被拦截时显示"跳过项"而非崩溃 | 通过 | 截图 `e2e-overview`：`spawn EPERM` 作为跳过项 |
| UI-04 | 中文路径 / 窄窗口 / 高对比度 | 布局不破版 | 未验证（仅静态检查） | — |
| UI-05 | 键盘可达性 | Tab 顺序与焦点可见 | 未验证（仅实现 focus-visible 样式） | — |

### 3.3 核心逻辑（自动化测试，可在任意平台执行）

| 编号 | 场景 | 结果 | 位置 |
| --- | --- | --- | --- |
| UT-01 | 路径守卫：根目录/UNC/短名/`..`/重解析点/大小写 | 通过 | `tests/unit/pathGuard.test.ts` |
| UT-02 | 身份核验：未验证 profile → unknown；装错产品 → mismatch | 通过 | `tests/unit/identity.test.ts` |
| UT-03 | 扫描：双版本识别、路径共享冲突、重解析点、跳过原因、受管标记、从卸载命令推导路径、快捷方式发现、去重 | 通过 | `tests/unit/scanner.test.ts` |
| UT-04 | 状态机：非法迁移、中断只允许验证/回滚 | 通过 | `tests/unit/journal.test.ts` |
| UT-05 | 预演：能力门阻断、精确路径、非受管不可卸载 | 通过 | `tests/unit/plan.test.ts` |
| UT-06 | 证据包：空/非法/字段缺失/完整 | 通过 | `tests/unit/plan.test.ts` |
| UT-07 | 包校验：坏签名、非信任发布者、错产品、无产品名、哈希不符 | 通过 | `tests/unit/packageVerifier.test.ts` |
| UT-08 | 发布来源：非白名单主机、重定向、schema 变化、超大、取消、哈希不符 | 通过 | `tests/unit/releaseSource.test.ts` |
| UT-09 | 注册表输出解析（含空值、脏行） | 通过 | `tests/unit/registry.test.ts` |
| UT-10 | 日志脱敏与凭据行丢弃 | 通过 | `tests/unit/redact.test.ts` |
| UT-11 | `.lnk` 解析：正常目标、IDList、无 LinkInfo、坏魔数、坏 CLSID、越界偏移、相对路径 | 通过 | `tests/unit/shortcut.test.ts` |
| UT-12 | `app.asar` 头部解析：扁平表、嵌套目录、坏 JSON、短前缀、缺失条目 | 通过 | `tests/unit/asar.test.ts` |
| UT-13 | 身份核验：`productName` 优先于两版相同的 `name`；asar 内元数据；asar 损坏 | 通过 | `tests/unit/identity.test.ts` |
| IT-01 | 事务：提交、失败回滚、缺少备份拒绝覆盖、删除需登记、路径逃逸、磁盘不足、取消、幂等、崩溃恢复、重复回滚 | 通过 | `tests/integration/transaction.test.ts` |

## 4. 本轮实际执行的命令与结果

| 时间 | 命令 | 结果 |
| --- | --- | --- |
| 2026-10-18 17:55 | `git status --short --branch` | `## No commits yet on master`；仅 `README.md`、`EXECUTION_PLAN.md` 未跟踪 |
| 2026-10-18 17:58 | `npm install` | 成功，449 个包 |
| 2026-10-18 18:09 | `npm run typecheck`（`tsc -p tsconfig.json`） | 通过，0 错误 |
| 2026-10-18 18:09 | `npm test -- --run` | 10 个测试文件、86 个测试全部通过 |
| 2026-10-18 18:10 | `npm run build` | 通过，产物 `dist/main`、`dist/preload`、`dist/renderer`、`dist/config` |
| 2026-10-18 18:10 | `npm run e2e` | 通过，5 张页签截图 + 2 个产品卡片 + 2 行安装行 |
| 2026-10-18 18:13 | `npm run dist:win` | 通过（首次，输出 `release/`） |
| 2026-10-18 18:14 | 第二次 `npm run dist:win` | **失败**：`release\win-unpacked\resources\app.asar` 被其它进程占用；改用 `-c.directories.output=release2` 后成功 |
| 2026-10-18 18:16 | 打包产物冒烟（`release2/win-unpacked/...exe --e2e`） | 通过，资源与 `config/` 正确加载，界面仍为只读模式 |
| 2026-10-18 18:42 | 携带版冒烟（复制到独立目录运行 `--e2e`） | 通过，`WorkBuddyDualEdition-Data` 生成在 exe 同级 |
| 2026-10-18 19:42 | `npm run typecheck` / `npm test -- --run` | 通过；12 个测试文件、111 个测试 |
| 2026-10-18 19:42 | `npm run scan:report`（只读扫描） | 通过：2 条记录，均来自快捷方式，身份读到 `WorkBuddy 5.8.3` / `WorkBuddy AI 5.8.4`，判定 `unknown` |
| 2026-10-18 19:45 | `Get-AuthenticodeSignature`（两个主程序，只读） | 均 `Valid`，发布者 `CN=Tencent Technology (Shenzhen) Company Limited` |
| 2026-10-18 19:47 | `npm run dist:portable`（重新打包） | 通过，哈希见 5.1 节更新 |

**注：** `reg.exe` 在本执行环境中被安全策略拦截（Program Blacklist），因此注册表读取在部分运行中返回 `spawn EPERM`，
被扫描器作为"跳过项"展示；注册表解析逻辑由 `tests/unit/registry.test.ts` 用固定文本样例覆盖。

## 5. 发布构建记录

| 项目 | 值 |
| --- | --- |
| 构建命令 | `npx electron-builder --win nsis --x64 --publish never -c.directories.output=release2` |
| 目标 | Windows x64，NSIS，per-user（`perMachine: false`），`allowElevation: false` |
| 产物 | `release2/workbuddy-dual-edition-manager-0.1.0-x64.exe` |
| 体积 | 82,174,781 字节 |
| SHA-256 | `c8438e471328580c8dd5e1d93dca09460e4b2a26d5fbd16b79bfa2dfce7d41c4` |
| 签名 | **未签名**（无代码签名证书），仅作测试构建；`signAndEditExecutable` 已启用但无 `CSC_LINK` |
| 图标 | 使用 Electron 默认图标（未提供 `.ico`） |
| 已知问题 | 重复打包时若 `win-unpacked` 被占用会失败；本机因安全删除策略无法清理该目录，改用新输出目录规避 |

### 5.1 携带版（portable）构建记录

| 项目 | 值 |
| --- | --- |
| 构建命令 | `npm run dist:portable`（`electron-builder --win portable zip --x64 -c.directories.output=release-portable`） |
| 单文件携带版 | `release-portable2/workbuddy-dual-edition-manager-0.1.0-x64-portable.exe` |
| 体积 / SHA-256 | 74,494,067 字节 / `f41aba6d8115fb31a2c24227e2ef966843938637c7bd8f22c5d87e2954dab765` |
| 绿色目录版 | `release-portable2/workbuddy-dual-edition-manager-0.1.0-x64.zip` |
| 体积 / SHA-256 | 111,874,131 字节 / `00684bbab1359bfeb29480966b988dba03eab6f663f24f08d64902d651b222bd` |
| 签名 | **未签名**（无证书） |
| 便携行为验证 | 2026-10-18 20:05，把 portable.exe 复制到独立临时目录后运行（`--e2e`）：进程启动、单页界面渲染、`WorkBuddyDualEdition-Data\` 在 exe 同级生成，未写入 `%APPDATA%` |
| 本次重打包 | 2026-10-18 20:05，输出到 `release-portable2/`（旧的 `release-portable/` 因本机安全删除策略无法清理，改用新目录） |
| 打包产物冒烟 | 通过：产品卡片 2、安装条目 3、状态均为“已识别（管理操作未开放）”、版本下拉框 0 |

### 5.2 宿主机只读观察（**不构成验收证据**）

按计划"宿主机只可做只读检查并将结果脱敏后报告"的授权，2026-10-18 19:42–19:45 执行了一次只读扫描
（`npm run scan:report`，无窗口、无写入、不读用户数据）。观察到：

| 观察项 | 国内版 | 国际版 |
| --- | --- | --- |
| 发现来源 | 开始菜单快捷方式目标 | 开始菜单快捷方式目标 |
| 安装目录 | `E:\Programs\workbuddy` | `F:\WorkBuddy-AI` |
| 主程序 | `WorkBuddy.exe` | `WorkBuddyAI.exe` |
| 元数据位置 | `resources/app.asar#package.json` | `resources/app.asar#package.json` |
| `productName` | `WorkBuddy` | `WorkBuddy AI` |
| `version` | `5.8.3` | `5.8.4` |
| `name`（两版相同，不可用于区分） | `@genie/workbuddy-desktop` | `@genie/workbuddy-desktop` |
| 文件版本资源 | `5.8.3.0` | `5.8.4.0` |
| Authenticode `Status` | `Valid` | `Valid` |
| 签名主体 | `CN=Tencent Technology (Shenzhen) Company Limited, O=..., C=CN` | 同左 |
| 证书到期 | 2028-11-05 | 2028-10-13 |
| 注册表卸载登记 | `HKLM` 一条，`InstallLocation` 为空 | `HKLM` 一条 + `HKCU` 一条，`InstallLocation` 均为空 |
| 工具判定 | `unknown`（身份基线未核实） | `unknown`（身份基线未核实） |

**这些观察能说明什么、不能说明什么：**

- 能说明：两个产品**同时存在于本机**，安装目录、主程序名、`productName`、版本各不相同；两者的元数据都打包在 `app.asar` 内；
  注册表卸载项**没有** `InstallLocation`，必须靠快捷方式或从 `UninstallString` 推导才能定位。
- **不能**说明：安装器是否支持自定义路径、是否会覆盖另一版、两版数据目录是否真正独立、内置更新如何触发、
  卸载器是否保留用户数据。这些必须由 Task 2 的虚拟机证据回答。
- 因此能力门保持 `read-only`，一键安装/更新/卸载继续关闭；上述数据只用于校准解析逻辑，**没有**写入 `config/evidence.json`。

---

# 第二阶段：通用安装检测与界面精简（2026-10-18）

> 对应 `EXECUTION_PLAN.md`「下一阶段执行单」。本阶段只做只读发现、状态区分、界面精简与测试，
> 不运行任何客户端安装器/卸载器/更新器，不写入客户端目录或用户数据。

## 6. 检测来源矩阵

| # | 来源 | 实现 | 本机可用性 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 卸载登记（HKCU + HKLM 32/64） | `src/main/adapters/windows.ts` + `src/core/scanner.ts` | **部分**：本执行环境禁止 `reg.exe`，返回 `spawn EPERM` 并作为跳过项展示 | 登记显示名含 WorkBuddy 即保留；`InstallLocation` 为空不再丢弃 |
| 2 | 登记字段推导（DisplayIcon → UninstallString → InstallSource） | `deriveLocationCandidates()` | 单元测试覆盖 | 只做字符串解析，**从不执行**命令行；路径必须规范化并确认存在 |
| 3 | 运行中进程可执行路径 | `src/main/adapters/processes.ts`（CIM 过滤，仅取名字含 workbuddy 的进程） | **可用** | 进程名只作为路径线索，不判定身份 |
| 4 | 桌面 / 开始菜单快捷方式 | `src/main/adapters/shortcuts.ts` + `src/core/shortcut.ts` | **可用** | 自行解析 `.lnk` 的 LinkInfo，不启动目标程序 |
| 5 | 有界常见位置 | `src/main/adapters/commonLocations.ts` | 可用（本机两版都不在这三处） | 只看 `%LOCALAPPDATA%\Programs`、`%ProgramFiles%`、`%ProgramFiles(x86)%` 的直接子目录 |
| 6 | 用户指定目录补扫 | `settings.userScanRoots` | 可用 | 支持多个目录，界面可增删 |

多条线索指向同一路径时合并为一份安装并保留全部线索；同一路径的多条卸载登记合并为一份并标注“重复登记”。

## 7. 状态模型（发现 / 身份 / 授权三层分离）

| 层 | 取值 | 含义 |
| --- | --- | --- |
| `discovery` | `not-found` / `registry-only` / `path-found` | 有没有登记、有没有解析出**存在**的路径 |
| `identity` | `unverified` / `identified` / `conflict` | 路径上的东西是不是目标产品（`confidence`: `verified` / `observed`） |
| 写操作授权 | 由证据门 `capability` 单独控制 | 与上面两层无关；无证据时恒为 `read-only` |

界面三态：`未发现` / `已发现，身份待确认`（或“登记已发现，路径待解析”）/ `已识别（管理操作未开放）`；
身份冲突或元数据损坏显示 `需人工确认`。

## 8. 自动化测试

| 编号 | 覆盖 | 结果 | 位置 |
| --- | --- | --- | --- |
| T-01 | `InstallLocation` 存在 / 为空但 `DisplayIcon` 有效 / 仅 `UninstallString` / `InstallSource` | 通过 | `tests/unit/scanner.test.ts` |
| T-02 | 32/64 与 HKCU 视图、两版各自路径、AI 重复登记合并、同产品多份安装保留 | 通过 | 同上 |
| T-03 | 进程 / 快捷方式 / 常见位置 / 用户目录补扫；线索去重；坏快捷方式、无效路径、重解析点给出跳过原因 | 通过 | 同上 |
| T-04 | 无证据包时 `identity=identified` + `confidence=observed`，但计划仍因能力门阻断 | 通过 | `tests/unit/scanner.test.ts` + `tests/unit/plan.test.ts` |
| T-05 | 无已核验端点时不发请求；UI 无版本下拉框、显示“尚未配置” | 通过 | `tests/unit/releaseSource.test.ts` + `npm run e2e` |
| T-06 | 身份识别（observed / verified / mismatch）、asar 元数据、`productName` 优先级 | 通过 | `tests/unit/identity.test.ts` |
| T-07 | 注册表输出解析（含空值、脏行、重复项） | 通过 | `tests/unit/registry.test.ts` |
| T-08 | `.lnk` 解析、asar 头部解析 | 通过 | `tests/unit/shortcut.test.ts`、`tests/unit/asar.test.ts` |

命令与结果：

| 时间 | 命令 | 结果 |
| --- | --- | --- |
| 2026-10-18 19:54 | `npm run typecheck` | 通过，0 错误 |
| 2026-10-18 19:54 | `npm test -- --run` | **12 个测试文件、122 个测试全部通过** |
| 2026-10-18 19:56 | `npm run build` | 通过 |
| 2026-10-18 19:56 | `npm run e2e` | 通过：产品卡片 2、安装条目 3、状态均为“已识别（管理操作未开放）”、版本下拉框 0 个、在线来源显示“尚未配置” |
| 2026-10-18 20:00 | `npm ci --ignore-scripts`（仅在含 package.json + package-lock.json 的临时副本中执行） | 通过，449 个包，锁文件完整。**未**在项目目录直接执行 `npm ci`：本机安全删除策略会拦截 `node_modules` 清理，存在破坏开发环境风险 |
| 2026-10-18 20:17 | 依赖修复后回归 `npm run typecheck` / `npm test -- --run` | 通过，12 文件 / 122 测试（曾误触发一次 `npm ci`，已用 `npm install` + `electron/install.js` 恢复，回归通过） |

## 9. 本机只读验收（2026-10-18 19:57）

`npm run scan:report`（无窗口、只读）：

| 产品 | 路径 | 版本 | 线索来源 | 发现 | 身份 |
| --- | --- | --- | --- | --- | --- |
| 国内版 WorkBuddy | `E:/Programs/workbuddy` | 5.8.3 | 快捷方式（WorkBuddy） | `path-found` | `identified`（observed） |
| 国内版 WorkBuddy（副本） | `E:/WorkBuddy-CN` | 5.8.3 | 运行中进程（WorkBuddy.exe） | `path-found` | `identified`（observed） |
| 国际版 WorkBuddy AI | `F:/WorkBuddy-AI` | 5.8.4 | 快捷方式 + 运行中进程 | `path-found` | `identified`（observed） |

- 国内版**两份安装全部列出**，标记为“副本 1/2、2/2”“主副本关系未知”，没有自动选择、合并或清理。
- 两个产品均判定 `found`，写操作按钮全部禁用并说明原因。
- 本机注册表登记未参与（`reg.exe` 被本执行环境拦截），因此“空 InstallLocation → 登记待解析”路径只由单元测试覆盖，
  真机复测需要在允许调用 `reg.exe` 的普通 Windows 环境执行。
- 全程未启动任何客户端进程（进程线索来自读取已运行进程的路径），未写入客户端目录、注册表或用户数据。

## 10. 仍未覆盖 / 限制

- `reg.exe` 被本执行环境拦截：注册表来源只能靠单元测试与解析器验证，真机注册表链路待复测。
- 无 Windows Sandbox / Hyper-V：安装器行为、共存、更新、卸载仍无证据，写操作保持关闭。
- 签名异常检测目前只用于安装包校验，扫描阶段未对已安装主程序做 Authenticode 校验（避免扫描期大量签名解析）。
- 界面可达性（键盘遍历、高对比度、缩放）仍只做了静态样式支持。

---

# 第三阶段：检测来源与诊断信息降噪（2026-10-18）

> 对应 `EXECUTION_PLAN.md`「检测来源与诊断信息降噪」。只改只读扫描的统计口径、呈现与诊断导出，
> 未新增安装/更新/卸载能力，能力门仍为 `read-only`。

## 11. 统计口径

| 概念 | 口径 | 实现 |
| --- | --- | --- |
| 安装份数 | 按规范化后的**实际安装目录**去重，且只统计身份证据不冲突的记录 | `src/core/scanner.ts` 以路径建键，同路径多线索合并 |
| 线索数 | 每条来源命中计 1 条，仅用来说明"扫描看到多少条证据" | `sources[]`，界面标注"线索数，不等于安装份数" |
| 多进程 | 同一目录的多个相关进程只增加线索数，不增加安装份数 | 路径键相同 → 合并 |
| 冲突候选 | 元数据与已知产品不匹配、管理器自身目录等，进"其他候选"，**不计入任一产品** | `productHint=conflict` / `isManagerSelf` |
| 登记待解析 | 有登记但路径解析不出 → `registry-only`，不进安装份数 | `discovery=registry-only` |

## 12. 快捷方式降噪

`src/core/scanner.ts` 先按名称相关性分流，再决定是否计入跳过项：

| 情况 | 处理 | 界面呈现 |
| --- | --- | --- |
| 名称相关、目标无法解析 | 计入跳过项，按条汇总 | "N 个与 WorkBuddy 相关的快捷方式无法解析…" |
| 名称无关、目标无法解析 | 只计数，不逐条列出 | 弱化一行"另有 N 个与本产品无关的快捷方式无法解析，已忽略" |
| 名称相关、目标可解析 | 作为路径线索，按规范化路径去重 | 安装项的"线索" |

本机（电脑 A）实测：47 个无关快捷方式解析失败 → 从"47 条跳过项"收敛为 1 行弱化汇总；
WorkBuddy 相关的跳过项为 0 条，其余 3 条跳过项均为注册表 `spawn EPERM`。

## 13. 界面与诊断导出

- 来源区标题为"检测线索"，并常驻说明"下面统计的是线索数量，不等于安装份数"。
- 跳过项、其他候选、补充扫描目录三块默认折叠；补充目录为空只显示"尚未添加补充扫描目录（可选功能，不影响自动检测）"。
- 计数为 0 的来源不渲染；`shortcuts:unrelated` 不进"影响检测的跳过项"计数。
- 导出脱敏诊断：路径经 `maskPath()` 收敛为"盘符 + 层级 + 末级目录 + 短哈希"，文本经 `sanitizeText()` 替换
  用户主目录、绝对路径与凭据样式字符串；保留来源类型、聚合数量、产品状态与能力门阻断原因。

## 14. 自动化测试

| 编号 | 覆盖 | 结果 | 位置 |
| --- | --- | --- | --- |
| T-20 | 同一目录的多进程不增加安装份数，线索数去重后统计 | 通过 | `tests/unit/scanner.test.ts` |
| T-21 | 无关坏快捷方式不进 WorkBuddy 跳过项，只做弱化汇总 | 通过 | 同上 |
| T-22 | 名称相关坏快捷方式形成汇总提示，数量按条统计 | 通过 | 同上 |
| T-23 | 元数据与已知产品不匹配的候选：保留冲突诊断，不计入任一产品 | 通过 | 同上 |
| T-24 | 管理器自身运行目录不计入产品、不标需人工确认 | 通过 | 同上 |
| T-25 | 脱敏导出不含用户名、完整个人路径、命令行、令牌；保留排障字段 | 通过 | `tests/unit/diagnostics.test.ts` |
| T-26 | 跳过项按类别聚合、路径清洗；补充目录为空不算错误 | 通过 | 同上 |

命令与结果：

| 时间 | 命令 | 结果 |
| --- | --- | --- |
| 2026-10-18 21:34 | `npm run typecheck` | 通过，0 错误 |
| 2026-10-18 21:34 | `npm test -- --run` | **13 个测试文件、135 个测试全部通过** |
| 2026-10-18 21:35 | `npm run build` | 通过 |
| 2026-10-18 21:35 | `npm run e2e` | 通过：产品卡片 2、安装条目 3、来源标题"检测线索"、版本下拉框 0 |
| 2026-10-18 21:35 | `npm run scan:report`（dev 入口，只读） | 通过：3 条记录、1 条多副本提示、4 条跳过项（3 注册表 + 1 无关快捷方式汇总） |

## 15. 本机只读复测（2026-10-18 21:35，电脑 A）

| 产品 | 路径 | 版本 | 路径来源 | 发现 | 身份 |
| --- | --- | --- | --- | --- | --- |
| 国内版 WorkBuddy | `E:\Programs\workbuddy` | 5.8.3 | 快捷方式 | `path-found` | `identified`（observed） |
| 国内版 WorkBuddy（副本） | `E:\WorkBuddy-CN` | 5.8.3 | 运行中进程 | `path-found` | `identified`（observed） |
| 国际版 WorkBuddy AI | `F:\WorkBuddy-AI` | 5.8.4 | 快捷方式 + 运行中进程 | `path-found` | `identified`（observed） |

- 来源线索：快捷方式 2 条、运行中进程 2 条（同一目录的多进程已去重）。
- 安装份数：国内版 2 份、国际版 1 份，与第二阶段一致；`win-unpacked` 类候选未被计入任一产品。
- 注册表：`scan:report` 模式下 `reg.exe` 仍被拦截（`spawn EPERM`）。便携版 GUI 冒烟时曾读到
  "卸载登记 2 条线索"，但该结果不稳定复现，故**不**记为注册表链路已验证。
- 脱敏检查：导出报告全文不含 `Administrator`、`C:\Users`、`AppData`、`token`、`Bearer`、`password`；
  仅保留安装路径（排障必需），用户主目录形式被替换。

## 16. 0.1.1 携带版构建记录

| 项目 | 值 |
| --- | --- |
| 版本 | 0.1.0 → **0.1.1**（仅打包/统计/呈现变更） |
| 构建命令 | `electron-builder --win portable zip --x64 --publish never -c.directories.output=release-portable3` |
| 单文件携带版 | `release-portable3/workbuddy-dual-edition-manager-0.1.1-x64-portable.exe` |
| 体积 / SHA-256 | 74,499,294 字节 / `60510cb8dc0847406e7b87cc61331c6a430723182ed7aba22899ad6367130c7c` |
| 绿色目录版 | `release-portable3/workbuddy-dual-edition-manager-0.1.1-x64.zip` |
| 体积 / SHA-256 | 111,881,145 字节 / `ff7e349ff975f5004504a497863a92b38ed062677034f0b102761033c475e923` |
| 签名 | **未签名**（无证书） |
| 携带版冒烟 | 2026-10-18 21:42，复制到独立临时目录运行 `--e2e`：退出码 0、界面渲染 2 产品 / 3 安装条目、`WorkBuddyDualEdition-Data\` 生成在 exe 同级、未写 `%APPDATA%` |
| 打包版只读扫描 | 同上，`--scan-report` 退出码 0，3 条记录与 dev 入口一致 |

**打包/冒烟的环境陷阱（新增记录）**：本执行环境向子进程注入 `ELECTRON_RUN_AS_NODE=1`，
打包后的 exe 会以纯 Node 方式启动并报 `bad option: --e2e`（退出码 9）。必须清除
`ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` 后再运行，`scripts/e2e.mjs` 已内置该处理。

## 17. 本阶段限制

- 跨电脑（电脑 B）验证未执行：需用户携带 `0.1.1` 携带版回去，按交接清单验收。
- 注册表来源仍未稳定验证（`reg.exe` 拦截与调用链相关）。
- 安装/更新/卸载能力仍未开放，证据门未变化。

---

# 第四阶段：按产品 × 按操作的辅助启动（2026-10-18）

> 对应 `EXECUTION_PLAN.md`「基于真实共存结果完善双版本管理」。
> 本阶段把“能不能操作”从单一总开关拆成**每产品 × 每操作**，并提供
> 「预检 → 用户确认 → 启动官方交互式界面 → 复扫」的辅助流程。
> **未**实现静默安装、自动更新接管、静默卸载，也**未**执行任何真实安装器/更新器/卸载器。

## 18. 证据来源分级（本阶段必须区分）

| 证据 | 内容 | 来源 | 能否作为验收依据 |
| --- | --- | --- | --- |
| A 机共存识别 | 国内版 2 份（`E:\Programs\workbuddy` 5.8.3、`E:\WorkBuddy-CN` 5.8.3），国际版 1 份（`F:\WorkBuddy-AI` 5.8.4） | 用户手动运行 + 本机只读复测 | 可作**共存识别**证据 |
| B 机共存识别 | 国内版 1 份（`F:\Program Files\WorkBuddy` 5.7.7），国际版 1 份（`H:\Programs\WorkBuddyAI` 5.7.6），`F:\code\win-unpacked` 判为管理器自身目录 | **用户手动测试并在对话中提供**，非本次复测 | 可作**共存识别**证据，不覆盖 B 机的安装器行为 |
| 安装器/更新器/卸载器行为 | 静默参数、自定义目录、是否覆盖、是否保留用户数据 | **无** | 不可作依据；本阶段全部不自动执行 |

**不得**由 A/B 的识别结果推断安装器安全性；本阶段的能力矩阵不依赖这类推断。

## 19. 能力矩阵（每产品 × 每操作）

状态语义：`assisted` = 可在用户确认后启动官方界面；`guidance-only` = 只给人工指引；`blocked` = 安全检查阻止。

| 操作 | 判定条件 | 本机实测状态（电脑 A） |
| --- | --- | --- |
| 安装 | 该产品无「身份冲突 / 需人工确认」记录；安装包须通过签名与产品身份预检 | 国内版、国际版均 `assisted` |
| 更新 | 需已识别**唯一**副本；多副本一律 `guidance-only`（无法可靠约束官方安装器只更新指定副本）；无官方在线来源时只允许本地包 | 国内版 `guidance-only`（2 份副本），国际版 `assisted`（1 份） |
| 卸载 | 逐实例判定：有可直接启动的本地卸载程序且位于安装目录内才 `assisted`；`MsiExec` / `rundll32` / 路径失效 → `guidance-only` | 两版均 `guidance-only`（本环境 `reg.exe` 被拦，无卸载命令可解析） |

判定逻辑在 `src/core/assisted.ts::deriveOperationAvailability`，与扫描结果解耦，可单测。

## 20. 辅助启动的安全检查

| 检查 | 实现 | 失败行为 |
| --- | --- | --- |
| 用户确认 | `runAssisted` 要求 `confirmed === true` | `E_VALIDATION`，启动器不被调用 |
| 安装包扩展名 / 存在性 / 体积 | `.exe` + 绝对路径 + 非空且 < 1GB | `E_VALIDATION` / `E_NOT_FOUND` |
| 签名有效性 | `Authenticode.status === "Valid"` | `E_SIGNATURE_INVALID` |
| 发布者基线 | 证据包发布者（verified）→ 否则本机已安装主程序签名发布者（observed）→ 否则拒绝 | `E_SIGNATURE_INVALID`（fail-closed） |
| 产品身份 | 包内产品名必须可读且不是另一产品 | `E_SIGNATURE_INVALID` |
| 目标实例 | 多副本时更新必须显式指定；卸载必须指定实例 | `E_VALIDATION` |
| 卸载程序归属 | 卸载程序必须位于该实例安装目录内 | `E_PATH_REJECTED` |
| 启动方式 | `spawn(file)`，**不传任何参数**、不隐藏窗口、不提升权限 | — |
| 结果判定 | 只看复扫；进程退出码与窗口关闭都不作成功依据 | `launched-not-verified` |

## 21. 自动化测试（全部 mock，未启动真实客户端）

| 编号 | 覆盖 | 结果 | 位置 |
| --- | --- | --- | --- |
| T-30 | 卸载命令解析：引号 / 无引号含空格 / `%VAR%` 展开 / `MsiExec` / `rundll32` / 空 | 通过 | `tests/unit/assisted.test.ts` |
| T-31 | 能力派生：无安装、单副本、多副本、需人工确认、卸载命令不可用、卸载程序不存在 | 通过 | 同上 |
| T-32 | 安装包判定：签名无效、无基线、发布者不符、无产品名、observed 基线通过、evidence 基线通过 | 通过 | 同上 |
| T-33 | 复扫对比：版本变化 / 另一版也变化 / 卸载残留 / 卸载完成 | 通过 | 同上 |
| T-34 | IPC 入参：未知字段、非法产品、非法操作类型全部拒绝 | 通过 | 同上 |
| T-35 | 服务守卫：未确认、空扫描卸载、未选包、非 `.exe`、包不存在 → 全部拒绝且启动器零调用 | 通过 | 同上 |
| T-36 | 成功路径（假扫描 + 假启动器）：只传文件不传参数；结论以复扫为准；无变化时 `launched-not-verified` | 通过 | 同上 |
| T-37 | 卸载隔离：只启动该实例卸载程序；卸载程序在安装目录外时拒绝 | 通过 | 同上 |
| T-38 | 诊断导出：辅助操作字段不含用户名、完整路径、原始命令行 | 通过 | 同上 |

命令与结果：

| 时间 | 命令 | 结果 |
| --- | --- | --- |
| 2026-10-18 22:24 | `npm run typecheck` | 通过，0 错误 |
| 2026-10-18 22:24 | `npm test -- --run` | **14 个测试文件、172 个测试全部通过** |
| 2026-10-18 22:24 | `npm run build` | 通过 |
| 2026-10-18 22:24 | `npm run e2e` | 通过：6 个操作行（2 产品 × 3 操作）、确认弹窗存在、状态非法组合 0 处 |
| 2026-10-18 22:24 | `npm run scan:report` | 通过：3 条记录（国内版 2、国际版 1），与上一阶段一致 |

## 22. 本机 E2E 观测到的能力矩阵

| 产品 | 安装 | 更新 | 卸载 |
| --- | --- | --- | --- |
| 国内版 WorkBuddy | `assisted`（1 个可点按钮） | `guidance-only`（多副本） | `guidance-only`（无可用卸载命令） |
| 国际版 WorkBuddy AI | `assisted` | `assisted` | `guidance-only` |

- `guidance-only` 行**不渲染按钮**，避免把“不可执行”包装成可点击动作。
- 卸载行会列出每个实例的路径与不可用原因，便于用户按指引手动处理。

## 23. 未验证事项（明确不宣称）

- 官方安装器的静默参数、自定义安装目录行为：**未在任何机器上验证**。
- 官方安装器是否覆盖现有版本、是否保留用户数据：**未知**。
- 官方更新是否会只改目标副本：**未知**，因此多副本一律降级为手动指引。
- 官方卸载器是否删除用户数据、是否影响另一版本：**未知**。
- 以上行为需要用户在日常使用时亲自确认，不能由本工具的复扫结果替代。

## 24. 本阶段限制

- `reg.exe` 仍被本执行环境拦截，卸载命令来源缺失 → 本机卸载入口全部降级为指引。
- 发布者基线在本机只能取“已安装主程序的签名发布者”（observed 级），未经证据包核实时不视为 verified。
- 安装器交互期间的 UAC 取消、用户中断只体现为“复扫无变化”，工具不会据此宣布失败原因。

---

# 第五阶段：受管部署安装 / 更新 / 卸载（2026-10-18 23:10，v0.2.0）

> 对应 `EXECUTION_PLAN.md`「交付真正可用的双版本安装、更新与卸载」。
> 本阶段把主流程从「启动官方 GUI」改为**管理器内解包部署**：不执行安装器、不传静默参数、不修改安装包。
> 能力现状见 `docs/FEATURE_GAP.md`。

## 25. 产品 × 操作矩阵（本阶段实测口径）

| 操作 | 管理器实际完成了什么 | 判定 |
| --- | --- | --- |
| 安装（本地包） | 校验 → 7za 解包（NSIS/7z/zip，递归内层 `app-*.7z`）→ 定位 `resources/app` → 事务部署到 `versions/<版本>` → 核验元数据与可执行文件 → 登记实例 | **已交付（合成包实测；真实官方包未实测）** |
| 安装（官方在线源） | 端点未配置，不发请求 | **未交付** |
| 更新 | 指定实例 → 新版本目录并排部署 → 核验 → 切换默认实例 → 旧版本保留 | **已交付（合成包实测）** |
| 卸载 | 指定实例 → 备份程序目录 → 删除目录 → 移除登记 → 重选默认实例 | **已交付（合成包实测）** |
| 启动 | 从受管实例目录启动主程序，启动前校验签名 | **已交付（签名校验为 mock 级）** |
| 删除用户数据 | 无入口，从不访问用户数据目录 | **未交付（仅保留策略）** |
| 官方安装器行为 | 从未执行 | **未验证** |

## 26. 自动化与真实文件操作

| 编号 | 覆盖 | 类型 | 结果 | 位置 |
| --- | --- | --- | --- | --- |
| T-40 | 7za `-slt` 输出解析、格式识别（NSIS/7z/zip/unknown）、内层归档选择、应用根定位 | 单元 | 通过 | `tests/unit/managedInstall.test.ts` |
| T-41 | 解包管线：递归解开外层+内层；缺少 `resources/app` 时 `E_PACKAGE_FORMAT` | 单元（假归档） | 通过 | 同上 |
| T-42 | 部署：成功落地文件；目标已存在 `E_TARGET_EXISTS`；目标越界 `E_PATH_REJECTED`；核验失败回滚且目标不残留 | 单元（真实临时目录 + 真实事务） | 通过 | 同上 |
| T-43 | 卸载：备份后删除、目录不存在 `E_NOT_FOUND` | 单元（真实临时目录） | 通过 | 同上 |
| T-44 | 服务层：安装登记默认实例、首装写入发布者信任、同版本重复安装被拒、更新切换默认并保留旧版本、卸载保留用户数据、未登记实例 `E_TARGET_NOT_MANAGED` | 集成（假包 + 假归档 + 真实文件） | 通过 | 同上 |
| T-45 | IPC：安装拒绝未知字段、卸载必须带 `confirmed` | 单元 | 通过 | 同上 |
| T-46 | **真实 7za.exe 解包**：用 7za 造一个含 `resources/app/package.json` 的 7z 包，走完整部署管线 | 集成（真实工具 + 真实文件） | 通过 | `tests/integration/managedDeploy.real.test.ts` |

命令与结果：

| 时间 | 命令 | 结果 |
| --- | --- | --- |
| 2026-10-18 23:05 | `npm run typecheck` | 通过，0 错误 |
| 2026-10-18 23:05 | `npm test -- --run` | **16 个测试文件、191 个测试全部通过** |
| 2026-10-18 23:05 | `npm run build` | 通过 |
| 2026-10-18 23:06 | `npm run e2e` | 通过：2 产品卡片、各 1 个安装按钮、实例区为空、确认弹窗与进度条存在、辅助启动表格 0 行 |
| 2026-10-18 23:06 | `npm run scan:report` | 通过：3 条记录（国内版 2、国际版 1） |

## 27. 0.2.0 构建记录

| 项目 | 值 |
| --- | --- |
| 版本 | 0.1.1 → **0.2.0** |
| 构建命令 | `electron-builder --win portable zip --x64 --publish never -c.directories.output=release-portable4` |
| 单文件携带版 | `release-portable4/workbuddy-dual-edition-manager-0.2.0-x64-portable.exe` |
| 体积 / SHA-256 | 74,914,857 字节 / `f79fe27876f768bb3c57ef68053d40c77171941288b862231f695d810692869e` |
| 绿色目录版 | `release-portable4/workbuddy-dual-edition-manager-0.2.0-x64.zip` |
| 体积 / SHA-256 | 112,471,820 字节 / `fec80488034d4ca0173ab7a6d7e57485f2324b7874e6fa896c2af161ecdd1b16` |
| 解包组件 | `release-portable4/win-unpacked/resources/7za.exe`（1,231,360 字节，随包分发） |
| 签名 | **未签名**（无证书） |
| 携带版冒烟 | 2026-10-18 23:10，复制到独立临时目录运行 `--e2e`：退出码 0、界面渲染、`WorkBuddyDualEdition-Data` 生成在 exe 同级 |

## 28. 本阶段未验证事项

- **真实官方安装包从未被解包或部署**：官方包的内层结构、是否包含 `resources/app`、是否有额外安装步骤全部未实测。
- 解包部署只还原文件树，**不写注册表、不建快捷方式、不注册卸载项**；官方安装器写的这些项不会被复制。
- 更新后的实例是否被客户端自身认可（更新器版本记录、快捷方式指向）未验证。
- 启动路径只在签名 mock 下验证过，未在真实客户端上运行。
- `reg.exe` 仍被本执行环境拦截，卸载命令来源缺失不影响受管卸载（不依赖它）。

---

# 第六阶段：发现即管理（接管）+ 归档安全 + 极简首屏（2026-10-18 23:55，v0.3.0）

> 对应 `EXECUTION_PLAN.md`「补齐 0.2.0 双版本管理的真实交付缺口」。
> 核心变化：扫描发现的既有安装可以被用户**显式接管**（只登记、不动文件），首屏不再把「已发现」错写成「未安装」。

## 29. 产品 × 操作（真实执行主体）

| 产品 | 操作 | 实例范围 | 管理器是否实际执行 | 验证类型 |
| --- | --- | --- | --- | --- |
| 国内版 | 安装（本地包） | 部署到管理根 `WorkBuddy-CN/versions/<版本>` | 是（解包 → 事务部署 → 完整树核验 → 登记） | 临时目录 + 真实 7za |
| 国内版 | 更新 | 指定 instanceId（deployed / adopted 均可） | 是（并排新目录 → 切默认 → 旧版保留） | 临时目录 |
| 国内版 | 卸载 | **仅 deployed 实例** | 是（备份 → 删目录 → 移登记） | 临时目录 |
| 国内版 | 启动 | 受管实例 | 是（启动前校验签名） | mock |
| 国内版 | 接管 | 扫描发现的既有安装 | 是（只登记，不改文件） | 临时目录 + 本机真实扫描 |
| 国际版 | 同上四项 | 同上 | 同上 | 同上 |

未交付：官方在线源、真实官方包部署、删除用户数据、进程关闭、快捷方式/注册表登记。

## 30. 本轮新增安全与修复

| 项 | 内容 | 测试 |
| --- | --- | --- |
| 归档安全 | 路径穿越 / 绝对路径 / UNC / 设备名 / 保留名 / 链接 / 重复 / 超条数 / 超体积 / 超深度，写盘前拒绝 | `tests/unit/archiveSafety.test.ts`（15 个） |
| 解包后复核 | 条目必须落在解包根内、无重解析点、累计体积受限 | 同上 |
| 完整应用树 | 主 exe + 应用代码 + Electron runtime，缺项拒绝 | 同上 |
| 接管校验 | 目录存在 / 非重解析点 / 元数据一致 / 主程序存在 / 签名有效 | `tests/unit/adopt.test.ts`（10 个） |
| 接管边界 | 只登记不改文件、移除跟踪、接管实例禁止删文件、重启恢复 | 同上 |
| 发布者基线 | 增加 `user-approved` 层，按证书指纹（thumbprint）匹配 | `tests/unit/assisted.test.ts` |
| **签名读取修复** | Electron 子进程拿不到系统签名模块时，回退 .NET 证书 API + 离线链校验 | 本机 `--e2e` 探针实测：`Valid` / 腾讯 / 指纹 `E1B5824E…` |

## 31. 命令与结果

| 时间 | 命令 | 结果 |
| --- | --- | --- |
| 2026-10-18 23:48 | `npm run typecheck` | 通过，0 错误 |
| 2026-10-18 23:48 | `npm test -- --run` | **18 个测试文件、216 个测试全部通过** |
| 2026-10-18 23:49 | `npm run build` | 通过 |
| 2026-10-18 23:49 | `npm run e2e` | 通过：2 产品卡片；国内版「已发现 2 个，尚未纳入管理」+ 2 个纳管按钮；国际版「已发现 1 个」+ 1 个纳管按钮；顶栏无在线源提示；诊断默认关闭；辅助表格 0 行 |
| 2026-10-18 23:49 | `npm run scan:report` | 通过：3 条记录（国内版 2、国际版 1），与历史一致 |

## 32. 首屏三种状态（E2E 覆盖）

| 状态 | 触发条件 | 断言 |
| --- | --- | --- |
| `absent` | 无受管实例且无扫描结果 | 卡片显示「未安装」 |
| `discovered` | 有扫描结果、无受管实例 | 显示「已发现 N 个，尚未纳入管理」，不得出现「未安装」，且必须有「纳入管理」入口 |
| `managed` | 有受管实例 | 显示「已管理 N 个」，实例行提供启动/更新/卸载（或移除跟踪） |

本机实测为 `discovered`（国内版 2、国际版 1），纳管按钮全部可用。

## 33. 0.3.0 构建记录

| 项目 | 值 |
| --- | --- |
| 版本 | 0.2.0 → **0.3.0** |
| 构建命令 | `electron-builder --win nsis portable zip --x64 --publish never -c.directories.output=release-0.3.0` |
| NSIS 安装版 | `release-0.3.0/workbuddy-dual-edition-manager-0.3.0-x64.exe` |
| 体积 / SHA-256 | 82,643,371 字节 / `9f766c14701e31a6ac56ef324a3fdc6f83b02246f9eaeec9ea5fb5eec0549b92` |
| 单文件携带版 | `release-0.3.0/workbuddy-dual-edition-manager-0.3.0-x64-portable.exe` |
| 体积 / SHA-256 | 82,415,631 字节 / `6482e06ce57513f201228d7537c23d65b34b6c6bc56ef1955c031d71434c75b9` |
| 绿色目录版 | `release-0.3.0/workbuddy-dual-edition-manager-0.3.0-x64.zip` |
| 体积 / SHA-256 | 112,488,314 字节 / `984b73fdb907b32f9848ac0213a689d9ba9cd281261d8ea8abe20fe8f49ab6d3` |
| 解包组件 | `release-0.3.0/win-unpacked/resources/7za.exe`（随包分发） |
| 签名 | **未签名**（无证书），测试版 |
| 携带版冒烟 | 2026-10-18 23:52，独立临时目录 `--e2e`：退出码 0、数据目录生成、截图 2 张 |

## 34. 仍未验证

- 真实官方安装包从未被解包或部署；官方包内层结构与部署结果未知。
- 接管在真实客户端上只做了**只读**校验（签名/元数据/主程序），未执行过启动、更新或卸载。
- 原位更新官方安装目录、删除用户数据、进程关闭、快捷方式与注册表登记均未实现。
- 电脑 B 的共存结果仍为用户提供，本阶段未重新测 B 机。


---

# 第七阶段：真实官方安装包验证（2026-10-19 00:20）

> 来源：官方站点人工点击下载（`workbuddy.cn` / `workbuddy.ai`），只读取证，未运行安装器。
> 完整记录见 `docs/evidence/official-packages-2026-10-19.json`。

## 35. 官方包实测结果

| 项目 | 国内版 | 国际版 |
| --- | --- | --- |
| 官方入口 | `https://www.workbuddy.cn/` →「当前设备 Windows」 | `https://www.workbuddy.ai/` →「当前设备 Windows」 |
| 文件 / 体积 | `workbuddy-cn-setup.exe` / 441,094,104 B | `workbuddy-ai-setup.exe` / 497,735,912 B |
| SHA-256 | `824de10f…66c03c` | `1ca65684…c80b843` |
| 签名 | Valid，Tencent，指纹 `2241B013…1C795B` | 同上（同证书同指纹） |
| 版本资源 | WorkBuddy 5.8.3 | WorkBuddy AI 5.8.4 |
| 容器 | NSIS 3 Unicode 自解压，外壳 12 条目 | 同构 |
| 应用位置 | `$PLUGINSDIR/app-64.7z`（440,177,782 B） | 同构 |
| 完整树（内层） | WorkBuddy.exe + resources/app.asar + runtime ✔ | ✔ |
| app.asar 元数据 | 可读，WorkBuddy / 5.8.3 | 可读，WorkBuddy AI / 5.8.4 |

## 36. 真实包验证用例

| 编号 | 覆盖 | 类型 | 结果 | 位置 |
| --- | --- | --- | --- | --- |
| T-50 | 官方包条目能列出且通过归档安全校验 | 真实包 | 通过（8 个用例） | `tests/integration/officialPackage.real.test.ts` |
| T-51 | 格式识别为 NSIS，且能找到内层 `app-64.7z` | 真实包 | 通过 | 同上 |
| T-52 | 从内层 `app-64.7z` 提取 `resources/app.asar` 并读出产品元数据 | 真实包 | 通过（国内/国际各 2.2s） | 同上 |
| T-53 | **完整部署**：解外层 → 解内层 → 事务复制到版本目录 → 完整树校验 | 真实包 + 真实文件 | 通过（101 秒） | `tests/integration/officialDeploy.real.test.ts`（需 `WB_FULL_DEPLOY=1`） |

真实部署目标：`artifacts/wb-official-deploy-*/managed/WorkBuddy-CN/versions/5.8.3`，含 `WorkBuddy.exe`、`resources/app.asar`、`ffmpeg.dll`，`evaluateAppDirectory` 通过。

## 37. 本轮修复的真实缺陷

| # | 缺陷 | 证据 | 修复 |
| --- | --- | --- | --- |
| 1 | 随包 `7za 21.07` 解官方内层 `app-64.7z` 报 `Unsupported Method`（ARM64 条目） | 完整部署第一次失败，stderr 列出 win32-arm64 / t64-arm.exe 等条目 | 解包工具改为**优先系统 7-Zip（22+）**，回退随包 7za；文档与界面提示版本要求 |
| 2 | 安装包签名证书与已安装主程序证书不同（`2241B013…` vs `E1B5824E…`），原实现用同一个基线会误拒真实官方包 | 真实包签名读取结果 | 发布者基线按用途拆分为 `package` / `binary`，各自独立记录与匹配 |
| 3 | `deployPackage` 未做空间预检（原 `requiredFreeSpaceBytes = 0`） | 在 C 盘只剩 2MB 时解压失败 | 按归档解压总体积 ×2 + 200MB 预检；不足时返回 `E_SPACE` |

## 38. 命令与结果（2026-10-19 00:19）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test -- --run` | **19 个文件 224 通过 / 1 跳过**（跳过项为真实完整部署，需 `WB_FULL_DEPLOY=1`） |
| 官方包只读用例 | 8/8 通过 |
| 官方包完整部署 | 1/1 通过（101 秒） |

## 39. 仍未验证

- 部署目录**没有启动过**：未验证能否登录、能否自更新、是否被官方更新器识别。
- 安装器的注册表/快捷方式/服务副作用未实现，也未验证缺失它们会有什么影响。
- 国际版未重复跑完整部署（结构与签名同构）。
- 官方在线版本 API 仍未核实（本次是人工点击下载，不是自动更新源）。


---

# 第八阶段：官网取包更新与真正卸载（2026-10-19 01:20，v0.4.0）

> 对应 `EXECUTION_PLAN.md`「官网取包更新与真正卸载」。
> 变化：更新不再只弹文件选择器或装到新目录，而是**原位替换用户选定的实例**；卸载对已接管实例调用**官方卸载器**。

## 40. 更新 / 卸载流程（实际行为）

| 步骤 | 更新 | 卸载 |
| --- | --- | --- |
| 入口 | 实例行「更新」 | 实例行「卸载」 |
| 官网 | 确认后 `shell.openExternal` 打开该产品固定官网 | — |
| 取包 | 用户在官网下载，回到管理器选择文件 | — |
| 校验 | 产品身份 + 签名 + 发布者指纹 + 版本必须更高 | 卸载器存在 + 签名 Valid + 产品标识匹配 + 登记唯一 |
| 执行 | 备份 → 解包 → 同卷目录交换 → 校验 | 受管：备份后删目录；接管：启动官方卸载器 |
| 结果 | 失败自动回滚，旧目录保留 | 轮询 60s 确认目录消失；否则报失败并保留跟踪 |
| 数据 | 不触碰用户数据 | 不触碰用户数据；官方卸载器行为未验证 |

## 41. 新增测试

| 编号 | 覆盖 | 结果 | 位置 |
| --- | --- | --- | --- |
| T-60 | 官网映射固定 HTTPS、无直链/查询串；`openOfficialSite` 只按产品 id 查表；无 openExternal 时如实报错 | 通过 | `tests/unit/updateUninstall.test.ts` |
| T-61 | `parseUninstallInvocation`：引号/无引号、`/currentuser` 放行、`/S` 与 `/D=` 拒绝、空命令拒绝 | 通过 | 同上 |
| T-62 | `replaceInstanceInPlace`：成功替换并保留旧目录与备份；校验失败回滚到旧版本；越界目录 `E_PATH_REJECTED` | 通过（真实临时目录） | 同上 |
| T-63 | 接管实例卸载：匹配登记 → 调用卸载器（参数 `/currentuser`）→ 目录消失 → 移除登记 | 通过（mock 卸载器） | 同上 |
| T-64 | 接管实例卸载：登记指向别的目录 / 无登记 → 拒绝且不删文件；卸载器退出但目录仍在 → `E_BUSY` 且保留登记 | 通过 | 同上 |
| T-65 | 更新语义变更：原点更新后实例仍为 1 个、版本变化、目录不变、旧目录保留 | 通过 | `tests/unit/managedInstall.test.ts` |
| T-66 | 注册表 .NET 适配器：本机真实读取到两条 HKCU 卸载登记（含 `/currentuser` 命令） | 通过（本机只读） | `npm run scan:report` |

## 42. 命令与结果（2026-10-19 01:15）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test -- --run` | **20 个文件 239 通过 / 1 跳过**（跳过项为真实官方包完整部署） |
| `npm run build` | 通过 |
| `npm run e2e` | 通过：两产品实例行含 启动/更新/卸载（接管实例另有「仅移除跟踪」）、纳管入口、安装入口；诊断默认关闭 |
| `npm run scan:report` | 通过：2 条记录（registry 来源，含卸载命令；`E://WorkBuddy-CN` 因客户端未运行且无登记，本轮未出现） |

## 43. 仍未验证

- **没有对真实客户端执行过更新或卸载**：只用合成包 + 临时目录验证了替换与回滚；官方卸载器只用 mock 验证了调用链。
- 官方卸载器在真实机器上的交互步骤、是否需要 UAC、是否保留用户数据：未验证。
- 更新后客户端能否被官方更新器识别、能否正常登录：未验证。
- 降级（回滚到旧版本）只保留目录，没有实现一键回滚按钮。


## 44. 0.4.0 构建记录

| 项目 | 值 |
| --- | --- |
| 版本 | 0.3.1 → **0.4.0** |
| 构建命令 | `electron-builder --win nsis portable zip --x64 --publish never -c.directories.output=E:/code/workbuddy共存/release-0.4.0-final` |
| NSIS 安装版 | `release-0.4.0-final/workbuddy-dual-edition-manager-0.4.0-x64.exe` · 82,660,011 B · `7ecf04c73c1061af6da73e7da1377eef606eaeae5def505010f4c2542668d468` |
| 单文件携带版 | `release-0.4.0-final/workbuddy-dual-edition-manager-0.4.0-x64-portable.exe` · 82,432,177 B · `f6b0cfa40f8dca4c5f4e1982433cff93e90bae7eca88296f69726bf9ea6cd832` |
| 绿色目录版 | `release-0.4.0-final/workbuddy-dual-edition-manager-0.4.0-x64.zip` · 112,507,631 B · `671f851764633ed589dab4e3ca3b7b9a958443e66d4b669170782fd9f2f022e0` |
| 签名 | **未签名**（无证书），测试版 |
| 携带版冒烟 | 2026-10-19 01:22，独立临时目录 `--e2e`：退出码 0、数据目录生成、截图 2 张 |

> 注：`release-0.4.0/` 目录是首次打包（dist 可能落后一次构建），以 `release-0.4.0-final/` 为准。


---

# 第九阶段：自动登记与完整安装布局（2026-10-19 16:00，v0.5.0）

> 对应 `EXECUTION_PLAN.md`「自动接管与真实安装管理」。
> 核心变化：删除"纳入管理"用户步骤，扫描即自动登记；更新时保留官方卸载器等维护文件。

## 45. 自动登记实测（本机，只读扫描）

| 项目 | 结果 |
| --- | --- |
| 扫描来源 | registry（.NET 适配器）+ shortcut + process |
| 自动登记实例 | **3 个**：`E://Programs//workbuddy`（cn 5.8.3）、`E://WorkBuddy-CN`（cn 5.8.3）、`F://WorkBuddy-AI`（ai 5.8.4） |
| 主程序识别 | `WorkBuddy.exe` / `WorkBuddyAI.exe`（已排除 `Uninstall WorkBuddy.exe`——本轮修掉的真实 bug） |
| 签名 | 三个实例均 Valid，发布者 Tencent；cn 指纹 `E1B5824E…`、ai 指纹 `2BC94A21…` |
| 幂等 | 连续扫描后 instances.json 仍为 3 条，instanceId 不变 |
| 未出现 | `E://WorkBuddy-CN` 当前无 registry/快捷方式/进程线索（该副本客户端未运行），由补偿校验保持 `verified=true` |

## 46. 本轮修复的真实问题

| # | 问题 | 证据 | 修复 |
| --- | --- | --- | --- |
| 1 | `detectExecutable` 把 `Uninstall WorkBuddy.exe` 当成主程序 | instances.json 里 `executableRelativePath` 为卸载器 | 排除 `uninstall/repair/update/crash`，优先精确 `WorkBuddy.exe`/`WorkBuddyAI.exe` |
| 2 | `npm run e2e` / `npm run scan:report` 出现"无结果、退出码 0" | 用户开着管理器时 `requestSingleInstanceLock` 失败 → `app.quit()` | 脚本模式跳过单实例锁；脚本模式异常也写 stdout；`dialog.showErrorBox` 在脚本模式改为输出错误 |
| 3 | 更新会丢官方卸载器 | 官方目录含 `Uninstall WorkBuddy.exe`，内层 `app-64.7z` 不含 | 替换时从旧目录保留 `Uninstall*.exe`、`version`、`*.msix`，结果里列出保留清单 |
| 4 | 注册表读取偶发 `spawn EPERM` | 一次 scan 的 skippedSources 记录 | .NET 适配器对 EPERM/EAGAIN/EBUSY 重试 2 次 |

## 47. 新增/调整测试

| 编号 | 覆盖 | 结果 | 位置 |
| --- | --- | --- | --- |
| T-70 | 自动登记判定：合格、目录缺失、重解析点、无主程序、签名无效/未知、身份未确认、管理器自身 | 通过（9 个用例） | `tests/unit/autoTrack.test.ts` |
| T-71 | 合并幂等、多副本全部登记、跨产品隔离、deployed 不被改写、未出现实例保留但未核验、active 唯一 | 通过 | 同上 |
| T-72 | 原位替换保留 `Uninstall WorkBuddy.exe` 与 `version` | 通过 | `tests/unit/updateUninstall.test.ts` |
| T-73 | 旧纳管测试（`adopt.test.ts`）已删除：其场景被自动登记 + 官方卸载测试覆盖 | — | — |

## 48. 命令与结果（2026-10-19 16:00）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test -- --run` | **20 文件 238 通过 / 1 跳过** |
| `npm run build` | 通过 |
| `npm run e2e` | 通过：无「纳入管理/接纳管理/尚未纳入管理/仅移除跟踪」；国内版 2 个实例、国际版 1 个，实例行均有 启动/更新/卸载 |
| `npm run scan:report` | 通过：2 条 registry 记录；instances.json 3 条 |

## 49. 仍未验证

- 真实客户端上的更新与卸载仍未执行（合成包 + 临时目录 + mock 卸载器）。
- 更新保留卸载器只验证了"文件被复制"，未验证官方卸载器在新树上仍能正常工作。
- `E://WorkBuddy-CN` 的线索来源（进程）在本轮不可复现；补偿校验只保证目录/签名有效。


## 50. 0.5.0 构建记录

| 项目 | 值 |
| --- | --- |
| 版本 | 0.4.0 → **0.5.0** |
| 构建命令 | `electron-builder --win nsis portable zip --x64 --publish never -c.directories.output=E:/code/workbuddy共存/release-0.5.0` |
| NSIS 安装版 | `release-0.5.0/workbuddy-dual-edition-manager-0.5.0-x64.exe` · 82,666,871 B · `d22cc5cd23e3aa5297a613616bcfd23da51c2d6454825834acefb205ac4822f0` |
| 单文件携带版 | `release-0.5.0/workbuddy-dual-edition-manager-0.5.0-x64-portable.exe` · 82,439,121 B · `fb969ef79baab2f43af0b299973e6a3a9a8d36428b8357cddd5820344784e0da` |
| 绿色目录版 | `release-0.5.0/workbuddy-dual-edition-manager-0.5.0-x64.zip` · 112,514,165 B · `1d83575cf20cf515c99eeea3848597ef6832b7863cf8267b3f64de754bb7f7ea` |
| 签名 | **未签名**（无证书），测试版 |
| 携带版冒烟 | 2026-10-19 16:25，独立临时目录 `--e2e`：退出码 0、数据目录生成、截图 2 张 |

---

# 第三阶段：0.6.0 真实安装闭环

> 对应 `EXECUTION_PLAN.md`（0.6.0）。目标：用户选择本地官方安装包后，国内版/国际版都能真正安装、更新、卸载，
> 自动创建桌面快捷方式，扫描即自动登记，不再依赖虚拟机证据包或“纳入管理”流程。

## 11. 本轮变更

| 项 | 变更 | 位置 |
| --- | --- | --- |
| 证据门 | 安装/更新/卸载不再被“缺少证据包”阻断；保留产品身份、包签名、应用树完整性检查 | `appService.checkCapability` |
| 签名基线 | 首次安装时若包签名 `Valid` 且发布者为腾讯，自动记录基线并继续（不再要求额外勾选） | `isOfficialPackageSignature`、`trustSigner` |
| 接管流程 | 删除 `adoptInstance` / `AdoptCandidate` / `releaseInstance` / 证据包导入导出接口 | `appService`、`ipc`、`preload`、`shared/ipc` |
| 桌面快捷方式 | 安装成功后创建 `WorkBuddy（国内版）.lnk` / `WorkBuddy AI（国际版）.lnk`；更新时修复；卸载时只删本工具创建的 | `core/shortcutSpec.ts`、`adapters/shortcutWriter.ts` |
| 失败日志 | 失败写入 `state/errors/<时间>-<操作>.json`，含阶段/错误码/回滚状态；脱敏，不写命令行 | `main/errorLog.ts` |
| 版本 | `0.6.0` | `package.json` |

## 12. 命令与结果（2026-10-19 19:07，本机）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，0 错误 |
| `npm test -- --run` | **22 个测试文件、252 通过、2 跳过** |
| `npm run build` | 通过 |
| `npm run e2e` | 通过：2 个产品卡片；国内版 2 个实例、国际版 1 个实例；启动/更新/卸载按钮可用；禁用词（纳入管理/接纳管理/仅移除跟踪/证据包/辅助启动）零命中 |
| `npm run scan:report` | 通过：国内版 2 份、国际版 1 份 |

跳过的 2 个用例是 `tests/integration/official*.real.test.ts`：需要真实官方安装包，本轮未提供，**不计为通过**。

## 13. 本轮新增/调整的测试

| 用例 | 覆盖 | 结果 |
| --- | --- | --- |
| `tests/unit/shortcutSpec.test.ts` | 快捷方式名称、目标、工作目录、缺主程序、路径穿越、单盘环境 | 通过（6） |
| `tests/unit/errorLog.test.ts` | 写入字段、脱敏（用户名/路径/令牌/命令行）、倒序列出、目录不可写返回 null | 通过（4） |
| `tests/unit/managedInstall.test.ts`（新增 4 例） | 安装后创建快捷方式并写入实例；快捷方式失败不回滚且如实提示；卸载删除本工具快捷方式；安装失败写错误日志 | 通过 |
| `tests/unit/updateUninstall.test.ts` | 接管流程删除后改用“扫描自动登记”获取外部实例，官方卸载器行为不变 | 通过 |

## 14. 未验证 / 限制（不得当作已完成）

| 项 | 原因 |
| --- | --- |
| 真实官方包安装/更新/卸载 | 本轮未提供 `WorkBuddy-win32-x64-user-5.8.3*.exe` 等真实包，`official*.real.test.ts` 被跳过 |
| 真实桌面快捷方式 | 单元测试注入假实现；本机仅做过一次真实创建验证（创建成功，随后清理，避免污染桌面） |
| 仅 C 盘 / C+D 盘实机 | 未在隔离环境实测；代码中不写死盘符，默认管理根为携带版 exe 同级 `WorkBuddyDualEdition-Data/Managed` |
| 更新后快捷方式指向 | 逻辑已实现（修复同一实例目录），未在真实包上验证 |
| 官方安装器行为 | 本工具只解包部署，不执行官方安装器；官方安装器的路径/注册表行为仍未验证 |

## 15. 已知风险

- 首次安装的签名基线来自“包签名有效 + 发布者为腾讯”，比证据包宽松；若官方更换签名主体，需要人工确认后更新。
- 解包部署不会写入注册表/开始菜单，Windows“应用和功能”里不会出现对应条目；卸载也只针对本工具实例。
- 快捷方式创建依赖系统脚本宿主；受限环境（禁用该组件）下会失败并在结果里说明，不影响安装本身。

## 16. 0.6.0 携带版产物

| 项目 | 值 |
| --- | --- |
| 构建命令 | `npx electron-builder --win portable --x64 --publish never --config.directories.output=release-portable` |
| 产物 | `release-portable/workbuddy-dual-edition-manager-0.6.0-x64-portable.exe` |
| 体积 / SHA-256 | 74,950,473 字节 / `40f46b1f02552c39ae1623c7833b09c659d9ce9f2f22adf0f57a977a284687b3` |
| 签名 | 未签名（无代码签名证书） |
| 旧产物 | 已删除 0.1.0 / 0.5.0 的 portable exe 与 zip，只保留 0.6.0 |
| 冒烟 | 复制到独立临时目录运行：进程启动、界面渲染；`WorkBuddyDualEdition-Data` 在 exe 同级生成（含 `app`、`state`） |

---

# 第四阶段：0.6.1 安装校验阻断修复

> 对应 `EXECUTION_PLAN.md`（安装校验阻断修复）。目标：Authenticode `NotSigned` / `Unknown` / 证书换签
> 不再阻止用户选择的包进入安装或更新；签名只作为诊断字段。

## 17. 移除的签名拦截点

| 位置 | 原行为 | 0.6.1 |
| --- | --- | --- |
| `core/packageVerifier.ts` | 签名非 Valid、发布者不在信任清单 → `verdict=invalid` | 签名只写入 `reasons`（标注“仅诊断”）；仍拒绝哈希不符、产品不匹配 |
| `core/assisted.ts` `evaluateAssistedPackage` | 无签名 / 无基线 / 指纹不一致 → 拒绝 | 只检查归档致命问题与包内产品名；签名/基线只写诊断 |
| `appService.installFromPackage` | 需要发布者基线，可被 `approveSigner` 记录 | 不再要求基线，`approveSigner` 参数删除 |
| `appService.updateInstance` | 同上 | 同上 |
| `appService` 卸载官方卸载器 | 签名非 Valid → 拒绝执行 | 改为：登记精确匹配目录 + 文件位于该目录内 + 产品标识匹配 |
| `appService.launchInstance` | 主程序签名非 Valid → 拒绝启动 | 签名只诊断；仍校验文件存在与实例归属 |
| `deriveCapabilities` | 由虚拟机证据决定，无证据 → `read-only` + 阻断文案 | 恒为可安装/更新/卸载（`mode: full`、`blockers: []`）；证据只用于产品特征展示 |
| `diagnostics` | 输出 `mode: read-only`、证据 blocker、在线源未配置 | schema v3：`build{id,time,packaged,portable}`、`deployment{install,update,uninstall,signatureGate:false}`、`lastOperation` |

## 18. 签名状态矩阵（自动化）

| 包签名状态 | 预检 | 安装/部署 | 依据 |
| --- | --- | --- | --- |
| `Valid`（腾讯） | 通过 | 通过 | `tests/unit/packageVerifier.test.ts`、`managedInstall.test.ts` |
| `NotSigned` | 通过 | 通过（含自动登记 + 快捷方式） | `packageVerifier`、`assisted`、`managedInstall` 三处用例 |
| `Unknown` | 通过 | 通过 | 同上 |
| 证书换签（发布者/指纹变化） | 通过 | 通过 | `packageVerifier`、`assisted` 用例 |

仍会拒绝并给出具体原因：哈希与官方元数据不符、包属于另一产品、包内产品名缺失、归档危险/路径穿越、
缺主程序或 `resources/app.asar`、版本无法识别、目标越界、磁盘不足、目标文件被占用。

## 19. 构建标识与产物

| 项 | 值 |
| --- | --- |
| 版本 | `0.6.1` |
| 构建标识 | 每次 `npm run build` 清空 `dist/` 并注入 `buildId`（时间戳）+ `buildTime` |
| 诊断 | 导出含 `build.id/time/packaged/portable`，可与运行产物比对 |
| E2E | `npm run e2e` 先构建再运行，断言 `buildId` 非 `dev`、`appVersion` 与 `package.json` 一致 |
| 携带版 | 见下节 |

## 20. 命令与结果（2026-10-19 20:2x，本机）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，0 错误 |
| `npm test -- --run` | **22 个测试文件、257 通过、2 跳过** |
| `npm run build` | 通过（dist 已清空重建） |
| `npm run e2e` | 通过；`buildId=20261019123013`、`appVersion=0.6.1`、`packaged=false`；禁用词零命中 |
| `npm run scan:report` | 通过（国内版 2 份、国际版 1 份） |

## 21. 未验证 / 限制

| 项 | 说明 |
| --- | --- |
| 用户问题中的原包 | 本机 `Downloads` / 桌面 / `artifacts` 均无 WorkBuddy 官方安装包，**该原包未复测**；`official*.real.test.ts` 被跳过，不计为通过 |
| 真实 NotSigned 官方包安装 | 未取得该包，签名矩阵仅由单元测试覆盖（合成包 + 注入签名状态） |
| 更新/卸载真实包 | 同上，未执行 |
| C 盘 / C+D 盘实机 | 未在隔离环境验证 |

## 22. 本轮环境事件

- 测试临时目录累积到 **1444 个 / 27 GB**（历次 official 真实包用例遗留），导致 C 盘写满、测试批量失败。
  已清理 `%TEMP%\wb-*` 释放 27 GB，随后全量测试通过。后续真实包用例应在结束时清理临时目录。

## 23. 0.6.1 携带版产物与冒烟

| 项目 | 值 |
| --- | --- |
| 构建命令 | `npx electron-builder --win portable --x64 --publish never --config.directories.output=release-061`（随后复制到 `release-portable/`） |
| 交付产物 | `release-portable/workbuddy-dual-edition-manager-0.6.1-x64-portable.exe` |
| 体积 / SHA-256 | 74,946,085 字节 / `4c9e0c8288a5bb4bd13a86221560b7f714f96bb617ba14ab0cadbb5450abfb78` |
| 签名 | 未签名（无代码签名证书） |
| win-unpacked 冒烟 | `release-061/win-unpacked/...exe --e2e`：`appVersion=0.6.1`、`buildId=20261019123013`、`packaged=true`、2 个产品卡片、禁用词零命中 |
| 携带版冒烟 | 复制到独立临时目录运行：进程启动；`WorkBuddyDualEdition-Data`（`app`、`state`）在 exe 同级生成；`state/instances.json` 已写入自动登记的实例 |
| 备注 | 直接打包到 `release-portable` 因旧 `win-unpacked/resources/app.asar` 被占用失败，改用新输出目录构建后复制 exe；旧 0.6.0 产物已删除 |

---

# 第五阶段：0.6.2 安装目标路径选择

> 对应 `docs/INSTALL_PATH_EXECUTION_PLAN.md`。用户选包后可明确选择国内版/国际版的最终安装目录，
> 不再静默落到管理器数据目录。

## 24. 变更

| 项 | 变更 | 位置 |
| --- | --- | --- |
| 安装弹窗 | 显示可编辑的**最终安装目录** + “浏览…”按钮（选择父目录后自动拼产品目录名，可继续编辑）；默认值仅作推荐 | `renderer.ts`、`styles.css` |
| IPC | `installManaged.targetDirectory` 改为**必填**（空/缺失直接拒绝） | `shared/ipc.ts` |
| 目标校验 | `validateInstallTarget`：本地绝对路径；拒绝 UNC/设备/根目录/系统目录/管理器自身目录/8.3 短名/重解析点/被占用目录；已存在必须为空；不存在则父目录必须存在且可写 | `core/pathGuard.ts` |
| 安装事务 | 目标必填；staging 放在目标同卷；已存在空目录先复核再清理；提交后写登记并复扫；登记失败回滚目录 | `appService.installFromPackage`、`core/managedInstall.ts` |
| 空间检查 | 由“管理根所在卷”改为**目标所在卷**（最近存在祖先） | `core/transaction.ts` |
| 卸载 | 允许删除位于管理根之外的实例目录（只放行该实例自身目录） | `appService.uninstallInstance` |
| 更新 | 固定使用实例当前路径，不弹目录选择 | 既有逻辑 |

## 25. 自动化验证

| 用例 | 覆盖 | 结果 |
| --- | --- | --- |
| `pathGuard.test.ts`（新增 10 例） | 空/相对/UNC/设备/根目录/系统目录/管理器自身/被占用/父目录包含实例/父目录不存在/父目录不可写/重解析点/已存在空目录/非空目录 | 通过 |
| `managedInstall.test.ts`（新增 5 例） | 装到管理根之外并登记、快捷方式指向该目录；空目录可装；非空拒绝且原文件不变；目标等于已有实例拒绝；登记写入失败回滚目录并清空实例 | 通过 |
| `installManagedSchema` | 缺少 `targetDirectory` 时拒绝 | 通过 |
| E2E | `installPathUi=1`；产品卡片 2、实例 3；禁用词零命中 | 通过 |

## 26. 命令与结果（2026-10-19 21:42，本机）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，0 错误 |
| `npm test -- --run` | **22 个测试文件、272 通过、2 跳过** |
| `npm run build` | 通过（dist 清空重建） |
| `npm run e2e` | 通过；`appVersion=0.6.2`、`buildId` 非 dev、`installPathUi=1` |
| `npm run scan:report` | 通过：国内版 2 份、国际版 1 份 |

## 27. 未验证 / 限制

| 项 | 说明 |
| --- | --- |
| 真实界面点选安装 | 原生文件选择框无法在 E2E 中自动化；本轮只验证了“安装界面带目标路径输入”与主进程路径校验，**未做真实点击安装的端到端截图** |
| C 盘 / C+D 盘实机 | 用临时目录模拟，未在独立 Windows 环境实测；代码不写死盘符 |
| 真实官方包安装到自选目录 | 本机无官方包，未执行 |
| 更新后快捷方式指向 | 逻辑保持（同一实例目录），真实包未验证 |

## 28. 环境说明

- 测试临时目录再次累积（约 500+ 个 `%TEMP%\wb-*`），已清理；`instances.json` 中指向临时目录的陈旧实例也会在复扫时消失。

## 29. 0.6.2 携带版产物

| 项目 | 值 |
| --- | --- |
| 产物 | `release-portable/workbuddy-dual-edition-manager-0.6.2-x64-portable.exe` |
| 体积 / SHA-256 | 74,950,731 字节 / `c721a1e2ea09651e0d08fc6c5c7aa1aa8c0d4a16e6462f9fc4eedcf72cd9bcac` |
| 签名 | 未签名 |
| win-unpacked 冒烟 | `appVersion=0.6.2`、`buildId=20261019134340`、`packaged=true`、`installPathUi=1` |
| 携带版冒烟 | 独立临时目录运行：`WorkBuddyDualEdition-Data\\{app,state}` 生成，`state/instances.json` 写入；进程正常退出 |
| 旧产物 | 0.6.1 携带包已删除，只保留 0.6.2 |

## 30. 打包残缺事故与修复（0.6.3）

**现象**：运行 `release-portable\win-unpacked\WorkBuddy Dual Edition Manager.exe` 报
“由于找不到 ffmpeg.dll，无法继续执行代码”。

**根因**：交付目录里的 `win-unpacked` 是 20:31 一次**被中断构建的残留**。当时旧进程占用
`resources/app.asar`，electron-builder 先清空输出目录再失败，只剩
`vk_swiftshader.dll`/`vulkan-1.dll` 等 6 个文件；随后成功构建输出到 `release-062`，
只复制了 exe，残缺目录一直留在 `release-portable`。**打包配置本身正确**：
`files` 只控制 asar 内的应用文件，Electron 运行时由 electron-builder 整包复制。

**修复**：

| 项 | 内容 |
| --- | --- |
| `scripts/verify-package.mjs`（新增） | 与 `node_modules/electron/dist` 对比：13 个必需运行时文件、`locales/*.pak`、`resources/app.asar`、`resources/7za.exe`，并校验关键文件字节大小一致 |
| `scripts/pack-portable.mjs`（新增） | 在系统临时目录构建 → 校验 → 只写不删地覆盖到 `release-portable` → 交付目录复检；失败不交付 |
| `npm run dist:portable` | 改为调用上述脚本（不再直接让 electron-builder 写交付目录） |
| `npm run verify:package` | 单独校验 `release-portable/win-unpacked` |
| `tests/unit/verifyPackage.test.ts` | 4 例：完整通过、缺 `ffmpeg.dll`、大小不一致、缺 app.asar/7za.exe |

**验证结果**：

- 对旧残缺目录运行校验：明确列出缺 `ffmpeg.dll`、`libEGL.dll`、`libGLESv2.dll`、
  `d3dcompiler_47.dll`、`icudtl.dat`、`chrome_*_percent.pak`、`locales/*.pak`、`resources/7za.exe`。
- 重新打包后：`18 个根文件，Electron 运行时完整`；6 个 DLL 全部存在，大小与 Electron 一致。
- `release-portable/win-unpacked` 直接启动：`appVersion=0.6.3`、`buildId=20261019141559`、`packaged=true`、exit 0。
- 便携版复制到独立临时目录启动：exit 0，`WorkBuddyDualEdition-Data` 正常生成。

**产物（0.6.3）**：

| 项目 | 值 |
| --- | --- |
| 文件 | `release-portable/workbuddy-dual-edition-manager-0.6.3-x64-portable.exe` |
| 体积 / SHA-256 | 74,951,218 字节 / `ba16631e0daed257fb87560d98a9d73f7628e223c6320871a66003dd1ea709af` |
| 目录 | `release-portable/win-unpacked`（已校验，可直接运行） |

**遗留**：旧目录 `release-build-staging`（一次失败构建的残留，含被句柄占用的 `app.asar`）暂未删除，
不参与交付；重启后可清理。0.6.2 的 exe 已从交付目录移除，避免同版本两个不同二进制。

## 31. 诊断报告可信度修复（0.6.5，schema v4）

**问题**：导出诊断直接用内存里的旧 `scanResult`（报告时间新、扫描时间旧）；`lastOperation` 只看
journal 第一条（失败发生在 journal 建立前就显示 null）；错误日志只有 `list()` 拿不到内容；
同时导出 `availability`/`assisted`/`scan.readOnly` 三套口径，互相矛盾。

**改动**：

| 项 | 内容 |
| --- | --- |
| 导出前刷新 | `exportDiagnostics()` 先真正跑 `scan()`；成功用本次结果，失败则 `scan.status="failed"` + 失败码 + 脱敏原因，**不回退旧结果** |
| 两个事实来源 | `managedInstances`（instances.json 登记）与 `scan.records`（磁盘发现）分开输出，再按规范化路径关联出 `scanToManaged`：`matched`/`discovered-not-managed`/`managed-not-found-on-disk`/`identity-conflict` |
| 最近操作 | `recentOperations`（journal ≤20）与 `recentErrors`（错误日志 ≤20）独立输出；`lastOperation` 由两者按时间合并，错误可独立成为最近操作 |
| 历史状态 | `historyStatus`：`ok`/`no-history`/`journal-unreadable`/`error-log-unreadable`，并给出损坏文件数 |
| 错误日志读取 | `ErrorLogPort.readRecent()`：时间倒序、最多 20 条、损坏文件跳过并计数、目录不存在视为“无记录”、ENOTDIR 视为不可读 |
| 文件名唯一 | 写入追加 6 位随机 ID，同一毫秒同类错误不再互相覆盖 |
| 删除旧字段 | 移除 `availability`、`assisted`、`scan.readOnly`、`capability`；改用 `deploymentCapabilities`（`source: "current-code"`）与 `scan.mode: "read-only-scan"` |
| 构建一致性 | 新增 `diagnosticsSchemaVersion` 与 `diagnosticsBuildId`（必须等于运行状态 `build.id`） |
| 界面 | 诊断面板新增摘要：登记 N 个实例 / 扫描发现 M 个目录 / 匹配·未找到·未登记 |

**测试**：

| 类型 | 覆盖 | 结果 |
| --- | --- | --- |
| 单元（diagnostics） | schema v4、旧字段消失、扫描失败、登记/扫描关联四种状态、lastOperation 合并与时间解析异常、脱敏 | 18 通过 |
| 单元（errorLog） | 读取最近、≤20、损坏容错、目录缺失/非目录、同毫秒不覆盖、脱敏 | 11 通过 |
| 服务级（diagnosticsExport） | 导出触发新扫描、失败不回退、登记实例单独输出、错误日志成为 lastOperation、no-history | 6 通过 |
| E2E（真实点击） | 点击“导出诊断”按钮 → 读回 JSON：schema=4、buildId 与运行状态一致、无 availability/assisted/readOnly、部署能力全 true、含 managedInstances/scanToManaged | 通过 |
| 全量 | `npm test -- --run` | **25 个文件、285 通过、2 跳过** |

**本机真实导出**（开发构建，2026-10-20 00:10）：
`schemaVersion=4`、`buildId=20261019160937`、扫描成功、导出到
`artifacts/e2e-diagnostics/workbuddy-diagnostics-*.json`；报告中列出登记实例、扫描实例与关联结果。


**产物级真实导出**（0.6.5，buildId `20261019161745`）：

| 产物 | packaged | portable | schema | 旧字段 | managedInstances | scanToManaged | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `release-portable/win-unpacked\WorkBuddy Dual Edition Manager.exe` | true | false | 4 | 无 availability/assisted/readOnly | 3 | matched / managed-not-found-on-disk / discovered-not-managed | 通过 |
| `release-portable/workbuddy-dual-edition-manager-0.6.5-x64-portable.exe`（复制到独立临时目录运行） | true | true | 4 | 同上 | 2 | matched / discovered-not-managed | 通过 |

两份报告的 `diagnosticsBuildId` 都等于同一次构建的 `build.id`，说明导出确实来自被测二进制。
`deploymentCapabilities` 全为 true、`signatureGate=false`；`scan.mode="read-only-scan"`。

**产物**：`workbuddy-dual-edition-manager-0.6.5-x64-portable.exe`，74,959,055 字节，
SHA-256 `d7a3bd3e0c26dcdc6c6618418e0ebb807035eb3b1706df9ec531d041dd108c82`；
`win-unpacked` 18 个根文件、Electron 运行时完整。

**已知限制**：本机当前 journal 为空、错误日志为空，因此真实报告里 `lastOperation=null`、
`historyStatus="no-history"`；"失败但无 journal" 的情形由单元/服务测试覆盖（错误日志可独立成为 lastOperation），
尚未在本机制造一次真实失败来验证。

## 32. 用户实机反馈：卸载后安装目录残留（2026-10-21）

用户反馈卸载后以下官方安装目录仍有文件残留：

- 国内版：`E:\Programs\workbuddy`
- 国际版：`F:\WorkBuddy-AI`

所附管理器截图中的操作结果提示：注册表没有找到与所选实例目录精确匹配的官方卸载程序，因此无法执行官方卸载；界面要求从 Windows“设置 > 应用”手动卸载或确认对应卸载程序是否存在。由此目前只能确认**管理器没有成功调用匹配的官方卸载器**，不能把该次操作记为卸载成功，也不能仅凭截图确定目录中具体残留文件的名称或归属。

**状态：未解决，待核实。** 后续应分别检查上述目录的卸载登记、卸载器文件及其真实结果；在匹配卸载器并确认目标目录已清理之前，UI 必须保持失败状态。不得通过直接递归删除官方安装目录来伪装卸载成功。用户截图未显示残留文件名，后续若需判定具体残留内容，应记录文件名、所在目录及卸载后的目录列表。

## 32. 安装目录被盘符根误判占用（0.6.10）

**复现输入**：进程线索 `{ path: "D:\", name: "WorkBuddy.exe" }`（另一台电脑上 WMI 的
`ExecutablePath` 为盘符根）。修复前 `scanner` 直接 `path.dirname("D:\")` → `D:\`，
`ensureRecord` 只检查“路径存在”（盘符根恒存在）→ 生成 `installLocation = D:\` 记录 →
进入 `occupiedDirectories` → `D:\workbuddyCN` 被判“已被现有实例占用：D:\”。

**修改**：

| 文件 | 变更 |
| --- | --- |
| `src/core/processPath.ts`（新增） | 纯函数解析：只接受“本地绝对路径 + `.exe`”；拒绝盘符根、目录路径、相对/UNC、无父目录、临时目录、非客户端主程序（卸载器/修复器/安装器/管理器自身）；文件名唯一映射产品，否则只留线索 |
| `src/main/adapters/processes.ts` | 只做 WMI 读取；用上述解析过滤，`listDetailed()` 返回被拒绝项及原因 |
| `src/core/scanner.ts` | 进程线索先解析再 `ensureRecord`；`ensureRecord` 增加盘符根兜底拒绝；被拒线索写入 `skippedSources`（`processes:invalid-path`） |
| `src/main/services/appService.ts` | `occupiedDirectories` 入口过滤：空值/相对路径/盘符根不参与占用判定 |
| `src/core/pathGuard.ts` | 新增 `isDriveRoot()`；`validateInstallTarget` 使用占用目录前忽略盘符根等无效项 |
| `src/core/diagnostics.ts` | 报告不输出盘符根记录、不参与 `scanToManaged`；新增 `scan.ignoredClues`、`instanceRegistry`；登记不可读时 `historyStatus.state="registry-unreadable"` |
| `src/renderer/renderer.ts` | 跳过项显示“无效进程路径（已忽略）”，不再像候选实例 |

**回归结果**：

| 类型 | 用例 | 结果 |
| --- | --- | --- |
| 单元 | `processes.test.ts` 11 例：盘符根/目录/相对/UNC/空路径/卸载器/修复器/安装器/管理器/临时目录/正例 | 通过 |
| 单元 | `scanner.test.ts` +3：`D:\` 不产生记录且不计 process 来源；卸载器/目录/临时目录不产生记录；真实路径仍能发现 | 通过 |
| 单元 | `pathGuard.test.ts` +4：occupied 含 `D:\` 时 `D:\workbuddyCN` 放行；空/相对占用被忽略；盘符根仍被拒；并列放行、同路径/父目录仍拒绝 | 通过 |
| 服务 | `managedInstall.test.ts` +2：扫描混入 `D:\` 记录时目标仍能部署；同路径有效客户端仍 `E_CONFLICT` | 通过 |
| 单元 | `diagnostics.test.ts` +3：盘符根记录不进入 `scan.records`/`scanToManaged`；`ignoredClues` 计数；登记不可读不再报 `no-history` | 通过 |
| 服务 | `diagnosticsExport.test.ts` +1：instances.json 变成目录 → `registry-unreadable` + 回退来源 | 通过 |
| E2E | `WB_E2E_OCCUPANCY_PROBE=1`：真实文件系统，occupied=`[盘符根, "D:\", "", "relative\dir"]`，目标为唯一临时子目录 → 放行；盘符根自身仍被拒 | 通过 |
| 全量 | `npm test -- --run` | **26 个文件、316 通过、2 跳过** |

**产物实测**（buildId `20261021155712`，版本 `0.6.10`）：

| 产物 | packaged | portable | occupancyProbe | D:\workbuddyCN | 诊断 schema/buildId |
| --- | --- | --- | --- | --- | --- |
| `win-unpacked\WorkBuddy Dual Edition Manager.exe` | true | false | ok | 通过（本机有 D 盘） | 4 / 一致 |
| `workbuddy-dual-edition-manager-0.6.10-x64-portable.exe`（复制到唯一临时目录运行） | true | true | ok | 通过 | 4 / 一致 |

探针只做**校验**，未在 `D:\workbuddyCN` 写入文件；部署文件只发生在自动创建的唯一临时目录，并在 finally 清理。
这是本机（有 D 盘）验证，**不是用户另一台电脑的复验**。

**产物**：`release-portable/workbuddy-dual-edition-manager-0.6.10-x64-portable.exe`，
75,052,638 字节，SHA-256 `1b57338dde6da0fd86f06f177f044cacd290ecd0dd02a7eb81c9d46aee8f5e9d`；`npm run verify:package` 通过（18 个根文件）。
