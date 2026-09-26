'use strict';

/* ═══════════════════════════════════════════════════════
   preview-window.js — 独立预览窗口
   内容同样来自 notes:// 协议（含未保存的实时缓冲）
   ═══════════════════════════════════════════════════════ */

(async function () {
  const api = window.notesAPI;
  Icons.hydrate();

  const frame = document.getElementById('frame');
  const emptyNode = document.getElementById('empty');
  const titleNode = document.getElementById('preview-title');
  const dirNode = document.getElementById('preview-dir');

  let current = null;
  let seq = 0;

  /* ─── 主题 ─────────────────────────────────────────── */
  async function applyTheme(mode) {
    let resolved = mode || 'dark';
    if (resolved === 'system') {
      const res = await api.systemIsDark();
      resolved = res.dark ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = resolved;
  }

  const prefRes = await api.getPrefs();
  await applyTheme(prefRes.success ? prefRes.prefs.theme : 'dark');

  /* ─── 显示 ─────────────────────────────────────────── */
  function previewUrl(rel) {
    return `${api.previewOrigin}/${rel.split('/').map(encodeURIComponent).join('/')}?v=${++seq}`;
  }

  function show(rel) {
    current = rel;
    if (!rel) {
      frame.removeAttribute('src');
      frame.classList.add('hidden');
      emptyNode.classList.remove('hidden');
      titleNode.textContent = '未选择笔记';
      dirNode.textContent = '';
      document.title = '预览 — Hypernote';
      return;
    }
    emptyNode.classList.add('hidden');
    frame.classList.remove('hidden');

    const parts = rel.split('/');
    const name = parts.pop();
    titleNode.textContent = name;
    dirNode.textContent = parts.length ? `— ${parts.join('/')}/` : '';
    document.title = `${name} — 预览`;
    frame.src = previewUrl(rel);
  }

  function reload() {
    if (current) frame.src = previewUrl(current);
  }

  /* ─── 初始目标 ─────────────────────────────────────── */
  const target = await api.requestPreviewTarget();
  show(target.success ? target.path : null);

  api.onPreviewTarget(({ path }) => show(path));
  api.onPreviewReload(() => reload());
  api.onPrefsChanged((p) => { if (p?.theme) applyTheme(p.theme); });

  /* ─── 按钮 ─────────────────────────────────────────── */
  document.getElementById('btn-refresh').addEventListener('click', reload);
  document.getElementById('btn-close').addEventListener('click', () => window.close());
  document.getElementById('btn-open-browser').addEventListener('click', async () => {
    if (!current) return;
    const res = await api.openPath(current);
    if (!res.success) alert(`打开失败：${res.error || '未知错误'}`);
  });

  /* ─── 预览内容里的链接 ─────────────────────────────── */
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__notes !== true) return;

    if (data.type === 'open-note') {
      // 独立窗口里点内部链接：直接在本窗口切换目标
      const prefix = `${api.previewOrigin}/`;
      if (!data.href.startsWith(prefix)) return;
      const rel = data.href
        .slice(prefix.length)
        .split('?')[0]
        .split('#')[0]
        .split('/')
        .map(decodeURIComponent)
        .join('/');
      if (/\.html?$/i.test(rel)) show(rel);
    }
  });

  /* ─── 快捷键 ───────────────────────────────────────── */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); reload(); }
    if (e.key === 'F5') { e.preventDefault(); reload(); }
  });
})();
