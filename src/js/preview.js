'use strict';

/* ═══════════════════════════════════════════════════════
   preview.js — 预览面板

   内容通过 notes:// 协议提供（见 main.js），因此：
     · 完整 JavaScript / ECharts / D3 / Mermaid 等 CDN 库可用
     · 笔记目录内的相对路径图片、CSS、子页面可用
     · 预览的是编辑器里的实时内容，不必先保存
   ═══════════════════════════════════════════════════════ */

const Preview = {
  frame: null,
  emptyNode: null,
  labelName: null,
  labelDir: null,
  barActions: null,
  target: null,
  _seq: 0,
  _debounced: null,

  init() {
    this.frame = $('#preview-frame');
    this.emptyNode = $('#preview-empty');
    this.labelName = $('#preview-name');
    this.labelDir = $('#preview-dir');

    this._debounced = debounce(() => this.update(), 450);

    // 接收预览内容的 postMessage（链接跳转 / 高度上报）
    window.addEventListener('message', (e) => this.onMessage(e));

    $('#btn-preview-refresh')?.addEventListener('click', () => this.refresh(true));
    $('#btn-preview-detach')?.addEventListener('click', () => this.toggleDetachWindow());
    $('#btn-preview-external')?.addEventListener('click', () => this.openExternal());

    window.notesAPI.onPreviewWindowClosed(() => this.updateDetachButton());
  },

  /* ─── 目标切换 ───────────────────────────────────────── */
  async setTarget(rel) {
    if (!rel || !PathUtil.isHtml(rel)) { this.clear(); return; }
    const changed = this.target !== rel;
    this.target = rel;
    this.updateLabel();
    this.updateDetachButton();
    const content = Editor.getValue(rel) ?? '';
    this.checkExternalResources(content);
    await this.pushBuffer();
    if (changed) this.reload();
  },

  updateLabel() {
    if (!this.target) return;
    if (this.labelName) this.labelName.textContent = PathUtil.base(this.target);
    if (this.labelDir) {
      const dir = PathUtil.dir(this.target);
      this.labelDir.textContent = dir ? `— ${dir}/` : '';
    }
  },

  clear() {
    this.target = null;
    this._seq++;
    if (this.frame) {
      this.frame.removeAttribute('src');
      this.frame.classList.add('hidden');
    }
    this.emptyNode?.classList.remove('hidden');
    if (this.labelName) this.labelName.textContent = '未选择笔记';
    if (this.labelDir) this.labelDir.textContent = '';
    window.notesAPI.clearLivePreview();
  },

  /* ─── 内容更新 ───────────────────────────────────────── */
  /** 把编辑器当前内容推给主进程（预览读到的是未保存的实时内容） */
  async pushBuffer() {
    if (!this.target) return;
    const content = Editor.getValue(this.target) ?? '';
    await window.notesAPI.setLivePreview(this.target, content);
  },

  /** 编辑器改动后调用，防抖刷新 */
  scheduleUpdate() {
    if (!App.prefs.livePreview || !this.target) return;
    this._debounced();
  },

  /* ─── 外网可用性 ─────────────────────────────────────── */
  // 笔记引用 CDN 时，外网不通会让预览「静默地少东西」。
  // 这里检测到这种情况就明确告诉用户原因，而不是让人对着空白发呆。
  _netState: null,        // null=未检测 / true=可用 / false=不可用
  _netWarned: false,

  async checkExternalResources(html) {
    if (this._netWarned || !html) return;
    // 只在这篇笔记真的引用了外部 js/css 时才值得探测
    const usesExternal = /<(script|link)\b[^>]*\b(?:src|href)\s*=\s*["']https?:\/\//i.test(html);
    if (!usesExternal) return;

    this._netWarned = true;

    let state = this._netState;
    if (state === null) {
      const res = await window.notesAPI.diagnoseNetwork();
      state = !!(res.success && res.ok);
      this._netState = state;
      this._netDetail = res;
    }
    if (state) return;

    const d = this._netDetail || {};
    const hint = d.usingProxy && d.proxyHost
      ? `系统代理 ${d.proxyHost} 连不上`
      : '外网不可达';

    Toast.warn(`这篇笔记引用了外部 CDN，但当前${hint}，脚本无法加载`, {
      timeout: 9000,
      action: { label: '查看原因', onClick: () => this.showNetworkHelp() },
    });
  },

  showNetworkHelp() {
    const d = this._netDetail || {};
    const proxyLine = d.usingProxy && d.proxyHost
      ? `<p>检测到系统代理 <code>${d.proxyHost}</code>，但连接失败。如果这个代理没有在运行，请在系统设置里关掉它（GNOME：设置 → 网络 → 网络代理；KDE：系统设置 → 网络 → 代理）。</p>`
      : '<p>当前没有配置代理，是直连失败。</p>';

    Modal.open({
      title: '外网不可用',
      icon: 'alert-triangle',
      width: 520,
      body: el('div', {}, [
        el('p', {
          html: '这篇笔记通过 <code>&lt;script src="https://..."&gt;</code> 引用了外部库（ECharts、D3、Mermaid 之类）。预览是一个独立的浏览器页面，它需要能访问外网才能把这些库下载下来。',
        }),
        proxyLine,
        el('p', { html: `原始错误：<code>${escapeHtml(d.error || '未知')}</code>` }),
        el('p', { html: '如果你在浏览器里打开同样的 HTML 也是空白，那就是同一个问题；如果浏览器正常，多半是 DNS：检查 <code>/etc/resolv.conf</code> 里的 DNS 服务器是否可达。' }),
        el('p', { html: '<b>离线替代方案：</b>把用到的库下载到笔记库里，用相对路径引用，例如 <code>&lt;script src="资源/echarts.min.js"&gt;&lt;/script&gt;</code>。这样完全不需要联网。' }),
      ]),
      footer: [
        el('button', {
          class: 'btn btn-ghost', text: '重新检测',
          onclick: async () => {
            this._netState = null;
            this._netWarned = false;
            const res = await window.notesAPI.diagnoseNetwork();
            Modal.closeTop();
            if (res.success && res.ok) { Toast.ok('外网已恢复'); this._netState = true; this._netWarned = true; }
            else Toast.error('外网仍然不可用');
          },
        }),
        el('button', { class: 'btn btn-primary', text: '知道了', onclick: () => Modal.closeTop() }),
      ],
    });
  },

  async update() {
    if (!this.target) return;
    const content = Editor.getValue(this.target) ?? '';
    this.checkExternalResources(content);
    await this.pushBuffer();
    this.reload();
    window.notesAPI.reloadPreviewWindow();
  },

  /** 强制刷新（重新读盘，用于外部改动后） */
  async refresh(fromDisk = false) {
    if (!this.target) return;
    if (fromDisk) {
      const res = await window.notesAPI.readFile(this.target);
      if (res.success) {
        Editor.refreshModel(this.target, res.content);
        App.syncSavedState(this.target, res.content);
      }
    }
    await this.update();
  },

  reload() {
    if (!this.target || !this.frame) return;
    // 带递增参数强制重新导航（协议层已设 no-store）
    this.frame.src = `${PathUtil.toPreviewUrl(this.target)}?v=${++this._seq}`;
    this.frame.classList.remove('hidden');
    this.emptyNode?.classList.add('hidden');
  },

  /* ─── 独立预览窗口 ───────────────────────────────────── */
  async toggleDetachWindow() {
    const res = await window.notesAPI.isPreviewWindowOpen();
    if (res.open) {
      await window.notesAPI.closePreviewWindow();
      Toast.info('已关闭独立预览窗口');
    } else {
      if (!this.target) { Toast.warn('先打开一篇笔记再弹出预览'); return; }
      await this.pushBuffer();
      await window.notesAPI.openPreviewWindow(this.target, Editor.getValue(this.target) ?? '');
      Toast.ok('已在独立窗口打开预览');
      // 切到「仅编辑」，把界面让出来
      if (App.mode !== 'edit') App.setMode('edit');
    }
    setTimeout(() => this.updateDetachButton(), 300);
  },

  async updateDetachButton() {
    const btn = $('#btn-preview-detach');
    if (!btn) return;
    const res = await window.notesAPI.isPreviewWindowOpen();
    btn.classList.toggle('active', res.open);
    btn.title = res.open ? '关闭独立预览窗口' : '在独立窗口打开预览';
  },

  async openExternal() {
    if (!this.target) return;
    await this.pushBuffer();
    const abs = `${App.vaultPath}/${this.target}`;
    // 先确保磁盘内容是最新的，否则外部浏览器看到的是旧内容
    if (Editor.isDirty(this.target)) await App.save(this.target, { silent: true });
    const res = await window.notesAPI.openPath(abs);
    if (!res.success) Toast.error(`打开失败：${res.error || '未知错误'}`);
  },

  onThemeChanged() {
    // 预览内容自身配色由笔记决定，这里只处理空状态
  },

  /* ─── 来自预览内容的通信 ─────────────────────────────── */
  onMessage(event) {
    const data = event.data;
    if (!data || data.__notes !== true) return;

    if (data.type === 'open-note') {
      const rel = PathUtil.fromPreviewUrl(data.href);
      // 只允许打开笔记库内的 HTML
      if (!rel || !PathUtil.isHtml(rel)) return;
      const exists = App.findInTree(rel);
      if (!exists) { Toast.warn(`笔记库中找不到 ${rel}`); return; }
      App.openFile(rel);
      return;
    }

    if (data.type === 'resize') {
      this._contentHeight = data.height;
    }
  },
};
