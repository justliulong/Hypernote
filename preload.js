'use strict';

/* ═══════════════════════════════════════════════════════
   preload.js — 渲染进程与主进程之间的安全桥接
   只暴露白名单 API，渲染进程拿不到 Node
   ═══════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const pkg = require('./package.json');

// Monaco 的绝对 file:// 路径（不依赖页面相对路径，避免换目录后失效）
const MONACO_MIN = path.join(__dirname, 'node_modules', 'monaco-editor', 'min');
const MONACO_VS = path.join(MONACO_MIN, 'vs');
const monacoBase = pathToFileURL(MONACO_VS).href;                                   // file:///.../min/vs
const monacoWorker = pathToFileURL(path.join(MONACO_VS, 'base', 'worker', 'workerMain.js')).href;
// worker 内部把 baseUrl 和模块 id（vs/...）拼接，所以要给到 min/ 这一层，否则会拼出 vs/vs/...
const monacoRoot = pathToFileURL(MONACO_MIN).href;                                  // file:///.../min

// 事件订阅：返回取消订阅函数，避免重复注册
function on(channel, callback) {
  const wrapped = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('notesAPI', {
  // ── 环境 ──
  platform: process.platform,
  version: pkg.version,
  monacoBase,
  monacoRoot,
  monacoWorker,
  /** notes:// 协议下笔记库的虚拟主机名 */
  previewOrigin: 'notes://vault',

  // ── 笔记库 ──
  openVault: invoke('vault:open'),
  openRecentVault: invoke('vault:open-recent'),
  refreshVault: invoke('vault:refresh'),
  revealVault: invoke('vault:reveal'),

  // ── 文件 ──
  readFile: invoke('file:read'),
  saveFile: invoke('file:save'),
  createFile: invoke('file:create'),
  createFolder: invoke('folder:create'),
  uniqueName: invoke('names:unique'),
  renameEntry: invoke('fs:rename'),
  deleteEntry: invoke('fs:delete'),
  duplicateEntry: invoke('fs:duplicate'),
  revealEntry: invoke('fs:reveal'),

  // ── 搜索 ──
  search: invoke('search:query'),

  // ── 预览 ──
  setLivePreview: invoke('preview:set-live'),
  clearLivePreview: invoke('preview:clear-live'),
  openPreviewWindow: invoke('preview:open-window'),
  closePreviewWindow: invoke('preview:close-window'),
  reloadPreviewWindow: invoke('preview:reload-window'),
  isPreviewWindowOpen: invoke('preview:window-is-open'),
  requestPreviewTarget: invoke('preview:request-target'),

  // ── 设置 / 应用 ──
  getPrefs: invoke('prefs:get'),
  setPref: invoke('prefs:set'),
  readyToClose: invoke('app:ready-to-close'),
  takePendingFile: invoke('app:take-pending-file'),
  quit: invoke('app:quit'),
  relaunch: invoke('app:relaunch'),
  openExternal: invoke('shell:open-external'),
  openPath: invoke('shell:open-path'),
  systemIsDark: invoke('theme:system-is-dark'),
  diagnoseNetwork: invoke('net:diagnose'),

  // ── 主进程 → 渲染进程事件 ──
  onOpenFile: (cb) => on('app:open-file', cb),
  onFsChanged: (cb) => on('vault:fs-changed', cb),
  onPrefsChanged: (cb) => on('prefs:changed', cb),
  onBeforeClose: (cb) => on('app:before-close', cb),
  onPreviewTarget: (cb) => on('preview:target', cb),
  onPreviewReload: (cb) => on('preview:reload', cb),
  onPreviewWindowClosed: (cb) => on('preview:window-closed', cb),
});
