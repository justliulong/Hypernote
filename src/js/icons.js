'use strict';

/* ═══════════════════════════════════════════════════════
   icons.js — 内联 SVG 图标集
   统一 24×24 viewBox、stroke 描边、currentColor 着色
   ═══════════════════════════════════════════════════════ */

const ICONS = {
  /* 导航 / 结构 */
  'chevron-right': '<path d="M9 18l6-6-6-6"/>',
  'chevrons-up-down': '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>',
  'panel-left':    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 4v16"/>',
  'menu':          '<path d="M4 7h16M4 12h16M4 17h16"/>',

  /* 文件夹 */
  'folder': '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'folder-plus': '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11.5v6M9 14.5h6"/>',
  'folder-reveal': '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9.5 14h5M12.4 11.6l2.4 2.4-2.4 2.4"/>',

  /* 文件 */
  'file': '<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>',
  'file-plus': '<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M12 12.5v5M9.5 15h5"/>',
  'file-code': '<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="m10 13.5-2 2.5 2 2.5M14 13.5l2 2.5-2 2.5"/>',
  'file-image': '<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><circle cx="10" cy="13.5" r="1.2"/><path d="m8 19 3-3 2 2 2-2 2 2"/>',
  'file-text': '<path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M9 13h6M9 17h4"/>',

  /* 操作 */
  'search': '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16.7 16.7"/>',
  'x': '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  'plus': '<path d="M12 5.5v13M5.5 12h13"/>',
  'refresh': '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5v5h-5"/>',
  'trash': '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7"/><path d="M9.5 7V5.2A1.7 1.7 0 0 1 11.2 3.5h1.6a1.7 1.7 0 0 1 1.7 1.7V7"/>',
  'pencil': '<path d="M4 20.5h4.3L20 8.8a2.7 2.7 0 0 0-3.8-3.8L4.5 16.7V20.5z"/><path d="m13.8 6.4 3.8 3.8"/>',
  'copy': '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 5.5v-1a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1"/>',
  'save': '<path d="M19 20.5H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h11l5 5v10a2 2 0 0 1-2 2z"/><path d="M16.5 20.5v-7h-9v7M7.5 3.5v5h7"/>',
  'external-link': '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18.5 14v5.5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19.5V8a1.5 1.5 0 0 1 1.5-1.5H11"/>',
  'clipboard-copy': '<path d="M9 4.5h6M8 6.5H6.5A1.5 1.5 0 0 0 5 8v11.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5H16"/><rect x="8" y="3" width="8" height="3.5" rx="1"/>',

  /* 视图模式 */
  'code': '<path d="m9 17-5-5 5-5M15 7l5 5-5 5"/>',
  'columns': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  'eye': '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'split-bottom': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  'maximize': '<path d="M15 3.5h5.5V9M20.5 3.5 13 11M9 20.5H3.5V15M3.5 20.5 11 13"/>',

  /* 主题 / 设置 */
  'sun': '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M2.5 12h2M19.5 12h2M4.9 19.1l1.5-1.5M17.6 6.4l1.5-1.5"/>',
  'moon': '<path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z"/>',
  'settings': '<circle cx="12" cy="12" r="3"/><path d="M19.5 14.5a1.7 1.7 0 0 0 .4 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.4 1.7 1.7 0 0 0-1 1.5v.3a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .4-1.9 1.7 1.7 0 0 0-1.5-1H2.6a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.4h.1a1.7 1.7 0 0 0 1-1.5V2.6a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.4l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.4 1.9v.1a1.7 1.7 0 0 0 1.5 1h.3a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"/>',
  'palette': '<path d="M12 3a9 9 0 0 0 0 18 2 2 0 0 0 1.7-3 2 2 0 0 1 1.7-3H18a3.5 3.5 0 0 0 3.5-3.5C21.5 6.5 17.3 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="11" cy="7.5" r="1.2"/><circle cx="16" cy="9.5" r="1.2"/>',

  /* 状态 */
  'check': '<path d="M20 6.5 9.5 17 4 11.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.8-5"/>',
  'alert-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  'alert-triangle': '<path d="M10.3 4 2.5 17.4A2 2 0 0 0 4.2 20.4h15.6a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  'info': '<circle cx="12" cy="12" r="9"/><path d="M12 16.5V11M12 8h.01"/>',

  /* 命令面板 */
  'command': '<path d="M15 6.5A2.5 2.5 0 1 1 17.5 9H15zM9 6.5A2.5 2.5 0 1 0 6.5 9H9zM15 17.5a2.5 2.5 0 1 0 2.5-2.5H15zM9 17.5A2.5 2.5 0 1 1 6.5 15H9z"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  'keyboard': '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8"/>',
};

const Icons = {
  /** 生成 SVG 字符串 */
  svg(name, cls = 'icon') {
    const inner = ICONS[name];
    if (!inner) return '';
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
           `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  },

  /** 生成 SVG DOM 节点 */
  el(name, cls = 'icon') {
    const wrap = document.createElement('span');
    wrap.className = 'icon-wrap';
    wrap.style.display = 'contents';
    wrap.innerHTML = this.svg(name, cls);
    return wrap.firstElementChild || document.createTextNode('');
  },

  /** 把容器内所有 [data-icon] 占位元素替换成图标 */
  hydrate(root = document) {
    root.querySelectorAll('[data-icon]').forEach((node) => {
      const svg = this.svg(node.dataset.icon, node.dataset.iconClass || 'icon');
      if (svg) node.innerHTML = svg;
    });
  },
};
