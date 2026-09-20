const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (event, cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  }
});
