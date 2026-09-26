'use strict';

/* ═══════════════════════════════════════════════════════
   util.js — 通用小工具
   ═══════════════════════════════════════════════════════ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 创建元素：el('div', {class:'x', onclick:fn}, [子元素或字符串]) */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 防抖 */
function debounce(fn, wait) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

/** 节流（每帧最多一次） */
function rafThrottle(fn) {
  let queued = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

/* ─── 路径 ─────────────────────────────────────────────── */
const PathUtil = {
  /** 取文件名 */
  base(p) { return p ? p.split('/').pop() : ''; },
  /** 取所在目录（根目录返回空串） */
  dir(p) {
    if (!p || !p.includes('/')) return '';
    return p.slice(0, p.lastIndexOf('/'));
  },
  /** 去掉扩展名 */
  stem(p) {
    const b = this.base(p);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(0, i) : b;
  },
  /** 取扩展名（小写，不含点） */
  ext(p) {
    const b = this.base(p);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1).toLowerCase() : '';
  },
  /** 拼路径，自动避免双斜杠 */
  join(...parts) {
    return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
  },
  /** 保证 .html 后缀 */
  ensureHtml(name) {
    return /\.html?$/i.test(name) ? name : `${name}.html`;
  },
  /** 是否 HTML */
  isHtml(p) { return /\.html?$/i.test(p); },
  /** 相对路径 → notes:// 预览地址 */
  toPreviewUrl(rel) {
    return `${window.notesAPI.previewOrigin}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  },
  /** notes:// 地址 → 库内相对路径（不在库内则返回 null） */
  fromPreviewUrl(url) {
    const prefix = `${window.notesAPI.previewOrigin}/`;
    if (!url.startsWith(prefix)) return null;
    const rel = url.slice(prefix.length).split('?')[0].split('#')[0];
    try {
      return rel.split('/').map(decodeURIComponent).join('/');
    } catch {
      return null;
    }
  },
};

/* ─── 格式化 ───────────────────────────────────────────── */
const Fmt = {
  /** 扩展名 → 图标类别 */
  iconKind(rel) {
    const ext = PathUtil.ext(rel);
    if (ext === 'html' || ext === 'htm') return 'html';
    if (ext === 'css') return 'css';
    if (ext === 'js' || ext === 'mjs' || ext === 'json') return 'js';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp'].includes(ext)) return 'img';
    return 'doc';
  },

  /** 扩展名 → 图标名 */
  iconName(rel) {
    const kind = this.iconKind(rel);
    if (kind === 'css' || kind === 'js') return 'file-code';
    if (kind === 'img') return 'file-image';
    if (kind === 'doc') return 'file-text';
    return 'file-code';
  },

  /** 扩展名徽标文字 */
  badge(rel) {
    const ext = PathUtil.ext(rel);
    if (!ext || ext === 'html' || ext === 'htm') return '';
    return ext.length > 4 ? ext.slice(0, 4) : ext;
  },
};

/* ─── 键盘 ─────────────────────────────────────────────── */
const Key = {
  /** 是否 Mac（决定用 ⌘ 还是 Ctrl） */
  get isMac() { return window.notesAPI.platform === 'darwin'; },

  /** 把 'Ctrl+Shift+F' 转成显示用的字符串 */
  display(combo) {
    if (this.isMac) {
      return combo
        .replace(/Ctrl\+/gi, '⌘')
        .replace(/Alt\+/gi, '⌥')
        .replace(/Shift\+/gi, '⇧')
        .replace(/Meta\+/gi, '⌘');
    }
    return combo;
  },

  /** 是否匹配快捷键组合 */
  match(event, combo) {
    const parts = combo.split('+');
    const key = parts.pop();
    const needCtrl = parts.some((p) => /^ctrl$/i.test(p));
    const needShift = parts.some((p) => /^shift$/i.test(p));
    const needAlt = parts.some((p) => /^alt$/i.test(p));
    const mod = this.isMac ? event.metaKey : event.ctrlKey;

    if (needCtrl !== mod) return false;
    if (needShift !== event.shiftKey) return false;
    if (needAlt !== event.altKey) return false;
    return event.key.toLowerCase() === key.toLowerCase();
  },
};
