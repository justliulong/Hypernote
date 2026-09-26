'use strict';

/* ═══════════════════════════════════════════════════════
   ui.js — 通用 UI 组件
   Toast / 浮动菜单 / 模态对话框 / 命令面板 / 主题
   ═══════════════════════════════════════════════════════ */

/* ─── 主题 ─────────────────────────────────────────────── */
const Theme = {
  mode: 'dark',        // 'dark' | 'light' | 'system'
  resolved: 'dark',

  async init() {
    const res = await window.notesAPI.getPrefs();
    this.mode = (res.success && res.prefs.theme) || 'dark';
    await this.apply();
    this.watchSystem();
  },

  async apply() {
    let resolved = this.mode;
    if (this.mode === 'system') {
      const res = await window.notesAPI.systemIsDark();
      resolved = res.dark ? 'dark' : 'light';
    }
    this.resolved = resolved;
    document.documentElement.dataset.theme = resolved;
    if (window.Editor && Editor.instance) Editor.setTheme(resolved);
    if (window.Preview) Preview.onThemeChanged(resolved);
    document.dispatchEvent(new CustomEvent('theme-changed', { detail: resolved }));
  },

  watchSystem() {
    if (this._mq) return;
    this._mq = window.matchMedia('(prefers-color-scheme: dark)');
    this._mq.addEventListener('change', () => {
      if (this.mode === 'system') this.apply();
    });
  },

  async set(mode) {
    this.mode = mode;
    await window.notesAPI.setPref('theme', mode);
    await this.apply();
  },

  /** 在 亮 → 暗 → 跟随系统 之间轮换 */
  cycle() {
    const order = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(this.mode) + 1) % order.length];
    this.set(next);
    return next;
  },

  get label() {
    return { dark: '暗色', light: '浅色', system: '跟随系统' }[this.mode] || '暗色';
  },
  get iconName() {
    return { dark: 'moon', light: 'sun', system: 'palette' }[this.mode] || 'moon';
  },
};

/* ─── Toast ────────────────────────────────────────────── */
const Toast = {
  container: null,

  ensure() {
    if (!this.container) {
      this.container = el('div', { class: 'toasts' });
      document.body.appendChild(this.container);
    }
    return this.container;
  },

  show(message, opts = {}) {
    const { type = 'info', timeout = 3200, action = null } = opts;
    const iconName = { ok: 'check-circle', error: 'alert-circle', warn: 'alert-triangle', info: 'info' }[type] || 'info';

    const node = el('div', { class: `toast ${type}` }, [
      Icons.el(iconName),
      el('div', { class: 'msg', text: message }),
    ]);

    if (action) {
      node.appendChild(el('button', {
        class: 'act',
        text: action.label,
        onclick: () => { action.onClick(); dismiss(); },
      }));
    }

    this.ensure().appendChild(node);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 160);
    };
    node.addEventListener('click', (e) => { if (e.target === node || e.target.classList.contains('msg')) dismiss(); });
    if (timeout) setTimeout(dismiss, timeout);
    return dismiss;
  },

  ok(msg, opts) { return this.show(msg, { type: 'ok', ...opts }); },
  error(msg, opts) { return this.show(msg, { type: 'error', timeout: 5200, ...opts }); },
  warn(msg, opts) { return this.show(msg, { type: 'warn', timeout: 4200, ...opts }); },
  info(msg, opts) { return this.show(msg, { type: 'info', ...opts }); },
};

/* ─── 浮动菜单（右键 / 下拉） ─────────────────────────── */
const Menu = {
  node: null,
  onClose: null,

  /**
   * items: [{label, icon, hint, danger, disabled, checked, onSelect} | {separator:true} | {type:'label', label}]
   */
  open(items, { x, y, anchor, align = 'start', onClose } = {}) {
    this.close();

    const node = el('div', { class: 'menu', role: 'menu' });
    for (const item of items) {
      if (!item) continue;
      if (item.separator) { node.appendChild(el('div', { class: 'menu-sep' })); continue; }
      if (item.type === 'label') { node.appendChild(el('div', { class: 'menu-label', text: item.label })); continue; }

      const cls = ['menu-item'];
      if (item.danger) cls.push('danger');
      if (item.disabled) cls.push('disabled');
      const row = el('div', { class: cls.join(' '), role: 'menuitem' }, [
        item.icon ? Icons.el(item.icon) : el('span', { style: 'width:16px;flex:none' }),
        el('span', { class: 'label', text: item.label }),
        item.checked ? Icons.el('check', 'icon icon-sm') : null,
        item.hint ? el('span', { class: 'hint', text: item.hint }) : null,
      ]);
      if (!item.disabled) {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this.close();
          item.onSelect?.();
        });
      }
      node.appendChild(row);
    }

    document.body.appendChild(node);
    this.node = node;
    this.onClose = onClose;

    // 定位（并夹到视口内）
    const rect = node.getBoundingClientRect();
    let left, top;
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      left = align === 'end' ? a.right - rect.width : a.left;
      top = a.bottom + 4;
    } else {
      left = x; top = y;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;

    // 延后注册，避免触发本次点击的冒泡立刻关闭
    setTimeout(() => {
      document.addEventListener('mousedown', this._outside = (e) => {
        if (!node.contains(e.target)) this.close();
      });
      document.addEventListener('keydown', this._onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
      });
      window.addEventListener('blur', this._onBlur = () => this.close());
    }, 0);

    return node;
  },

  close() {
    if (!this.node) return;
    this.node.remove();
    this.node = null;
    if (this._outside) document.removeEventListener('mousedown', this._outside);
    if (this._onKey) document.removeEventListener('keydown', this._onKey);
    if (this._onBlur) window.removeEventListener('blur', this._onBlur);
    this._outside = this._onKey = this._onBlur = null;
    this.onClose?.();
    this.onClose = null;
  },
};

/* ─── 模态对话框 ───────────────────────────────────────── */
const Modal = {
  stack: [],

  /**
   * 打开模态框
   * body: Node | Node[] | string
   * footer: Node[]（默认一个「关闭」）
   */
  open({ title, icon = 'info', danger = false, body, footer, width, onClose, className = '' }) {
    const bodyNode = el('div', { class: 'modal-body' });
    if (typeof body === 'string') bodyNode.innerHTML = body;
    else if (body) bodyNode.append(...[].concat(body).filter(Boolean));

    const modal = el('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: `modal-head ${danger ? 'danger' : ''}` }, [
        Icons.el(icon, 'icon icon-lg'),
        el('h2', { text: title }),
      ]),
      bodyNode,
      footer && footer.length ? el('div', { class: 'modal-foot' }, footer) : null,
    ]);
    if (width) modal.style.maxWidth = `${width}px`;

    const overlay = el('div', { class: 'overlay' }, [modal]);

    const prevFocus = document.activeElement;
    const entry = { overlay, modal, onClose };
    this.stack.push(entry);
    document.body.appendChild(overlay);

    // 焦点移入，Esc 关闭
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(entry); }
      if (e.key === 'Tab') this._trapTab(e, modal);
    };
    overlay.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this.close(entry);
    });

    setTimeout(() => {
      const focusable = modal.querySelector('input, textarea, button.btn-primary, button');
      focusable?.focus();
      if (focusable?.select) focusable.select();
    }, 20);

    entry.dispose = () => {
      overlay.remove();
      prevFocus?.focus?.();
    };
    return entry;
  },

  close(entry) {
    const idx = this.stack.indexOf(entry);
    if (idx === -1) return;
    this.stack.splice(idx, 1);
    entry.dispose();
    entry.onClose?.();
  },

  closeTop() {
    if (this.stack.length) this.close(this.stack[this.stack.length - 1]);
  },

  _trapTab(e, modal) {
    const items = $$('a[href], button:not([disabled]), input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])', modal)
      .filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  },
};

/* ─── 高层对话框（Promise 风格） ──────────────────────── */

/** 输入框对话框 → Promise<string|null> */
function askText({ title, label, value = '', placeholder = '', hint = '', icon = 'pencil',
                   selectRange = null, validate = null, confirmLabel = '确定' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const input = el('input', { type: 'text', value, placeholder, spellcheck: 'false' });
    const errorNode = el('div', { class: 'error hidden' });

    const field = el('div', { class: 'field' }, [
      label ? el('label', { text: label }) : null,
      input,
      hint ? el('div', { class: 'hint', text: hint }) : null,
      errorNode,
    ]);

    const showError = (msg) => {
      if (!msg) { errorNode.classList.add('hidden'); return false; }
      errorNode.textContent = msg;
      errorNode.classList.remove('hidden');
      return true;
    };

    const submit = () => {
      const v = input.value.trim();
      const err = validate ? validate(v) : (v ? null : '不能为空');
      if (showError(err)) { input.focus(); return; }
      settled = true;
      Modal.close(entry);
      resolve(v);
    };

    const cancel = () => {
      if (!settled) { settled = true; resolve(null); }
    };

    const entry = Modal.open({
      title,
      icon,
      body: field,
      footer: [
        el('button', { class: 'btn btn-ghost', text: '取消', onclick: () => { settled = true; resolve(null); Modal.close(entry); } }),
        el('button', { class: 'btn btn-primary', text: confirmLabel, onclick: submit }),
      ],
      onClose: cancel,
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    input.addEventListener('input', () => showError(null));

    setTimeout(() => {
      input.focus();
      if (selectRange) input.setSelectionRange(selectRange[0], selectRange[1]);
      else {
        // 默认选中主文件名（不含扩展名），方便直接改名
        const dot = input.value.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
      }
    }, 30);
  });
}

/** 确认对话框 → Promise<boolean> */
function askConfirm({ title, message, detail = '', icon = 'alert-triangle', danger = false,
                      confirmLabel = '确定', cancelLabel = '取消' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const entry = Modal.open({
      title,
      icon,
      danger,
      body: el('div', {}, [
        el('p', { html: message }),
        detail ? el('p', { html: detail }) : null,
      ]),
      footer: [
        el('button', { class: 'btn btn-ghost', text: cancelLabel, onclick: () => { finish(false); Modal.close(entry); } }),
        el('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          text: confirmLabel,
          onclick: () => { finish(true); Modal.close(entry); },
        }),
      ],
      onClose: () => finish(false),
    });
  });
}

/** 关于 / 信息对话框 */
function showAbout() {
  const rows = [
    ['版本', window.notesAPI.version || '—'],
    ['编辑器', 'Monaco Editor 0.52.2'],
    ['运行时', `Electron ${navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] || '—'}`],
  ];
  Modal.open({
    title: 'Hypernote',
    icon: 'info',
    body: el('div', {}, [
      el('p', { text: '基于文件夹的笔记管理器。笔记是磁盘上真实的 HTML 文件，支持完整 JavaScript、外部图表库与相对路径资源。' }),
      el('div', { class: 'setting' }, []),
      ...rows.map(([k, v]) => el('div', { class: 'setting' }, [
        el('div', { class: 'setting-info' }, [el('b', { text: k })]),
        el('span', { class: 'mono', text: v }),
      ])),
    ]),
    footer: [el('button', { class: 'btn btn-primary', text: '好', onclick: () => Modal.closeTop() })],
  });
}

/* ─── 命令面板 ─────────────────────────────────────────── */
const Palette = {
  entry: null,

  /** commands: [{id, label, hint, icon, group, run}] | {separator:true} */
  open(commands) {
    if (this.entry) { Modal.close(this.entry); this.entry = null; }

    let filtered = commands.slice();
    let activeIndex = 0;
    // 分隔线只是视觉分组，不能选中 —— 导航时跳过
    const selectable = () => filtered.filter((c) => !c.separator);
    const activeCmd = () => selectable()[activeIndex];

    const input = el('input', {
      class: 'palette-input',
      type: 'text',
      placeholder: '输入命令…',
      spellcheck: 'false',
    });
    const list = el('div', { class: 'palette-list' });

    const renderList = () => {
      list.innerHTML = '';
      const current = activeCmd();
      if (!selectable().length) {
        list.appendChild(el('div', { class: 'palette-empty', text: '没有匹配的命令' }));
        return;
      }
      for (const cmd of filtered) {
        if (cmd.separator) {
          list.appendChild(el('div', { class: 'menu-sep' }));
          continue;
        }
        const row = el('div', { class: `palette-item ${cmd === current ? 'active' : ''}` }, [
          Icons.el(cmd.icon || 'command'),
          el('span', { text: cmd.label }),
          cmd.hint ? el('span', { class: 'hint', text: Key.display(cmd.hint) }) : null,
        ]);
        row.addEventListener('click', () => run(cmd));
        row.addEventListener('mousemove', () => {
          if (cmd === current) return;
          activeIndex = selectable().indexOf(cmd);
          $$('.palette-item', list).forEach((n) => n.classList.toggle('active', n === row));
        });
        list.appendChild(row);
      }
    };

    const run = (cmd) => {
      Modal.close(this.entry);
      this.entry = null;
      setTimeout(() => cmd.run(), 0);
    };

    const filter = (query) => {
      const q = query.trim().toLowerCase();
      if (!q) {
        filtered = commands.slice();
      } else {
        // 搜索时不要分隔线，它们会让结果显得断裂
        filtered = commands
          .filter((c) => !c.separator)
          .map((cmd) => ({ cmd, score: fuzzyScore(cmd.label.toLowerCase(), q) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.cmd);
      }
      activeIndex = 0;
      renderList();
    };

    const move = (delta) => {
      const total = selectable().length;
      if (!total) return;
      activeIndex = Math.max(0, Math.min(activeIndex + delta, total - 1));
      renderList();
      $$('.palette-item', list)[activeIndex]?.scrollIntoView({ block: 'nearest' });
    };

    input.addEventListener('input', () => filter(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = activeCmd();
        if (cmd?.run) run(cmd);
      }
    });

    renderList();
    this.entry = Modal.open({
      title: '',
      icon: 'command',
      className: 'palette',
      body: el('div', {}, [input, list]),
      footer: null,
      onClose: () => { this.entry = null; },
    });
    // 隐藏标题头，让输入框成为第一个视觉元素
    this.entry.modal.querySelector('.modal-head').style.display = 'none';
    setTimeout(() => input.focus(), 30);
  },
};

/** 子序列模糊匹配：命中返回分数，未命中返回 0 */
function fuzzyScore(text, query) {
  if (!query) return 1;
  let ti = 0, score = 0, streak = 0;
  for (const ch of query) {
    const found = text.indexOf(ch, ti);
    if (found === -1) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak * 2 - Math.min(found - ti, 6) * 0.5;
    ti = found + 1;
  }
  // 前缀命中额外加权
  if (text.startsWith(query)) score += 6;
  return score;
}
