# API 赞助商链接执行计划

> 执行人：WorkBuddy。项目目录：`E:/code/workbuddy共存`。只实现界面展示与打开赞助商网站，不改业务功能、不打包，除非用户另行要求。

**目标：** 在管理器主界面显眼展示可点击的「API赞助商：memefast.cc」，点击后用系统默认浏览器打开 `https://memefast.cc/`。

**现状：** 顶栏 `src/renderer/index.html` 有品牌区和右侧版本号；主界面工具栏位于 `main` 内。应用已禁止任意新窗口/远程导航，主进程已有固定官网 URL 的白名单打开机制，不能直接从 renderer 调用任意 URL。

## 修改范围

- `src/renderer/index.html`：在顶栏右侧版本号附近加入独立的赞助商链接节点，准确文案为「API赞助商：memefast.cc」。保持品牌标题和管理器版本信息不变。
- `src/renderer/styles.css`：添加清晰醒目的赞助商样式，确保初次打开即能看到；采用品牌蓝底或高对比强调样式，文字可读、不遮挡版本号。窄窗口下允许换行，不得挤压或覆盖品牌区。
- `src/shared/ipc.ts`：为打开赞助商站点增加专用 IPC 通道/API；只允许无参数调用，或用严格枚举值，不允许 renderer 传入 URL。
- `src/main/ipc.ts`、`src/main/services/appService.ts`：复用现有发送方校验和 `shell.openExternal` 注入，但由主进程固定映射到 `https://memefast.cc/`。不得扩展成任意 URL 打开接口。
- `src/preload/index.ts`：仅暴露专用的 `openSponsor()` 方法。
- `src/renderer/renderer.ts`：绑定点击事件，调用 `openSponsor()`；打开失败时用现有 toast 明确提示。
- `scripts/e2e.mjs` 与相关测试：断言赞助商文案可见、链接目标/调用固定、没有任意 URL 参数通道。

## 实施步骤

1. 先检查现有 `openOfficial` 的 IPC、服务依赖和测试模式，沿用同一安全边界；不要使用普通 `<a href>` 直接导航，也不要放开 `setWindowOpenHandler`。
2. 新增专用 sponsor IPC。主进程唯一目标固定为 `https://memefast.cc/`；renderer 不提供也不能覆盖 hostname、scheme 或 URL。
3. 在顶栏右侧加入链接，视觉上明显区别于版本号；可使用短标签或按钮式链接，但必须显示完整文案「API赞助商：memefast.cc」。添加键盘焦点样式、可读的 `aria-label`，并在窄窗口验证布局。
4. 点击时调用专用 IPC，由主进程使用系统浏览器打开固定地址；错误沿用应用现有错误提示方式。
5. 增加测试：
   - DOM/E2E 可见完整赞助商文案；
   - 点击触发主进程固定地址 `https://memefast.cc/`；
   - 不能从 renderer 注入 `javascript:`、其他域名或任意 URL；
   - 打开失败会显示错误提示；
   - 常规产品卡片、工具栏、版本号和现有导航/E2E 断言仍通过。
6. 执行 `npm run typecheck`、`npm test -- --run`、`npm run e2e`、`npm run build`。若有失败，修复并重跑相关命令，不得只改快照/断言绕过问题。
7. 本任务仅交付源码和验证结果；不运行 `dist:portable` 或 `dist:win`，不删除旧构建产物。

## 验收标准

- 首屏顶栏明显显示「API赞助商：memefast.cc」，点击后由系统默认浏览器打开 `https://memefast.cc/`。
- 链接打开使用固定白名单，渲染进程无法传入或注入任意 URL。
- 桌面常见宽度与窄窗口下均不遮挡标题、版本号或工具栏；键盘可聚焦并激活。
- 类型检查、单元测试、E2E、构建全部通过。
- 最终回复列出实际修改文件、验证命令结果；未执行打包需明确写「未打包」。
