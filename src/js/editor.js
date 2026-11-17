'use strict';

/* ═══════════════════════════════════════════════════════
   editor.js — Monaco 编辑器封装
   每个打开的文件一个 model，切换标签时保留撤销历史与光标位置
   ═══════════════════════════════════════════════════════ */

const Editor = {
  instance: null,
  models: new Map(),     // relPath -> monaco model
  ready: false,
  activePath: null,
  _suppressChange: false,

  /* ─── 加载 Monaco ────────────────────────────────────── */
  load() {
    return new Promise((resolve) => {
      if (window.monaco?.editor) return resolve();
      if (typeof require === 'undefined') {
        console.error('Monaco loader 未加载');
        return resolve();
      }
      require.config({ paths: { vs: window.notesAPI.monacoBase } });
      require(['vs/editor/editor.main'], () => resolve());
    });
  },

  /* ─── 初始化 ─────────────────────────────────────────── */
  async init(prefs = {}) {
    await this.load();
    if (typeof monaco === 'undefined' || !monaco.editor) {
      Toast.error('编辑器加载失败，语法高亮不可用');
      return;
    }

    this.defineThemes();
    this.registerCompletions();

    const host = $('#editor-host');
    if (!host) return;

    this.instance = monaco.editor.create(host, {
      value: '',
      language: 'html',
      theme: Theme.resolved === 'light' ? 'notes-light' : 'notes-dark',
      fontSize: prefs.fontSize || 13.5,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'DejaVu Sans Mono', monospace",
      fontLigatures: true,
      lineHeight: prefs.lineHeight || 1.65,
      minimap: { enabled: prefs.minimap !== false, side: 'right', showSlider: 'mouseover', maxColumn: 80 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      padding: { top: 12, bottom: 24 },
      renderLineHighlight: 'line',
      roundedSelection: false,
      tabSize: Number(prefs.tabSize) || 2,
      insertSpaces: true,
      wordWrap: prefs.wordWrap ? 'on' : 'off',
      wrappingIndent: 'indent',
      automaticLayout: true,
      bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
      guides: { bracketPairs: 'active', indentation: true, highlightActiveIndentation: true },
      formatOnPaste: true,
      formatOnType: false,
      linkedEditing: true,
      suggest: { showWords: true },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      stickyScroll: { enabled: false },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      fixedOverflowWidgets: true,
      emptySelectionClipboard: false,
      unicodeHighlight: { ambiguousCharacters: false },
      // HTML 校验噪音较大，只保留语法层面提示
      'semanticHighlighting.enabled': true,
    });

    monaco.editor.setTheme(Theme.resolved === 'light' ? 'notes-light' : 'notes-dark');
    this.ready = true;
    this.bindEvents();
  },

  bindEvents() {
    this.instance.onDidChangeModelContent(() => {
      if (this._suppressChange || !this.activePath) return;
      App.markDirty(this.activePath);
      Preview.scheduleUpdate();
    });

    this.instance.onDidChangeCursorPosition((e) => {
      const pos = e.position;
      Status.setCursor(pos.lineNumber, pos.column, this.instance.getModel()?.getLineCount() || 0);
      // 光标 → 预览里的对应元素描边（见 preview.js）
      if (typeof Preview !== 'undefined') Preview.onEditorCursor?.(pos.lineNumber);
    });

    // 编辑器滚动 → 预览跟随（见 preview.js）
    this.instance.onDidScrollChange(() => {
      if (typeof Preview !== 'undefined') Preview.onEditorScroll();
    });

    this.instance.onDidChangeModel(() => {
      const model = this.instance.getModel();
      App.onModelChanged(model);
    });

    // 编辑器内快捷键
    this.instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => App.saveActive());
    this.instance.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => this.format());
    this.instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => App.openQuickOpen());
    this.instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => App.openPalette());
    this.instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => AI.toggle());
    // Ctrl+E 在三种布局间轮换
    this.instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => App.cycleMode());

    // 右键菜单加「插入组件」
    this.instance.addAction({
      id: 'hypernote-templates',
      label: '插入组件…',
      keybindings: [],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run: () => Templates.open(),
    });

    // 粘贴图片 → 自动落盘并插入 <img>。
    // Monaco 的 CopyPasteController 会在容器（editor-host）的 capture 阶段
    // stopPropagation 接管 paste，所以必须挂到它的父级才能先拿到事件。
    const dom = this.instance.getDomNode();
    const pasteZone = dom.parentElement?.parentElement ?? dom;
    pasteZone.addEventListener('paste', (e) => this.onPaste(e), true);
    // Ctrl/Cmd + 滚轮调整字号
    dom.addEventListener('wheel', (e) => this.onWheelZoom(e), { passive: false });
  },

  /** 粘贴板里有图片时接管事件，文本粘贴仍然交给 Monaco */
  onPaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imgItem = items.find((it) => it.type.startsWith('image/'));
    if (!imgItem) return;
    const file = imgItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    App.handleImagePaste(file);
  },

  /** Ctrl/Cmd+滚轮 缩放编辑器字号（9–30，防抖持久化） */
  onWheelZoom(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const cur = Number(App.prefs.fontSize) || 13.5;
    const next = Math.min(30, Math.max(9, cur + (e.deltaY < 0 ? 1 : -1)));
    if (next === cur) return;
    App.prefs.fontSize = next;
    this.updateOptions({ fontSize: next });
    Status.setMessage(`字号 ${next}`);
    clearTimeout(this._fontSaveTimer);
    this._fontSaveTimer = setTimeout(() => window.notesAPI.setPref('fontSize', next), 600);
  },

  /** href / src 里补全库内文件的相对路径 */
  registerCompletions() {
    if (this._completionsRegistered) return;
    this._completionsRegistered = true;
    monaco.languages.registerCompletionItemProvider('html', {
      triggerCharacters: ['/', '.', '-', '_'],
      provideCompletionItems: (model, position) => {
        const before = model.getValueInRange({
          startLineNumber: position.lineNumber, startColumn: 1,
          endLineNumber: position.lineNumber, endColumn: position.column,
        });
        // 光标必须停在 href=" 或 src=" 的引号内
        const m = before.match(/(?:href|src)\s*=\s*(["'])([^"']*)$/);
        if (!m) return { suggestions: [] };
        const typed = m[2];
        const active = this.activePath;
        if (!active || !App.vaultPath) return { suggestions: [] };

        const files = [];
        (function walk(nodes) {
          for (const n of nodes || []) {
            if (n.type === 'folder') walk(n.children);
            else files.push(n.path);
          }
        })(App.tree);

        const seen = new Set();
        const suggestions = [];
        for (const rel of files) {
          if (rel === active) continue;
          const target = PathUtil.relTo(active, rel);
          if (seen.has(target)) continue;
          seen.add(target);
          suggestions.push({
            label: target,
            kind: monaco.languages.CompletionItemKind.File,
            detail: rel,
            insertText: target,
            range: new monaco.Range(
              position.lineNumber, position.column - typed.length,
              position.lineNumber, position.column,
            ),
          });
        }
        return { suggestions: suggestions.slice(0, 80) };
      },
    });
  },

  /** 在光标处插入文本 */
  insertText(text) {
    if (!this.ready) return;
    const sel = this.instance.getSelection();
    this.instance.executeEdits('hypernote', [{ range: sel, text, forceMoveMarkers: true }]);
    this.instance.focus();
  },

  /* ─── 主题 ───────────────────────────────────────────── */
  defineThemes() {
    const dark = {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: '', foreground: 'cdd6f4' },
        { token: 'comment', foreground: '6c7086', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'cba6f7' },
        { token: 'string', foreground: 'a6e3a1' },
        { token: 'number', foreground: 'fab387' },
        { token: 'type', foreground: '89b4fa' },
        { token: 'tag', foreground: 'f38ba8' },
        { token: 'metatag', foreground: 'f38ba8' },
        { token: 'attribute.name', foreground: 'f9e2af' },
        { token: 'attribute.value', foreground: 'a6e3a1' },
        { token: 'delimiter', foreground: '9399b2' },
        { token: 'delimiter.html', foreground: '7f849c' },
        // 语言限定的 token 名：Monaco 基础主题（vs / vs-dark）对 html、css
        // 子语言有更具体的规则，必须同样具体才压得住
        { token: 'tag.html', foreground: 'f38ba8' },
        { token: 'attribute.name.html', foreground: 'f9e2af' },
        { token: 'attribute.value.html', foreground: 'a6e3a1' },
        { token: 'tag.css', foreground: '89b4fa' },
        { token: 'attribute.name.css', foreground: '89b4fa' },
        { token: 'attribute.value.css', foreground: 'a6e3a1' },
        { token: 'attribute.value.hex.css', foreground: 'fab387' },
        { token: 'attribute.value.number.css', foreground: 'fab387' },
        { token: 'property', foreground: '89b4fa' },
        { token: 'variable', foreground: 'cdd6f4' },
        { token: 'function', foreground: '89b4fa' },
        { token: 'invalid', foreground: 'f38ba8' },
      ],
      colors: {
        'editor.background': '#1e1e2e',
        'editor.foreground': '#cdd6f4',
        'editor.lineHighlightBackground': '#26263a',
        'editor.lineHighlightBorder': '#00000000',
        'editorLineNumber.foreground': '#4e5165',
        'editorLineNumber.activeForeground': '#a6adc8',
        'editor.selectionBackground': '#3a3d55',
        'editor.inactiveSelectionBackground': '#2c2f45',
        'editor.selectionHighlightBackground': '#3a3d5580',
        'editor.wordHighlightBackground': '#3a3d5560',
        'editor.findMatchBackground': '#89b4fa55',
        'editor.findMatchHighlightBackground': '#89b4fa30',
        'editorCursor.foreground': '#89b4fa',
        'editorWhitespace.foreground': '#313244',
        'editorIndentGuide.background1': '#2a2b3d',
        'editorIndentGuide.activeBackground1': '#45475a',
        'editorBracketHighlight.foreground1': '#89b4fa',
        'editorBracketHighlight.foreground2': '#cba6f7',
        'editorBracketHighlight.foreground3': '#f9e2af',
        'editorWidget.background': '#23233a',
        'editorWidget.border': '#313244',
        'editorSuggestWidget.background': '#23233a',
        'editorSuggestWidget.border': '#313244',
        'editorSuggestWidget.selectedBackground': '#313244',
        'editorHoverWidget.background': '#23233a',
        'editorHoverWidget.border': '#313244',
        'input.background': '#11111b',
        'input.border': '#313244',
        'dropdown.background': '#23233a',
        'dropdown.border': '#313244',
        'list.hoverBackground': '#313244',
        'list.activeSelectionBackground': '#313244',
        'scrollbarSlider.background': '#45475a66',
        'scrollbarSlider.hoverBackground': '#45475aaa',
        'scrollbarSlider.activeBackground': '#45475a',
        'editorOverviewRuler.border': '#00000000',
        'editorGutter.background': '#1e1e2e',
        'minimap.background': '#1e1e2e',
        'editorError.foreground': '#f38ba8',
        'editorWarning.foreground': '#f9e2af',
        'editorInfo.foreground': '#89dceb',
      },
    };

    const light = {
      base: 'vs', inherit: true,
      rules: [
        { token: '', foreground: '4c4f69' },
        { token: 'comment', foreground: '9ca0b0', fontStyle: 'italic' },
        { token: 'keyword', foreground: '8839ef' },
        { token: 'string', foreground: '40a02b' },
        { token: 'number', foreground: 'fe640b' },
        { token: 'type', foreground: '1e66f5' },
        { token: 'tag', foreground: 'd20f39' },
        { token: 'metatag', foreground: 'd20f39' },
        { token: 'attribute.name', foreground: 'df8e1d' },
        { token: 'attribute.value', foreground: '40a02b' },
        { token: 'delimiter', foreground: '8c8fa1' },
        { token: 'delimiter.html', foreground: '9ca0b0' },
        // 与暗色主题保持对称，见上面的说明
        { token: 'tag.html', foreground: 'd20f39' },
        { token: 'attribute.name.html', foreground: 'df8e1d' },
        { token: 'attribute.value.html', foreground: '40a02b' },
        { token: 'tag.css', foreground: '1e66f5' },
        { token: 'attribute.name.css', foreground: '1e66f5' },
        { token: 'attribute.value.css', foreground: '40a02b' },
        { token: 'attribute.value.hex.css', foreground: 'fe640b' },
        { token: 'attribute.value.number.css', foreground: 'fe640b' },
        { token: 'property', foreground: '1e66f5' },
        { token: 'function', foreground: '1e66f5' },
        { token: 'invalid', foreground: 'd20f39' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#4c4f69',
        'editor.lineHighlightBackground': '#f4f5f9',
        'editor.lineHighlightBorder': '#00000000',
        'editorLineNumber.foreground': '#bcc0cc',
        'editorLineNumber.activeForeground': '#6c6f85',
        'editor.selectionBackground': '#d3dcf7',
        'editor.inactiveSelectionBackground': '#e6e9ef',
        'editor.selectionHighlightBackground': '#d3dcf780',
        'editor.findMatchBackground': '#1e66f540',
        'editor.findMatchHighlightBackground': '#1e66f528',
        'editorCursor.foreground': '#1e66f5',
        'editorWhitespace.foreground': '#dce0e8',
        'editorIndentGuide.background1': '#e6e9ef',
        'editorIndentGuide.activeBackground1': '#bcc0cc',
        'editorWidget.background': '#ffffff',
        'editorWidget.border': '#dce0e8',
        'editorSuggestWidget.background': '#ffffff',
        'editorSuggestWidget.border': '#dce0e8',
        'editorSuggestWidget.selectedBackground': '#eff1f5',
        'editorHoverWidget.background': '#ffffff',
        'editorHoverWidget.border': '#dce0e8',
        'input.background': '#ffffff',
        'input.border': '#dce0e8',
        'dropdown.background': '#ffffff',
        'dropdown.border': '#dce0e8',
        'list.hoverBackground': '#eff1f5',
        'list.activeSelectionBackground': '#e6e9ef',
        'scrollbarSlider.background': '#9ca0b055',
        'scrollbarSlider.hoverBackground': '#9ca0b088',
        'scrollbarSlider.activeBackground': '#9ca0b0',
        'editorOverviewRuler.border': '#00000000',
        'editorGutter.background': '#ffffff',
        'minimap.background': '#ffffff',
      },
    };

    monaco.editor.defineTheme('notes-dark', dark);
    monaco.editor.defineTheme('notes-light', light);
  },

  setTheme(resolved) {
    if (!this.ready) return;
    monaco.editor.setTheme(resolved === 'light' ? 'notes-light' : 'notes-dark');
  },

  /* ─── 模型管理 ───────────────────────────────────────── */
  modelUri(rel) {
    return monaco.Uri.file(`/${rel}`);
  },

  /** 扩展名 → Monaco 语言 id（状态栏、语法高亮保持一致） */
  languageFor(rel) {
    const ext = PathUtil.ext(rel);
    return {
      html: 'html', htm: 'html',
      css: 'css',
      js: 'javascript', mjs: 'javascript',
      json: 'json',
      md: 'markdown',
      svg: 'xml', xml: 'xml',
      txt: 'plaintext',
    }[ext] || 'plaintext';
  },

  getModel(rel, content) {
    if (this.models.has(rel)) return this.models.get(rel);
    const uri = this.modelUri(rel);
    // Uri 已被占用（例如同名文件）时复用已有 model，避免 monaco 抛错
    const model = monaco.editor.getModel(uri)
      || monaco.editor.createModel(content ?? '', this.languageFor(rel), uri);
    this.models.set(rel, model);
    return model;
  },

  /** 磁盘内容变了：如果 model 没有未保存改动就同步，否则保留用户编辑 */
  refreshModel(rel, content) {
    const model = this.models.get(rel);
    if (!model) return;
    this._suppressChange = true;
    if (model.getValue() !== content) model.setValue(content);
    this._suppressChange = false;
  },

  setActiveModel(rel, content) {
    if (!this.ready) return;
    const model = this.getModel(rel, content);
    // 首次载入：把磁盘内容写进 model
    if (model.getValue() === '' && content) {
      this._suppressChange = true;
      model.setValue(content);
      this._suppressChange = false;
    }
    if (this.instance.getModel() !== model) {
      // 记住切换前的视图状态
      if (this.activePath) this._saveViewState(this.activePath);
      this.activePath = rel;
      this.instance.setModel(model);
      model.updateOptions({ tabSize: Number(App.prefs.tabSize) || 2, insertSpaces: true });
      this._restoreViewState(rel);
    }
    this.instance.updateOptions({ readOnly: false });
    this.instance.focus();
  },

  _viewStates: new Map(),
  _saveViewState(rel) {
    if (!this.instance) return;
    const state = this.instance.saveViewState();
    if (state) this._viewStates.set(rel, state);
  },
  _restoreViewState(rel) {
    const state = this._viewStates.get(rel);
    if (state) { this.instance.restoreViewState(state); }
    else { this.instance.setScrollPosition({ scrollTop: 0 }); this.instance.setPosition({ lineNumber: 1, column: 1 }); }
  },

  disposeModel(rel) {
    const model = this.models.get(rel);
    if (!model) return;
    if (this.activePath === rel) {
      this._saveViewState(rel);
      this.instance?.setModel(null);
      this.activePath = null;
    }
    this._viewStates.delete(rel);
    this._savedVersion.delete(rel);
    this.models.delete(rel);
    model.dispose();
  },

  /* ─── 读写 ───────────────────────────────────────────── */
  getValue(rel = this.activePath) {
    const model = rel ? this.models.get(rel) : null;
    return model ? model.getValue() : '';
  },

  /* ─── 脏状态 ─────────────────────────────────────────── */
  _savedVersion: new Map(),

  /** 记录「已保存」版本，用 Monaco 的 alternativeVersionId 判断，
   *  这样撤销回到保存点时会自动变回「未修改」 */
  markSaved(rel) {
    const model = this.models.get(rel);
    if (model) this._savedVersion.set(rel, model.getAlternativeVersionId());
  },

  isDirty(rel) {
    const model = this.models.get(rel);
    if (!model) return false;
    const saved = this._savedVersion.get(rel);
    if (saved === undefined) return true;   // 没记录过保存点的新文件
    return model.getAlternativeVersionId() !== saved;
  },

  format() {
    if (!this.ready) return;
    this.instance.getAction('editor.action.formatDocument')?.run().catch(() => {});
  },

  layout() {
    this.instance?.layout();
  },

  updateOptions(opts) {
    this.instance?.updateOptions(opts);
  },

  /** 当前视口最上面一行的行号（滚动同步用） */
  getTopVisibleLine() {
    if (!this.ready || !this.instance) return 0;
    const ranges = this.instance.getVisibleRanges();
    return ranges.length ? ranges[0].startLineNumber : 0;
  },

  /** 把某一行滚到视口顶部，不动光标（滚动同步用） */
  scrollToSourceLine(line) {
    if (!this.ready || !this.instance || !line) return;
    const model = this.instance.getModel();
    if (!model) return;
    const target = Math.max(1, Math.min(Math.round(line), model.getLineCount()));
    this.instance.setScrollTop(this.instance.getTopForLineNumber(target));
  },

  /**
   * 跳到源码行。给了 endLine 时选中整段（预览里点中的元素可能跨多行），
   * 跨度过大时只定位不选中，免得把整个文件选蓝。
   */
  revealLine(line, endLine) {
    if (!this.ready || !this.instance || !line) return;
    const model = this.instance.getModel();
    const count = model ? model.getLineCount() : line;
    const start = Math.max(1, Math.min(line, count));
    const end = endLine ? Math.max(start, Math.min(endLine, count)) : 0;

    this.instance.revealLineInCenter(start);
    this.instance.setPosition({ lineNumber: start, column: 1 });
    this.instance.focus();

    if (end) {
      const stopLine = Math.max(start, end);
      // 跨度过大时只定位不选中，免得把整个文件选蓝
      if (stopLine - start <= 400) {
        const lastCol = model ? model.getLineMaxColumn(stopLine) : 1;
        this.instance.setSelection(new monaco.Range(start, 1, stopLine, lastCol));
      }
    }

    // 短暂高亮，帮用户定位
    if (!model) return;
    const decorations = this.instance.deltaDecorations([], [{
      range: new monaco.Range(start, 1, start, Math.max(2, model.getLineMaxColumn(start))),
      options: { isWholeLine: true, className: 'line-flash' },
    }]);
    setTimeout(() => this.instance?.deltaDecorations(decorations, []), 1200);
  },
};
