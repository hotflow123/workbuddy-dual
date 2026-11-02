import { contextBridge, ipcRenderer } from "electron";
import { IPC, type ProgressPayload, type WorkBuddyApi } from "../shared/ipc";

/**
 * 最小化、强类型的 preload API。
 * 只暴露白名单方法；不暴露 fs / path / child_process / 任意 IPC 通道。
 */

function unwrapDialogPath(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const result = value as { ok?: unknown; value?: unknown };
  return result.ok === true && typeof result.value === "string" ? result.value : null;
}

const api: WorkBuddyApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  scan: () => ipcRenderer.invoke(IPC.scan),
  inspectPackage: (file, product) => ipcRenderer.invoke(IPC.inspectPackage, { file, product }),
  preview: (kind, selections) => ipcRenderer.invoke(IPC.preview, { kind, selections }),
  start: (kind, selections) => ipcRenderer.invoke(IPC.start, { kind, selections }),
  cancel: (operationId) => ipcRenderer.invoke(IPC.cancel, { operationId }),
  rollback: (operationId) => ipcRenderer.invoke(IPC.rollback, { operationId }),
  listOperations: () => ipcRenderer.invoke(IPC.listOperations),
  checkUpdates: (product) => ipcRenderer.invoke(IPC.checkUpdates, { product }),
  launch: (product) => ipcRenderer.invoke(IPC.launch, { product }),
  runAssisted: (input) => ipcRenderer.invoke(IPC.runAssisted, input),
  installManaged: (input) => ipcRenderer.invoke(IPC.installManaged, input),
  updateManaged: (input) => ipcRenderer.invoke(IPC.updateManaged, input),
  uninstallManaged: (input) => ipcRenderer.invoke(IPC.uninstallManaged, input),
  launchInstance: (input) => ipcRenderer.invoke(IPC.launchInstance, input),
  listInstances: () => ipcRenderer.invoke(IPC.listInstances),
  openOfficial: (input) => ipcRenderer.invoke(IPC.openOfficial, input),
  // 无入参：目标地址由主进程固定，renderer 无法传入或覆盖 URL
  openSponsor: () => ipcRenderer.invoke(IPC.openSponsor),
  exportDiagnostics: () => ipcRenderer.invoke(IPC.exportDiagnostics),
  // Dialog handlers use the standard Result envelope; the renderer API exposes only the selected path.
  pickDirectory: async () => unwrapDialogPath(await ipcRenderer.invoke(IPC.pickDirectory)),
  pickPackage: async () => unwrapDialogPath(await ipcRenderer.invoke(IPC.pickPackage)),
  onProgress: (listener) => {
    const handler = (_event: unknown, payload: ProgressPayload) => {
      listener(payload);
    };
    ipcRenderer.on(IPC.progress, handler);
    return () => ipcRenderer.removeListener(IPC.progress, handler);
  },
};

contextBridge.exposeInMainWorld("workbuddy", api);
