import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { fail, type Result } from "../core/contracts";
import {
  IPC,
  assistedInputSchema,
  cancelInputSchema,
  inspectInputSchema,
  installManagedSchema,
  launchInstanceSchema,
  openOfficialSchema,
  previewInputSchema,
  productInputSchema,
  rollbackInputSchema,
  settingsPatchSchema,
  sponsorInputSchema,
  startInputSchema,
  uninstallManagedSchema,
  updateManagedSchema,
} from "../shared/ipc";
import type { AppService } from "./services/appService";

/**
 * IPC 注册。每个处理器都：
 *  1) 校验发送方是本应用加载的本地页面；
 *  2) 用 zod 严格解析入参（拒绝未知字段）；
 *  3) 把异常收敛成 Result，绝不把原始堆栈抛给界面。
 */

export interface IpcContext {
  service: AppService;
  allowed: Set<number>;
  pickDirectory: () => Promise<string | null>;
  pickPackage: () => Promise<string | null>;
  exportDirectory: () => Promise<string | null>;
}

function guard(context: IpcContext, event: IpcMainInvokeEvent): Result<true> | null {
  if (!context.allowed.has(event.sender.id)) {
    return fail("E_PERMISSION", "拒绝来自未授权窗口的调用");
  }
  return null;
}

function toFailure(error: unknown): Result<never> {
  return fail("E_INTERNAL", "内部错误，已记录到诊断日志", {
    reason: error instanceof Error ? error.message : String(error),
  });
}

function handleNoInput<T>(channel: string, context: IpcContext, run: () => Promise<Result<T>>): void {
  ipcMain.handle(channel, async (event) => {
    const denied = guard(context, event);
    if (denied) return denied;
    try {
      return await run();
    } catch (error) {
      return toFailure(error);
    }
  });
}

function handleWithInput<TSchema extends z.ZodTypeAny, T>(
  channel: string,
  context: IpcContext,
  schema: TSchema,
  run: (input: z.infer<TSchema>) => Promise<Result<T>>,
): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    const denied = guard(context, event);
    if (denied) return denied;
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail("E_VALIDATION", `参数不合法：${issue?.path.join(".") ?? "root"}`, {
        reason: issue?.message ?? "unknown",
      });
    }
    try {
      return await run(parsed.data as z.infer<TSchema>);
    } catch (error) {
      return toFailure(error);
    }
  });
}

export function registerIpcHandlers(context: IpcContext): void {
  const { service } = context;

  handleNoInput(IPC.getState, context, async () => ({ ok: true as const, value: await service.getState() }));
  handleNoInput(IPC.getSettings, context, async () => ({ ok: true as const, value: await service.getSettings() }));
  handleWithInput(IPC.updateSettings, context, settingsPatchSchema, async (input) =>
    service.updateSettings(input as never),
  );
  handleNoInput(IPC.scan, context, () => service.scan());
  handleWithInput(IPC.inspectPackage, context, inspectInputSchema, async (input) =>
    service.inspectPackage(input.file, input.product),
  );
  handleWithInput(IPC.preview, context, previewInputSchema, async (input) => service.preview(input.kind, input.selections));
  handleWithInput(IPC.start, context, startInputSchema, async (input) => service.start(input.kind, input.selections));
  handleWithInput(IPC.cancel, context, cancelInputSchema, async (input) => service.cancel(input.operationId));
  handleWithInput(IPC.rollback, context, rollbackInputSchema, async (input) => service.rollback(input.operationId));
  handleNoInput(IPC.listOperations, context, async () => ({ ok: true as const, value: await service.listOperations() }));
  handleWithInput(IPC.checkUpdates, context, productInputSchema, async (input) => service.checkUpdates(input.product));
  handleWithInput(IPC.launch, context, productInputSchema, async (input) => service.launchProduct(input.product));
  handleWithInput(IPC.runAssisted, context, assistedInputSchema, async (input) =>
    service.runAssisted({
      product: input.product,
      kind: input.kind,
      packagePath: input.packagePath ?? null,
      targetRecordId: input.targetRecordId ?? null,
      confirmed: input.confirmed,
      timeoutMs: input.timeoutMs,
    }),
  );
  handleWithInput(IPC.installManaged, context, installManagedSchema, async (input) =>
    service.installFromPackage({
      product: input.product,
      packagePath: input.packagePath,
      targetDirectory: input.targetDirectory ?? null,
    }),
  );
  handleWithInput(IPC.updateManaged, context, updateManagedSchema, async (input) =>
    service.updateInstance({
      product: input.product,
      instanceId: input.instanceId,
      packagePath: input.packagePath,
    }),
  );
  handleWithInput(IPC.uninstallManaged, context, uninstallManagedSchema, async (input) => {
    if (input.confirmed !== true) {
      return fail("E_VALIDATION", "卸载必须由用户在确认框中明确同意");
    }
    return service.uninstallInstance({ product: input.product, instanceId: input.instanceId });
  });
  handleWithInput(IPC.launchInstance, context, launchInstanceSchema, async (input) =>
    service.launchInstance({ product: input.product, instanceId: input.instanceId ?? null }),
  );
  handleNoInput(IPC.listInstances, context, async () => ({ ok: true as const, value: await service.listInstances() }));
  handleWithInput(IPC.openOfficial, context, openOfficialSchema, async (input) =>
    service.openOfficialSite(input.product),
  );
  // 赞助商入口：入参必须是严格空对象，URL 由主进程常量决定
  handleWithInput(IPC.openSponsor, context, sponsorInputSchema, () => service.openSponsorSite());
  handleNoInput(IPC.exportDiagnostics, context, async () => {
    const directory = await context.exportDirectory();
    if (!directory) return fail<string>("E_CANCELLED", "用户取消了导出");
    return service.exportDiagnostics(directory);
  });
  handleNoInput(IPC.pickDirectory, context, async () => ({ ok: true as const, value: await context.pickDirectory() }));
  handleNoInput(IPC.pickPackage, context, async () => ({ ok: true as const, value: await context.pickPackage() }));
}

export function detachIpcHandlers(): void {
  for (const channel of Object.values(IPC)) {
    ipcMain.removeHandler(channel);
  }
}
