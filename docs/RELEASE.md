# 发布流程

## 1. 版本与依赖锁定

| 项目 | 值 |
| --- | --- |
| 管理器版本 | 0.3.0 |
| Node.js（构建用） | v22.22.2 |
| Electron | 33.4.11 |
| electron-builder | 25.1.8 |
| TypeScript | 5.9.3 |
| esbuild | 0.24.2 |
| Vitest | 2.1.9 |
| 目标平台 | Windows 10/11 x64 |
| 安装形态 | NSIS，per-user（`perMachine: false`），不需要管理员权限 |

依赖通过 `package-lock.json` 锁定，CI 使用 `npm install`（禁止在本机执行 `npm ci`，会清空 Electron 二进制）。

## 2. 构建

```bash
npm ci
npm run typecheck
npm test -- --run
npm run build
npm run dist:win
```

产物：

```
release/workbuddy-dual-edition-manager-<version>-x64.exe      # NSIS 安装版
release/win-unpacked/                                         # 免安装目录，用于冒烟
```

携带版（免安装单文件 + 绿色 zip）：

```bash
npm run dist:portable
```

产物：

```
release-portable/workbuddy-dual-edition-manager-<version>-x64-portable.exe   # 单文件携带版
release-portable/workbuddy-dual-edition-manager-<version>-x64.zip            # 解压即用的目录版
release-portable/win-unpacked/                                               # 上述 zip 的源目录
```

携带版与安装版的差异仅在**数据落点**：携带版把 `userData`/`sessionData`/`cache`/`logs`、
设置、操作日志、受管目录全部写到 exe 同级的 `WorkBuddyDualEdition-Data\`，不写 `%APPDATA%`、不写注册表。
两者共用同一份 `app.asar` 与 `config/`，安全策略（能力门、路径守卫、事务）完全一致。

## 3. 签名

**当前状态：未签名测试构建。** 没有可信代码签名证书时，不得对外标记为正式版。

正式签名步骤：

1. 取得组织代码签名证书（EV 或 OV），确认有效期与私钥保护方式（硬件令牌/HSM）。
2. 通过环境变量提供凭据，不写入仓库：
   ```powershell
   $env:CSC_LINK = "C:\secure\codesign.pfx"
   $env:CSC_KEY_PASSWORD = "<从密码管理器读取>"
   ```
3. 重新执行 `npm run dist:win`，electron-builder 会自动签名安装包与 `win-unpacked` 内的可执行文件。
4. 校验签名：
   ```powershell
   Get-AuthenticodeSignature -LiteralPath .\release\workbuddy-dual-edition-manager-0.3.0-x64.exe |
     Format-List Status, StatusMessage, SignerCertificate
   ```
   要求 `Status = Valid`，且 `SignerCertificate.Subject` 与预期主体一致。
5. 记录产物 SHA-256：
   ```powershell
   Get-FileHash .\release\workbuddy-dual-edition-manager-0.3.0-x64.exe -Algorithm SHA256
   ```

## 4. 发布检查清单

- [ ] 依赖已就绪（本机禁止执行 `npm ci`：曾误清空 Electron 二进制）
- [ ] `npm run typecheck` 无错误
- [ ] `npm test -- --run` 全绿（当前 216 个测试）
- [ ] `npm run build` 成功
- [ ] `npm run e2e` 通过，截图人工检查无破版
- [ ] `npm run dist:win` 成功，产物哈希已记录
- [ ] `npm run dist:portable` 成功，携带版 exe 与 zip 哈希已记录
- [ ] 携带版在**不含 Node.js** 的机器上双击可启动，且 `WorkBuddyDualEdition-Data` 生成在 exe 同级
- [ ] 安装包已签名且 `Status = Valid`（正式版必须）
- [ ] 在干净 Windows x64（无 Node.js、标准用户）安装并启动，完成一次只读扫描
- [ ] `git status --short` 中无客户端安装包、用户数据、日志、密钥
- [ ] `docs/TEST_MATRIX.md` 的支持矩阵与证据一致
- [ ] README 的"已验证/未验证"表与实际状态一致

## 5. 管理器自身更新

- 只更新本工具自身，使用 electron-builder 支持的 Windows NSIS 更新流程，并校验管理器发布签名。
- 与 WorkBuddy 客户端更新**完全分离**：管理器更新不会触发任何客户端安装器。
- 当前未启用自动更新（无签名证书、无发布通道），仅支持手动重新安装新版本。

## 6. 回滚

- 保留上一个可启动的管理器版本安装包与哈希。
- 管理器自身回滚 = 重新安装上一版本；用户数据目录（`%APPDATA%\workbuddy-dual-edition-manager`）不随卸载删除。
- 受管实例回滚：更新采用 side-by-side，旧版本目录保留；失败时事务自动删除新目录。
- 卸载回滚：删除前已备份到 `<管理根>/<产品>/backups`，可从备份恢复程序文件。
- 官方安装器回滚：不支持（本工具不执行官方安装器）。

## 7. 解包组件分发

- 受管部署使用随项目分发的官方 7-Zip Extra 26.04 x64；`7za.exe`、配套 DLL 与原版 `License.txt` 位于 `resources/7zip/`。
- 无需系统安装 7-Zip；打包后检查 `release-*/win-unpacked/resources/7zip/` 的组件与许可文件均存在，否则不交付。
- 0.3.0 起 NSIS、portable、zip 三种形态一次构建（`--win nsis portable zip`）。
- 7za 只用于 `list` / `extract`，从不执行归档内容；不写注册表或系统目录。
