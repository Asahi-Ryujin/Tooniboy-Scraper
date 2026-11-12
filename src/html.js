const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', bull: '•',
  middot: '·', laquo: '«', raquo: '»', times: '×', nbsp: ' '
};

export function decodeEntities(value = '') {
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);?/gi, (whole, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === '#') {
      const hex = key[1] === 'x';
      const number = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(number) || number < 0 || number > 0x10ffff) return '\uFFFD';
      try { return String.fromCodePoint(number); } catch { return '\uFFFD'; }
    }
    return ENTITY_MAP[key] ?? whole;
  });
}

function findTagEnd(source, start) {
  let quote = '';
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
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

function parseAttributes(input) {
  const attrs = Object.create(null);
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s|\//.test(input[i])) i++;
    if (i >= input.length) break;
    const start = i;
    while (i < input.length && !/[\s=/>]/.test(input[i])) i++;
    if (start === i) { i++; continue; }
    const name = input.slice(start, i).toLowerCase();
    while (i < input.length && /\s/.test(input[i])) i++;
    let value = '';
    if (input[i] === '=') {
      i++;
      while (i < input.length && /\s/.test(input[i])) i++;
      if (input[i] === '"' || input[i] === "'") {
        const quote = input[i++];
        const valueStart = i;
        while (i < input.length && input[i] !== quote) i++;
        value = input.slice(valueStart, i);
        if (input[i] === quote) i++;
      } else {
        const valueStart = i;
        while (i < input.length && !/[\s>]/.test(input[i])) i++;
        value = input.slice(valueStart, i);
      }
    }
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function addText(parent, value) {
  if (!value) return;
  parent.children.push({ type: 'text', value, parent });
}

export function parseHTML(source) {
  const html = String(source || '');
  const lower = html.toLowerCase();
  const root = { type: 'element', tag: '#document', attrs: Object.create(null), children: [], parent: null };
  const stack = [root];
  let i = 0;

  while (i < html.length) {
    const parent = stack[stack.length - 1];
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      addText(parent, html.slice(i, next < 0 ? html.length : next));
      i = next < 0 ? html.length : next;
      continue;
    }
    if (/^<!|^<\?/.test(html.slice(i, i + 2))) {
      const end = findTagEnd(html, i + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const end = findTagEnd(html, i + 1);
    if (end < 0) {
      addText(parent, html.slice(i));
      break;
    }
    const raw = html.slice(i + 1, end);
    const closeMatch = raw.match(/^\s*\/\s*([a-z][\w:-]*)/i);
    if (closeMatch) {
      const tag = closeMatch[1].toLowerCase();
      for (let p = stack.length - 1; p > 0; p--) {
        if (stack[p].tag === tag) {
          stack.length = p;
          break;
        }
      }
      i = end + 1;
      continue;
    }
    const openMatch = raw.match(/^\s*([a-z][\w:-]*)/i);
    if (!openMatch) {
      addText(parent, '<');
      i++;
      continue;
    }
    const tag = openMatch[1].toLowerCase();
    const attrText = raw.slice(openMatch[0].length).replace(/\/\s*$/, '');
    const node = { type: 'element', tag, attrs: parseAttributes(attrText), children: [], parent };
    parent.children.push(node);
    const selfClosing = /\/\s*$/.test(raw) || VOID_TAGS.has(tag);
    i = end + 1;
    if (!selfClosing) {
      stack.push(node);
      if (RAW_TAGS.has(tag)) {
        const closeAt = lower.indexOf(`</${tag}`, i);
        if (closeAt < 0) {
          addText(node, html.slice(i));
          i = html.length;
        } else {
          addText(node, html.slice(i, closeAt));
          i = closeAt;
        }
      }
    }
  }
  return root;
}

export function getAttr(node, name) {
  return node?.attrs?.[String(name).toLowerCase()] ?? '';
}

export function getText(node) {
  if (!node) return '';
  if (node.type === 'text') return decodeEntities(node.value);
  return (node.children || []).map(getText).join('');
}

export function cleanText(value = '') {
  return decodeEntities(String(value)).replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function textOf(node) {
  return cleanText(getText(node));
}

export function classes(node) {
  return String(getAttr(node, 'class') || '').split(/\s+/).filter(Boolean);
}

export function hasClass(node, className) {
  return classes(node).includes(className);
}

export function allElements(root, predicate = () => true) {
  const out = [];
  const visit = node => {
    for (const child of node?.children || []) {
      if (child.type === 'element') {
        if (predicate(child)) out.push(child);
        visit(child);
      }
    }
  };
  visit(root);
  return out;
}

export function firstElement(root, predicate = () => true) {
  const stack = [...(root?.children || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.type !== 'element') continue;
    if (predicate(node)) return node;
    for (let i = node.children.length - 1; i >= 0; i--) {
      if (node.children[i].type === 'element') stack.push(node.children[i]);
    }
  }
  return null;
}

export function directChildren(root, tag) {
  return (root?.children || []).filter(x => x.type === 'element' && (!tag || x.tag === tag.toLowerCase()));
}

export function byTag(root, tag) {
  const wanted = String(tag).toLowerCase();
  return allElements(root, node => node.tag === wanted);
}

export function byClass(root, className, tag = '') {
  const wanted = String(tag).toLowerCase();
  return allElements(root, node => (!wanted || node.tag === wanted) && hasClass(node, className));
}

export function byId(root, id) {
  return firstElement(root, node => getAttr(node, 'id') === id);
}

export function closest(node, predicate) {
  let current = node;
  while (current) {
    if (current.type === 'element' && predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

export function attrRecords(root, selectorPredicate) {
  return allElements(root, selectorPredicate);
}

export function getMeta(root, key, attrName = 'property') {
  const node = firstElement(root, el => el.tag === 'meta' && getAttr(el, attrName).toLowerCase() === key.toLowerCase());
  return getAttr(node, 'content');
}

export function getHrefRecords(root, predicate = () => true, baseUrl = '') {
  return allElements(root, node => node.tag === 'a' && getAttr(node, 'href') && predicate(node)).map(a => ({
    text: textOf(a), href: getAttr(a, 'href'), url: absoluteUrl(getAttr(a, 'href'), baseUrl)
  }));
}

export function absoluteUrl(raw, baseUrl) {
  const value = cleanText(raw || '');
  if (!value || /^(?:javascript:|data:|blob:|mailto:|tel:|about:|#)/i.test(value)) return '';
  try {
    const u = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    return u.href;
  } catch {
    return '';
  }
}

export function mediaUrl(node, baseUrl) {
  if (!node) return '';
  for (const key of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-url', 'poster', 'data-lazy-srcset']) {
    const raw = getAttr(node, key);
    if (raw) {
      if (key.includes('srcset')) {
        const candidates = raw.split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
        const resolved = candidates.map(x => absoluteUrl(x, baseUrl)).filter(Boolean);
        if (resolved.length) return resolved[resolved.length - 1];
      } else {
        const resolved = absoluteUrl(raw, baseUrl);
        if (resolved) return resolved;
      }
    }
  }
  const srcset = getAttr(node, 'srcset');
  if (srcset) {
    const candidates = srcset.split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
    const resolved = candidates.map(x => absoluteUrl(x, baseUrl)).filter(Boolean);
    if (resolved.length) return resolved[resolved.length - 1];
  }
  const style = getAttr(node, 'style');
  const match = style.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
  return match ? absoluteUrl(match[1], baseUrl) : '';
}

export function linksFrom(root, predicate, baseUrl) {
  return allElements(root, node => node.tag === 'a' && getAttr(node, 'href') && predicate(node)).map(node => ({
    name: textOf(node), text: textOf(node), href: getAttr(node, 'href'), url: absoluteUrl(getAttr(node, 'href'), baseUrl)
  })).filter(x => x.url);
}
