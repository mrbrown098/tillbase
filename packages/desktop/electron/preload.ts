import { contextBridge, ipcRenderer } from "electron";
import { channels, type IpcResult, type TillbaseApi } from "../shared/api.js";

const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>;

for (const name of channels) {
  api[name] = async (...args: unknown[]) => {
    const result = (await ipcRenderer.invoke(name, ...args)) as IpcResult<unknown>;
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
}

contextBridge.exposeInMainWorld("tillbase", api as unknown as TillbaseApi);
