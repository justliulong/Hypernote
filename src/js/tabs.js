'use strict';

/* ═══════════════════════════════════════════════════════
   tabs.js — 多标签
   每个标签对应 Monaco 的一个 model，切换时保留撤销历史与光标
   ═══════════════════════════════════════════════════════ */

const Tabs = {
  container: null,
  tabs: [],        // [{ path, name }]
  activePath: null,

  init() {
    this.container = $('#tabs');
    this.container.addEventListener('contextmenu', (e) => {
      const tabNode = e.target.closest('.tab');
      if (!tabNode) return;
      e.preventDefault();
      this.showContextMenu(e, tabNode.dataset.path);
    });
  },

  has(path) { return this.tabs.some((t) => t.path === path); },

  async add(path, { activate = true } = {}) {
    if (!this.has(path)) {
      this.tabs.push({ path, name: PathUtil.base(path) });
    }
    this.render();
    if (activate) this.setActive(path);
  },

  close(path, { force = false } = {}) {
    const idx = this.tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;

    if (!force && App.isDirty(path)) {
      App.confirmCloseDirty(path).then((ok) => { if (ok) this.close(path, { force: true }); });
      return;
    }

    this.tabs.splice(idx, 1);
    Editor.disposeModel(path);

    // 关闭的是当前标签 → 激活邻居
    if (this.activePath === path) {
      const next = this.tabs[idx] || this.tabs[idx - 1] || null;
      this.activePath = null;
      this.render();
      if (next) this.setActive(next.path);
      else App.showWelcome();
    } else {
      this.render();
    }
  },

  closeOthers(keepPath) {
    const dirty = this.tabs.filter((t) => t.path !== keepPath && App.isDirty(t.path));
    const doIt = () => {
      for (const t of this.tabs.slice()) if (t.path !== keepPath) this.close(t.path, { force: true });
      this.setActive(keepPath);
    };
    if (dirty.length) {
      askConfirm({
        title: '关闭其他标签',
        icon: 'alert-triangle',
        message: `有 <span class="mono">${dirty.length}</span> 个标签存在未保存的修改，关闭后修改将丢失。`,
        confirmLabel: '仍然关闭',
        danger: true,
      }).then((ok) => { if (ok) doIt(); });
    } else doIt();
  },

  closeAll() {
    const dirty = this.tabs.filter((t) => App.isDirty(t.path));
    const doIt = () => {
      for (const t of this.tabs.slice()) this.close(t.path, { force: true });
      App.showWelcome();
    };
    if (dirty.length) {
      askConfirm({
        title: '关闭全部标签',
        icon: 'alert-triangle',
        message: `有 <span class="mono">${dirty.length}</span> 个标签存在未保存的修改，关闭后修改将丢失。`,
        confirmLabel: '仍然关闭',
        danger: true,
      }).then((ok) => { if (ok) doIt(); });
    } else doIt();
  },

  setActive(path) {
    this.activePath = path;
    this.render();
    const tab = this.container.querySelector(`.tab[data-path="${cssEscape(path)}"]`);
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    App.activateFile(path);
  },

  /** 文件被重命名后同步标签 */
  rename(oldPath, newPath) {
    const tab = this.tabs.find((t) => t.path === oldPath);
    if (!tab) return;
    tab.path = newPath;
    tab.name = PathUtil.base(newPath);
    if (this.activePath === oldPath) this.activePath = newPath;
    this.render();
  },

  markDirty(path) {
    const tab = this.container?.querySelector(`.tab[data-path="${cssEscape(path)}"]`);
    tab?.classList.toggle('dirty', App.isDirty(path));
  },

  render() {
    if (!this.container) return;
    this.container.innerHTML = '';

    for (const tab of this.tabs) {
      const isActive = tab.path === this.activePath;
      const dirty = App.isDirty(tab.path);

      const node = el('div', {
        class: `tab ${isActive ? 'active' : ''} ${dirty ? 'dirty' : ''}`,
        dataset: { path: tab.path },
        title: tab.path,
      }, [
        el('span', { class: 'tab-icon' }, [Icons.el(Fmt.iconName(tab.path), 'icon')]),
        el('span', { class: 'tab-title', text: tab.name }),
        el('span', { class: 'tab-dot' }),
        el('button', {
          class: 'tab-close',
          'aria-label': '关闭',
          onclick: (e) => { e.stopPropagation(); this.close(tab.path); },
        }, [Icons.el('x', 'icon icon-close')]),
      ]);

      node.addEventListener('click', (e) => {
        if (e.target.closest('.tab-close')) return;
        this.setActive(tab.path);
      });
      // 中键关闭
      node.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); this.close(tab.path); }
      });
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showContextMenu(e, tab.path);
      });

      this.container.appendChild(node);
    }
  },

  showContextMenu(e, path) {
    Menu.open([
      { label: '关闭', icon: 'x', hint: 'Ctrl+W', onSelect: () => this.close(path) },
      { label: '关闭其他', onSelect: () => this.closeOthers(path) },
      { label: '关闭全部', onSelect: () => this.closeAll() },
      { separator: true },
      { label: '在文件管理器中显示', icon: 'folder-reveal', onSelect: () => App.reveal(path) },
      { label: '复制路径', icon: 'clipboard-copy', onSelect: () => App.copyPath(path) },
      { separator: true },
      { label: '重命名…', icon: 'pencil', onSelect: () => FileTree.startRename(path) },
    ], { x: e.clientX, y: e.clientY });
  },

  /** 当前标签的相邻标签（用于 Ctrl+Tab） */
  cycle(delta = 1) {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.path === this.activePath);
    const next = (idx + delta + this.tabs.length) % this.tabs.length;
    this.setActive(this.tabs[next].path);
  },
};
