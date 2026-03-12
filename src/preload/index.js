const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arie', {
  onboard: {
    complete:    (d)   => ipcRenderer.invoke('onboard:complete', d),
    validateKey: (key) => ipcRenderer.invoke('onboard:validate-key', key),
  },
  claude: {
    chat:     (messages, system, feature) => ipcRenderer.invoke('claude:chat', { messages, system, feature }),
    getCosts: ()                          => ipcRenderer.invoke('claude:get-costs'),
  },
  app: {
    getUser:           ()  => ipcRenderer.invoke('app:get-user'),
    getUserFull:       ()  => ipcRenderer.invoke('app:get-user-full'),
    getWorkspace:      ()  => ipcRenderer.invoke('app:get-workspace'),
    getTrackingStatus: ()  => ipcRenderer.invoke('app:get-tracking-status'),
    saveStyle:         (d) => ipcRenderer.invoke('app:save-style', d),
    getStyle:          ()  => ipcRenderer.invoke('app:get-style'),
    setUnreadCount:    (n) => ipcRenderer.invoke('app:set-unread-count', n),
    updateUser:        (d) => ipcRenderer.invoke('app:update-user', d),
    installUpdate:     ()  => ipcRenderer.invoke('app:install-update'),
    getPlatform:       ()  => ipcRenderer.invoke('app:get-platform'),
  },
  oauth: {
    microsoft:  ()      => ipcRenderer.invoke('oauth:microsoft'),
    google:     ()      => ipcRenderer.invoke('oauth:google'),
    apple:      (creds) => ipcRenderer.invoke('apple:connect', creds),
    disconnect: (p)     => ipcRenderer.invoke('oauth:disconnect', p),
  },
  email: {
    fetch: (provider) => ipcRenderer.invoke('email:fetch', { provider }),
    send:  (opts)     => ipcRenderer.invoke('email:send', opts),
  },
  calendar: {
    fetch: (provider) => ipcRenderer.invoke('calendar:fetch', { provider }),
  },
  shell: {
    open:     (url)  => ipcRenderer.invoke('shell:open', url),
    copyText: (text) => ipcRenderer.invoke('shell:copy', text),
  },
  tracker: {
    record:    (type, detail) => ipcRenderer.invoke('tracker:record', type, detail),
    status:    ()             => ipcRenderer.invoke('tracker:status'),
    submitNow: ()             => ipcRenderer.invoke('tracker:submit-now'),
  },
  // Backend API bridge — renderer calls backend routes without holding auth token
  backend: {
    call: (method, path, body) => ipcRenderer.invoke('backend:call', method, path, body),
  },
  // Events from main → renderer
  onTrayNav:          (cb) => ipcRenderer.on('tray:nav',          (_, page) => cb(page)),
  onUpdateAvailable:  (cb) => ipcRenderer.on('update:available',  (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, info) => cb(info)),
  onPaymentComplete:  (cb) => ipcRenderer.on('payment:complete',  ()        => cb()),
  onStripeSuccess:    (cb) => ipcRenderer.on('stripe:success',    (_, d)    => cb(d)),
  on: (channel, cb) => {
    const allowed = ['tray:nav','update:available','update:downloaded','stripe:success','sync:online','sync:offline'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, ...args) => cb(...args));
  },
  platform: process.platform,
});
