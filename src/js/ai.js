'use strict';

/* ═══════════════════════════════════════════════════════
   ai.js — AI 助手侧板 + 组件模板插入
   对话走主进程代理（API Key 不进渲染进程），流式渲染；
   AI 修改笔记用「编辑块」格式（SEARCH/REPLACE），一键应用，
   走 Monaco 编辑操作，Ctrl+Z 可以整体撤销。
   ═══════════════════════════════════════════════════════ */

const AI_SYSTEM_PROMPT = [
  '你是 Hypernote 笔记应用内置的 AI 助手。Hypernote 的每篇笔记是一个完整的 HTML 文件（可包含 CSS/JS）。',
  '当用户要求修改笔记时，不要重写整篇文档，而是用下面的编辑块格式精确描述修改：',
  '',
  '<<<<<<< SEARCH',
  '（要被替换的原文片段：逐字符复制自原文，包括缩进，保持简短且在文中唯一）',
  '=======',
  '（替换后的新内容，为空则表示删除）',
  '>>>>>>> REPLACE',
  '',
  '可以给出多个编辑块，按出现顺序应用。非修改类请求直接用简洁的中文回答。',
  '新内容应与笔记整体风格保持一致。',
].join('\n');

/* ─── 编辑块解析与应用 ─────────────────────────────────── */

/** 从回复文本里抽出全部 SEARCH/REPLACE 编辑块 */
function parseEditBlocks(text) {
  const blocks = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^<{5,}\s*SEARCH\s*$/.test(lines[i].trim())) continue;
    const search = [];
    const replace = [];
    let phase = 'search';
    i++;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (phase === 'search' && /^={5,}\s*$/.test(line.trim())) { phase = 'replace'; continue; }
      if (phase === 'replace' && /^>{5,}\s*REPLACE\s*$/.test(line.trim())) { i++; break; }
      (phase === 'search' ? search : replace).push(line);
    }
    if (search.length || replace.length) {
      blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
    }
  }
  return blocks;
}

/** 把编辑块应用到当前笔记（宽松匹配容错缩进/空白差异），走一次可撤销的编辑操作 */
function applyEditBlocks(blocks) {
  const model = Editor.instance?.getModel();
  if (!model) return { applied: 0, failed: [] };
  const edits = [];
  const failed = [];

  for (const b of blocks) {
    const search = b.search.replace(/^\n+|\n+$/g, '');
    if (!search) { failed.push({ snippet: '(空 SEARCH)', reason: '空' }); continue; }
    let matches = [];
    try {
      matches = model.findMatches(search, model.getFullModelRange(), false, true, null, false, 10);
    } catch { matches = []; }
    if (!matches.length) {
      // 宽松匹配：把空白差异（缩进/换行）当作 \s+ 处理
      const pattern = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      try {
        matches = model.findMatches(pattern, model.getFullModelRange(), true, false, null, false, 10);
      } catch { matches = []; }
    }
    if (!matches.length) {
      failed.push({ snippet: search.slice(0, 60), reason: '原文中找不到该片段' });
      continue;
    }
    for (const m of matches) {
      edits.push({ range: m.range, text: b.replace.replace(/^\n+|\n+$/g, '') });
    }
  }

  if (edits.length) {
    Editor.instance.executeEdits('hypernote-ai', edits.map((e) => ({ ...e, forceMoveMarkers: true })));
    Editor.instance.focus();
  }
  return { applied: edits.length, failed };
}

/* ─── AI 侧板 ──────────────────────────────────────────── */

const QUICK_ACTIONS = [
  { label: '润色', prompt: '请润色这篇笔记的正文文字：表达更流畅自然，保持 HTML 结构、代码与样式不变，用编辑块给出修改。' },
  { label: '翻译成英文', prompt: '请把笔记中的中文正文翻译成英文，保持 HTML 标签、代码与样式不变，用编辑块给出修改。' },
  { label: '总结', prompt: '请用简洁的要点总结这篇笔记的核心内容，直接回复要点即可，不要修改笔记。', forceNote: true },
  { label: '续写', prompt: '请顺着这篇笔记的内容与风格，在结尾自然地续写两三段，用编辑块给出修改（SEARCH 取结尾最后一段原文）。', forceNote: true },
  { label: '修复 HTML', prompt: '请检查这篇笔记的 HTML：修复未闭合标签、错误嵌套等结构性问题，不做其他改动，用编辑块给出修改。' },
  { label: '解释代码', prompt: '请用初学者能看懂的语言，解释这篇笔记里用到的 HTML/CSS/JS 关键点。直接回复，不要修改笔记。' },
];

const AI = {
  open: false,
  ctxMode: 'note',            // 'note' | 'selection'
  history: [],                // [{role:'user'|'assistant', text, blocks?}]
  streaming: null,            // {id, text}
  node: null,

  init() {
    window.notesAPI.onAiChunk(({ id, delta }) => {
      if (!this.streaming || this.streaming.id !== id) return;
      this.streaming.text += delta;
      this.renderStreamingText();
    });
    window.notesAPI.onAiDone(({ id, aborted, error }) => {
      if (!this.streaming || this.streaming.id !== id) return;
      this.finishStreaming(aborted, error);
    });
  },

  toggle() {
    this.open ? this.close() : this.show();
  },

  show() {
    if (!this.node) this.build();
    this.node.classList.remove('closing');
    this.node.classList.add('open');
    this.open = true;
    $('#btn-ai')?.classList.add('active');
    this.render();
    setTimeout(() => this.input?.focus(), 150);
  },

  close() {
    if (!this.node) return;
    this.node.classList.remove('open');
    this.node.classList.add('closing');
    this.open = false;
    $('#btn-ai')?.classList.remove('active');
  },

  /* ─── 构建 DOM ─────────────────────────────────────── */
  build() {
    const workspace = $('#workspace');
    this.node = el('div', { class: 'ai-panel' }, [
      el('div', { class: 'ai-head' }, [
        el('span', { class: 'ai-title' }, [Icons.el('sparkles', 'icon'), el('span', { text: 'AI 助手' })]),
        el('span', { style: 'flex:1' }),
        el('select', {
          class: 'ai-ctx',
          title: '发给 AI 的上下文',
          onchange: (e) => { this.ctxMode = e.target.value; },
        }, [
          el('option', { value: 'note', text: '整篇笔记' }),
          el('option', { value: 'selection', text: '选中内容' }),
        ]),
        el('button', {
          class: 'icon-btn', title: '清空对话',
          onclick: () => { this.history = []; this.render(); },
        }, [Icons.el('trash')]),
        el('button', { class: 'icon-btn', title: '关闭 (Esc)', onclick: () => this.close() }, [Icons.el('x')]),
      ]),
      this.msgs = el('div', { class: 'ai-msgs' }),
      el('div', { class: 'ai-foot' }, [
        el('div', { class: 'ai-chips' }, QUICK_ACTIONS.map((a) => el('button', {
          class: 'ai-chip', text: a.label,
          onclick: () => this.quickAction(a),
        }))),
        el('div', { class: 'ai-inputrow' }, [
          this.input = el('textarea', {
            class: 'ai-input', rows: '2',
            placeholder: '描述想改的地方，比如「把标题改成蓝色」「加一个双栏卡片」…',
            onkeydown: (e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit(); }
              else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
            },
            oninput: () => this.autoGrow(),
          }),
          this.sendBtn = el('button', { class: 'icon-btn ai-send', title: '发送 (Enter)', onclick: () => this.streaming ? this.abort() : this.submit() }, [Icons.el('send')]),
        ]),
      ]),
    ]);
    workspace.appendChild(this.node);
  },

  autoGrow() {
    if (!this.input) return;
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 140)}px`;
  },

  /* ─── 渲染 ─────────────────────────────────────────── */
  render() {
    if (!this.msgs) return;
    this.msgs.replaceChildren();

    if (!this.history.length) {
      this.msgs.appendChild(el('div', { class: 'ai-empty' }, [
        el('div', { class: 'ai-empty-icon' }, [Icons.el('sparkles', 'icon icon-lg')]),
        el('p', { text: '让 AI 帮你改笔记，不用懂 HTML' }),
        el('p', { class: 'ai-empty-sub', text: '比如：「把标题改成蓝色」「把这段文字排成两栏」「帮我画一个柱状图」' }),
      ]));
      return;
    }
    for (const m of this.history) this.appendMsg(m);
    this.scrollBottom();
  },

  appendMsg(m) {
    const bubble = el('div', { class: `ai-msg ${m.role}${m.error ? ' error' : ''}` }, [
      el('div', { class: 'ai-msg-text', html: m.html || escapeHtml(this.displayText(m.text)).replace(/\n/g, '<br>') }),
    ]);
    this.msgs.appendChild(bubble);

    if (m.blocks?.length && m.role === 'assistant') {
      const bar = el('div', { class: 'ai-apply' }, [
        el('span', { class: 'ai-apply-label', text: `检测到 ${m.blocks.length} 处修改` }),
        el('span', { style: 'flex:1' }),
        m.applied
          ? el('span', { class: 'ai-apply-done', text: '已应用' })
          : el('button', { class: 'btn btn-primary btn-sm', text: '应用到笔记', onclick: () => this.apply(m, bar) }),
      ]);
      this.msgs.appendChild(bar);
    }
    return bubble;
  },

  scrollBottom() {
    if (this.msgs) this.msgs.scrollTop = this.msgs.scrollHeight;
  },

  /** 把编辑块从显示文本里折叠成占位行 */
  displayText(text) {
    const lines = String(text).split('\n');
    const out = [];
    let hide = false;
    for (const line of lines) {
      if (/^<{5,}\s*SEARCH\s*$/.test(line.trim())) { hide = true; out.push('✎ ┄ 编辑块 ┄'); continue; }
      if (hide && /^={5,}\s*$/.test(line.trim())) continue;
      if (hide && /^>{5,}\s*REPLACE\s*$/.test(line.trim())) { hide = false; continue; }
      if (!hide) out.push(line);
    }
    return out.join('\n');
  },

  /* ─── 发送 / 流式 ──────────────────────────────────── */
  submit() {
    const text = (this.input?.value || '').trim();
    if (!text) return;
    this.input.value = '';
    this.autoGrow();
    this.send(text);
  },

  quickAction(action) {
    if (this.streaming) { Toast.warn('AI 正在回复，请稍候或点击停止'); return; }
    if (action.forceNote) this.ctxMode = 'note';
    this.send(action.prompt);
  },

  async send(text) {
    if (this.streaming) { Toast.warn('AI 正在回复，请稍候或点击停止'); return; }
    const cfgReady = App.prefs.aiBaseUrl && App.prefs.aiModel;
    if (!cfgReady) {
      Toast.error('请先在设置里配置 AI 服务（Ctrl+,）', {
        action: { label: '打开设置', onClick: () => App.openSettings() },
      });
      return;
    }

    const userMsg = { role: 'user', text };
    this.history.push(userMsg);
    this.render();
    this.msgs.appendChild(el('div', { class: 'ai-msg assistant pending', html: '<span class="ai-dot"></span>' }));
    this.scrollBottom();
    this.setStreamingUI(true);

    const id = `ai-${Date.now()}`;
    this.streaming = { id, text: '', userMsg };

    try {
      const res = await window.notesAPI.aiChat({ id, messages: this.buildMessages(text) });
      if (!res.success) {
        this.streaming = null;
        this.setStreamingUI(false);
        this.history.push({ role: 'assistant', text: res.error, error: true });
        this.render();
      }
      // 成功发起后等待 onAiChunk / onAiDone 推送
    } catch (err) {
      this.streaming = null;
      this.setStreamingUI(false);
      this.history.push({ role: 'assistant', text: `请求失败：${err?.message || err}`, error: true });
      this.render();
    }
  },

  buildMessages(instruction) {
    const hist = [];
    for (const m of this.history.slice(-9)) {
      if (m.role === 'user') hist.push({ role: 'user', content: m.text });
      else hist.push({
        role: 'assistant',
        content: m.blocks?.length ? `${this.displayText(m.text)}\n\n（已生成 ${m.blocks.length} 个编辑块${m.applied ? '并已应用' : ''}）` : m.text,
      });
    }
    const ctx = this.getContext();
    const header = ctx ? `${ctx}\n\n` : '';
    return [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      ...hist,
      { role: 'user', content: `${header}${instruction}` },
    ];
  },

  /** 当前发给 AI 的上下文；无笔记打开返回 null */
  getContext() {
    const rel = Tabs.activePath;
    if (!rel) return null;
    const codeFence = (t) => `\`\`\`html\n${t}\n\`\`\``;
    if (this.ctxMode === 'selection') {
      const sel = Editor.instance?.getSelection();
      const model = Editor.instance?.getModel();
      if (sel && model && !sel.isEmpty()) {
        return `以下是笔记《${PathUtil.base(rel)}》中选中的 HTML 片段：\n${codeFence(model.getValueInRange(sel))}`;
      }
      // 无选区 → 回落整篇
    }
    let text = Editor.getValue(rel) || '';
    if (text.length > 30000) text = `${text.slice(0, 30000)}\n<!--（笔记过长，已截断）-->`;
    return `以下是当前笔记《${PathUtil.base(rel)}》的 HTML 源码：\n${codeFence(text)}`;
  },

  renderStreamingText() {
    const pending = this.msgs?.querySelector('.ai-msg.pending');
    if (!pending) return;
    pending.classList.remove('pending');
    pending.querySelector('.ai-msg-text').innerHTML =
      escapeHtml(this.displayText(this.streaming.text)).replace(/\n/g, '<br>') || '<span class="ai-dot"></span>';
    this.scrollBottom();
  },

  finishStreaming(aborted, error) {
    const cur = this.streaming;
    this.streaming = null;
    this.setStreamingUI(false);
    if (!cur) return;

    const pending = this.msgs?.querySelector('.ai-msg.pending');
    pending?.remove();

    if (error) {
      this.history.push({ role: 'assistant', text: `请求失败：${error}`, error: true });
    } else {
      const text = cur.text || (aborted ? '（已停止）' : '（空回复）');
      const blocks = parseEditBlocks(cur.text || '');
      this.history.push({ role: 'assistant', text, blocks });
    }
    this.render();
  },

  abort() {
    if (!this.streaming) return;
    window.notesAPI.aiAbort({ id: this.streaming.id });
  },

  setStreamingUI(on) {
    if (!this.sendBtn) return;
    this.sendBtn.innerHTML = Icons.svg(on ? 'stop' : 'send');
    this.sendBtn.title = on ? '停止' : '发送 (Enter)';
    this.sendBtn.classList.toggle('stop', on);
    $$('.ai-chip', this.msgs?.parentElement?.parentElement || document).forEach((c) => { c.disabled = on; });
  },

  apply(msg, bar) {
    const { applied, failed } = applyEditBlocks(msg.blocks);
    msg.applied = applied > 0;
    if (applied) {
      Status.setMessage(`AI 已修改 ${applied} 处，Ctrl+Z 可撤销`);
      Toast.ok(`已应用 ${applied} 处修改`, { timeout: 2000 });
    }
    if (failed.length) {
      Toast.warn(`${failed.length} 处未能匹配原文${applied ? '，其余已应用' : ''}`, { timeout: 3600 });
    }
    this.render();
  },
};

/* ─── 组件模板插入 ─────────────────────────────────────── */

const Templates = {
  list: [
    {
      label: '信息卡片', icon: 'info',
      snippet: [
        '<div style="border:1px solid #e2e8f0;border-radius:12px;padding:16px 18px;margin:18px 0;box-shadow:0 1px 3px rgba(15,23,42,.06)">',
        '  <div style="font-weight:700;font-size:15px;margin-bottom:6px">卡片标题</div>',
        '  <div style="color:#475569;font-size:13px;line-height:1.7">在这里写内容…</div>',
        '</div>',
      ].join('\n'),
    },
    {
      label: '双栏布局', icon: 'columns',
      snippet: [
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0">',
        '  <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">左栏内容…</div>',
        '  <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px">右栏内容…</div>',
        '</div>',
      ].join('\n'),
    },
    {
      label: '表格', icon: 'table',
      snippet: [
        '<table style="border-collapse:collapse;width:100%;margin:18px 0;font-size:13px">',
        '  <thead><tr><th style="border:1px solid #e2e8f0;background:#f1f5f9;padding:8px 12px;text-align:left">列一</th><th style="border:1px solid #e2e8f0;background:#f1f5f9;padding:8px 12px;text-align:left">列二</th></tr></thead>',
        '  <tbody><tr><td style="border:1px solid #e2e8f0;padding:8px 12px">内容</td><td style="border:1px solid #e2e8f0;padding:8px 12px">内容</td></tr></tbody>',
        '</table>',
      ].join('\n'),
    },
    {
      label: '折叠面板', icon: 'chevrons-up-down',
      snippet: [
        '<details style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;margin:18px 0">',
        '  <summary style="cursor:pointer;font-weight:600">点击展开</summary>',
        '  <p style="color:#475569">折叠的内容…</p>',
        '</details>',
      ].join('\n'),
    },
    {
      label: '任务清单', icon: 'check',
      snippet: [
        '<ul style="list-style:none;padding-left:0;margin:18px 0">',
        '  <li><label><input type="checkbox" checked> 已完成的事项</label></li>',
        '  <li><label><input type="checkbox"> 待办的事项</label></li>',
        '</ul>',
      ].join('\n'),
    },
    {
      label: '引用块', icon: 'quote',
      snippet: [
        '<blockquote style="border-left:3px solid #89b4fa;background:#f4f7fe;padding:10px 16px;border-radius:0 8px 8px 0;margin:18px 0;color:#334155">',
        '  引用或强调的内容…',
        '</blockquote>',
      ].join('\n'),
    },
    {
      label: 'ECharts 图表', icon: 'chart-column',
      snippet: [
        '<div id="chart-1" style="width:100%;height:320px;margin:18px 0"></div>',
        '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>',
        '<script>',
        "  echarts.init(document.getElementById('chart-1')).setOption({",
        "    xAxis: { type: 'category', data: ['一月', '二月', '三月', '四月'] },",
        "    yAxis: { type: 'value' },",
        "    series: [{ type: 'bar', data: [120, 200, 150, 80] }]",
        '  });',
        "  window.addEventListener('resize', () => echarts.getInstanceByDom(document.getElementById('chart-1'))?.resize());",
        '</script>',
      ].join('\n'),
    },
    {
      label: '图片（含说明）', icon: 'image',
      snippet: [
        '<figure style="margin:18px 0;text-align:center">',
        '  <img src="assets/图片.png" alt="说明" style="max-width:100%;border-radius:8px">',
        '  <figcaption style="color:#64748b;font-size:12px;margin-top:6px">图片说明</figcaption>',
        '</figure>',
      ].join('\n'),
    },
  ],

  open(x, y) {
    if (!Tabs.activePath) { Toast.warn('先打开一篇笔记'); return; }
    Menu.open(this.list.map((t) => ({
      label: t.label,
      icon: t.icon,
      onSelect: () => {
        Editor.insertText(`\n${t.snippet}\n`);
        Toast.ok(`已插入「${t.label}」`, { timeout: 1500 });
      },
    })), {
      x: x ?? window.innerWidth / 2 - 100,
      y: y ?? Math.max(120, window.innerHeight / 2 - 160),
    });
  },
};

window.addEventListener('DOMContentLoaded', () => AI.init());
