'use strict';

/* ═══════════════════════════════════════════════════════
   search.js — 全文搜索（结果显示在侧边栏，替换文件树）
   ═══════════════════════════════════════════════════════ */

const Search = {
  active: false,
  query: '',
  caseSensitive: false,
  results: [],
  _seq: 0,
  _debounced: null,

  init() {
    this.wrap = $('#search-wrap');
    this.input = $('#search-input');
    this.countNode = $('#search-count');
    this.caseBtn = $('#search-case');
    this.resultsPane = $('#search-results');
    this.listNode = $('#search-results-list');
    this.treePane = $('#file-tree');
    this.treeHead = $('#tree-head');
    this.searchHead = $('#search-head');

    this._debounced = debounce((q) => this.run(q), 220);

    this.input.addEventListener('input', () => this._debounced(this.input.value));
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.toggle(false); }
      if (e.key === 'Enter') { e.preventDefault(); this.run(this.input.value, { immediate: true }); }
    });
    this.caseBtn.addEventListener('click', () => {
      this.caseSensitive = !this.caseSensitive;
      this.caseBtn.classList.toggle('active', this.caseSensitive);
      this.caseBtn.title = this.caseSensitive ? '区分大小写：开' : '区分大小写：关';
      if (this.query) this.run(this.query, { immediate: true });
    });
    $('#search-close').addEventListener('click', () => this.toggle(false));
    $('#btn-collapse-search').addEventListener('click', () => this.toggle(false));
    $('#btn-replace-all').addEventListener('click', () => this.replaceAll());
  },

  /* ─── 开关 ───────────────────────────────────────────── */
  toggle(show) {
    const next = show === undefined ? !this.active : !!show;

    if (next) {
      // 没有笔记库就没法搜
      if (!App.vaultPath) { Toast.warn('先打开一个笔记文件夹'); return; }
      App.setMode(App.mode === 'preview' ? 'split' : App.mode);  // 搜索要能看到侧栏
      this.wrap.classList.remove('hidden');
      this.input.focus();
      this.input.select();
      this.active = true;
    } else {
      this.wrap.classList.add('hidden');
      this.input.value = '';
      this.active = false;
      this.clearResults();
    }
  },

  /* ─── 查询 ───────────────────────────────────────────── */
  async run(query, { immediate = false } = {}) {
    if (immediate) this._debounced.cancel();
    this.query = (query || '').trim();

    if (this.query.length < 2) {
      this.clearResults();
      return;
    }

    const seq = ++this._seq;
    this.showResultsPane();
    this.countNode.textContent = '搜索中…';
    this.listNode.innerHTML = '';

    // 把有未保存改动的标签内容一并带上，搜索也能命中还没写到磁盘的编辑
    const overrides = {};
    for (const tab of Tabs.tabs) {
      if (App.isDirty(tab.path)) overrides[tab.path] = Editor.getValue(tab.path) ?? '';
    }

    const res = await window.notesAPI.search(this.query, { caseSensitive: this.caseSensitive, overrides });
    if (seq !== this._seq) return;   // 已有更新的查询，丢弃这次结果

    if (!res.success) {
      this.countNode.textContent = '';
      this.listNode.appendChild(el('div', { class: 'empty' }, [
        Icons.el('alert-circle', 'icon icon-lg'),
        el('p', { text: `搜索失败：${res.error}` }),
      ]));
      return;
    }

    this.results = res.results;
    this.render(res);
  },

  /* ─── 渲染 ───────────────────────────────────────────── */
  showResultsPane() {
    this.treePane.classList.add('hidden');
    this.treeHead.classList.add('hidden');
    this.searchHead.classList.remove('hidden');
    this.resultsPane.classList.remove('hidden');
  },

  hideResultsPane() {
    this.resultsPane.classList.add('hidden');
    this.treeHead.classList.remove('hidden');
    this.searchHead.classList.add('hidden');
    this.treePane.classList.remove('hidden');
  },

  clearResults() {
    this.results = [];
    this.countNode.textContent = '';
    this.listNode.innerHTML = '';
    $('#btn-replace-all').classList.add('hidden');
    this.hideResultsPane();
  },

  /* ─── 替换全部 ───────────────────────────────────────── */
  async replaceAll() {
    if (!this.results.length || !this.query) return;
    const targets = this.results.map((r) => r.path);
    const dirtyTargets = targets.filter((p) => Tabs.has(p) && App.isDirty(p));

    const replacement = await askText({
      title: '替换全部',
      icon: 'replace',
      label: `把「${this.query}」替换为`,
      placeholder: '替换为（留空即删除该词）',
      confirmLabel: '下一步',
    });
    if (replacement === null) return;

    const ok = await askConfirm({
      title: '确认替换',
      icon: 'alert-triangle',
      danger: true,
      message: `将在 <span class="mono">${targets.length}</span> 个文件中把 <code>${escapeHtml(this.query)}</code> 替换为 <code>${escapeHtml(replacement)}</code>。`,
      detail: dirtyTargets.length
        ? `<span class="mono">${dirtyTargets.length}</span> 个打开的标签有未保存修改，将被跳过。替换直接写入磁盘（旧版本自动存入历史）。`
        : '替换会直接写入磁盘（旧版本自动存入历史，可从「历史版本」恢复）。',
      confirmLabel: '全部替换',
    });
    if (!ok) return;

    let files = 0;
    let hits = 0;
    let failed = 0;
    let skipped = dirtyTargets.length;
    for (const path of targets) {
      if (Tabs.has(path) && App.isDirty(path)) continue;
      const res = await window.notesAPI.readFile(path);
      if (!res.success) { failed++; continue; }
      const { text, count } = replaceAllIn(res.content, this.query, replacement, this.caseSensitive);
      if (!count) continue;
      const save = await window.notesAPI.saveFile(path, text);
      if (!save.success) { failed++; continue; }
      files++;
      hits += count;
      // 打开中的标签同步新内容，避免被 watcher 提示「外部修改」
      if (Tabs.has(path)) {
        App.savedContent.set(path, text);
        Editor.refreshModel(path, text);
        Editor.markSaved(path);
        Tabs.markDirty(path);
        if (path === Preview.target) Preview.refresh();
      }
    }

    if (failed) Toast.error(`替换完成，但 ${failed} 个文件写入失败`);
    else Toast.ok(`已在 ${files} 个文件中替换 ${hits} 处${skipped ? `，跳过 ${skipped} 个未保存标签` : ''}`);
    Status.setMessage(`替换 ${hits} 处`);
    if (this.query) this.run(this.query, { immediate: true });   // 刷新结果
  },

  render(res) {
    const { results, truncated } = res;
    this.countNode.textContent = results.length
      ? `${results.length}${truncated ? '+' : ''} 个文件`
      : '无结果';
    $('#btn-replace-all').classList.toggle('hidden', !results.length);

    this.listNode.innerHTML = '';

    if (!results.length) {
      this.listNode.appendChild(el('div', { class: 'empty' }, [
        Icons.el('search', 'icon icon-lg'),
        el('p', {}, ['没有找到 ', el('strong', { text: this.query }), ' 的匹配内容']),
      ]));
      return;
    }

    for (const item of results) {
      const group = el('div', { class: 'result-group' });

      const fileRow = el('div', { class: 'result-file', title: item.path }, [
        Icons.el('file-code'),
        el('span', { class: 'name', text: item.name }),
        item.dir ? el('span', { class: 'dir', text: item.dir }) : null,
        el('span', { class: 'count', text: `${item.count}${item.count >= 5 ? '+' : ''}` }),
      ]);

      const snippet = el('div', { class: 'result-snippet' });
      snippet.innerHTML = this.highlight(item.snippet, this.query);

      const open = () => {
        App.openFile(item.path, { line: item.line || null });
        this.toggle(false);
      };
      fileRow.addEventListener('click', open);
      snippet.addEventListener('click', open);

      group.append(fileRow, snippet);
      this.listNode.appendChild(group);
    }

    if (truncated) {
      this.listNode.appendChild(el('div', { class: 'empty' }, [
        el('p', { text: '结果过多，仅显示前 200 个文件。试试更具体的关键词。' }),
      ]));
    }
  },

  highlight(text, query) {
    if (!text) return '';
    const safe = escapeHtml(text);
    const words = query.split(/\s+/).filter((w) => w.length >= 1);
    if (!words.length) return safe;
    const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const flags = this.caseSensitive ? 'g' : 'gi';
    try {
      return safe.replace(new RegExp(`(${pattern})`, flags), '<mark>$1</mark>');
    } catch {
      return safe;
    }
  },
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 字面量全量替换（不受 $& 等特殊符号影响），返回新文本与替换次数 */
function replaceAllIn(text, needle, replacement, caseSensitive) {
  if (caseSensitive) {
    const count = text.split(needle).length - 1;
    return { text: count ? text.split(needle).join(replacement) : text, count };
  }
  const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let count = 0;
  const out = text.replace(new RegExp(pattern, 'gi'), () => { count++; return replacement; });
  return { text: out, count };
}
