'use strict';

/* ═══════════════════════════════════════════════════════
   main.js — 主进程
   窗口 / 自定义协议 / 文件系统 / 菜单 / 文件监听
   ═══════════════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, session, net, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { annotateHtml } = require('./src/source-map');

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
// 三件事：滚动位置恢复、源码行号 ↔ 滚动位置换算、点击元素反查源码行号。
const PREVIEW_HELPER = `
<style data-notes-injected>
  [data-notes-hover] { outline: 2px solid #89b4fa !important; outline-offset: -1px !important; }
  [data-notes-flash] { outline: 2px solid #f9e2af !important; outline-offset: 2px !important; }
  [data-notes-cursor] { outline: 1.5px dashed rgba(137, 180, 250, 0.75) !important; outline-offset: 2px !important; }
  html[data-notes-jump], html[data-notes-jump] * { cursor: crosshair !important; }
</style>
<script data-notes-injected>
(function () {
  var SRC = 'data-notes-line';
  var END = 'data-notes-end';
  var parentWin = window.parent;
  var embedded = !!parentWin && parentWin !== window;

  function post(msg) {
    if (!embedded) return;
    msg.__notes = true;
    try { parentWin.postMessage(msg, '*'); } catch (e) {}
  }

  /* ── 1. 刷新后恢复滚动位置（sessionStorage 跨 reload 保留） ── */
  var KEY = 'notes:scroll:' + location.pathname;
  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved) requestAnimationFrame(function () { window.scrollTo(0, parseInt(saved, 10) || 0); });
  } catch (e) {}

  /* ── 2. 源码行号 ↔ 滚动位置 ─────────────────────── */
  // 用注入了 data-notes-line 的元素当锚点，在相邻锚点之间线性插值，
  // 这样源码和预览长度不一致时也能平滑对应。
  var anchors = [];
  var anchorsAt = 0;
  var suppressUntil = 0;
  var lastReport = 0;
  var lastLine = -1;
  var reportTimer = null;

  function buildAnchors() {
    anchors = [];
    var nodes = document.querySelectorAll('[' + SRC + ']');
    var prevLine = -1;
    var prevY = -Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var line = parseInt(node.getAttribute(SRC), 10);
      if (!line || line <= prevLine) continue;
      if (!node.getClientRects().length) continue;      // 隐藏元素不参与
      var y = node.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0);
      if (y < prevY - 1) continue;                      // 绝对定位等导致顺序错乱的跳过
      anchors.push({ line: line, y: y });
      prevLine = line;
      prevY = y;
    }
    anchorsAt = Date.now();
  }

  function anchorList() {
    if (!anchors.length || Date.now() - anchorsAt > 1500) buildAnchors();
    return anchors;
  }

  // 二分：最后一个 list[i][key] <= value 的下标
  function lastBelow(list, key, value) {
    var lo = 0;
    var hi = list.length - 1;
    var hit = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid][key] <= value) { hit = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return hit;
  }

  function lineToY(line) {
    var list = anchorList();
    if (!list.length) return 0;
    var idx = lastBelow(list, 'line', line);
    if (idx < 0) return 0;
    var a = list[idx];
    var b = list[idx + 1];
    if (!b || b.y <= a.y || b.line <= a.line) return a.y;
    var t = (line - a.line) / (b.line - a.line);
    return a.y + t * (b.y - a.y);
  }

  function yToLine(y) {
    var list = anchorList();
    if (!list.length) return 0;
    var idx = lastBelow(list, 'y', y);
    if (idx < 0) return list[0].line;
    var a = list[idx];
    var b = list[idx + 1];
    if (!b || b.y <= a.y || b.line <= a.line) return a.line;
    var t = (y - a.y) / (b.y - a.y);
    return a.line + t * (b.line - a.line);
  }

  function reportScroll() {
    if (!embedded || Date.now() < suppressUntil) return;
    var line = Math.round(yToLine(window.scrollY));
    if (!line || line === lastLine) return;
    lastLine = line;
    lastReport = Date.now();
    post({ type: 'scroll', line: line });
  }

  function scheduleReport() {
    if (!embedded) return;
    // 滚动过程中跟手同步，停下来再补一次最终位置
    if (Date.now() - lastReport > 80) reportScroll();
    clearTimeout(reportTimer);
    reportTimer = setTimeout(reportScroll, 140);
  }

  function syncToLine(line) {
    if (!line) return;
    suppressUntil = Date.now() + 200;
    window.scrollTo(0, Math.max(0, Math.round(lineToY(line))));
  }

  var saveTimer = null;
  var rafPending = false;
  window.addEventListener('scroll', function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { sessionStorage.setItem(KEY, String(window.scrollY)); } catch (e) {}
    }, 150);
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(function () { rafPending = false; scheduleReport(); });
    }
  }, { passive: true });

  /* ── 3. 点击元素 → 源码行号 ─────────────────────── */
  var jumpMode = false;
  var hovered = null;
  var hoverPending = false;

  function sourceNode(start) {
    var node = start;
    while (node && node.nodeType !== 1) node = node.parentNode;
    while (node) {
      // html / body 代表整页，点空白处不该跳到它们
      if (node !== document.body && node !== document.documentElement &&
          node.getAttribute && node.getAttribute(SRC)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function setHover(node) {
    if (hovered === node) return;
    if (hovered) hovered.removeAttribute('data-notes-hover');
    hovered = node;
    if (node) node.setAttribute('data-notes-hover', '');
  }

  function exitJumpMode() {
    jumpMode = false;
    document.documentElement.removeAttribute('data-notes-jump');
    setHover(null);
  }

  // 必须先于链接处理器注册：Ctrl+点击命中元素时用 stopImmediatePropagation 拦住链接行为
  document.addEventListener('click', function (ev) {
    if (!jumpMode && !ev.ctrlKey && !ev.metaKey) return;
    var node = sourceNode(ev.target);
    if (!node) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    post({
      type: 'jump-source',
      line: parseInt(node.getAttribute(SRC), 10) || 1,
      end: parseInt(node.getAttribute(END), 10) || 0,
      tag: (node.tagName || '').toLowerCase(),
      href: location.href,
    });
    if (jumpMode) exitJumpMode();
  }, true);

  document.addEventListener('mousemove', function (ev) {
    if (!jumpMode || hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(function () {
      hoverPending = false;
      setHover(sourceNode(ev.target));
    });
  }, true);

  // Esc 退出定位模式（预览文档里按的 Esc 宿主窗口收不到，这里转告它）
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || !jumpMode) return;
    exitJumpMode();
    post({ type: 'jump-mode', on: false });
  }, true);

  /* ── 4. 宿主 → 预览：模式 / 同步滚动 / 高亮 ───────── */
  function flashLine(line) {
    if (!line) return;
    var nodes = document.querySelectorAll('[' + SRC + ']');
    var target = null;
    for (var i = 0; i < nodes.length; i++) {
      var l = parseInt(nodes[i].getAttribute(SRC), 10);
      if (l === line) { target = nodes[i]; break; }
      if (l > line) break;
      target = nodes[i];
    }
    if (!target) return;
    target.setAttribute('data-notes-flash', '');
    setTimeout(function () { target.removeAttribute('data-notes-flash'); }, 1600);
  }

  // 编辑器光标所在行 → 预览里包含该行的最内层元素描边
  var cursorNode = null;
  function markCursor(line) {
    if (!line) return;
    var nodes = document.querySelectorAll('[' + SRC + ']');
    var hit = null;
    var hitSpan = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var start = parseInt(node.getAttribute(SRC), 10);
      if (start > line) break;
      if (node === document.body || node === document.documentElement) continue;
      var end = parseInt(node.getAttribute(END), 10) || start;
      if (line > end) continue;
      if (end - start < hitSpan) { hit = node; hitSpan = end - start; }
    }
    if (cursorNode === hit) return;
    if (cursorNode) cursorNode.removeAttribute('data-notes-cursor');
    cursorNode = hit;
    if (hit) hit.setAttribute('data-notes-cursor', '');
  }

  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (!data || data.__notes !== true) return;
    if (ev.source !== parentWin) return;

    if (data.type === 'jump-mode') {
      jumpMode = !!data.on;
      if (jumpMode) document.documentElement.setAttribute('data-notes-jump', '');
      else exitJumpMode();
    } else if (data.type === 'sync-scroll') {
      syncToLine(data.line);
    } else if (data.type === 'flash-source') {
      flashLine(data.line);
    } else if (data.type === 'cursor-line') {
      markCursor(data.line);
    }
  });

  /* ── 5. 链接行为：外链走系统浏览器，库内 .html 交给宿主打开成标签页 ── */
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
      post({ type: 'open-note', href: el.href });
    }
  }, true);

  /* ── 6. 把内容高度报给宿主，便于自适应 ────────────── */
  try {
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        post({ type: 'resize', height: document.documentElement.scrollHeight });
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
      // 注入 data-notes-line 属性，让预览里的元素能反查到源码行号
      const body = isHtml ? injectHelper(annotateHtml(state.liveContent)) : state.liveContent;
      return new Response(body, {
        headers: { 'Content-Type': mimeOf(hit.rel), 'Cache-Control': 'no-store' },
      });
    }

    // 其余路径（图片、CSS、子页面…）→ 直接读磁盘
    try {
      const isHtml = /\.html?$/i.test(hit.rel);
      if (isHtml) {
        const text = await fsp.readFile(hit.abs, 'utf-8');
        return new Response(injectHelper(annotateHtml(text)), {
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

  // 本地历史：覆盖磁盘上不同的旧版本前，先把它存进库外历史目录
  await snapshotHistory(rel, full);

  // 原子写：先写同目录的隐藏临时文件再 rename。
  // 写到一半崩溃/断电时，原笔记还是完整的旧版本，不会变成半截文件。
  const dir = path.dirname(full);
  const tmp = path.join(dir, `.${path.basename(full)}.tmp-${process.pid}-${Date.now()}`);
  try {
    await fsp.writeFile(tmp, content, 'utf-8');
    const prev = await fsp.stat(full).catch(() => null);
    if (prev) await fsp.chmod(tmp, prev.mode).catch(() => {});   // 保留原权限
    await fsp.rename(tmp, full);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  const st = await fsp.stat(full);
  // 若保存的正是预览中的文件，同步缓冲
  if (state.liveFile === rel) state.liveContent = content;
  return { success: true, mtime: st.mtimeMs };
});

// ─── 本地历史 ───────────────────────────────────────────
// 每次保存前，把磁盘上的旧版本快照到 userData/history/<库>/<相对路径>.<时间戳>.<后缀>
// 快照存在笔记库外面，不污染文件树，也不会被 watcher 盯上。
const HISTORY_KEEP = 50;

function historyDirFor(rel) {
  if (!state.vault) return null;
  const key = Buffer.from(state.vault, 'utf-8').toString('base64url');
  return path.join(app.getPath('userData'), 'history', key, rel);
}

async function snapshotHistory(rel, full) {
  try {
    const prev = await fsp.readFile(full, 'utf-8').catch(() => null);
    if (prev === null) return;                       // 新文件没有旧版本
    const st = await fsp.stat(full);
    const histDir = historyDirFor(rel);
    if (!histDir) return;
    const ext = path.extname(rel) || '';
    const base = path.basename(rel, ext);
    const ts = formatStamp(st.mtime);
    const dest = path.join(histDir, `${base}.${ts}${ext}`);
    const same = await fsp.readFile(dest, 'utf-8').catch(() => null);
    if (same === prev) return;                       // 这个版本已经存过
    await fsp.mkdir(histDir, { recursive: true });
    await fsp.writeFile(dest, prev, 'utf-8');
    await pruneHistory(histDir, base, ext);
  } catch { /* 历史是锦上添花，失败不影响保存 */ }
}

function formatStamp(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function pruneHistory(histDir, base, ext) {
  const prefix = base + '.';
  const entries = (await fsp.readdir(histDir).catch(() => []))
    .filter((n) => n.startsWith(prefix) && n.endsWith(ext))
    .sort();
  while (entries.length > HISTORY_KEEP) {
    await fsp.rm(path.join(histDir, entries.shift()), { force: true }).catch(() => {});
  }
}

handle('history:list', async (rel) => {
  const histDir = historyDirFor(rel);
  if (!histDir) return { success: false, error: '未打开笔记库' };
  const ext = path.extname(rel) || '';
  const base = path.basename(rel, ext);
  const prefix = base + '.';
  const entries = (await fsp.readdir(histDir).catch(() => []))
    .filter((n) => n.startsWith(prefix) && n.endsWith(ext))
    .sort()
    .reverse();
  const versions = [];
  for (const name of entries) {
    const m = name.slice(prefix.length, name.length - ext.length);
    if (!/^\d{8}-\d{6}$/.test(m)) continue;
    const st = await fsp.stat(path.join(histDir, name)).catch(() => null);
    versions.push({ ts: m, size: st ? st.size : 0 });
  }
  return { success: true, versions };
});

handle('history:read', async (rel, ts) => {
  const histDir = historyDirFor(rel);
  if (!histDir || !/^\d{8}-\d{6}$/.test(ts || '')) return { success: false, error: '路径无效' };
  const ext = path.extname(rel) || '';
  const base = path.basename(rel, ext);
  const content = await fsp.readFile(path.join(histDir, `${base}.${ts}${ext}`), 'utf-8');
  return { success: true, content };
});

// — 二进制文件（粘贴图片等）—
handle('file:save-binary', async (rel, dataB64) => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, Buffer.from(String(dataB64 || ''), 'base64'));
  return { success: true, path: rel };
});

// — 导出 —
// 弹出「另存为」对话框并写入内容（渲染进程已把 HTML 组织好）
handle('app:save-as', async (defaultName, content) => {
  if (!state.vault) return { success: false, error: '未打开笔记库' };
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出为…',
    defaultPath: path.join(app.getPath('downloads'), defaultName || 'export.html'),
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (res.canceled || !res.filePath) return { success: false, canceled: true };
  await fsp.writeFile(res.filePath, content, 'utf-8');
  return { success: true, path: res.filePath };
});

// 把笔记渲染成 PDF：隐藏窗口加载 notes:// 协议里的笔记（相对资源都能解析），再 printToPDF
handle('export:pdf', async (rel) => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    const url = 'notes://vault/' + rel.split('/').map(encodeURIComponent).join('/');
    await win.loadURL(url);
    // 等图表/脚本渲染：did-finish-load 之后再留一小段渲染时间
    await new Promise((r) => setTimeout(r, 1200));
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margin: { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 },
    });
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出 PDF',
      defaultPath: path.join(app.getPath('downloads'), path.basename(rel, path.extname(rel)) + '.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return { success: false, canceled: true };
    await fsp.writeFile(res.filePath, buf);
    return { success: true, path: res.filePath };
  } finally {
    win.destroy();
  }
});

// ─── AI 助手 ────────────────────────────────────────────
// API Key 只存在主进程的 prefs 里，渲染进程拿不到；对话请求由主进程代理，
// 流式返回通过 ai:chunk / ai:done 广播给渲染进程。
const AI_TIMEOUT = 120000;
const aiRequests = new Map();   // id -> AbortController

function aiConfig() {
  return {
    protocol: prefs.aiProtocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: String(prefs.aiBaseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(prefs.aiApiKey || '').trim(),
    model: String(prefs.aiModel || '').trim(),
  };
}

function aiUrl(cfg, kind) {
  // kind: 'chat' | 'test'；用户填到域名或 /v1 都能自动拼出完整端点
  if (cfg.protocol === 'anthropic') {
    return /\/messages$/.test(cfg.baseUrl) ? cfg.baseUrl : `${cfg.baseUrl}/v1/messages`;
  }
  return /\/chat\/completions$/.test(cfg.baseUrl) ? cfg.baseUrl : `${cfg.baseUrl}/chat/completions`;
}

function aiHeaders(cfg) {
  if (cfg.protocol === 'anthropic') {
    return { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
  }
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

function aiBody(cfg, messages, { stream = true, maxTokens = 4096 } = {}) {
  if (cfg.protocol === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    return JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      stream,
      ...(system ? { system } : {}),
      messages: messages.filter((m) => m.role !== 'system'),
    });
  }
  return JSON.stringify({ model: cfg.model, messages, stream, max_tokens: maxTokens });
}

/** 从 SSE 响应里提取增量文本的解析器（非流式 JSON 在 aiRequest 里直接处理） */
function aiChunkExtractor(cfg, contentType) {
  if (!contentType.includes('text/event-stream')) return null;
  if (cfg.protocol === 'anthropic') {
    return (line) => {
      if (!line.startsWith('data:')) return '';
      try {
        const evt = JSON.parse(line.slice(5).trim());
        if (evt.type === 'content_block_delta') return evt.delta?.text || '';
        if (evt.type === 'error') throw new Error(evt.error?.message || '流式响应错误');
      } catch (e) { if (e instanceof SyntaxError) return ''; throw e; }
      return '';
    };
  }
  return (line) => {
    if (!line.startsWith('data:')) return '';
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return '';
    try {
      const evt = JSON.parse(payload);
      return evt.choices?.[0]?.delta?.content || '';
    } catch { return ''; }
  };
}

async function aiRequest(cfg, messages, { stream = true, maxTokens } = {}, onDelta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), AI_TIMEOUT);
  try {
    const res = await fetch(aiUrl(cfg, 'chat'), {
      method: 'POST',
      headers: aiHeaders(cfg),
      body: aiBody(cfg, messages, { stream, maxTokens }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`);
    }

    const ctype = res.headers.get('content-type') || '';
    if (!stream || !ctype.includes('text/event-stream')) {
      const json = await res.json();
      const text = cfg.protocol === 'anthropic'
        ? (json.content || []).map((c) => c.text || '').join('')
        : (json.choices?.[0]?.message?.content || '');
      onDelta?.(text);
      return text;
    }

    // SSE 流式
    const extract = aiChunkExtractor(cfg, ctype);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let carry = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const delta = extract(line);
        if (delta) { full += delta; onDelta?.(delta); }
      }
    }
    return full;
  } finally {
    clearTimeout(timer);
  }
}

// 发起对话：立即返回，流式内容通过 ai:chunk / ai:done 推送
handle('ai:chat', async ({ id, messages }) => {
  const cfg = aiConfig();
  if (!cfg.baseUrl || !cfg.model) {
    return { success: false, error: '请先在设置里配置 AI 服务地址和模型' };
  }
  const controller = new AbortController();
  aiRequests.set(id, controller);

  (async () => {
    try {
      // anthropic 的 system 由 aiBody 单独拆出；openai 直接透传
      await aiRequest(cfg, messages, { stream: true }, (delta) => broadcast('ai:chunk', { id, delta }));
      broadcast('ai:done', { id });
    } catch (err) {
      if (controller.signal.aborted || /aborted/i.test(String(err?.message))) broadcast('ai:done', { id, aborted: true });
      else broadcast('ai:done', { id, error: err.message });
    } finally {
      aiRequests.delete(id);
    }
  })();
  return { success: true };
});

handle('ai:abort', async ({ id }) => {
  aiRequests.get(id)?.abort(new Error('aborted'));
  return { success: true };
});

// 设置里的「测试连接」：发一个最小请求
handle('ai:test', async () => {
  const cfg = aiConfig();
  if (!cfg.baseUrl || !cfg.model) return { success: false, error: '请先填写服务地址和模型' };
  try {
    const reply = await aiRequest(cfg, [{ role: 'user', content: '回复"连接成功"四个字' }], { stream: false, maxTokens: 16 });
    return { success: true, reply: String(reply).trim().slice(0, 50) };
  } catch (err) {
    return { success: false, error: err.message };
  }
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

// 删除（文件夹递归删除；默认移入系统回收站，可在设置里改为永久删除）
handle('fs:delete', async (rel) => {
  const full = insideVault(rel);
  if (!full) return { success: false, error: '路径无效' };
  const st = await fsp.stat(full);
  const useTrash = prefs.trashInsteadOfDelete !== false;
  if (st.isDirectory()) {
    const entries = await fsp.readdir(full);
    if (entries.length) {
      // 交给渲染进程二次确认（非空文件夹）
      return { success: false, needsConfirm: true, count: entries.length, trash: useTrash };
    }
  }
  if (useTrash) {
    await shell.trashItem(full);
  } else {
    await fsp.rm(full, { recursive: true, force: true });
  }
  return { success: true, trashed: useTrash };
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
// 每次查询带一个递增 token：新的查询会立刻让旧查询收手，并且每扫一批文件
// 就让出一次事件循环，避免大库搜索时主进程卡住整个窗口。
let searchToken = 0;

handle('search:query', async (query, opts = {}) => {
  if (!state.vault) return { success: false, error: '未打开笔记库' };
  const q = (query || '').trim();
  if (q.length < 2) return { success: true, results: [], truncated: false };

  const token = ++searchToken;
  const caseSensitive = !!opts.caseSensitive;
  const overrides = opts.overrides || {};
  const needle = caseSensitive ? q : q.toLowerCase();
  const files = await collectHtml(state.vault);
  const results = [];
  const LIMIT = 200;
  let scanned = 0;

  for (const filePath of files) {
    if (token !== searchToken) {
      return { success: true, results: [], truncated: false, superseded: true };
    }
    if (results.length >= LIMIT) break;
    if (++scanned % 20 === 0) await new Promise((r) => setImmediate(r));

    const rel = path.relative(path.resolve(state.vault), filePath).split(path.sep).join('/');

    // 编辑器里有未保存改动的文件用内存里的版本，别的读磁盘
    let content;
    if (Object.prototype.hasOwnProperty.call(overrides, rel)) {
      content = String(overrides[rel] ?? '');
    } else {
      try { content = await fsp.readFile(filePath, 'utf-8'); } catch { continue; }
    }

    const haystack = caseSensitive ? content : content.toLowerCase();
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

    // 第一个命中在原始源码里的行号，点结果可以直接跳过去
    const line = content.slice(0, matches[0]).split('\n').length;

    const st = await fsp.stat(filePath).catch(() => null);
    results.push({
      path: rel,
      name: path.basename(filePath),
      dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
      count: matches.length,
      line,
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
  const existed = !!previewWindow && !previewWindow.isDestroyed();
  createPreviewWindow();
  if (previewWindow) {
    if (existed) {
      // 窗口已经加载好了，直接发目标；不能再挂 did-finish-load，否则会残留监听
      previewWindow.webContents.send('preview:target', { path: rel });
    } else {
      // 等窗口就绪后再通知它加载目标
      previewWindow.webContents.once('did-finish-load', () => {
        previewWindow?.webContents.send('preview:target', { path: rel });
      });
    }
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

// 独立预览窗口里点了元素 → 转给主窗口去定位源码
handle('preview:jump-source', async (payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:jump-source', payload || {});
    mainWindow.focus();
  }
  return { success: true };
});

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
