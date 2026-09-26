'use strict';

/* ═══════════════════════════════════════════════════════
   main.js — 主进程
   窗口 / 自定义协议 / 文件系统 / 菜单 / 文件监听
   ═══════════════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, session, net, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// ─── 全局状态 ───────────────────────────────────────────
let mainWindow = null;
let previewWindow = null;

const state = {
  vault: null,          // 当前笔记库绝对路径
  liveFile: null,       // 正在预览的文件（相对路径）
  liveContent: null,    // 该文件的实时缓冲区（未保存内容也在此）
  pendingFile: null,    // 启动时由命令行传入、等待渲染进程来取的文件
  watcher: null,
  watcherTimer: null,
};

// 偏好设置持久化
const PREFS_FILE = () => path.join(app.getPath('userData'), 'prefs.json');
let prefs = {};
function loadPrefs() {
  try { prefs = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf-8')); } catch { prefs = {}; }
}
function savePrefs() {
  try { fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs, null, 2), 'utf-8'); } catch { /* 忽略 */ }
}
function setPref(key, value) {
  prefs[key] = value;
  savePrefs();
  broadcast('prefs:changed', prefs);
}
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// ─── 自定义协议 ─────────────────────────────────────────
// 用 notes://vault/<相对路径> 提供笔记内容，替代坏掉的 webview+blob 方案。
// 好处：完整 JS / CDN / 相对路径图片全部可用，且能预览未保存的实时内容。
protocol.registerSchemesAsPrivileged([{
  scheme: 'notes',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// 注入预览专用的辅助脚本（只影响预览流，不写回磁盘）
const PREVIEW_HELPER = `
<script data-notes-injected>
(function () {
  // 1. 刷新后恢复滚动位置（sessionStorage 跨 reload 保留）
  var KEY = 'notes:scroll:' + location.pathname;
  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved) requestAnimationFrame(function () { window.scrollTo(0, parseInt(saved, 10) || 0); });
  } catch (e) {}
  var t;
  window.addEventListener('scroll', function () {
    clearTimeout(t);
    t = setTimeout(function () {
      try { sessionStorage.setItem(KEY, String(window.scrollY)); } catch (e) {}
    }, 120);
  }, { passive: true });

  // 2. 链接行为：外链走系统浏览器，库内 .html 交给宿主打开成标签页
  document.addEventListener('click', function (ev) {
    var el = ev.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (!el || !el.getAttribute) return;
    var href = el.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;

    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.slice(0, 2) === '//') {
      if (/^(https?|mailto):/i.test(href) || href.slice(0, 2) === '//') {
        ev.preventDefault();
        window.open(el.href, '_blank');
      }
      return;
    }
    if (/\\.html?($|[?#])/i.test(href)) {
      ev.preventDefault();
      try { parent.postMessage({ __notes: true, type: 'open-note', href: el.href }, '*'); } catch (e) {}
    }
  }, true);

  // 3. 把内容高度报给宿主，便于自适应
  try {
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        try { parent.postMessage({ __notes: true, type: 'resize', height: document.documentElement.scrollHeight }, '*'); } catch (e) {}
      }).observe(document.documentElement);
    }
  } catch (e) {}
})();
</script>`;

function injectHelper(html) {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + PREVIEW_HELPER;
  return html.slice(0, idx) + PREVIEW_HELPER + html.slice(idx);
}

// 解析 notes:// 请求 → vault 内的绝对路径（含越界防护）
function resolveVaultPath(urlStr) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(urlStr).pathname);
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (!rel || !state.vault) return null;

  const abs = path.resolve(state.vault, rel);
  const root = path.resolve(state.vault);
  // 防止 ../ 逃逸出笔记库
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return { abs, rel: path.relative(root, abs).split(path.sep).join('/') };
}

function registerProtocol() {
  protocol.handle('notes', async (request) => {
    const hit = resolveVaultPath(request.url);
    if (!hit) return new Response('Not found', { status: 404 });

    // 正在预览的文件 → 返回内存中的实时缓冲（含未保存修改）
    if (state.liveFile && hit.rel === state.liveFile && state.liveContent !== null) {
      const isHtml = /\.html?$/i.test(hit.rel);
      const body = isHtml ? injectHelper(state.liveContent) : state.liveContent;
      return new Response(body, {
        headers: { 'Content-Type': mimeOf(hit.rel), 'Cache-Control': 'no-store' },
      });
    }

    // 其余路径（图片、CSS、子页面…）→ 直接读磁盘
    try {
      const isHtml = /\.html?$/i.test(hit.rel);
      if (isHtml) {
        const text = await fsp.readFile(hit.abs, 'utf-8');
        return new Response(injectHelper(text), {
          headers: { 'Content-Type': mimeOf(hit.rel), 'Cache-Control': 'no-store' },
        });
      }
      const buf = await fsp.readFile(hit.abs);
      return new Response(buf, {
        headers: { 'Content-Type': mimeOf(hit.rel), 'Cache-Control': 'no-store' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ─── 文件系统 ───────────────────────────────────────────

function abs(rel) {
  return path.resolve(state.vault, rel);
}

// 确认路径在笔记库内
function insideVault(rel) {
  if (!state.vault || typeof rel !== 'string' || !rel) return null;
  const a = abs(rel);
  const root = path.resolve(state.vault);
  if (a !== root && !a.startsWith(root + path.sep)) return null;
  return a;
}

const SKIP = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.obsidian']);

// 递归扫描 → 文件树（空文件夹同样保留，否则新建的文件夹看不见）
async function scan(dir, rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push({
        type: 'folder',
        name: entry.name,
        path: childRel,
        children: await scan(childAbs, childRel),
      });
    } else if (/\.(html?|css|js|mjs|json|svg|png|jpe?g|gif|webp|md|txt|pdf)$/i.test(entry.name)) {
      // 不需要 stat：前端只用到名字和路径，省掉每个文件一次系统调用
      out.push({
        type: 'file',
        name: entry.name,
        path: childRel,
        ext: path.extname(entry.name).toLowerCase(),
      });
    }
  }

  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  });
  return out;
}

async function scanVault() {
  if (!state.vault) return [];
  return scan(state.vault);
}

// 递归收集所有 HTML（供搜索用）
async function collectHtml(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await collectHtml(full, out);
    else if (/\.html?$/i.test(e.name)) out.push(full);
  }
  return out;
}

// 文件名去重：a.html → a-1.html → a-2.html
async function uniqueName(dirAbs, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dirAbs, candidate))) {
    candidate = `${stem}-${i++}${ext}`;
  }
  return candidate;
}

// ─── 文件监听（外部改动自动刷新） ───────────────────────
function startWatcher() {
  stopWatcher();
  if (!state.vault) return;
  try {
    state.watcher = fs.watch(state.vault, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const base = path.basename(filename);
      if (base.startsWith('.') || SKIP.has(base)) return;
      clearTimeout(state.watcherTimer);
      state.watcherTimer = setTimeout(() => {
        broadcast('vault:fs-changed', { event, filename });
      }, 350);
    });
  } catch { /* 某些文件系统不支持 recursive watch */ }
}
function stopWatcher() {
  if (state.watcher) {
    try { state.watcher.close(); } catch { /* 忽略 */ }
    state.watcher = null;
  }
  clearTimeout(state.watcherTimer);
}

// ─── 窗口 ───────────────────────────────────────────────

// 去掉 Electron 默认菜单栏，改用应用内菜单
Menu.setApplicationMenu(null);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: prefs.theme === 'light' ? '#eff1f5' : '#11111b',
    title: 'Hypernote',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 站内链接不要在应用窗口里导航，交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 未保存改动时拦截关闭
  mainWindow.on('close', (e) => {
    if (state.forceQuit) return;
    e.preventDefault();
    mainWindow.webContents.send('app:before-close');
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // 记住窗口尺寸
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const b = mainWindow.getNormalBounds();
    prefs.bounds = { width: b.width, height: b.height, x: b.x, y: b.y };
    savePrefs();
  };
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);

  if (prefs.bounds) {
    try { mainWindow.setBounds(prefs.bounds); } catch { /* 屏幕变化，忽略 */ }
  }
  if (prefs.maximized) mainWindow.maximize();

  // 调试辅助：--screenshot <file> 截图后退出，可配合 --exec "<js>" 先驱动界面
  const shotIdx = process.argv.indexOf('--screenshot');
  if (shotIdx !== -1) {
    const target = process.argv[shotIdx + 1];
    const execIdx = process.argv.indexOf('--exec');
    const script = execIdx !== -1 ? process.argv[execIdx + 1] : null;
    const waitIdx = process.argv.indexOf('--wait');
    const wait = waitIdx !== -1 ? Number(process.argv[waitIdx + 1]) || 2500 : 2500;

    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (script) {
          try {
            const out = await mainWindow.webContents.executeJavaScript(script, true);
            console.log('EXEC_RESULT ' + JSON.stringify(out));
          } catch (err) {
            console.log('EXEC_FAIL ' + err.message);
          }
          // 给界面时间响应这次操作
          await new Promise((r) => setTimeout(r, 1200));
        }
        try {
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(target, img.toPNG());
          console.log('SCREENSHOT_OK ' + target);
          // 其余窗口（例如独立预览窗口）另存为 xxx-2.png
          let n = 1;
          for (const win of BrowserWindow.getAllWindows()) {
            if (win === mainWindow || win.isDestroyed()) continue;
            n++;
            const extra = target.replace(/\.png$/i, `-${n}.png`);
            const im = await win.webContents.capturePage();
            fs.writeFileSync(extra, im.toPNG());
            console.log('SCREENSHOT_OK ' + extra);
          }
        } catch (err) {
          console.log('SCREENSHOT_FAIL ' + err.message);
        }
        state.forceQuit = true;
        app.quit();
      }, wait);
    });
  }

  // 把渲染进程的日志转到主进程 stdout，便于调试
  if (process.argv.includes('--dev') || process.argv.includes('--screenshot')) {
    const LEVELS = ['debug', 'info', 'warn', 'error'];
    mainWindow.webContents.on('console-message', (event) => {
      const level = LEVELS[event.level] ?? event.level;
      if (level === 'debug' || level === 'info') return;
      console.log(`[renderer/${level}] ${event.message}  (${event.sourceId}:${event.lineNumber})`);
    });
    mainWindow.webContents.on('render-process-gone', (e, details) => {
      console.log('[renderer] 进程崩溃:', JSON.stringify(details));
    });
    mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
      console.log(`[renderer] 加载失败 ${code} ${desc} ${url}`);
    });
  }
}

// 独立预览窗口
function createPreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.focus();
    return;
  }
  previewWindow = new BrowserWindow({
    width: 900,
    height: 800,
    backgroundColor: '#ffffff',
    title: '预览',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  previewWindow.loadFile(path.join(__dirname, 'src', 'preview.html'));
  previewWindow.on('closed', () => {
    previewWindow = null;
    broadcast('preview:window-closed');
  });
}

// ─── IPC ────────────────────────────────────────────────

const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// — 笔记库 —
handle('vault:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择笔记文件夹',
    defaultPath: prefs.lastVault || app.getPath('documents'),
  });
  if (res.canceled || !res.filePaths.length) return { success: false, canceled: true };
  return openVault(res.filePaths[0]);
});

handle('vault:open-recent', async (vaultPath) => openVault(vaultPath));

handle('vault:refresh', async () => {
  if (!state.vault) return { success: false, error: '未打开笔记库' };
  return { success: true, tree: await scanVault() };
});

handle('vault:reveal', async () => {
  if (!state.vault) return { success: false };
  await shell.openPath(state.vault);
  return { success: true };
});

async function openVault(vaultPath) {
  if (!fs.existsSync(vaultPath)) return { success: false, error: '文件夹不存在' };
  state.vault = vaultPath;
  state.liveFile = null;
  state.liveContent = null;
  prefs.lastVault = vaultPath;
  savePrefs();
  startWatcher();
  return {
    success: true,
    vaultPath,
    vaultName: path.basename(vaultPath),
    tree: await scanVault(),
  };
}

// — 文件读写 —
handle('file:read', async (rel) => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };
  const content = await fsp.readFile(full, 'utf-8');
  const st = await fsp.stat(full);
  return { success: true, content, mtime: st.mtimeMs };
});

handle('file:save', async (rel, content) => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf-8');
  const st = await fsp.stat(full);
  // 若保存的正是预览中的文件，同步缓冲
  if (state.liveFile === rel) state.liveContent = content;
  return { success: true, mtime: st.mtimeMs };
});

handle('file:create', async (rel, content = '') => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };
  if (fs.existsSync(full)) return { success: false, error: '同名文件已存在' };
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf-8');
  return { success: true, path: rel };
});

handle('folder:create', async (rel) => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };
  if (fs.existsSync(full)) return { success: false, error: '同名文件夹已存在' };
  await fsp.mkdir(full, { recursive: true });
  return { success: true, path: rel };
});

handle('names:unique', async (dirRel, name) => {
  const dirAbs = insideVault(dirRel || '.');
  if (!dirAbs) return { success: false, error: '路径无效' };
  await fsp.mkdir(dirAbs, { recursive: true });
  return { success: true, name: await uniqueName(dirAbs, name) };
});

// 重命名 / 移动（同一套逻辑，目标已存在则自动改名避让）
handle('fs:rename', async (oldRel, newRel) => {
  const from = insideVault(oldRel);
  const to = insideVault(newRel);
  if (!from || !to) return { success: false, error: '路径无效' };
  if (from === to) return { success: true, path: newRel, unchanged: true };
  if (!fs.existsSync(from)) return { success: false, error: '源文件不存在' };

  let finalRel = newRel;
  if (fs.existsSync(to)) {
    const dir = path.dirname(to);
    const name = await uniqueName(dir, path.basename(to));
    finalRel = path.relative(path.resolve(state.vault), path.join(dir, name)).split(path.sep).join('/');
  }
  await fsp.mkdir(path.dirname(insideVault(finalRel)), { recursive: true });
  await fsp.rename(from, insideVault(finalRel));
  return { success: true, path: finalRel, renamed: finalRel !== newRel };
});

// 删除（文件夹递归删除）
handle('fs:delete', async (rel) => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };
  const st = await fsp.stat(full);
  if (st.isDirectory()) {
    const entries = await fsp.readdir(full);
    if (entries.length && !prefs.trashInsteadOfDelete) {
      // 交给渲染进程二次确认（非空文件夹）
      return { success: false, needsConfirm: true, count: entries.length };
    }
    await fsp.rm(full, { recursive: true, force: true });
  } else {
    await fsp.rm(full, { force: true });
  }
  return { success: true };
});

handle('fs:duplicate', async (rel) => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };
  const dir = path.dirname(full);
  const name = await uniqueName(dir, path.basename(full));
  await fsp.copyFile(full, path.join(dir, name));
  return {
    success: true,
    path: path.relative(path.resolve(state.vault), path.join(dir, name)).split(path.sep).join('/'),
  };
});

handle('fs:reveal', async (rel) => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };
  shell.showItemInFolder(full);
  return { success: true };
});

// — 搜索 —
handle('search:query', async (query, opts = {}) => {
  if (!state.vault) return { success: false, error: '未打开笔记库' };
  const q = (query || '').trim();
  if (q.length < 2) return { success: true, results: [], truncated: false };

  const caseSensitive = !!opts.caseSensitive;
  const needle = caseSensitive ? q : q.toLowerCase();
  const files = await collectHtml(state.vault);
  const results = [];
  const LIMIT = 200;

  for (const filePath of files) {
    if (results.length >= LIMIT) break;
    let content;
    try { content = await fsp.readFile(filePath, 'utf-8'); } catch { continue; }

    const haystack = caseSensitive ? content : content.toLowerCase();
    const rel = path.relative(path.resolve(state.vault), filePath).split(path.sep).join('/');
    const matches = [];

    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      matches.push(idx);
      if (matches.length >= 5) break;
      idx = haystack.indexOf(needle, idx + needle.length);
    }
    if (!matches.length) continue;

    // 去掉标签后取上下文片段
    const plain = content.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                         .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                         .replace(/<[^>]*>/g, ' ')
                         .replace(/\s+/g, ' ');
    const plainLower = caseSensitive ? plain : plain.toLowerCase();
    // 用可见文本中的位置，比原始 HTML 偏移更贴近用户看到的内容
    const words = q.split(/\s+/).filter(Boolean);
    let anchor = plainLower.indexOf(caseSensitive ? words[0] : words[0].toLowerCase());
    if (anchor === -1) anchor = 0;

    const start = Math.max(0, anchor - 60);
    const snippet = (start > 0 ? '…' : '') + plain.slice(start, anchor + 140) + '…';

    const st = await fsp.stat(filePath).catch(() => null);
    results.push({
      path: rel,
      name: path.basename(filePath),
      dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
      count: matches.length,
      snippet,
      mtime: st ? st.mtimeMs : 0,
    });
  }

  results.sort((a, b) => b.count - a.count || b.mtime - a.mtime);
  return { success: true, results, truncated: results.length >= LIMIT };
});

// — 预览 —
handle('preview:set-live', async (rel, content) => {
  state.liveFile = rel || null;
  state.liveContent = content === undefined ? null : content;
  return { success: true };
});

handle('preview:clear-live', async () => {
  state.liveFile = null;
  state.liveContent = null;
  return { success: true };
});

handle('preview:open-window', async (rel, content) => {
  state.liveFile = rel || null;
  state.liveContent = content === undefined ? null : content;
  createPreviewWindow();
  // 等窗口就绪后再通知它加载目标
  if (previewWindow) {
    previewWindow.webContents.once('did-finish-load', () => {
      previewWindow.webContents.send('preview:target', { path: rel });
    });
  }
  return { success: true };
});

handle('preview:close-window', async () => {
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.close();
  return { success: true };
});

handle('preview:reload-window', async () => {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.webContents.send('preview:reload');
  }
  return { success: true };
});

handle('preview:window-is-open', async () => ({
  success: true,
  open: !!previewWindow && !previewWindow.isDestroyed(),
}));

// — 偏好设置 —
handle('prefs:get', async () => ({ success: true, prefs }));
handle('prefs:set', async (key, value) => { setPref(key, value); return { success: true }; });

// — 应用/窗口 —
handle('app:ready-to-close', async (ok) => {
  if (ok) {
    state.forceQuit = true;
    if (mainWindow) mainWindow.close();
    else app.quit();
  }
  return { success: true };
});

handle('app:quit', async () => {
  state.forceQuit = true;
  app.quit();
  return { success: true };
});

handle('app:relaunch', async () => {
  state.forceQuit = true;
  app.relaunch();
  app.exit(0);
});

// 渲染进程初始化完成后主动来取「启动时命令行传入的文件」。
// 用拉取而不是推送，避免初始化慢时的丢消息竞态。
handle('app:take-pending-file', async () => {
  const rel = state.pendingFile;
  state.pendingFile = null;
  return { success: true, path: rel };
});

handle('shell:open-external', async (target) => {
  if (!/^(https?|mailto):/i.test(target)) return { success: false, error: '仅支持 http(s)/mailto' };
  await shell.openExternal(target);
  return { success: true };
});

handle('shell:open-path', async (target) => {
  const err = await shell.openPath(target);
  return err ? { success: false, error: err } : { success: true };
});

handle('theme:system-is-dark', async () => ({ success: true, dark: nativeTheme.shouldUseDarkColors }));

// — 网络诊断 —
// 笔记里引用 CDN（ECharts / D3 / Mermaid…）时，如果外网不通，预览会静默地少东西。
// 这里主动探测一次，好让界面能明确告诉用户「为什么图表没出来」。
handle('net:diagnose', async () => {
  const PROBE = 'https://registry.npmmirror.com/';
  let proxy = 'DIRECT';
  try {
    proxy = await session.defaultSession.resolveProxy(PROBE);
  } catch { /* 忽略 */ }

  let ok = false;
  let error = null;
  try {
    const res = await net.fetch(PROBE, {
      method: 'HEAD',
      signal: AbortSignal.timeout(6000),
    });
    ok = res.status < 500;
  } catch (err) {
    error = err.message || String(err);
  }

  // 代理被配置了但连不上 → 给出可直接照做的提示
  const usingProxy = /PROXY/i.test(proxy);
  const proxyHost = usingProxy ? (proxy.match(/PROXY\s+([^\s;]+)/i)?.[1] || '') : '';

  return { success: true, ok, error, proxy, usingProxy, proxyHost };
});

// — 独立预览窗口请求目标 —
handle('preview:request-target', async () => ({
  success: true,
  path: state.liveFile,
  vaultName: state.vault ? path.basename(state.vault) : null,
}));

// ─── 从命令行参数里取出要打开的笔记文件 ─────────────────
// 对应 package.json 里的 .html / .htm 文件关联：双击笔记文件时走到这里
function fileFromArgv() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (!/\.html?$/i.test(arg)) continue;
    const abs = path.resolve(arg);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

// ─── 生命周期 ───────────────────────────────────────────
// 单实例：第二次启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      // 第二次启动传入的文件，直接在主窗口打开
      const file = fileFromArgv();
      if (file) openFileFromOutside(file);
    }
  });

  app.whenReady().then(async () => {
    loadPrefs();
    registerProtocol();

    // 命令行给了笔记文件 → 用它的所在目录作为笔记库
    const startupFile = fileFromArgv();
    if (startupFile) {
      state.vault = path.dirname(startupFile);
      await openVault(state.vault);
    } else if (prefs.lastVault && fs.existsSync(prefs.lastVault)) {
      // 否则恢复上次的笔记库
      state.vault = prefs.lastVault;
      startWatcher();
    }

    createWindow();

    // 命令行传入的笔记：记下来让渲染进程初始化完成后主动来取。
    // 不能在这里直接 send —— 渲染进程此时还在 await 初始化（要加载 Monaco），
    // 监听器尚未注册，推过去的消息会丢失。
    if (startupFile) {
      state.pendingFile = path.relative(state.vault, startupFile).split(path.sep).join('/');
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

/** 处理来自外部（第二次启动 / 文件关联）的打开请求 */
function openFileFromOutside(absPath) {
  const dir = path.dirname(absPath);
  if (state.vault !== dir) {
    // 换到文件所在目录
    openVault(dir).then(() => {
      const rel = path.relative(dir, absPath).split(path.sep).join('/');
      broadcast('app:open-file', rel);
    });
    return;
  }
  const rel = path.relative(path.resolve(dir), absPath).split(path.sep).join('/');
  broadcast('app:open-file', rel);
}

app.on('window-all-closed', () => {
  stopWatcher();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { state.forceQuit = true; });
