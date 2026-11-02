# 能力差距矩阵（FEATURE_GAP）

> 更新：2026-10-19 20:35（v0.6.1）。验证类型严格区分：
> `源码` 仅实现 · `mock` 假依赖 · `临时目录` 真实文件操作 · `真实工具` 真实 7za · `真实官方包` 未取得 · `用户实机` 由用户提供结果。
> **「启动官方 GUI」「给指引」「按钮存在」一律不算交付。**

## 1. 能力矩阵

| # | 能力 | 状态 | 验证类型 | 位置 |
| --- | --- | --- | --- | --- |
| 1 | 官方版本发现 | **未交付**（`releases.json` 端点为空，不发请求；已人工核实两个官网下载入口） | 源码 + 官网人工核实 | `releaseSource.ts`、`docs/evidence/official-packages-2026-10-19.json` |
| 2 | 官方包下载 | **未交付**（无下载落盘管线） | 源码 | 同上 |
| 3 | 本地包选择 + 校验 | 已实现（0.6.1 起签名不阻断） | 临时目录（合成包）+ 签名矩阵单测 | `inspectPackage`、`packageVerifier` |
| 4 | 归档安全（穿越/绝对/链接/体积/条数/深度） | 已实现，危险包写盘前拒绝 | mock + 临时目录 | `archiveSafety.ts`、`tests/unit/archiveSafety.test.ts` |
| 5 | 完整应用树验证（主 exe + 应用代码 + runtime） | 已实现，缺项拒绝部署 | mock + 临时目录 | `appTree.ts` |
| 6 | 解包部署安装 | 已实现（保留旧目录 `Uninstall*.exe`/`version`/`*.msix`） | 临时目录 + **真实 7za** | `managedInstall.ts`、`tests/integration/managedDeploy.real.test.ts` |
| 7 | 真实官方包部署 | 已实现（国内版实测完整部署成功；国际版结构同构未重复跑） | 真实官方包 + 真实 7-Zip 24.09 | `docs/evidence/official-packages-2026-10-19.json` |
| 8 | 自动登记既有安装（扫描即登记） | 已实现，幂等 | 本机真实扫描（3 实例） | `core/autoTrack.ts`、`tests/unit/autoTrack.test.ts` |
| 9 | 移除跟踪 | 保留为内部状态修复 API，主界面不再暴露 | 临时目录 | `releaseInstance` |
| 10 | 更新（原位替换） | 已实现：备份 → 解包 → 同卷交换 → 校验 → 失败回滚 | 临时目录（合成包） | `replaceInstanceInPlace` |
| 11 | 更新到官方安装目录 | 已实现（受控例外写入已接管目录；需签名/版本/进程检查，备份后替换） | 临时目录 | `PathGuard.externalRoots` |
| 12 | 卸载（受管目录） | 已实现 | 临时目录 | `uninstallInstance` |
| 13 | 卸载接管实例 | 已实现：调用注册表匹配的官方卸载器 + 轮询确认；无匹配登记则明确拒绝 | mock 卸载器 | `uninstallAdopted` |
| 14 | 删除用户数据 | **未交付**（无入口，从不访问） | — | — |
| 15 | 启动 | 已实现，启动前校验签名 | mock | `launchInstance` |
| 16 | 进程检测 | 已实现（更新前只读检测，运行中拒绝覆盖）；强制关闭**未交付** | 临时目录 | `runningExecutables` |
| 17 | 桌面快捷方式 | 已实现（安装后创建、更新修复、卸载只删本工具创建的） | 单元测试（假实现）+ 一次真实创建 | `core/shortcutSpec.ts`、`adapters/shortcutWriter.ts` |
| 17b | 注册表 / 开始菜单登记 | **未交付**（解包部署不写注册表） | — | — |
| 18 | 发布者基线按 thumbprint 绑定 | **已取消**（0.6.1：签名只作诊断，不再作为安装/更新门槛） | 单元测试 | `packageVerifier.ts`、`assisted.ts` |
| 19 | 极简首屏 + 诊断次级入口 | 已实现 | E2E 截图 + 禁用词零命中 | `renderer.ts` |
| 21 | 失败日志 | 已实现（`state/errors/<时间>-<操作>.json`，脱敏） | 单元测试 | `main/errorLog.ts` |
| 22 | 取消虚拟机证据门 | 已实现（安装/更新/卸载不再被证据包阻断） | 单元测试 + 真实签名基线 | `appService.checkCapability` |
| 20 | 便携版 / NSIS 打包 | 已实现（0.3.0 构建） | 打包冒烟 | `release-0.3.0/` |

## 2. 本轮修复的真实缺陷

| 问题 | 现象 | 修复 |
| --- | --- | --- |
| Electron 子进程读不到 Authenticode | `Get-AuthenticodeSignature` 在 Electron spawn 的 PowerShell 里返回 null（安全模块不可用），导致自动登记时读不到主程序签名、实例被标为不可管理 | 保留首选调用；失败时回退到 .NET `X509Certificate.CreateFromSignedFile` + `X509Chain`（`RevocationMode=NoCheck`）离线链校验。本机实测读到 `Valid`、发布者腾讯、指纹 `E1B5824E…` |

## 3. 用户实机证据的使用范围

| 来源 | 内容 | 用途 |
| --- | --- | --- |
| 电脑 A（本次本机复测） | 国内版 2 份（`E:\Programs\workbuddy`、`E:\WorkBuddy-CN`）、国际版 1 份（`F:\WorkBuddy-AI`） | 只用于**共存识别与纳管候选**；不证明官方包部署结果 |
| 电脑 B（用户对话提供） | 国内版 5.7.7、国际版 5.7.6、`win-unpacked` 判为管理器自身 | 同上，且明确标注非本次复测 |

## 4. 未交付清单

| 项 | 原因 | 需要什么 |
| --- | --- | --- |
| 官方在线源（自动版本/下载） | 只做「打开官网让用户下载」，不碰 API/直链 | 若要做自动更新，需官方端点与条款确认 |
| 真实官方包部署后的运行 | 部署目录未启动、未登录 | 在可销毁目录里启动一次并确认登录/自更新行为 |
| 原位更新官方安装目录 | 无官方安装器行为证据 | 受控实测记录 + 用户授权 |
| 删除用户数据 | 数据目录归属未证明 | 精确目录清单 + 二次确认设计 |
| 进程强制关闭 | 计划明确要求不强杀 | 不需要（改为提示用户先退出） |
| 快捷方式/注册表/服务 | 解包部署不写这些 | 按产品逐项实现并验证 |
