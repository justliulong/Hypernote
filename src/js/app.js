'use strict';

/* ═══════════════════════════════════════════════════════
   app.js — 主控制器
   ═══════════════════════════════════════════════════════ */

const App = {
  vaultPath: null,
  vaultName: null,
  tree: [],
  prefs: {
    theme: 'dark',
    fontSize: 13.5,
    lineHeight: 1.65,
    tabSize: 2,
    wordWrap: false,
    minimap: false,
    livePreview: true,
    autoSave: false,
    sidebarWidth: 262,
    splitRatio: 0.5,
  },
  savedContent: new Map(),   // rel -> 磁盘上的内容（用于外部改动比对）
  mode: 'split',             // edit | split | preview
  splitDir: 'right',         // right | bottom
  _watcherTimer: null,
  _autoSaveTimer: null,

  /* ═══ 启动 ═══════════════════════════════════════════ */
  async init() {
    Icons.hydrate();

    // 读偏好设置
    const prefRes = await window.notesAPI.getPrefs();
    if (prefRes.success) {
      const p = prefRes.prefs || {};
      Object.assign(this.prefs, {
        theme: p.theme || this.prefs.theme,
        fontSize: p.fontSize || this.prefs.fontSize,
        tabSize: p.tabSize ?? this.prefs.tabSize,
        wordWrap: p.wordWrap ?? this.prefs.wordWrap,
        minimap: p.minimap ?? this.prefs.minimap,
        livePreview: p.livePreview ?? this.prefs.livePreview,
        autoSave: p.autoSave ?? this.prefs.autoSave,
        sidebarWidth: p.sidebarWidth || this.prefs.sidebarWidth,
        splitRatio: p.splitRatio || this.prefs.splitRatio,
      });
    }

    // 恢复界面状态
    this.mode = this.loadUiState('mode', 'split');
    this.splitDir = this.loadUiState('splitDir', 'right');

    await Theme.init();

    Tabs.init();
    FileTree.init();
    Search.init();
    Preview.init();

    this.applyLayout();
    this.bindChrome();
    this.bindKeys();
    this.bindIpc();

    await Editor.init(this.prefs);
    if (Editor.ready) Editor.setTheme(Theme.resolved);

    Status.setMessage('就绪');

    // 主进程可能已经恢复了上次的笔记库
    await this.restoreVault();

    // 启动时命令行传入的笔记（文件关联 / `hypernote 某篇.html`）。
    // 主动来取而不是等主进程推送 —— 初始化到这里已经花了不少时间，
    // 推送模式会因为监听器注册太晚而丢消息。
    const pending = await window.notesAPI.takePendingFile();
    if (pending?.success && pending.path) {
      if (FileTree.findNode(pending.path)) await this.openFile(pending.path);
      else Toast.warn(`找不到笔记 ${pending.path}`);
    }

    // 一个标签页都没有时展示欢迎页
    if (!Tabs.tabs.length) this.showWelcome(true);
  },

  async restoreVault() {
    const prefRes = await window.notesAPI.getPrefs();
    const last = prefRes.success ? prefRes.prefs.lastVault : null;
    if (!last) return;
    const res = await window.notesAPI.openRecentVault(last);
    if (res.success) this.onVaultOpened(res);
  },

  /* ═══ 界面状态持久化（localStorage，不受主进程影响） ═══ */
  uiKey(key) { return `notes.ui.${this.vaultPath || 'global'}.${key}`; },
  loadUiState(key, fallback) {
    try {
      const raw = localStorage.getItem(this.uiKey(key));
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  saveUiState(key, value) {
    try { localStorage.setItem(this.uiKey(key), JSON.stringify(value)); } catch { /* 忽略 */ }
  },

  /* ═══ 布局 ═══════════════════════════════════════════ */
  applyLayout() {
    document.body.dataset.mode = this.mode;
    document.body.dataset.split = this.splitDir;
    $$('#layout-switch .icon-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === this.mode));
    this.applyPaneSizes();
    Editor.layout();
  },

  setMode(mode) {
    if (!['edit', 'split', 'preview'].includes(mode)) return;
    this.mode = mode;
    this.saveUiState('mode', mode);
    this.applyLayout();
  },

  cycleMode() {
    const order = ['edit', 'split', 'preview'];
    this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
    Status.setMessage(`布局：${{ edit: '仅编辑', split: '分屏', preview: '仅预览' }[this.mode]}`);
  },

  setSplitDir(dir) {
    this.splitDir = dir;
    this.saveUiState('splitDir', dir);
    this.applyLayout();
    Status.setMessage(`预览位置：${dir === 'right' ? '右侧' : '下方'}`);
  },

  /** 把保存的宽度 / 比例应用到面板 */
  applyPaneSizes() {
    const sidebar = $('#sidebar');
    const previewPane = $('#pane-preview');
    const w = Math.max(180, Math.min(this.prefs.sidebarWidth || 262, window.innerWidth * 0.5));
    sidebar.style.width = `${w}px`;

    if (this.mode === 'split' && previewPane) {
      const ratio = Math.max(0.15, Math.min(this.prefs.splitRatio || 0.5, 0.85));
      previewPane.style.flex = `0 0 ${(ratio * 100).toFixed(2)}%`;
    } else if (previewPane) {
      previewPane.style.flex = '1 1 0';
    }
    if (Editor.ready) Editor.layout();
  },

  /* ═══ 侧边栏 / 分屏 拖拽 ═══════════════════════════ */
  bindResizers() {
    this.makeResizer($('#resizer-sidebar'), {
      axis: 'x',
      onMove: (delta, startValue) => {
        const w = Math.max(180, Math.min(startValue + delta, window.innerWidth * 0.5));
        $('#sidebar').style.width = `${w}px`;
      },
      onEnd: () => {
        this.prefs.sidebarWidth = parseInt($('#sidebar').style.width, 10) || 262;
        window.notesAPI.setPref('sidebarWidth', this.prefs.sidebarWidth);
        Editor.layout();
      },
    });

    this.makeResizer($('#resizer-split'), {
      axis: this.splitDir === 'right' ? 'x' : 'y',
      onMove: (delta) => {
        const panes = $('#panes');
        const rect = panes.getBoundingClientRect();
        const total = this.splitDir === 'right' ? rect.width : rect.height;
        const other = this.splitDir === 'right' ? $('#pane-editor').getBoundingClientRect().width
                                                : $('#pane-editor').getBoundingClientRect().height;
        const ratio = Math.max(0.15, Math.min((other + delta) / total, 0.85));
        $('#pane-preview').style.flex = `0 0 ${(ratio * 100).toFixed(2)}%`;
        this.prefs.splitRatio = ratio;
        Editor.layout();
      },
      onEnd: () => window.notesAPI.setPref('splitRatio', this.prefs.splitRatio),
    });
  },

  makeResizer(node, { axis, onMove, onEnd }) {
    if (!node) return;
    let dragging = false;
    let start = 0;

    node.addEventListener('mousedown', (e) => {
      dragging = true;
      start = axis === 'x' ? e.clientX : e.clientY;
      node.classList.add('dragging');
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    const move = (e) => {
      if (!dragging) return;
      const delta = (axis === 'x' ? e.clientX : e.clientY) - start;
      onMove(delta, start);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      node.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onEnd?.();
    };

    document.addEventListener('mousemove', rafThrottle(move));
    document.addEventListener('mouseup', up);
  },

  /* ═══ 顶栏 / 侧栏按钮绑定 ═══════════════════════════ */
  bindChrome() {
    this.bindResizers();

    $('#btn-app-menu').addEventListener('click', (e) => this.showAppMenu(e.currentTarget));
    $('#btn-theme').addEventListener('click', () => {
      const next = Theme.cycle();
      Toast.info(`主题：${{ dark: '暗色', light: '浅色', system: '跟随系统' }[next]}`, { timeout: 1500 });
    });
    $('#btn-open-vault').addEventListener('click', () => this.openVault());
    $('#btn-open-vault-welcome').addEventListener('click', () => this.openVault());
    $('#btn-new-note').addEventListener('click', () => this.createNote({}));
    $('#btn-new-folder').addEventListener('click', () => this.createFolder({}));
    $('#btn-refresh').addEventListener('click', () => this.refreshVault());
    $('#btn-search').addEventListener('click', () => Search.toggle());
    $('#btn-collapse-all').addEventListener('click', () => {
      const allOpen = $$('.tree-row.folder.open', FileTree.container).length > 0;
      allOpen ? FileTree.collapseAll() : FileTree.expandAll();
    });
    $('#btn-sidebar-toggle').addEventListener('click', () => this.toggleSidebar());

    // 布局模式切换
    $$('#layout-switch .icon-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
    });
    // 分屏方向：双击分屏按钮切换左右 / 上下
    $('#layout-btn-split')?.addEventListener('dblclick', () => {
      this.setSplitDir(this.splitDir === 'right' ? 'bottom' : 'right');
    });

    // 左右分屏方向下拉
    $('#btn-split-dir')?.addEventListener('click', (e) => {
      Menu.open([
        { label: '预览在右侧', icon: 'columns', checked: this.splitDir === 'right', onSelect: () => this.setSplitDir('right') },
        { label: '预览在下方', icon: 'split-bottom', checked: this.splitDir === 'bottom', onSelect: () => this.setSplitDir('bottom') },
      ], { anchor: e.currentTarget, align: 'end' });
    });

    // 侧栏空白处右键
    $('#sidebar').addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tree-row')) return;
      e.preventDefault();
      FileTree.showRootContextMenu(e);
    });
    // 点击空白处取消选中
    $('#file-tree').addEventListener('click', (e) => {
      if (!e.target.closest('.tree-row')) FileTree.select(null);
    });
    // 记住文件树滚动位置
    $('#sidebar-scroll').addEventListener('scroll', rafThrottle(() => FileTree.saveScroll()));
  },

  showAppMenu(anchor) {
    const hasVault = !!this.vaultPath;
    Menu.open([
      { type: 'label', label: '笔记库' },
      { label: '打开文件夹…', icon: 'folder', hint: 'Ctrl+O', onSelect: () => this.openVault() },
      { label: '刷新', icon: 'refresh', hint: 'F5', disabled: !hasVault, onSelect: () => this.refreshVault() },
      { label: '在文件管理器中显示', icon: 'folder-reveal', disabled: !hasVault, onSelect: () => window.notesAPI.revealVault() },
      { separator: true },
      { type: 'label', label: '新建' },
      { label: '新建笔记', icon: 'file-plus', hint: 'Ctrl+N', disabled: !hasVault, onSelect: () => this.createNote({}) },
      { label: '新建文件夹', icon: 'folder-plus', disabled: !hasVault, onSelect: () => this.createFolder({}) },
      { separator: true },
      { label: '命令面板…', icon: 'command', hint: 'Ctrl+P', onSelect: () => this.openPalette() },
      { label: '查找全部…', icon: 'search', hint: 'Ctrl+Shift+F', disabled: !hasVault, onSelect: () => Search.toggle(true) },
      { separator: true },
      { label: '设置…', icon: 'settings', hint: 'Ctrl+,', onSelect: () => this.openSettings() },
      { label: '键盘快捷键', icon: 'keyboard', onSelect: () => this.showShortcuts() },
      { label: '关于', icon: 'info', onSelect: () => showAbout() },
    ], { anchor, align: 'start' });
  },

  toggleSidebar() {
    const sidebar = $('#sidebar');
    const hidden = sidebar.classList.toggle('hidden');
    $('#resizer-sidebar').classList.toggle('hidden', hidden);
    $('#btn-sidebar-toggle').classList.toggle('active', !hidden);
    Editor.layout();
  },

  /* ═══ 笔记库 ═════════════════════════════════════════ */
  async openVault() {
    const res = await window.notesAPI.openVault();
    if (res.canceled) return;
    if (!res.success) { Toast.error(`打开失败：${res.error}`); return; }
    this.onVaultOpened(res);
    Toast.ok(`已打开 ${res.vaultName}`);
  },

  onVaultOpened(res) {
    this.vaultPath = res.vaultPath;
    this.vaultName = res.vaultName;
    this.tree = res.tree;

    // 切换笔记库后重置展开状态与滚动位置
    FileTree.init();
    FileTree.render(this.tree);

    $('#vault-name').textContent = this.vaultName;
    $('#vault-name').classList.remove('hidden');
    $('#vault-empty').classList.add('hidden');
    $('#welcome-vault-name').textContent = res.vaultPath;
    Status.setVault(res.vaultPath);

    this.applyPaneSizes();
    this.updateWindowTitle();
  },

  async refreshVault({ silent = false } = {}) {
    if (!this.vaultPath) return;
    const res = await window.notesAPI.refreshVault();
    if (!res.success) { if (!silent) Toast.error(`刷新失败：${res.error}`); return; }
    this.tree = res.tree;
    FileTree.render(this.tree);
    if (FileTree.active) FileTree.setActive(FileTree.active);
    if (!silent) Status.setMessage('文件列表已刷新');
  },

  /** 文件树变动后的统一收尾：刷新树、恢复选中、同步标签 */
  async afterTreeChange({ select = null, expand = null, renameTab = null } = {}) {
    if (expand) FileTree.expanded.add(expand);
    await this.refreshVault({ silent: true });

    if (renameTab) {
      const [oldRel, newRel] = renameTab;
      const content = Editor.getValue(oldRel);
      const model = Editor.models.get(oldRel);
      if (model) {
        // 文件重命名后重建 model（URI 变了）
        Editor.models.delete(oldRel);
        model.dispose();
      }
      Tabs.rename(oldRel, newRel);
      if (content !== undefined) {
        const res = await window.notesAPI.readFile(newRel);
        if (res.success) {
          Editor.getModel(newRel, res.content);
          Editor.markSaved(newRel);
          this.savedContent.set(newRel, res.content);
        }
      }
      if (Tabs.activePath === newRel) {
        Editor.activePath = null;
        Tabs.setActive(newRel);
      }
    }

    if (select) {
      FileTree.select(select);
      FileTree.setActive(select);
    }
  },

  /* ═══ 打开 / 激活文件 ════════════════════════════════ */
  async openFile(rel, { line = null, endLine = null } = {}) {
    if (!rel) return;

    if (Tabs.has(rel)) {
      Tabs.setActive(rel);
      if (line) Editor.revealLine(line, endLine);
      return;
    }

    const res = await window.notesAPI.readFile(rel);
    if (!res.success) {
      Toast.error(`打开失败：${res.error}`);
      return;
    }

    Editor.getModel(rel, res.content);
    Editor.markSaved(rel);
    this.savedContent.set(rel, res.content);

    const wasMaximized = this.mode === 'preview';
    await Tabs.add(rel);
    if (wasMaximized) this.setMode('split');
    if (line) setTimeout(() => Editor.revealLine(line, endLine), 80);
  },

  /** 标签激活后的联动（由 Tabs.setActive 调用） */
  activateFile(rel) {
    this.hideWelcome();
    Editor.setActiveModel(rel, this.savedContent.get(rel) ?? '');
    Preview.setTarget(rel);
    FileTree.setActive(rel);
    Status.setFile(rel);
    Tabs.markDirty(rel);
    this.updateWindowTitle();
  },

  onModelChanged(model) {
    if (!model) return;
    const path = model.uri?.path?.replace(/^\//, '') || null;
    if (path) Status.setLanguage(path);
  },

  showWelcome(force = false) {
    const welcome = $('#welcome');
    if (Tabs.tabs.length && !force) { welcome.classList.add('hidden'); return; }
    if (Tabs.tabs.length) return;
    welcome.classList.remove('hidden');
    Preview.clear();
    Status.clearFile();
    this.updateWindowTitle();
  },

  hideWelcome() {
    $('#welcome').classList.add('hidden');
  },

  activePath() {
    return Tabs.activePath;
  },

  /* ═══ 脏状态 / 保存 ══════════════════════════════════ */
  isDirty(rel) {
    return rel ? Editor.isDirty(rel) : false;
  },

  anyDirty() {
    return Tabs.tabs.some((t) => Editor.isDirty(t.path));
  },

  markDirty(rel) {
    Tabs.markDirty(rel);
    FileTree.updateDirtyMark(rel);
    Status.setDirty(this.anyDirty());
    this.updateWindowTitle();
    this.scheduleAutoSave();
  },

  /** 磁盘内容变化后同步基线 */
  syncSavedState(rel, content) {
    this.savedContent.set(rel, content);
    Editor.markSaved(rel);
    Tabs.markDirty(rel);
    FileTree.updateDirtyMark(rel);
    Status.setDirty(this.anyDirty());
    this.updateWindowTitle();
  },

  scheduleAutoSave() {
    if (!this.prefs.autoSave) return;
    clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(() => {
      for (const tab of Tabs.tabs) {
        if (Editor.isDirty(tab.path)) this.save(tab.path, { silent: true });
      }
    }, 1500);
  },

  async save(rel = this.activePath(), { silent = false } = {}) {
    if (!rel) return false;
    if (!Editor.isDirty(rel)) {
      if (!silent) Status.setMessage('没有需要保存的修改');
      return true;
    }

    const content = Editor.getValue(rel);
    const res = await window.notesAPI.saveFile(rel, content);
    if (!res.success) {
      Toast.error(`保存失败：${res.error}`);
      return false;
    }

    // 记录时间，供文件监听忽略「自己刚写入」触发的事件
    this._lastSaveAt = Date.now();
    this.syncSavedState(rel, content);
    // 关闭实时预览时，保存后才刷新预览
    if (!this.prefs.livePreview && rel === Preview.target) Preview.update();
    if (!silent) Toast.ok(`已保存 ${PathUtil.base(rel)}`, { timeout: 1400 });
    Status.setMessage(`已保存 ${PathUtil.base(rel)}`);
    return true;
  },

  saveActive() { return this.save(this.activePath()); },

  async saveAll() {
    const dirty = Tabs.tabs.filter((t) => Editor.isDirty(t.path));
    if (!dirty.length) { Status.setMessage('没有需要保存的修改'); return; }
    let ok = 0;
    for (const tab of dirty) if (await this.save(tab.path, { silent: true })) ok++;
    if (ok === dirty.length) Toast.ok(`已保存 ${ok} 个文件`);
    else Toast.warn(`已保存 ${ok}/${dirty.length} 个文件`);
  },

  /* ═══ 新建 / 重命名 / 删除 ═══════════════════════════ */
  async createNote({ dir = '' } = {}) {
    if (!this.vaultPath) { Toast.warn('先打开一个笔记文件夹'); return; }

    const name = await askText({
      title: '新建笔记',
      icon: 'file-plus',
      label: '文件名',
      value: '未命名.html',
      hint: dir ? `将创建在 ${dir}/` : '将创建在笔记库根目录',
      validate: (v) => {
        if (!v) return '文件名不能为空';
        if (/[\\/:*?"<>|]/.test(v)) return '文件名不能包含 \\ / : * ? " < > |';
        return null;
      },
    });
    if (!name) return;

    const fileName = PathUtil.ensureHtml(name);
    const rel = PathUtil.join(dir, fileName);
    const title = PathUtil.stem(fileName);

    const res = await window.notesAPI.createFile(rel, this.noteTemplate(title));
    if (!res.success) { Toast.error(`创建失败：${res.error}`); return; }

    await this.afterTreeChange({ select: rel, expand: dir || null });
    await this.openFile(rel);
    Toast.ok(`已创建 ${fileName}`);
  },

  async createFolder({ dir = '' } = {}) {
    if (!this.vaultPath) { Toast.warn('先打开一个笔记文件夹'); return; }

    const name = await askText({
      title: '新建文件夹',
      icon: 'folder-plus',
      label: '文件夹名',
      value: '新建文件夹',
      hint: dir ? `将创建在 ${dir}/` : '将创建在笔记库根目录',
      validate: (v) => {
        if (!v) return '名称不能为空';
        if (/[\\/:*?"<>|]/.test(v)) return '名称不能包含 \\ / : * ? " < > |';
        return null;
      },
    });
    if (!name) return;

    const rel = PathUtil.join(dir, name);
    const res = await window.notesAPI.createFolder(rel);
    if (!res.success) { Toast.error(`创建失败：${res.error}`); return; }

    FileTree.expanded.add(rel);
    if (dir) FileTree.expanded.add(dir);
    FileTree.persistExpanded();
    await this.afterTreeChange({ select: rel, expand: rel });
    Toast.ok(`已创建文件夹 ${name}`);
  },

  async duplicate(rel) {
    const res = await window.notesAPI.duplicateEntry(rel);
    if (!res.success) { Toast.error(`复制失败：${res.error}`); return; }
    await this.afterTreeChange({ select: res.path });
    Toast.ok(`已复制为 ${PathUtil.base(res.path)}`);
  },

  async deleteEntry(rel, isFolder = false) {
    if (!rel) return;
    const name = PathUtil.base(rel);

    let ok;
    if (isFolder) {
      const node = FileTree.findNode(rel);
      const count = node ? countFiles(node) : 0;
      ok = await askConfirm({
        title: '删除文件夹',
        icon: 'trash',
        danger: true,
        message: `确定要删除文件夹 <code>${escapeHtml(name)}</code> 吗？`,
        detail: count
          ? `其中包含 <span class="mono">${count}</span> 个文件，将会<b>一并删除且无法撤销</b>。`
          : '该文件夹是空的。',
        confirmLabel: '删除',
      });
    } else {
      ok = await askConfirm({
        title: '删除笔记',
        icon: 'trash',
        danger: true,
        message: `确定要删除 <code>${escapeHtml(rel)}</code> 吗？`,
        detail: '此操作不可撤销。',
        confirmLabel: '删除',
      });
    }
    if (!ok) return;

    const res = await window.notesAPI.deleteEntry(rel);
    if (!res.success) {
      // 主进程对非空文件夹返回 needsConfirm，这里在上层已经确认过了，直接强制删
      if (res.needsConfirm) {
        const retry = await askConfirm({
          title: '删除非空文件夹',
          icon: 'alert-triangle',
          danger: true,
          message: `文件夹 <code>${escapeHtml(name)}</code> 不为空。`,
          detail: '确认后将连同里面的所有内容一起删除。',
          confirmLabel: '确认删除',
        });
        if (!retry) return;
        // 用文件树里已知的子项逐个删除，再删目录本身
        const node = FileTree.findNode(rel);
        const files = collectFiles(node);
        for (const f of files) await window.notesAPI.deleteEntry(f);
        await window.notesAPI.deleteEntry(rel);
      } else {
        Toast.error(`删除失败：${res.error}`);
        return;
      }
    }

    // 关闭被删除文件（及其子文件）的标签
    const prefix = rel + '/';
    for (const tab of Tabs.tabs.slice()) {
      if (tab.path === rel || tab.path.startsWith(prefix)) Tabs.close(tab.path, { force: true });
    }
    this.savedContent.delete(rel);

    await this.afterTreeChange({ select: null });
    Toast.ok(`已删除 ${name}`);
  },

  async reveal(rel) {
    const res = await window.notesAPI.revealEntry(rel);
    if (!res.success) Toast.error(`无法显示：${res.error}`);
  },

  async copyPath(rel) {
    const full = `${this.vaultPath}/${rel}`;
    try {
      await navigator.clipboard.writeText(full);
      Toast.ok('路径已复制', { timeout: 1400 });
    } catch {
      Toast.error('复制失败');
    }
  },

  async openExternal(rel) {
    const abs = `${this.vaultPath}/${rel}`;
    if (Editor.isDirty(rel)) await this.save(rel, { silent: true });
    const res = await window.notesAPI.openPath(abs);
    if (!res.success) Toast.error(`打开失败：${res.error}`);
  },

  findInTree(rel) { return !!FileTree.findNode(rel); },

  /* ═══ 新建笔记模板 ═══════════════════════════════════ */
  noteTemplate(title) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      max-width: 720px;
      margin: 48px auto;
      padding: 0 24px;
      font-family: system-ui, -apple-system, 'Noto Sans CJK SC', sans-serif;
      font-size: 16px;
      line-height: 1.75;
      color: #2b2b33;
      background: #fff;
    }
    h1 {
      font-size: 28px;
      margin: 0 0 8px;
      padding-bottom: 12px;
      border-bottom: 2px solid #89b4fa;
    }
    .meta { color: #8c8fa1; font-size: 13px; margin-bottom: 32px; }
    @media (prefers-color-scheme: dark) {
      body { color: #cdd6f4; background: #1e1e2e; }
      .meta { color: #7f849c; }
    }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p class="meta">${new Date().toLocaleDateString('zh-CN')}</p>

  <p>在这里开始写你的笔记。这里可以用完整的 HTML、CSS 和 JavaScript。</p>
</body>
</html>
`;
  },

  /* ═══ 关闭保护 ═══════════════════════════════════════ */
  async confirmCloseDirty(rel) {
    const name = PathUtil.base(rel);
    return new Promise((resolve) => {
      const entry = Modal.open({
        title: '未保存的修改',
        icon: 'alert-triangle',
        body: el('p', { html: `<code>${escapeHtml(name)}</code> 有未保存的修改，关闭后将会丢失。` }),
        footer: [
          el('button', { class: 'btn btn-ghost', text: '取消', onclick: () => { Modal.close(entry); resolve(false); } }),
          el('button', { class: 'btn btn-ghost', text: '不保存', onclick: () => { Modal.close(entry); resolve(true); } }),
          el('button', {
            class: 'btn btn-primary', text: '保存并关闭',
            onclick: async () => { Modal.close(entry); await this.save(rel, { silent: true }); resolve(true); },
          }),
        ],
        onClose: () => resolve(false),
      });
    });
  },

  async handleBeforeClose() {
    const dirty = Tabs.tabs.filter((t) => Editor.isDirty(t.path));
    if (!dirty.length) { window.notesAPI.readyToClose(true); return; }

    const names = dirty.map((t) => PathUtil.base(t.path));
    const preview = names.slice(0, 5).map((n) => `<code>${escapeHtml(n)}</code>`).join('、');

    const entry = Modal.open({
      title: '还有未保存的修改',
      icon: 'alert-triangle',
      danger: true,
      body: el('p', {
        html: `${names.length} 个文件尚未保存${names.length > 5 ? `（${preview} 等）` : `：${preview}`}。`,
      }),
      footer: [
        el('button', { class: 'btn btn-ghost', text: '取消', onclick: () => Modal.close(entry) }),
        el('button', {
          class: 'btn btn-ghost', text: '放弃修改并退出',
          onclick: () => { Modal.close(entry); window.notesAPI.readyToClose(true); },
        }),
        el('button', {
          class: 'btn btn-primary', text: '全部保存并退出',
          onclick: async () => { Modal.close(entry); await this.saveAll(); window.notesAPI.readyToClose(true); },
        }),
      ],
    });
  },

  /* ═══ 设置 / 快捷键 / 关于 ═══════════════════════════ */
  openSettings() {
    const mkSwitch = (key, label, desc, onChange) => {
      const btn = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!this.prefs[key]) });
      btn.addEventListener('click', async () => {
        const next = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', String(next));
        this.prefs[key] = next;
        await window.notesAPI.setPref(key, next);
        onChange?.(next);
      });
      return el('div', { class: 'setting' }, [
        el('div', { class: 'setting-info' }, [el('b', { text: label }), el('span', { text: desc })]),
        btn,
      ]);
    };

    const mkNumber = (key, label, desc, opts, apply) => {
      const input = el('input', {
        type: 'text',
        value: String(this.prefs[key]),
        style: 'width:64px;text-align:center',
      });
      input.addEventListener('change', async () => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v < opts.min || v > opts.max) {
          input.value = String(this.prefs[key]);
          Toast.warn(`请输入 ${opts.min}–${opts.max} 之间的数值`);
          return;
        }
        this.prefs[key] = v;
        await window.notesAPI.setPref(key, v);
        apply(v);
      });
      return el('div', { class: 'setting' }, [
        el('div', { class: 'setting-info' }, [el('b', { text: label }), el('span', { text: desc })]),
        input,
      ]);
    };

    const themeRow = el('div', { class: 'setting' }, [
      el('div', { class: 'setting-info' }, [
        el('b', { text: '主题' }),
        el('span', { text: '暗色 / 浅色 / 跟随系统' }),
      ]),
      el('div', { class: 'segmented' },
        [['light', 'sun', '浅色'], ['dark', 'moon', '暗色'], ['system', 'palette', '跟随系统']].map(([mode, icon, title]) => {
          const btn = el('button', {
            class: `icon-btn ${Theme.mode === mode ? 'active' : ''}`,
            title,
            onclick: async (e) => {
              await Theme.set(mode);
              $$('.icon-btn', e.currentTarget.parentElement).forEach((b) => b.classList.remove('active'));
              e.currentTarget.classList.add('active');
            },
          }, [Icons.el(icon)]);
          return btn;
        })),
    ]);

    Modal.open({
      title: '设置',
      icon: 'settings',
      width: 520,
      body: el('div', {}, [
        themeRow,
        mkNumber('fontSize', '字号', '编辑器字体大小（px）', { min: 10, max: 24 },
          (v) => Editor.updateOptions({ fontSize: v })),
        mkNumber('tabSize', '缩进宽度', 'Tab 等于几个空格', { min: 2, max: 8 },
          (v) => { Editor.models.forEach((m) => m.updateOptions({ tabSize: v })); Editor.updateOptions({ tabSize: v }); }),
        mkSwitch('wordWrap', '自动换行', '长行在编辑器里折行显示',
          (v) => Editor.updateOptions({ wordWrap: v ? 'on' : 'off' })),
        mkSwitch('minimap', '代码缩略图', '在编辑器右侧显示 minimap',
          (v) => Editor.updateOptions({ minimap: { enabled: v } })),
        mkSwitch('livePreview', '实时预览', '编辑时自动刷新预览（关闭后需手动刷新或保存）',
          (v) => { if (v && Preview.target) Preview.update(); }),
        mkSwitch('autoSave', '自动保存', '停止输入 1.5 秒后自动写入磁盘'),
      ]),
      footer: [
        el('button', {
          class: 'btn btn-ghost', text: '恢复默认',
          onclick: async () => {
            Object.assign(this.prefs, {
              fontSize: 13.5, tabSize: 2, wordWrap: false, minimap: false,
              livePreview: true, autoSave: false,
            });
            for (const k of ['fontSize', 'tabSize', 'wordWrap', 'minimap', 'livePreview', 'autoSave']) {
              await window.notesAPI.setPref(k, this.prefs[k]);
            }
            Editor.updateOptions({
              fontSize: 13.5, tabSize: 2, wordWrap: 'off', minimap: { enabled: false },
            });
            Modal.closeTop();
            Toast.ok('已恢复默认设置');
          },
        }),
        el('button', { class: 'btn btn-primary', text: '完成', onclick: () => Modal.closeTop() }),
      ],
    });
  },

  showShortcuts() {
    const rows = [
      ['打开笔记文件夹', 'Ctrl+O'],
      ['新建笔记', 'Ctrl+N'],
      ['新建文件夹', 'Ctrl+Shift+N'],
      ['保存', 'Ctrl+S'],
      ['全部保存', 'Ctrl+Alt+S'],
      ['关闭当前标签', 'Ctrl+W'],
      ['下一个标签', 'Ctrl+Tab'],
      ['查找全部', 'Ctrl+Shift+F'],
      ['命令面板', 'Ctrl+P'],
      ['切换布局', 'Ctrl+E'],
      ['侧边栏开关', 'Ctrl+B'],
      ['格式化文档', 'Alt+Shift+F'],
      ['重命名（文件树上）', 'F2'],
      ['删除（文件树上）', 'Delete'],
      ['刷新', 'F5'],
      ['设置', 'Ctrl+,'],
    ];
    Modal.open({
      title: '键盘快捷键',
      icon: 'keyboard',
      width: 460,
      body: el('div', {}, rows.map(([label, combo]) => el('div', { class: 'setting' }, [
        el('div', { class: 'setting-info' }, [el('b', { text: label })]),
        el('span', { class: 'mono', text: Key.display(combo) }),
      ]))),
      footer: [el('button', { class: 'btn btn-primary', text: '好', onclick: () => Modal.closeTop() })],
    });
  },

  /* ═══ 命令面板 ═══════════════════════════════════════ */
  openPalette() {
    const hasVault = !!this.vaultPath;
    const hasFile = !!Tabs.activePath;
    const cmds = [
      { label: '打开笔记文件夹', icon: 'folder', hint: 'Ctrl+O', run: () => this.openVault() },
      { label: '新建笔记', icon: 'file-plus', hint: 'Ctrl+N', disabled: !hasVault, run: () => this.createNote({}) },
      { label: '新建文件夹', icon: 'folder-plus', hint: 'Ctrl+Shift+N', disabled: !hasVault, run: () => this.createFolder({}) },
      { label: '保存', icon: 'save', hint: 'Ctrl+S', disabled: !hasFile, run: () => this.saveActive() },
      { label: '全部保存', icon: 'save', hint: 'Ctrl+Alt+S', run: () => this.saveAll() },
      { label: '查找全部', icon: 'search', hint: 'Ctrl+Shift+F', disabled: !hasVault, run: () => Search.toggle(true) },
      { label: '刷新文件列表', icon: 'refresh', hint: 'F5', disabled: !hasVault, run: () => this.refreshVault() },
      { separator: true },
      { label: '布局：仅编辑', icon: 'code', run: () => this.setMode('edit') },
      { label: '布局：左右分屏', icon: 'columns', run: () => { this.setSplitDir('right'); this.setMode('split'); } },
      { label: '布局：上下分屏', icon: 'split-bottom', run: () => { this.setSplitDir('bottom'); this.setMode('split'); } },
      { label: '布局：仅预览', icon: 'eye', run: () => this.setMode('preview') },
      { label: '预览：弹出到独立窗口', icon: 'maximize', disabled: !hasFile, run: () => Preview.toggleDetachWindow() },
      { label: '预览：刷新', icon: 'refresh', disabled: !hasFile, run: () => Preview.refresh(true) },
      { separator: true },
      { label: '文件树：全部展开', icon: 'chevrons-up-down', disabled: !hasVault, run: () => FileTree.expandAll() },
      { label: '文件树：全部折叠', icon: 'chevrons-up-down', disabled: !hasVault, run: () => FileTree.collapseAll() },
      { label: '格式化文档', icon: 'code', disabled: !hasFile, hint: 'Alt+Shift+F', run: () => Editor.format() },
      { label: '标签：关闭当前', icon: 'x', hint: 'Ctrl+W', disabled: !hasFile, run: () => Tabs.close(Tabs.activePath) },
      { label: '标签：关闭全部', icon: 'x', run: () => Tabs.closeAll() },
      { separator: true },
      { label: `主题：切换（当前${Theme.label}）`, icon: Theme.iconName, run: () => Theme.cycle() },
      { label: '侧边栏：显示/隐藏', icon: 'panel-left', hint: 'Ctrl+B', run: () => this.toggleSidebar() },
      { label: '设置…', icon: 'settings', hint: 'Ctrl+,', run: () => this.openSettings() },
      { label: '键盘快捷键', icon: 'keyboard', run: () => this.showShortcuts() },
      { label: '关于 Hypernote', icon: 'info', run: () => showAbout() },
    ].filter((c) => !c.disabled || c.separator);

    Palette.open(cmds.map((c) => (
      c.separator
        ? { separator: true }
        : { label: c.label, icon: c.icon, hint: c.hint, run: () => c.run() }
    )));
  },

  /* ═══ 快捷键 ═════════════════════════════════════════ */
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      // 模态打开时交给模态处理
      if (Modal.stack.length) return;

      // 搜索框内只处理退出
      const inSearch = e.target === Search.input;
      if (inSearch && !['Escape', 'Enter'].includes(e.key)) return;

      // 文件树键盘导航
      const inTree = document.activeElement?.closest?.('#file-tree');
      if (inTree && FileTree.onKeyDown(e)) return;

      const inInput = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;

      if (Key.match(e, 'Ctrl+P')) { e.preventDefault(); this.openPalette(); return; }
      if (Key.match(e, 'Ctrl+Shift+F')) { e.preventDefault(); Search.toggle(); return; }
      if (Key.match(e, 'Ctrl+O')) { e.preventDefault(); this.openVault(); return; }
      if (Key.match(e, 'Ctrl+Shift+N')) { e.preventDefault(); this.createFolder({}); return; }
      if (Key.match(e, 'Ctrl+Alt+S')) { e.preventDefault(); this.saveAll(); return; }
      if (Key.match(e, 'Ctrl+E')) { e.preventDefault(); this.cycleMode(); return; }
      if (Key.match(e, 'Ctrl+B')) { e.preventDefault(); this.toggleSidebar(); return; }
      if (Key.match(e, 'Ctrl+,')) { e.preventDefault(); this.openSettings(); return; }
      if (Key.match(e, 'Ctrl+W')) {
        if (Tabs.activePath) { e.preventDefault(); Tabs.close(Tabs.activePath); }
        return;
      }
      if (Key.match(e, 'Ctrl+Tab')) { e.preventDefault(); Tabs.cycle(e.shiftKey ? -1 : 1); return; }
      if (e.key === 'F5') { e.preventDefault(); this.refreshVault(); return; }

      // 以下在输入框里不触发
      if (inInput) return;
      if (Key.match(e, 'Ctrl+N')) { e.preventDefault(); this.createNote({}); return; }
      if (Key.match(e, 'Ctrl+S')) { e.preventDefault(); this.saveActive(); return; }
      if (e.key === 'Escape') {
        if (Menu.node) { Menu.close(); return; }
        if (Search.active) Search.toggle(false);
      }
    });
  },

  /* ═══ 主进程事件 ═════════════════════════════════════ */
  bindIpc() {
    // 第二个实例传来的打开请求（此时窗口已加载完，推送是安全的）
    window.notesAPI.onOpenFile((rel) => {
      if (FileTree.findNode(rel)) this.openFile(rel);
      else Toast.warn(`找不到笔记 ${rel}`);
    });
    window.notesAPI.onFsChanged((info) => this.onFsChanged(info));
    window.notesAPI.onBeforeClose(() => this.handleBeforeClose());
    window.notesAPI.onPrefsChanged((p) => {
      if (!p) return;
      if (p.theme && p.theme !== Theme.mode) Theme.set(p.theme);
    });
  },

  /** 外部改动（别的程序改了文件） */
  async onFsChanged(info) {
    if (!this.vaultPath) return;
    // 自己刚保存会触发 watcher，忽略短时间内的自身写入
    const now = Date.now();
    if (now - (this._lastSaveAt || 0) < 800) return;

    await this.refreshVault({ silent: true });

    // 已打开且没有未保存改动的文件 → 重新载入
    const filename = info?.filename;
    for (const tab of Tabs.tabs.slice()) {
      if (!Editor.isDirty(tab.path)) {
        const res = await window.notesAPI.readFile(tab.path);
        if (!res.success) continue;
        if (res.content !== this.savedContent.get(tab.path)) {
          Editor.refreshModel(tab.path, res.content);
          this.syncSavedState(tab.path, res.content);
          if (tab.path === Preview.target) Preview.refresh();
        }
      } else if (filename && tab.path.endsWith(filename)) {
        Toast.warn(`${PathUtil.base(tab.path)} 在外部被修改，但你本地有未保存的改动`, {
          action: { label: '用磁盘版本覆盖', onClick: () => Preview.refresh(true) },
        });
      }
    }
  },

  /* ═══ 窗口标题 / 状态栏 ══════════════════════════════ */
  updateWindowTitle() {
    const rel = Tabs.activePath;
    const dirty = rel ? Editor.isDirty(rel) : false;
    const name = rel ? PathUtil.base(rel) : (this.vaultName || 'Hypernote');
    document.title = `${dirty ? '● ' : ''}${name}${rel ? ' — ' : ''}${this.vaultName && rel ? 'Hypernote' : ''}`.trim();
  },
};

/* ═══════════════════════════════════════════════════════
   Status — 状态栏
   ═══════════════════════════════════════════════════════ */
const Status = {
  init() {},

  setVault(p) {
    const node = $('#status-vault');
    node.title = p;
    node.querySelector('.text').textContent = p;
  },

  setFile(rel) {
    $('#status-file').textContent = rel;
    this.setLanguage(rel);
  },

  clearFile() {
    $('#status-file').textContent = '';
    $('#status-lang').textContent = '';
    $('#status-cursor').textContent = '';
    this.setDirty(false);
  },

  setLanguage(rel) {
    const ext = PathUtil.ext(rel);
    const label = { html: 'HTML', htm: 'HTML', css: 'CSS', js: 'JavaScript', mjs: 'JavaScript', json: 'JSON', md: 'Markdown', svg: 'SVG' }[ext] || ext.toUpperCase();
    $('#status-lang').textContent = label;
  },

  setCursor(line, col, total) {
    $('#status-cursor').textContent = `行 ${line}，列 ${col}${total ? ` / 共 ${total} 行` : ''}`;
  },

  setDirty(dirty) {
    const pill = $('#status-saved');
    pill.className = `status-pill ${dirty ? 'dirty' : 'saved'}`;
    pill.querySelector('.text').textContent = dirty ? '未保存' : '已保存';
  },

  setMessage(text) {
    const node = $('#status-message');
    if (!node) return;
    node.textContent = text;
    node.style.opacity = '1';
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => { node.style.opacity = '0.35'; }, 2600);
  },
};

/* ═══════════════════════════════════════════════════════
   辅助
   ═══════════════════════════════════════════════════════ */
function countFiles(node) {
  return collectFiles(node).length;
}

function collectFiles(node) {
  if (!node) return [];
  if (node.type === 'file') return [node.path];
  return (node.children || []).flatMap(collectFiles);
}

/* ═══════════════════════════════════════════════════════
   启动
   ═══════════════════════════════════════════════════════ */

// Monaco 切换 model 时会用 CancellationTokenSource 取消挂起的语言服务请求
// （HTML 校验、格式化等）。这个取消信号偶尔会以「未处理的 Promise 拒绝」冒出来，
// 它是控制流标记，不是错误。这里只过滤这一种字符串，其余未处理拒绝照常抛给控制台，
// 免得把真正的问题一起盖掉。
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = reason?.message ?? String(reason ?? '');
  if (message === 'Canceled' || message === 'Canceled: Canceled') {
    event.preventDefault();
    console.debug('[monaco] 已忽略被取代的语言服务请求（正常现象）');
  }
});

window.addEventListener('DOMContentLoaded', () => {
  Status.init();
  App.init().catch((err) => {
    console.error('初始化失败', err);
    Toast.error(`初始化失败：${err.message}`);
  });
});

// 关闭前保存文件树滚动位置
window.addEventListener('beforeunload', () => {
  FileTree.saveScroll();
});
