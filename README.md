# WorkBuddy 双版本共存工具

让 **国内版 WorkBuddy** 和 **国际版 WorkBuddy AI** 装在同一台电脑上、各用各的目录，互不覆盖。

Windows 10 / 11 x64。
<img width="1166" height="813" alt="68d63b52-d490-4d02-b3bf-755cb5d5072b" src="https://github.com/user-attachments/assets/95c0bd24-5c9e-46c6-b2ab-b423b897b123" />


## 怎么用

1. **准备好安装包**：从官网下载 `workbuddy-cn-setup.exe` / `workbuddy-ai-setup.exe`，放在本机任意位置。
2. **选择版本**：打开工具，点对应产品卡片上的「安装新版本…」，在弹出的文件框里选中刚下载的安装包。
3. **选择安装路径**：确认安装目录。默认填的是管理根目录下的版本化路径，可以改成你想要的目录，例如 `D:\WorkBuddy-CN`、`D:\WorkBuddy-AI`。两个版本要选**不同**目录。
4. **点击安装**：点「开始安装」，等进度条走完即可。装好后点「启动」就能用。

装完会在桌面生成对应快捷方式。想装另一个版本，重复上面 4 步，换个目录。

> 安装目录可以填不存在的路径（工具会创建）；已存在的目录必须是空目录。

## 已经装过的怎么办

打开工具会自动扫描，已装的版本直接列出来，不需要重新安装。之后可以在列表里「启动」「更新」「卸载」。

- **更新**：点实例上的「更新」→ 工具打开官网 → 你下载新安装包 → 回来选中文件 → 工具自动替换原目录（先备份，失败自动还原）。
- **卸载**：点「卸载」，只删程序文件，聊天记录和登录状态不动。

## 数据放在哪

| 版本 | 数据位置 |
| --- | --- |
| 安装版 | `%APPDATA%\workbuddy-dual-edition-manager` |
| 携带版 | exe 同级的 `WorkBuddyDualEdition-Data\` |

携带版是单个 exe，双击即用，不写注册表、不建快捷方式，整个文件夹拷走就能换台电脑用。

## 开发者

```bash
npm install
npm run build          # 构建到 dist/
npm start              # 构建并启动
npm test -- --run      # 单元测试
npm run e2e            # 界面冒烟测试
npm run dist:portable  # 打包携带版到 release-portable/
npm run dist:win       # 打包安装版到 release/
```

源码结构：`src/core` 业务逻辑、`src/main` 主进程、`src/renderer` 界面、`src/shared` IPC 契约、`tests` 测试、`docs` 文档。
