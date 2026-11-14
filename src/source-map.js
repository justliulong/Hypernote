'use strict';

/* ═══════════════════════════════════════════════════════
   source-map.js — 给预览用的 HTML 标注源码行号

   预览是一个独立文档，它并不知道某个元素来自源码的哪一行。
   这里在把 HTML 交给预览之前，为每个元素的起始标签插入两个属性：

       <div class="card">   →   <div data-notes-line="12" data-notes-end="40" class="card">

   · data-notes-line：起始标签所在行
   · data-notes-end ：对应结束标签所在行（自闭合 / 空元素等于起始行）

   只影响预览流（notes:// 协议），不写回磁盘，也不改动编辑器里的内容。
   注入的属性让预览侧可以把「点击的元素」反查成「源码行号」，
   也能让两侧按同样的行号做滚动同步。
   ═══════════════════════════════════════════════════════ */

// 内容不当作文本解析的元素：遇到它们要直接跳到结束标签
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
// HTML 空元素：没有结束标签
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
// 没有可见盒子的元素，标注了也点不到，反而白白增加预览体积
const NO_ANNOTATE = new Set([
  'head', 'title', 'meta', 'link', 'base', 'style', 'script', 'template', 'noscript',
]);

// sticky 正则：配合 lastIndex 在原串上就地匹配，避免反复 slice
const TAG_RE = /<([a-zA-Z][^\s/>]*)/y;
const END_RE = /<\/([a-zA-Z][^\s/>]*)\s*>/y;

function countLines(html, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) if (html.charCodeAt(i) === 10) n++;
  return n;
}

/** 找到起始标签结尾的 '>'（跳过引号里的 '>'） */
function findTagEnd(html, from) {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * 返回注入了源码行号属性的 HTML。
 * 解析失败或没有标签时原样返回。
 */
function annotateHtml(html) {
  if (typeof html !== 'string' || !html || html.indexOf('<') === -1) return html;

  const inserts = [];          // { startLine, endLine, insertAt }
  const stack = [];            // { name, rec } —— 用于配对结束标签
  const n = html.length;
  let pos = 0;
  let line = 1;

  /** 结束标签 → 回填栈里对应（及被隐式关闭的）元素 */
  const close = (name, endLine) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name !== name) continue;
      stack[i].rec.endLine = endLine;
      // 中间没写结束标签的元素（<p><div> 这类）也一并收尾
      for (let k = stack.length - 1; k > i; k--) {
        if (!stack[k].rec.endLine) stack[k].rec.endLine = endLine;
      }
      stack.length = i;
      return;
    }
  };

  while (pos < n) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) break;
    line += countLines(html, pos, lt);
    pos = lt;
    const c1 = html[lt + 1];

    /* 注释 / DOCTYPE / CDATA：整体跳过 */
    if (c1 === '!') {
      if (html.startsWith('<!--', lt)) {
        let end = html.indexOf('-->', lt + 4);
        end = end < 0 ? n : end + 3;
        line += countLines(html, lt, end);
        pos = end;
        continue;
      }
      if (html.startsWith('<![CDATA[', lt)) {
        let end = html.indexOf(']]>', lt + 9);
        end = end < 0 ? n : end + 3;
        line += countLines(html, lt, end);
        pos = end;
        continue;
      }
      const end = html.indexOf('>', lt + 2);
      const next = end < 0 ? n : end + 1;
      line += countLines(html, lt, next);
      pos = next;
      continue;
    }

    /* 结束标签 */
    if (c1 === '/') {
      END_RE.lastIndex = lt;
      const m = END_RE.exec(html);
      if (!m) { pos = lt + 1; continue; }
      const next = END_RE.lastIndex;
      line += countLines(html, lt, next);
      close(m[1].toLowerCase(), line);
      pos = next;
      continue;
    }

    /* 起始标签 */
    if (c1 && (c1 >= 'a' && c1 <= 'z' || c1 >= 'A' && c1 <= 'Z')) {
      TAG_RE.lastIndex = lt;
      const m = TAG_RE.exec(html);
      if (!m) { pos = lt + 1; continue; }

      const name = m[1].toLowerCase();
      const nameEnd = TAG_RE.lastIndex;
      const tagEnd = findTagEnd(html, nameEnd);
      if (tagEnd < 0) break;               // 标签没闭合，后面都没法定位了

      const startLine = line;
      const selfClosing = html[tagEnd - 1] === '/';
      const rec = {
        startLine,
        endLine: 0,
        insertAt: nameEnd,                 // 属性插在标签名后面
        annotate: !NO_ANNOTATE.has(name),
      };
      if (rec.annotate) inserts.push(rec);

      if (selfClosing || VOID.has(name)) {
        rec.endLine = startLine;
      } else {
        stack.push({ name, rec });
      }

      const next = tagEnd + 1;
      line += countLines(html, lt, next);  // 开始标签本身可能跨行

      /* script / style / textarea：内容不解析，直接找结束标签 */
      if (!selfClosing && RAW_TEXT.has(name)) {
        const closeRe = new RegExp(`</${name}\\s*>`, 'ig');
        closeRe.lastIndex = next;
        const cm = closeRe.exec(html);
        const end = cm ? cm.index + cm[0].length : n;
        line += countLines(html, next, end);
        if (cm) close(name, line);
        pos = end;
        continue;
      }

      pos = next;
      continue;
    }

    pos = lt + 1;
  }

  /* 收尾：没闭合的元素结束在文档最后一行 */
  line += countLines(html, pos, n);
  for (const entry of stack) {
    if (!entry.rec.endLine) entry.rec.endLine = line;
  }

  if (!inserts.length) return html;

  inserts.sort((a, b) => a.insertAt - b.insertAt);
  let out = '';
  let last = 0;
  for (const rec of inserts) {
    if (rec.insertAt < last) continue;
    out += html.slice(last, rec.insertAt);
    out += ` data-notes-line="${rec.startLine}" data-notes-end="${rec.endLine || rec.startLine}"`;
    last = rec.insertAt;
  }
  return out + html.slice(last);
}

module.exports = { annotateHtml };
