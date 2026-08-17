import { contextBridge, ipcRenderer } from 'electron';

export interface BajinApi {
  bootstrap(): Promise<{
    mock: boolean;
    apiKey: string | null;
    model: string | null;
    mode: string | null;
    baseUrl: string | null;
    home: string | null;
  }>;
  rpc<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T>;
  pickDir(): Promise<string | null>;
  remotesList(): Promise<Array<RemoteWorkspace>>;
  remotesAdd(r: RemoteWorkspace): Promise<Array<RemoteWorkspace>>;
  remotesRemove(name: string): Promise<Array<RemoteWorkspace>>;
  connectRemote(name: string): Promise<{ ok: boolean; error?: string }>;
  termStart(cwd?: string): Promise<{ ok: boolean; error?: string }>;
  termInput(input: string): Promise<{ ok: boolean }>;
  termStop(): Promise<{ ok: boolean }>;
  configGetSettings<T = Record<string, unknown>>(): Promise<T>;
  configSetSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  configPatch(patch: Record<string, unknown>): Promise<{ dataDir: string | null; mcpCount: number }>;
  mcpGet<T = Record<string, unknown>>(): Promise<T>;
  dataDirGet(): Promise<string | null>;
  dataMigrate(target: string): Promise<{ ok: boolean; error?: string }>;
  notify(title: string, body: string): Promise<boolean>;
  revealPath(p: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  browserClearCache(): Promise<boolean>;
  browserClearData(): Promise<boolean>;
  browserNavigate(url: string): Promise<boolean>;
  onBrowserNavigate(cb: (url: string) => void): () => void;
  hooksGet<T = Record<string, unknown> | null>(): Promise<T>;
  hooksSetEnabled(enabled: boolean): Promise<Record<string, unknown>>;
  hooksSave(hooks: Record<string, unknown>): Promise<Record<string, unknown>>;
  onEvent(cb: (payload: { event: string; params: unknown }) => void): () => void;
}

export interface RemoteWorkspace {
  name: string;
  host: string;
  port?: number;
  user?: string;
  path: string;
}

const api: BajinApi = {
  bootstrap: () => ipcRenderer.invoke('bajin:bootstrap'),
  rpc: (method, params) => ipcRenderer.invoke('bajin:rpc', method, params),
  pickDir: () => ipcRenderer.invoke('bajin:pick-dir'),
  remotesList: () => ipcRenderer.invoke('bajin:remotes:list'),
  remotesAdd: (r: RemoteWorkspace) => ipcRenderer.invoke('bajin:remotes:add', r),
  remotesRemove: (name: string) => ipcRenderer.invoke('bajin:remotes:remove', name),
  connectRemote: (name: string) => ipcRenderer.invoke('bajin:connect-remote', name),
  termStart: (cwd?: string) => ipcRenderer.invoke('bajin:term:start', cwd),
  termInput: (input: string) => ipcRenderer.invoke('bajin:term:input', input),
  termStop: () => ipcRenderer.invoke('bajin:term:stop'),
  configGetSettings: () => ipcRenderer.invoke('bajin:config:get-settings'),
  configSetSettings: (patch) => ipcRenderer.invoke('bajin:config:set-settings', patch),
  configPatch: (patch) => ipcRenderer.invoke('bajin:config:patch', patch),
  mcpGet: () => ipcRenderer.invoke('bajin:config:mcp'),
  dataDirGet: () => ipcRenderer.invoke('bajin:config:data-dir'),
  dataMigrate: (target) => ipcRenderer.invoke('bajin:data:migrate', target),
  notify: (title, body) => ipcRenderer.invoke('bajin:notify', title, body),
  revealPath: (p) => ipcRenderer.invoke('bajin:reveal-path', p),
  openExternal: (url) => ipcRenderer.invoke('bajin:open-external', url),
  browserClearCache: () => ipcRenderer.invoke('bajin:browser:clear-cache'),
  browserClearData: () => ipcRenderer.invoke('bajin:browser:clear-data'),
  browserNavigate: (url) => ipcRenderer.invoke('bajin:browser:navigate', url),
  onBrowserNavigate: (cb) => {
    const listener = (_e: unknown, p: { url: string }) => cb(p.url);
    ipcRenderer.on('bajin:browser:navigate', listener as never);
    return () => ipcRenderer.removeListener('bajin:browser:navigate', listener as never);
  },
  hooksGet: () => ipcRenderer.invoke('bajin:hooks:get'),
  hooksSetEnabled: (enabled: boolean) => ipcRenderer.invoke('bajin:hooks:set-enabled', enabled),
  hooksSave: (hooks) => ipcRenderer.invoke('bajin:hooks:save', hooks),
  onEvent: (cb) => {
    const listener = (_e: unknown, payload: { event: string; params: unknown }) => cb(payload);
    ipcRenderer.on('bajin:event', listener);
    return () => ipcRenderer.removeListener('bajin:event', listener);
  },
};

contextBridge.exposeInMainWorld('bajin', api);
