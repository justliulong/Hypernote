'use strict';

/* ═══════════════════════════════════════════════════════
   fileTree.js — 文件树
   渲染 / 展开折叠 / 右键菜单 / 拖拽移动 / 内联重命名
   ═══════════════════════════════════════════════════════ */

const FileTree = {
  container: null,
  tree: [],
  expanded: new Set(),
  selected: null,
  active: null,
  dragging: null,
  renaming: null,

  init() {
    this.container = $('#file-tree');
    this.expanded = new Set(App.loadUiState('expanded', []));
  },

  persistExpanded() {
    App.saveUiState('expanded', Array.from(this.expanded));
  },

  /* ─── 渲染 ───────────────────────────────────────────── */
  render(tree) {
    if (!this.container) this.init();
    this.tree = tree || [];

    if (!this.tree.length) {
      this.container.innerHTML = '';
      this.container.appendChild(this.emptyState());
      return;
    }

    this.container.innerHTML = '';
    this.container.appendChild(this.buildRows(this.tree, 0));
    this.restoreScroll();
  },

  emptyState() {
    const wrap = el('div', { class: 'empty' }, [
      Icons.el('file-plus', 'icon icon-lg'),
      el('p', {}, [
        el('strong', { text: '还没有笔记' }),
        '按 ',
        el('kbd', { text: Key.display('Ctrl+N') }),
        ' 或点上方 ',
        Icons.el('plus', 'icon icon-sm'),
        ' 新建一篇',
      ]),
    ]);
    return wrap;
  },

  buildRows(nodes, level) {
    const frag = document.createDocumentFragment();
    for (const node of nodes) frag.appendChild(this.buildRow(node, level));
    return frag;
  },

  buildRow(node, level) {
    const isFolder = node.type === 'folder';
    const open = isFolder && this.expanded.has(node.path);

    const row = el('div', {
      class: [
        'tree-row',
        isFolder ? 'folder' : 'file',
        open ? 'open' : '',
        this.selected === node.path ? 'selected' : '',
        this.active === node.path ? 'active' : '',
      ].filter(Boolean).join(' '),
      dataset: { path: node.path, type: node.type },
      draggable: 'true',
      title: node.path,
    });
    row.style.paddingLeft = `${8 + level * 13}px`;

    // 展开箭头 / 占位
    if (isFolder) {
      const arrow = el('span', { class: 'tree-arrow' }, [Icons.el('chevron-right', 'icon')]);
      row.appendChild(arrow);
    } else {
      row.appendChild(el('span', { class: 'tree-spacer' }));
    }

    // 图标
    if (isFolder) {
      row.appendChild(el('span', { class: 'tree-icon' }, [Icons.el(open ? 'folder' : 'folder')]));
    } else {
      const kind = Fmt.iconKind(node.path);
      const iconBox = el('span', { class: 'tree-icon', dataset: { ext: kind } }, [Icons.el(Fmt.iconName(node.path))]);
      row.appendChild(iconBox);
    }

    // 名称
    const label = el('span', { class: 'tree-label', text: node.name });
    row.appendChild(label);

    // 右侧信息
    if (isFolder) {
      const count = (node.children || []).length;
      if (count) row.appendChild(el('span', { class: 'tree-count', text: String(count) }));
    } else {
      const badge = Fmt.badge(node.path);
      if (badge) row.appendChild(el('span', { class: 'tree-badge', text: badge }));
      if (App.isDirty(node.path)) row.appendChild(el('span', { class: 'tree-dot' }));
    }

    this.bindRow(row, node);

    const frag = document.createDocumentFragment();
    frag.appendChild(row);

    if (isFolder && node.children?.length) {
      const kids = el('div', { class: 'tree-children' });
      kids.style.display = open ? 'block' : 'none';
      kids.appendChild(this.buildRows(node.children, level + 1));
      frag.appendChild(kids);
    }
    return frag;
  },

  bindRow(row, node) {
    const isFolder = node.type === 'folder';

    row.addEventListener('click', (e) => {
      if (e.target.closest('.tree-rename')) return;
      this.select(node.path);
      if (isFolder) this.toggle(node.path);
      else App.openFile(node.path);
    });

    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (!isFolder) return;
      this.toggle(node.path);
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select(node.path);
      this.showContextMenu(e, node);
    });

    /* 拖拽移动 */
    row.addEventListener('dragstart', (e) => {
      if (this.renaming) { e.preventDefault(); return; }
      this.dragging = node.path;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.path);
    });
    row.addEventListener('dragend', () => {
      this.dragging = null;
      row.classList.remove('dragging');
      this.clearDropHints();
    });

    row.addEventListener('dragover', (e) => {
      if (!this.dragging || this.dragging === node.path) return;
      // 不能把文件夹拖进自己的子孙里
      if (isFolder && (node.path === this.dragging || node.path.startsWith(this.dragging + '/'))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.showDropHint(row, e, node, isFolder);
    });
    row.addEventListener('dragleave', (e) => {
      if (row.contains(e.relatedTarget)) return;
      row.classList.remove('drop-into', 'drop-before', 'drop-after');
    });
    row.addEventListener('drop', async (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = this.dropZone(row);
      this.clearDropHints();
      await this.handleDrop(this.dragging, node, zone, isFolder);
    });
  },

  /* ─── 拖拽落点 ───────────────────────────────────────── */
  dropZone(row) {
    if (row.classList.contains('drop-into')) return 'into';
    if (row.classList.contains('drop-before')) return 'before';
    if (row.classList.contains('drop-after')) return 'after';
    return 'inside';
  },

  showDropHint(row, e, node, isFolder) {
    this.clearDropHints(row);
    const rect = row.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;

    if (isFolder && ratio > 0.28 && ratio < 0.72) {
      row.classList.add('drop-into');
    } else if (ratio < 0.5) {
      row.classList.add('drop-before');
    } else {
      row.classList.add('drop-after');
    }
  },

  clearDropHints(except) {
    $$('.tree-row', this.container).forEach((r) => {
      if (r === except) return;
      r.classList.remove('drop-into', 'drop-before', 'drop-after');
    });
  },

  async handleDrop(fromRel, targetNode, zone, targetIsFolder) {
    if (!fromRel || fromRel === targetNode.path) return;

    const name = PathUtil.base(fromRel);
    let destDir;

    if (zone === 'into' && targetIsFolder) {
      destDir = targetNode.path;
    } else {
      destDir = PathUtil.dir(targetNode.path);
    }

    const newRel = PathUtil.join(destDir, name);

    // 位置没变
    if (newRel === fromRel) return;
    // 拖进自己的子孙目录
    if (destDir === fromRel || destDir.startsWith(fromRel + '/')) {
      Toast.warn('不能把文件夹移动到它自己的子目录里');
      return;
    }
    // 同目录内前后移动不改变路径，忽略
    if (PathUtil.dir(fromRel) === destDir) {
      if (zone === 'into') return;
      await this.reorderInPlace(fromRel, targetNode.path, zone === 'before');
      return;
    }

    const res = await window.notesAPI.renameEntry(fromRel, newRel);
    if (!res.success) { Toast.error(`移动失败：${res.error}`); return; }

    if (res.renamed) Toast.warn(`目标位置已有同名项，已改名为 ${PathUtil.base(res.path)}`);
    else Toast.ok(`已移动到 ${destDir || '根目录'}`);

    await App.afterTreeChange({ select: res.path, expand: destDir });
  },

  /** 同目录内拖拽排序：改文件名加序号前缀代价太大，这里只做提示 */
  async reorderInPlace() {
    Toast.info('同一目录内暂不支持手动排序，文件按名称自动排列');
  },

  /* ─── 展开 / 折叠 ────────────────────────────────────── */
  toggle(path) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    this.persistExpanded();
    this.applyExpansion();
  },

  applyExpansion() {
    $$('.tree-row.folder', this.container).forEach((row) => {
      const open = this.expanded.has(row.dataset.path);
      row.classList.toggle('open', open);
      const kids = row.nextElementSibling;
      if (kids?.classList.contains('tree-children')) kids.style.display = open ? 'block' : 'none';
    });
  },

  expandAll() {
    const walk = (nodes) => nodes.forEach((n) => {
      if (n.type === 'folder') { this.expanded.add(n.path); walk(n.children || []); }
    });
    walk(this.tree);
    this.persistExpanded();
    this.applyExpansion();
  },

  collapseAll() {
    this.expanded.clear();
    this.persistExpanded();
    this.applyExpansion();
    if (this.active) this.expandTo(this.active, { silent: true });
  },

  /** 展开到指定路径的所有祖先 */
  expandTo(rel, { silent = false } = {}) {
    const parts = rel.split('/');
    let cur = '';
    let changed = false;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      if (!this.expanded.has(cur)) { this.expanded.add(cur); changed = true; }
    }
    if (changed) {
      this.persistExpanded();
      if (!silent) this.applyExpansion();
    }
    return changed;
  },

  /* ─── 选中 / 高亮 ────────────────────────────────────── */
  select(rel) {
    this.selected = rel;
    $$('.tree-row', this.container).forEach((r) => r.classList.toggle('selected', r.dataset.path === rel));
  },

  setActive(rel) {
    const needRerender = this.expandTo(rel);
    if (needRerender) { this.renderRerender(); }
    this.active = rel;
    this.selected = rel;
    $$('.tree-row', this.container).forEach((r) => {
      r.classList.toggle('active', r.dataset.path === rel);
      r.classList.toggle('selected', r.dataset.path === rel);
    });
    this.scrollIntoView(rel);
  },

  /** 展开状态变化后需要重建 DOM 才能显示子节点 */
  renderRerender() {
    const scrollTop = this.container.parentElement?.scrollTop || 0;
    this.container.innerHTML = '';
    this.container.appendChild(this.buildRows(this.tree, 0));
    if (this.container.parentElement) this.container.parentElement.scrollTop = scrollTop;
  },

  scrollIntoView(rel, { center = true } = {}) {
    const row = this.container?.querySelector(`.tree-row[data-path="${cssEscape(rel)}"]`);
    if (row) row.scrollIntoView({ block: center ? 'center' : 'nearest' });
  },

  restoreScroll() {
    const top = App.loadUiState('treeScroll', 0);
    const scroller = this.container.parentElement;
    if (scroller && top) scroller.scrollTop = top;
  },

  saveScroll() {
    const scroller = this.container?.parentElement;
    if (scroller) App.saveUiState('treeScroll', scroller.scrollTop);
  },

  findNode(rel, nodes = this.tree) {
    for (const n of nodes) {
      if (n.path === rel) return n;
      if (n.type === 'folder' && n.children) {
        const hit = this.findNode(rel, n.children);
        if (hit) return hit;
      }
    }
    return null;
  },

  /* ─── 脏标记 ─────────────────────────────────────────── */
  updateDirtyMark(rel) {
    const row = this.container?.querySelector(`.tree-row[data-path="${cssEscape(rel)}"]`);
    if (!row) return;
    const dirty = App.isDirty(rel);
    const dot = row.querySelector('.tree-dot');
    if (dirty && !dot) row.appendChild(el('span', { class: 'tree-dot' }));
    else if (!dirty && dot) dot.remove();
  },

  /* ─── 右键菜单 ───────────────────────────────────────── */
  showContextMenu(e, node) {
    const isFolder = node.type === 'folder';
    const dir = isFolder ? node.path : PathUtil.dir(node.path);

    const items = [];
    if (isFolder) {
      items.push(
        { label: '新建笔记', icon: 'file-plus', hint: 'Ctrl+N', onSelect: () => App.createNote({ dir: node.path }) },
        { label: '新建文件夹', icon: 'folder-plus', onSelect: () => App.createFolder({ dir: node.path }) },
        { separator: true },
        { label: '重命名', icon: 'pencil', hint: 'F2', onSelect: () => this.startRename(node.path) },
      );
    } else {
      items.push(
        { label: '打开', icon: 'external-link', onSelect: () => App.openFile(node.path) },
        { label: '重命名', icon: 'pencil', hint: 'F2', onSelect: () => this.startRename(node.path) },
        { label: '复制副本', icon: 'copy', onSelect: () => App.duplicate(node.path) },
      );
    }
    items.push(
      { separator: true },
      { label: '在文件管理器中显示', icon: 'folder-reveal', onSelect: () => App.reveal(node.path) },
      { label: '复制路径', icon: 'clipboard-copy', onSelect: () => App.copyPath(node.path) },
    );
    if (!isFolder) {
      items.push({ separator: true },
        { label: '用外部浏览器打开', icon: 'external-link', onSelect: () => App.openExternal(node.path) });
    }
    items.push({ separator: true },
      { label: isFolder ? '删除文件夹' : '删除', icon: 'trash', danger: true, hint: 'Del',
        onSelect: () => App.deleteEntry(node.path, isFolder) });

    // 侧栏空白处也能新建
    Menu.open(items, { x: e.clientX, y: e.clientY });
  },

  showRootContextMenu(e) {
    Menu.open([
      { label: '新建笔记', icon: 'file-plus', hint: 'Ctrl+N', disabled: !App.vaultPath, onSelect: () => App.createNote({}) },
      { label: '新建文件夹', icon: 'folder-plus', disabled: !App.vaultPath, onSelect: () => App.createFolder({}) },
      { separator: true },
      { label: '刷新', icon: 'refresh', hint: 'F5', disabled: !App.vaultPath, onSelect: () => App.refreshVault() },
      { label: '全部折叠', icon: 'chevrons-up-down', onSelect: () => this.collapseAll() },
      { separator: true },
      { label: '更换笔记文件夹…', icon: 'folder', hint: 'Ctrl+O', onSelect: () => App.openVault() },
    ], { x: e.clientX, y: e.clientY });
  },

  /* ─── 内联重命名 ─────────────────────────────────────── */
  startRename(rel) {
    const row = this.container?.querySelector(`.tree-row[data-path="${cssEscape(rel)}"]`);
    if (!row) return;
    const label = row.querySelector('.tree-label');
    if (!label) return;

    this.renaming = rel;
    const oldName = PathUtil.base(rel);
    const input = el('input', { class: 'tree-rename', type: 'text', value: oldName, spellcheck: 'false' });

    label.replaceWith(input);
    input.focus();
    // 选中主文件名（不含扩展名）
    const dot = oldName.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : oldName.length);

    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      this.renaming = null;

      const newName = input.value.trim();
      const restore = () => {
        const span = el('span', { class: 'tree-label', text: oldName });
        input.replaceWith(span);
      };

      if (!commit || !newName || newName === oldName) { restore(); return; }

      const dir = PathUtil.dir(rel);
      let finalName = newName;
      // 文件保持 HTML 后缀
      if (!PathUtil.base(rel).match(/\.\w+$/) || (!/\.[a-z0-9]+$/i.test(newName) && PathUtil.isHtml(rel))) {
        finalName = PathUtil.ensureHtml(newName);
      }
      const newRel = PathUtil.join(dir, finalName);

      const res = await window.notesAPI.renameEntry(rel, newRel);
      if (!res.success) {
        Toast.error(`重命名失败：${res.error}`);
        restore();
        return;
      }
      if (res.renamed) Toast.warn(`已存在同名项，改为 ${PathUtil.base(res.path)}`);
      else Toast.ok(`已重命名为 ${PathUtil.base(res.path)}`);
      await App.afterTreeChange({ select: res.path, renameTab: [rel, res.path] });
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  },

  /* ─── 键盘导航 ───────────────────────────────────────── */
  visibleRows() {
    return $$('.tree-row', this.container).filter((r) => r.offsetParent !== null);
  },

  onKeyDown(e) {
    if (this.renaming) return false;
    const rows = this.visibleRows();
    if (!rows.length) return false;
    const current = rows.findIndex((r) => r.dataset.path === this.selected);
    const move = (idx) => {
      const target = rows[Math.max(0, Math.min(idx, rows.length - 1))];
      if (target) { this.select(target.dataset.path); this.scrollIntoView(target.dataset.path, { center: false }); }
    };

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(current + 1); return true;
      case 'ArrowUp': e.preventDefault(); move(current - 1); return true;
      case 'ArrowRight': {
        e.preventDefault();
        const row = rows[current];
        if (row?.classList.contains('folder') && !this.expanded.has(row.dataset.path)) this.toggle(row.dataset.path);
        else move(current + 1);
        return true;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const row = rows[current];
        if (row?.classList.contains('folder') && this.expanded.has(row.dataset.path)) { this.toggle(row.dataset.path); return true; }
        const parentDir = PathUtil.dir(this.selected || '');
        if (parentDir) { this.select(parentDir); this.scrollIntoView(parentDir, { center: false }); }
        return true;
      }
      case 'Enter': {
        e.preventDefault();
        if (!this.selected) return true;
        const node = this.findNode(this.selected);
        if (node?.type === 'folder') this.toggle(node.path);
        else App.openFile(this.selected);
        return true;
      }
      case 'F2': e.preventDefault(); if (this.selected) this.startRename(this.selected); return true;
      case 'Delete': {
        e.preventDefault();
        if (!this.selected) return true;
        const node = this.findNode(this.selected);
        App.deleteEntry(this.selected, node?.type === 'folder');
        return true;
      }
      default: return false;
    }
  },
};

/** CSS.escape 的兜底实现（文件路径含中文、空格、点号） */
function cssEscape(str) {
  if (window.CSS?.escape) return CSS.escape(str);
  return String(str).replace(/["\\]/g, '\\$&');
}
