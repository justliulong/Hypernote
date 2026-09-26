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

    const res = await window.notesAPI.search(this.query, { caseSensitive: this.caseSensitive });
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
    this.hideResultsPane();
  },

  render(res) {
    const { results, truncated } = res;
    this.countNode.textContent = results.length
      ? `${results.length}${truncated ? '+' : ''} 个文件`
      : '无结果';

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

      const open = () => { App.openFile(item.path); this.toggle(false); };
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
