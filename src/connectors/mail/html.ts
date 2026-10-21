/**
 * Small, tolerant HTML utilities (no dependencies): entity decoding,
 * HTML → plain text, and a forgiving tree builder with simple queries. Used
 * for email bodies and LMS brief/rubric pages. Not a browser: scripts are
 * dropped, never executed.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  zwnj: '‌', zwj: '‍', shy: '­',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'template', 'noscript']);
const BLOCK = new Set(['p', 'div', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'ul', 'ol', 'hr', 'dd', 'dt']);

export interface HtmlNode {
  tag: string; // '#text' for text nodes, '#root' for the root
  attrs: Record<string, string>;
  children: HtmlNode[];
  text?: string;
  parent?: HtmlNode;
}

/** Forgiving parser: unknown/mismatched end tags are ignored or auto-close open elements. */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [] };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (t: string) => {
    if (t) cur.children.push({ tag: '#text', attrs: {}, children: [], text: decodeEntities(t), parent: cur });
  };
  while ((m = re.exec(html))) {
    pushText(html.slice(last, m.index));
    last = re.lastIndex;
    const full = m[0];
    if (!m[1]) continue; // comment/doctype
    const tag = m[1].toLowerCase();
    if (full.startsWith('</')) {
      let n: HtmlNode | undefined = cur;
      while (n && n.tag !== tag && n.tag !== '#root') n = n.parent;
      if (n && n.tag === tag) cur = n.parent ?? root;
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(m[2] ?? ''))) attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const node: HtmlNode = { tag, attrs, children: [], parent: cur };
    cur.children.push(node);
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, last);
      const stop = end < 0 ? html.length : end;
      node.children.push({ tag: '#text', attrs: {}, children: [], text: html.slice(last, stop), parent: node });
      const close = end < 0 ? html.length : html.indexOf('>', end) + 1;
      last = close;
      re.lastIndex = close;
      continue;
    }
    if (!VOID.has(tag) && m[3] !== '/') cur = node;
  }
  pushText(html.slice(last));
  return root;
}

export function walk(n: HtmlNode, fn: (n: HtmlNode) => void): void {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

export function findAll(n: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode[] {
  const out: HtmlNode[] = [];
  walk(n, (x) => {
    if (x !== n && pred(x)) out.push(x);
  });
  return out;
}

export function findFirst(n: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode | undefined {
  return findAll(n, pred)[0];
}

export const hasClass = (n: HtmlNode, cls: string | RegExp) => {
  const c = (n.attrs.class ?? '').split(/\s+/);
  return typeof cls === 'string' ? c.includes(cls) : c.some((x) => cls.test(x));
};

/** Visible text of a subtree (scripts/styles dropped, block elements become line breaks). */
export function textOf(n: HtmlNode): string {
  const parts: string[] = [];
  const rec = (x: HtmlNode) => {
    if (x.tag === '#text') {
      parts.push(x.text ?? '');
      return;
    }
    if (RAW.has(x.tag) || x.attrs.hidden !== undefined || /display\s*:\s*none/i.test(x.attrs.style ?? '')) return;
    if (BLOCK.has(x.tag)) parts.push('\n');
    if (x.tag === 'td' || x.tag === 'th') parts.push(' ');
    for (const c of x.children) rec(c);
    if (BLOCK.has(x.tag)) parts.push('\n');
  };
  rec(n);
  return parts
    .join('')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** HTML → plain text for email bodies. Hidden elements are dropped. */
export function htmlToText(html: string): string {
  return textOf(parseHtml(html));
}

/** Text inside elements a mail client would not display (hidden attr, display:none, zero size, white-on-white is not detected). */
export function hiddenTextOf(html: string): string {
  const root = parseHtml(html);
  const out: string[] = [];
  const isHidden = (x: HtmlNode) =>
    x.attrs.hidden !== undefined || /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|max-height\s*:\s*0|opacity\s*:\s*0(?![.\d])/i.test(x.attrs.style ?? '');
  walk(root, (x) => {
    if (x.tag !== '#text' && !RAW.has(x.tag) && isHidden(x)) {
      const attrs: Record<string, string> = { ...x.attrs, style: '' };
      delete attrs.hidden;
      const shown: HtmlNode = { ...x, attrs };
      out.push(textOf(shown));
    }
  });
  return out.join('\n').trim();
}
