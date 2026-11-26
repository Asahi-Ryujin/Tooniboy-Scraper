import {
  parseHTML, getAttr, textOf, cleanText, allElements, firstElement,
  directChildren, hasClass, byId, mediaUrl, absoluteUrl, getMeta, linksFrom
} from './html.js';

const cleanPath = value => String(value || '').replace(/\s+/g, '').replace(/\/+$/, '') || '/';
const text = node => textOf(node);
const hasAnyClass = (node, names) => names.some(name => hasClass(node, name));
const isTag = (node, tag) => node?.type === 'element' && node.tag === tag;
const direct = (node, tag, predicate = () => true) => directChildren(node, tag).filter(predicate);
const first = (node, predicate) => firstElement(node, predicate);
const all = (node, predicate) => allElements(node, predicate);
const findClass = (node, cls, tag = '') => first(node, el => (!tag || el.tag === tag) && hasClass(el, cls));
const findAllClass = (node, cls, tag = '') => all(node, el => (!tag || el.tag === tag) && hasClass(el, cls));

function categoryFromHref(label, href, baseUrl, group = 'other', source = 'navigation') {
  let path = '';
  try {
    const parsed = new URL(String(href || ''), baseUrl);
    if (parsed.origin !== new URL(baseUrl).origin) return null;
    path = parsed.pathname;
  } catch { return null; }
  const match = path.match(/^\/category\/(.+?)\/?$/i);
  if (!match) return null;
  const slug = match[1].replace(/^\/+|\/+$/g, '');
  if (!slug) return null;
  return { name: cleanText(label) || slug.replace(/[-&]+/g, ' '), slug, path: `/category/${slug}/`, group };
}

export function parseGenres(html, url) {
  const doc = parseHTML(html);
  const categories = new Map();
  const groupForLabel = label => /network/i.test(label) ? 'networks'
    : /language|audio|dub/i.test(label) ? 'language'
      : /genre|genres/i.test(label) ? 'genre' : 'primary';

  // Prefer the known top navigation, but do not require its original .menu
  // class. A top-level UL with nested LI/UL groups carries the same semantics.
  const topLists = all(doc, el => el.tag === 'ul' && !isTag(el.parent, 'li'));
  for (const list of topLists) {
    for (const li of direct(list, 'li')) {
      const anchors = direct(li, 'a');
      const parentAnchor = anchors[0];
      const sub = direct(li, 'ul')[0] || null;
      const groupName = text(parentAnchor) || text(first(li, el => el.tag === 'span')) || '';
      const groupKey = groupForLabel(groupName);
      if (parentAnchor) {
        const record = categoryFromHref(text(parentAnchor), getAttr(parentAnchor, 'href'), url, groupKey);
        if (record) categories.set(record.slug.toLowerCase(), record);
      }
      if (sub) {
        for (const child of direct(sub, 'li')) {
          const a = direct(child, 'a')[0];
          if (!a) continue;
          const record = categoryFromHref(text(a), getAttr(a, 'href'), url, groupKey);
          if (record) categories.set(record.slug.toLowerCase(), record);
        }
      }
    }
  }

  // Detail-page and classless-navigation fallback. Infer a group from the
  // nearest short semantic container, then from taxonomy path prefixes.
  for (const a of all(doc, el => el.tag === 'a' && /\/category\//i.test(getAttr(el, 'href')))) {
    let group = 'detail-genre';
    const href = getAttr(a, 'href');
    if (/\/category\/language\//i.test(href)) group = 'language';
    else {
      let parent = a.parent;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parent) {
        const label = `${getAttr(parent, 'aria-label')} ${getAttr(parent, 'id')} ${getAttr(parent, 'role')} ${text(parent).slice(0, 180)}`;
        if (/network/i.test(label)) { group = 'networks'; break; }
        if (/language|audio|dub/i.test(label)) { group = 'language'; break; }
        if (/genres?/i.test(label)) { group = 'genre'; break; }
      }
    }
    const record = categoryFromHref(text(a), href, url, group, 'page-metadata');
    if (record && !categories.has(record.slug.toLowerCase())) categories.set(record.slug.toLowerCase(), record);
  }
  const items = [...categories.values()];
  const groups = {};
  for (const item of items) (groups[item.group] ||= []).push(item);
  return { count: items.length, groups };
}

function parseImage(node, baseUrl) {
  return mediaUrl(node, baseUrl) || '';
}

function isInternalContentLink(anchor, baseUrl) {
  const href = getAttr(anchor, 'href');
  if (!href) return false;
  try {
    const candidate = new URL(href, baseUrl);
    const base = new URL(baseUrl);
    return candidate.protocol === 'https:' && candidate.origin === base.origin &&
      /^\/(?:series|movies|episode)\//i.test(candidate.pathname);
  } catch { return false; }
}

function parseCard(article, baseUrl, preferredAnchor = null) {
  const anchor = preferredAnchor || (article?.tag === 'a' && isInternalContentLink(article, baseUrl)
    ? article
    : first(article, el => el.tag === 'a' && isInternalContentLink(el, baseUrl) && (
      hasClass(el, 'lnk-blk') || /^\/(?:series|movies|episode)\//i.test(getAttr(el, 'href'))
    )));
  if (!anchor) return null;
  const href = getAttr(anchor, 'href');
  const url = absoluteUrl(href, baseUrl);
  if (!url) return null;
  const titleNode = first(article, el => ['h1','h2','h3','h4','h5','h6'].includes(el.tag) ||
    ['name','headline'].includes(getAttr(el, 'itemprop')) || hasAnyClass(el, ['entry-title','entry-title1','title','name'])) ;
  const image = first(article, el => el.tag === 'img' || el.tag === 'picture') ||
    first(article, el => el.tag === 'source' && (getAttr(el, 'srcset') || getAttr(el, 'data-srcset')));
  const imageNode = image?.tag === 'picture' ? (first(image, el => el.tag === 'img') || first(image, el => el.tag === 'source') || image) : image;
  const title = text(titleNode) || cleanText(getAttr(anchor, 'title') || getAttr(anchor, 'aria-label')) ||
    cleanText(getAttr(imageNode, 'alt')) || text(anchor) || decodeSlug(href);
  const voteNode = first(article, el => hasClass(el, 'vote') || getAttr(el, 'itemprop') === 'ratingValue');
  const voteText = text(voteNode) || getAttr(voteNode, 'content');
  const ratingMatch = voteText.match(/([0-9]+(?:\.[0-9]+)?)/);
  const path = cleanPath(new URL(url).pathname);
  const kind = /\/movies\//i.test(path) ? 'movie' : /\/episode\//i.test(path) ? 'episode' : 'series';
  const number = text(first(article, el => hasAnyClass(el, ['num-epi','episode-number']) || getAttr(el, 'data-episode-number')));
  const episodeTitle = text(first(article, el => hasAnyClass(el, ['entry-title1','episode-title'])));
  return {
    title, path, url, kind, poster: parseImage(imageNode, baseUrl),
    ...(ratingMatch ? { rating: Number(ratingMatch[1]) } : {}),
    ...(voteText ? { ratingSource: /TMDB/i.test(voteText) ? 'TMDB' : 'unknown' } : {}),
    ...(number ? { number } : {}), ...(episodeTitle ? { episodeTitle } : {})
  };
}

function nearestCardContainer(anchor) {
  let current = anchor;
  let best = anchor;
  let depth = 0;
  while (current?.parent && current.parent.tag !== '#document' && depth < 8) {
    current = current.parent;
    depth++;
    if (['article','li'].includes(current.tag)) return current;
    if (['div','figure','section'].includes(current.tag)) {
      const hasVisual = !!first(current, el => el.tag === 'img' || el.tag === 'picture');
      const hasHeading = !!first(current, el => /^h[1-6]$/.test(el.tag));
      const txt = text(current);
      if ((hasVisual || hasHeading) && txt.length < 2400) best = current;
    }
    if (current.tag === 'main' || current.tag === 'body') break;
  }
  return best;
}

function parseCards(root, baseUrl, mode = 'content') {
  const out = [];
  const seen = new Set();
  const add = item => {
    if (!item || seen.has(item.url)) return;
    if (mode === 'episode' && item.kind !== 'episode') return;
    if (mode === 'content' && item.kind === 'episode') return;
    seen.add(item.url);
    out.push(item);
  };
  // First pass: established source-specific structure. These selectors remain
  // useful when the upstream markup is unchanged.
  for (const article of all(root, el => el.tag === 'article' && hasClass(el, 'post'))) {
    if (mode === 'episode' && !hasClass(article, 'episodes')) continue;
    if (mode === 'content' && !hasAnyClass(article, ['movies', 'episodes', 'series'])) continue;
    add(parseCard(article, baseUrl));
  }
  // Second pass: semantic URL structure. This deliberately does not depend on
  // CSS class names, generated class hashes, or visual layout wrappers.
  for (const anchor of all(root, el => el.tag === 'a' && isInternalContentLink(el, baseUrl))) {
    add(parseCard(nearestCardContainer(anchor), baseUrl, anchor));
  }
  return out;
}

function parsePagination(doc, baseUrl) {
  const nav = first(doc, el => (el.tag === 'nav' || el.tag === 'div' || el.tag === 'ul') &&
    (hasClass(el, 'pagination') || /pagination|pager/i.test(`${getAttr(el, 'aria-label')} ${getAttr(el, 'role')} ${getAttr(el, 'id')}`)));
  const scope = nav || doc;
  const links = all(scope, el => el.tag === 'a' && getAttr(el, 'href')).map(a => {
    const href = getAttr(a, 'href');
    let page = null;
    try { page = Number(new URL(href, baseUrl).searchParams.get('page') || getAttr(a, 'data-page') || 0) || null; } catch {}
    return { label: text(a) || getAttr(a, 'aria-label'), page, rel: getAttr(a, 'rel') };
  }).filter(x => x.page);
  const numericPages = links.map(x => x.page);
  const next = links.find(x => /^(?:next|›|»|>|next page)$/i.test(x.label) || /next/i.test(x.rel));
  const previous = links.find(x => /^(?:previous|prev|‹|«|<|previous page)$/i.test(x.label) || /prev/i.test(x.rel));
  const current = Number(new URL(baseUrl).searchParams.get('page') || 1);
  return {
    currentPage: current, maxPage: numericPages.length ? Math.max(...numericPages) : null,
    nextPage: next?.page || null, previousPage: previous?.page || null,
    pages: links.map(({label,page}) => ({label,page}))
  };
}

export function parseListing(html, url, options = {}) {
  const doc = parseHTML(html);
  const articles = parseCards(doc, url, 'content');
  const pagination = parsePagination(doc, url);
  const heading = first(doc, el => (el.tag === 'h1' || el.tag === 'h2') && !hasClass(el, 'entry-title'));
  const type = options.type || new URL(url).searchParams.get('type') || 'all';
  return {
    title: text(heading) || null,
    category: options.category || (new URL(url).pathname.match(/^\/category\/(.+?)\/?$/)?.[1] || null),
    type, page: pagination.currentPage || Number(new URL(url).searchParams.get('page') || 1),
    count: articles.length, items: articles, pagination
  };
}

export function parseHome(html, url) {
  const doc = parseHTML(html);
  const sections = [];
  const seenSections = new Set();
  const addSection = (section, heading) => {
    const title = text(heading);
    if (!title) return;
    const items = parseCards(section, url, /episode/i.test(title) ? 'episode' : 'content');
    if (!items.length) return;
    const key = `${title.toLowerCase()}|${items.map(x => x.path).join('|')}`;
    if (seenSections.has(key)) return;
    seenSections.add(key);
    const type = /episode/i.test(title) ? 'episodes' : /series/i.test(title) ? 'series' : /movie/i.test(title) ? 'movies' : 'other';
    const more = first(section, el => el.tag === 'a' && /view more|see all|more/i.test(text(el)) && getAttr(el, 'href'));
    let morePath = null;
    if (more) {
      try {
        const candidate = new URL(getAttr(more, 'href'), url);
        if (candidate.origin === new URL(url).origin) morePath = cleanPath(candidate.pathname);
      } catch { /* omit malformed navigation */ }
    }
    sections.push({ title, type, count: items.length, items, ...(morePath ? { morePath } : {}) });
  };
  // Known source structure.
  for (const section of all(doc, el => el.tag === 'section' && hasAnyClass(el, ['widget_list_episodes', 'widget_list_movies_series']))) {
    const heading = first(section, el => ['h2','h3','h4'].includes(el.tag) && (hasClass(el, 'section-title') || text(el)));
    addSection(section, heading);
  }
  // CSS-independent fallback: inspect semantic section headings even when
  // some known source sections were already found. A redesign can preserve
  // only a subset of the original widget classes.
  for (const section of all(doc, el => el.tag === 'section' || el.tag === 'div')) {
    const heading = first(section, el => ['h2','h3','h4'].includes(el.tag));
    if (heading) addSection(section, heading);
  }
  return {
    title: text(first(doc, el => el.tag === 'h1')) || 'Home',
    sections,
    categories: Object.values(parseGenres(html, url).groups).flat()
  };
}

function decodeSlug(path) {
  try { return decodeURIComponent(String(path).split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' '); }
  catch { return String(path).split('/').filter(Boolean).pop() || ''; }
}

function recordsInClass(root, cls, baseUrl) {
  return all(root, el => el.tag === 'a' && hasClass(el.parent || {}, cls) && getAttr(el, 'href')).map(a => ({
    name: text(a), slug: new URL(absoluteUrl(getAttr(a, 'href'), baseUrl)).pathname.replace(/\/$/, '').split('/').pop(),
    path: new URL(absoluteUrl(getAttr(a, 'href'), baseUrl)).pathname, url: absoluteUrl(getAttr(a, 'href'), baseUrl)
  }));
}

function findLabelValue(root, label) {
  const re = new RegExp(`^${label}\\s*:\\s*`, 'i');
  for (const node of all(root, el => el.tag === 'p' || el.tag === 'div' || el.tag === 'li')) {
    const value = text(node);
    if (re.test(value)) return cleanText(value.replace(re, ''));
  }
  return '';
}

function parseDescription(root) {
  const node = findClass(root, 'description') || first(root, el =>
    getAttr(el, 'itemprop').toLowerCase() === 'description' ||
    /description|synopsis|overview/i.test(`${getAttr(el, 'aria-label')} ${getAttr(el, 'id')} ${getAttr(el, 'data-section')}`)
  );
  if (!node) return [];
  const out = [];
  const nodes = ['p','div','span'].includes(node.tag) ? [node] : all(node, el => el.tag === 'p' || getAttr(el, 'itemprop').toLowerCase() === 'description');
  for (const candidate of nodes) {
    const value = text(candidate);
    if (value && value.length > 20 && !/^(?:language|quality|running time)\s*:/i.test(value)) out.push(value);
  }
  return [...new Set(out)];
}

function parseCrew(root, baseUrl) {
  const crew = {};
  const castRoot = findClass(root, 'cast-lst') || first(root, el =>
    /cast|crew|staff|people/i.test(`${getAttr(el, 'aria-label')} ${getAttr(el, 'id')} ${text(first(el, child => /^h[1-6]$/.test(child.tag)))}`)
  );
  if (castRoot) {
    for (const li of all(castRoot, el => el.tag === 'li')) {
      const label = directChildren(li, 'span')[0] || first(li, el => el.tag === 'span');
      const key = text(label).toLowerCase();
      if (!key) continue;
      const people = all(li, el => el.tag === 'a' && getAttr(el, 'href')).map(a => ({
        name: text(a), url: absoluteUrl(getAttr(a, 'href'), baseUrl), path: getAttr(a, 'href')
      })).filter(x => x.name);
      if (people.length) crew[key] = people;
    }
  }
  // Schema.org microdata fallback for pages without cast list classes.
  for (const node of all(root, el => ['actor','director','creator','author'].includes(getAttr(el, 'itemprop').toLowerCase()))) {
    const key = getAttr(node, 'itemprop').toLowerCase();
    const name = text(node) || cleanText(getAttr(node, 'content') || getAttr(node, 'name'));
    if (!name) continue;
    const href = getAttr(node, 'href') || getAttr(first(node, el => el.tag === 'a'), 'href');
    const entry = { name, ...(href ? { url: absoluteUrl(href, baseUrl), path: href } : {}) };
    const existing = crew[key] || [];
    if (!existing.some(item => item.name === name)) crew[key] = [...existing, entry];
  }
  return crew;
}

function parseSeasons(doc, baseUrl) {
  const map = new Map();
  for (const node of all(doc, el => (
    (el.tag === 'a' || el.tag === 'button') && (hasClass(el, 'season-btn') || getAttr(el, 'data-url').includes('/season/') || getAttr(el, 'href').includes('/season/'))
  ))) {
    const raw = getAttr(node, 'data-url') || getAttr(node, 'href');
    const match = String(raw).match(/\/season\/(\d+)/i);
    const season = Number(getAttr(node, 'data-season') || match?.[1] || 0);
    if (!season || !raw || map.has(season)) continue;
    const resolved = absoluteUrl(raw, baseUrl);
    map.set(season, { season, label: text(node) || `Season ${season}`, path: new URL(resolved).pathname, url: resolved, episodeCount: 0, hasPreExtracted: false });
  }
  return [...map.values()].sort((a, b) => a.season - b.season);
}

function parseEpisodeCards(doc, baseUrl, itemId = '') {
  let nodes = all(doc, el => el.tag === 'article' && hasClass(el, 'episodes'));
  const map = new Map();
  const addFromAnchor = (anchor, node) => {
    if (!isInternalContentLink(anchor, baseUrl) || !/\/episode\//i.test(getAttr(anchor, 'href'))) return;
    const episodeUrl = absoluteUrl(getAttr(anchor, 'href'), baseUrl);
    if (!episodeUrl) return;
    const number = text(first(node, el => hasAnyClass(el, ['num-epi','entry-title1','episode-number']))) ||
      getAttr(node, 'data-episode') || getAttr(anchor, 'data-episode');
    const match = number.match(/(\d+)\s*x\s*(\d+)/i) || String(getAttr(node, 'data-episode')).match(/(\d+)\s*x\s*(\d+)/i) || [];
    let seasonContainer = node;
    while (seasonContainer && getAttr(seasonContainer, 'id') !== 'episode_by_temp' && !getAttr(seasonContainer, 'data-season')) seasonContainer = seasonContainer.parent;
    const season = Number(getAttr(node, 'data-season') || getAttr(seasonContainer, 'data-season') || match[1] || 1) || 1;
    const episode = Number(getAttr(node, 'data-episode-number') || getAttr(node, 'data-episode') || match[2] || 0) || (map.size + 1);
    const heading = first(node, el => /^h[1-6]$/.test(el.tag) || hasAnyClass(el, ['entry-title1','episode-title','title']));
    const title = text(heading) || cleanText(getAttr(anchor, 'title') || getAttr(anchor, 'aria-label')) || number || `Episode ${episode}`;
    const img = first(node, el => el.tag === 'img' || el.tag === 'picture');
    if (!map.has(episodeUrl)) map.set(episodeUrl, {
      id: new URL(episodeUrl).pathname, itemId, season, episode,
      number: number || `${season}x${episode}`, title,
      url: episodeUrl, poster: parseImage(img, baseUrl)
    });
  };
  for (const node of nodes) {
    const anchor = first(node, el => el.tag === 'a' && isInternalContentLink(el, baseUrl) && /\/episode\//i.test(getAttr(el, 'href')));
    if (anchor) addFromAnchor(anchor, node);
  }
  // CSS-independent fallback for episode anchors wrapped in arbitrary markup.
  for (const anchor of all(doc, el => el.tag === 'a' && isInternalContentLink(el, baseUrl) && /\/episode\//i.test(getAttr(el, 'href')))) {
    addFromAnchor(anchor, nearestCardContainer(anchor));
  }
  return [...map.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function parseStructuredData(doc) {
  const records = [];
  const visit = value => {
    if (!value) return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (typeof value !== 'object') return;
    if (value['@type'] || value.name || value.headline) records.push(value);
    if (value['@graph']) visit(value['@graph']);
    for (const key of ['mainEntity','mainEntityOfPage','itemListElement','subjectOf']) if (value[key]) visit(value[key]);
  };
  for (const script of all(doc, el => el.tag === 'script' && /ld\+json/i.test(getAttr(el, 'type')))) {
    try { visit(JSON.parse((script.children || []).map(x => x.value || '').join(''))); } catch { /* Ignore malformed structured data. */ }
  }
  return records.find(item => {
    const type = [].concat(item['@type'] || []).join(' ').toLowerCase();
    return /movie|series|tvseries|episode|creativework|videoobject/.test(type) || item.name || item.headline;
  }) || records[0] || {};
}

function structuredImage(value, baseUrl) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  for (const row of rows) {
    const raw = typeof row === 'string' ? row : row?.url || row?.contentUrl;
    const resolved = absoluteUrl(raw, baseUrl);
    if (resolved) return resolved;
  }
  return '';
}

function parseMediaCandidates(root, doc, url) {
  const banner = [];
  const poster = [];
  const bannerClasses = ['post-backdrop', 'backdrop', 'post-banner', 'banner', 'cover-image', 'cover', 'post-cover', 'detail-banner'];
  const posterClasses = ['post-thumbnail', 'post-cover', 'cover-image'];
  for (const node of all(root, el => bannerClasses.some(cls => hasClass(el, cls)))) {
    const value = mediaUrl(node, url) || mediaUrl(first(node, el => el.tag === 'img'), url);
    if (value) banner.push(value);
  }
  for (const node of all(doc, el => el.tag === 'meta' && ['og:image', 'twitter:image'].includes(getAttr(el, 'property') || getAttr(el, 'name')))) {
    const value = absoluteUrl(getAttr(node, 'content'), url);
    if (value) banner.push(value);
  }
  for (const node of all(root, el => posterClasses.some(cls => hasClass(el, cls)))) {
    const value = mediaUrl(first(node, el => el.tag === 'img') || node, url);
    if (value) poster.push(value);
  }
  const ld = all(doc, el => el.tag === 'script' && getAttr(el, 'type').includes('ld+json'));
  for (const script of ld) {
    try {
      const parsed = JSON.parse(script.children.map(x => x.value || '').join(''));
      const walk = value => {
        if (!value) return;
        if (Array.isArray(value)) return value.forEach(walk);
        if (typeof value !== 'object') return;
        const image = value.image;
        for (const item of (Array.isArray(image) ? image : image ? [image] : [])) {
          const raw = typeof item === 'string' ? item : item?.url;
          const resolved = absoluteUrl(raw, url);
          if (resolved) banner.push(resolved);
        }
        walk(value['@graph']);
      };
      walk(parsed);
    } catch { /* Ignore malformed JSON-LD. */ }
  }
  const unique = xs => [...new Set(xs.filter(Boolean))];
  return { banner: unique(banner), poster: unique(poster) };
}

function parseRelated(doc, url) {
  return parseCards(doc, url, 'content').filter(item => item.kind !== 'episode');
}

export function parseDetail(html, url, options = {}) {
  const doc = parseHTML(html);
  const root = findClass(doc, 'single', 'article') || doc;
  const structured = parseStructuredData(doc);
  const title = text(findClass(root, 'entry-title')) || text(first(doc, el => el.tag === 'h1')) ||
    cleanText(getMeta(doc, 'og:title')) || cleanText(structured.name || structured.headline) ||
    text(first(doc, el => el.tag === 'title'));
  const path = new URL(url).pathname;
  const kind = options.kind || (/\/movies\//i.test(path) ? 'movie' : /\/episode\//i.test(path) ? 'episode' : 'series');
  const media = parseMediaCandidates(root, doc, url);
  const structuredPoster = structuredImage(structured.image || structured.thumbnailUrl, url);
  const poster = media.poster[0] || mediaUrl(first(root, el => hasAnyClass(el, ['post-thumbnail','poster','cover']) || el.tag === 'img'), url) || structuredPoster || media.banner[0] || '';
  const banner = media.banner.find(x => x !== poster) || media.banner[0] || poster;
  const genreLinks = linksFrom(root, a => hasClass(a.parent, 'genres') || hasClass(a.parent, 'genre') ||
    /\/category\//i.test(getAttr(a, 'href')), url);
  const genres = [...new Map(genreLinks.map(x => {
    const parsed = new URL(x.url);
    return [parsed.pathname, { name: x.name, slug: parsed.pathname.replace(/\/$/, '').split('/').pop(), path: parsed.pathname, url: x.url }];
  })).values()];
  const tags = linksFrom(root, a => hasClass(a.parent, 'tag') || hasClass(a.parent, 'tags') || /\/tag\//i.test(getAttr(a, 'href')), url)
    .map(x => ({ name: x.name, slug: new URL(x.url).pathname.replace(/\/$/, '').split('/').pop(), path: new URL(x.url).pathname, url: x.url }));
  const year = text(findClass(root, 'year')) || String(structured.datePublished || structured.dateCreated || '').slice(0, 4);
  const duration = text(findClass(root, 'duration')) || cleanText(structured.duration || '');
  const ratingNode = findClass(first(root, el => el.tag === 'footer') || root, 'num') || findClass(root, 'vote') ||
    first(doc, el => getAttr(el, 'itemprop') === 'ratingValue');
  const ratingText = text(ratingNode).match(/[0-9]+(?:\.[0-9]+)?/)?.[0] ||
    String(structured.aggregateRating?.ratingValue || structured.ratingValue || '').match(/[0-9]+(?:\.[0-9]+)?/)?.[0] || '';
  const description = parseDescription(root);
  if (!description.length) {
    const fallbackDescription = cleanText(getMeta(doc, 'og:description') || getMeta(doc, 'description', 'name') || structured.description || '');
    if (fallbackDescription) description.push(fallbackDescription);
  }
  const language = findLabelValue(root, 'Language') || cleanText(structured.inLanguage || '');
  const quality = findLabelValue(root, 'Quality');
  const runningTime = findLabelValue(root, 'Running time');
  const crew = parseCrew(root, url);
  const seasons = parseSeasons(doc, url);
  const episodes = parseEpisodeCards(doc, url, path);
  for (const season of seasons) {
    const count = episodes.filter(item => item.season === season.season).length;
    season.episodeCount = count;
    season.hasPreExtracted = count > 0;
  }
  if (!seasons.length && episodes.length) {
    const firstSeason = Math.min(...episodes.map(item => item.season));
    seasons.push({ season: firstSeason, label: `Season ${firstSeason}`, path: '', url: '', episodeCount: episodes.filter(x => x.season === firstSeason).length, hasPreExtracted: true });
  }
  const trailerRoot = byId(doc, 'mdl-trailer') || first(doc, el => /trailer/i.test(getAttr(el, 'id')) || /trailer/i.test(getAttr(el, 'aria-label')));
  const trailerFrame = trailerRoot && first(trailerRoot, el => el.tag === 'iframe');
  const relatedItems = parseRelated(doc, url).filter(x => x.url !== url);
  return {
    id: path, path, url, kind, title,
    poster, banner, mediaCandidates: [...new Set([banner, poster, ...media.banner, ...media.poster].filter(Boolean))],
    genres, tags,
    metadata: { year, duration, language, quality, runningTime, rating: ratingText ? Number(ratingText) : null },
    description, crew, seasons, episodes,
    trailerAvailable: Boolean(trailerFrame), related: relatedItems
  };
}

function normalizeServerName(name) {
  return cleanText(name).toLowerCase().replace(/\s+/g, '').replace(/stream/gi, '').replace(/-.*$/g, '').trim();
}

export function normalizeServerConfig(value) {
  const rows = Array.isArray(value) ? value
    : Array.isArray(value?.data) ? value.data
      : Array.isArray(value?.servers) ? value.servers
        : Array.isArray(value?.data?.servers) ? value.data.servers
          : [];
  return rows.map(item => ({
    name: cleanText(item?.name || item?.nickname || ''),
    nickname: cleanText(item?.nickname || item?.name || ''),
    oldUrl: String(item?.oldUrl || item?.oldDomain || item?.host || ''),
    url: String(item?.url || item?.newUrl || item?.domain || ''),
    aliases: Array.isArray(item?.aliases) ? item.aliases.map(String) : [],
    order: Number(item?.order || 999), enabled: item?.enabled !== false,
    key: normalizeServerName(item?.nickname || item?.name || '')
  })).filter(item => item.name || (item.oldUrl && item.url));
}

function applyServerMapping(rawUrl, config) {
  if (!config?.oldUrl || !config?.url) return rawUrl;
  try {
    const old = new URL(config.oldUrl.includes('://') ? config.oldUrl : `https://${config.oldUrl}`);
    const target = new URL(config.url.includes('://') ? config.url : `https://${config.url}`);
    const current = new URL(rawUrl);
    if (target.protocol !== 'https:' || target.username || target.password || !target.hostname) return rawUrl;
    const aliases = [old.hostname, ...config.aliases.map(alias => {
      try { return new URL(alias.includes('://') ? alias : `https://${alias}`).hostname; } catch { return ''; }
    })].filter(Boolean).map(x => x.toLowerCase());
    if (!aliases.includes(current.hostname.toLowerCase())) return rawUrl;
    current.protocol = 'https:';
    current.host = target.host;
    return current.href;
  } catch {
    // Retain legacy exact-string substitution only for a valid HTTPS target.
    try {
      const target = new URL(config.url);
      if (target.protocol === 'https:' && rawUrl.includes(config.oldUrl)) return rawUrl.replace(config.oldUrl, target.origin);
    } catch { /* Ignore invalid mappings. */ }
    return rawUrl;
  }
}

function scriptText(script) {
  return (script.children || []).map(child => child.value || '').join('')
    .replace(/\\\//g, '/')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&');
}

function findScriptPlayerUrls(doc, url) {
  const found = [];
  const seen = new Set();
  const urlKeys = /^(?:src|url|href|embed|embedurl|iframe|iframeurl|file|player|playerurl|video|videosrc|stream|streamurl|link|source|contenturl|dataurl)$/i;

  const add = (value, source = 'player-script-config') => {
    const normalized = String(value || '')
      .replace(/\\\//g, '/')
      .replace(/\\u002f/gi, '/')
      .replace(/\\u0026/gi, '&');
    const resolved = absoluteUrl(normalized, url);
    if (!resolved) return;
    let parsed;
    try { parsed = new URL(resolved); } catch { return; }
    if (parsed.origin === new URL(url).origin || seen.has(resolved)) return;
    seen.add(resolved);
    found.push({ embedUrl: resolved, source });
  };

  const walk = value => {
    if (!value) return;
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && urlKeys.test(key) && /^(?:https?:)?\/\//i.test(child.trim())) add(child);
      else if (child && typeof child === 'object') walk(child);
    }
  };

  const scanText = source => {
    if (!source) return;
    const unescaped = String(source)
      .replace(/\\\//g, '/')
      .replace(/\\u002f/gi, '/')
      .replace(/\\x2f/gi, '/')
      .replace(/\\u003a/gi, ':')
      .replace(/\\x3a/gi, ':')
      .replace(/\\u0026/gi, '&')
      .replace(/&amp;/gi, '&');
    try { walk(JSON.parse(unescaped)); } catch { /* Most script tags are executable JS. */ }

    // Handles common JWPlayer / custom-player config object literals.
    const keyed = /(?:["']?)(?:src|url|embed(?:Url)?|iframe(?:Url)?|file|player(?:Url)?|video(?:Src)?|stream(?:Url)?|link|source)(?:["']?)\s*[:=]\s*["']((?:https?:)?\/\/[^"'\\\s<>]+)["']/gi;
    let match;
    while ((match = keyed.exec(unescaped))) add(match[1]);

    // Some providers encode the JSON player config or its URL fields with
    // encodeURIComponent before placing it in an inline player bootstrap.
    const encoded = /(?:https?%3a%2f%2f|%2f%2f)[a-z0-9._~%:/?#[\]@!$&'()*+,;=-]{8,}/gi;
    while ((match = encoded.exec(unescaped))) {
      try { add(decodeURIComponent(match[0])); } catch { /* Ignore malformed encoding. */ }
    }

    // Some providers wrap their player JSON in atob(). Decode only bounded
    // literals from scripts already identified as player-related.
    const b64 = /atob\(\s*["']([A-Za-z0-9+/_=-]{20,65536})["']\s*\)/gi;
    while ((match = b64.exec(unescaped))) {
      try {
        const normalized = match[1].replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(normalized);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        try { walk(JSON.parse(decoded)); } catch { scanDecodedText(decoded); }
      } catch { /* Ignore invalid or unsupported base64 payloads. */ }
    }
  };

  const scanDecodedText = decoded => {
    const keyed = /(?:["']?)(?:src|url|embed(?:Url)?|iframe(?:Url)?|file|player(?:Url)?|video(?:Src)?|stream(?:Url)?|link|source)(?:["']?)\s*[:=]\s*["']((?:https?:)?\/\/[^"'\\\s<>]+)["']/gi;
    let match;
    while ((match = keyed.exec(String(decoded).replace(/\\\//g, '/')))) add(match[1]);
  };

  for (const script of all(doc, el => el.tag === 'script')) {
    const source = scriptText(script);
    if (!/(?:player|iframe|embed|stream|video|source|jwplayer|dplayer)/i.test(source)) continue;
    scanText(source);
  }
  return found;
}

function inTrailer(node) {
  let current = node;
  while (current) {
    if (/trailer/i.test(`${getAttr(current, 'id')} ${getAttr(current, 'class')} ${getAttr(current, 'aria-label')}`)) return true;
    current = current.parent;
  }
  return false;
}

function parsePlayerServers(doc, url, configs = []) {
  const serverLabels = new Map();
  const buttons = all(doc, el => el.tag === 'a' && getAttr(el, 'href').startsWith('#options-'));
  for (const button of buttons) {
    const target = getAttr(button, 'href').slice(1);
    const serverSpan = first(button, el => hasClass(el, 'server'));
    const label = text(serverSpan) || text(button).replace(/server\s*\d+/i, '').trim();
    const numberText = text(first(button, el => el.tag === 'span' && /^\d+$/.test(text(el)))) || text(button).match(/server\s*(\d+)/i)?.[1] || '';
    serverLabels.set(target, { name: label || `Server ${serverLabels.size + 1}`, number: Number(numberText) || serverLabels.size + 1 });
  }
  const out = [];
  const seen = new Set();
  const add = (rawUrl, meta = {}) => {
    if (!rawUrl) return;
    let candidate = rawUrl;
    const rawName = meta.name || `Server ${out.length + 1}`;
    const original = candidate;
    const originalHost = (() => { try { return new URL(original).hostname.toLowerCase(); } catch { return ''; } })();
    const matched = configs.find(config => {
      if (config.key && config.key === normalizeServerName(rawName)) return true;
      const oldHost = (() => { try { return new URL(config.oldUrl.includes('://') ? config.oldUrl : `https://${config.oldUrl}`).hostname.toLowerCase(); } catch { return ''; } })();
      const aliasHosts = (config.aliases || []).map(alias => { try { return new URL(alias.includes('://') ? alias : `https://${alias}`).hostname.toLowerCase(); } catch { return ''; } });
      return Boolean(originalHost && (originalHost === oldHost || aliasHosts.includes(originalHost)));
    });
    candidate = applyServerMapping(candidate, matched);
    let parsed;
    try { parsed = new URL(candidate); } catch { return; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return;
    if (parsed.origin === new URL(url).origin || seen.has(parsed.href)) return;
    seen.add(parsed.href);
    out.push({
      number: meta.number || out.length + 1,
      playerId: meta.playerId || null,
      name: matched?.nickname || rawName,
      embedUrl: parsed.href,
      originalEmbedUrl: rawUrl,
      enabled: matched ? matched.enabled : null,
      order: matched?.order ?? out.length + 1,
      source: meta.source || 'player-iframe'
    });
  };

  const playerRoot = byId(doc, 'aa-options') || findClass(doc, 'video-player') || findClass(doc, 'player');
  const candidates = all(doc, el => ['iframe','video','embed','object'].includes(el.tag) && !inTrailer(el));
  for (const node of candidates) {
    const raw = mediaUrl(node, url) || (['video','object'].includes(node.tag) ? mediaUrl(first(node, el => el.tag === 'source'), url) : '') || getAttr(node, 'data') || '';
    if (!raw) continue;
    let current = node;
    let insidePlayer = Boolean(playerRoot);
    while (!insidePlayer && current) {
      if (/player|video|stream|server|embed/i.test(`${getAttr(current, 'id')} ${getAttr(current, 'class')} ${getAttr(current, 'data-player')}`)) insidePlayer = true;
      current = current.parent;
    }
    // All non-trailer iframe/video elements are useful fallback candidates if
    // the source removes or renames its wrapper classes.
    if (!insidePlayer && !['iframe','video','embed','object'].includes(node.tag)) continue;
    let slot = node;
    while (slot.parent && !['div','section','li','article'].includes(slot.parent.tag)) slot = slot.parent;
    const slotId = getAttr(slot, 'id') || getAttr(node.parent, 'id') || '';
    const label = serverLabels.get(slotId) || serverLabels.get(`options-${getAttr(slot, 'data-index')}`) || {};
    add(absoluteUrl(raw, url), {
      name: label.name || getAttr(node, 'title') || getAttr(node, 'aria-label'),
      number: label.number,
      playerId: slotId,
      source: 'player-iframe'
    });
  }

  // Player configurations embedded in JSON/JavaScript survive class and slot
  // changes. Only URL-valued player keys are accepted; arbitrary script URLs
  // are not harvested as media links.
  for (const item of findScriptPlayerUrls(doc, url)) add(item.embedUrl, { source: item.source });

  // Some layouts publish server buttons as external anchors instead of iframes.
  for (const anchor of all(doc, el => el.tag === 'a' && getAttr(el, 'href') &&
    /(?:server|stream|play|watch)/i.test(`${text(el)} ${getAttr(el, 'aria-label')} ${getAttr(el, 'class')}`) && !getAttr(el, 'href').startsWith('#'))) {
    const href = absoluteUrl(getAttr(anchor, 'href'), url);
    if (href && new URL(href).origin !== new URL(url).origin) add(href, { name: text(anchor), source: 'player-link-fallback' });
  }
  return out.sort((a, b) => a.order - b.order || a.number - b.number);
}

function closestPlayer(node) {
  let current = node;
  while (current) {
    if (hasClass(current, 'player') || hasClass(current, 'video-player')) return true;
    current = current.parent;
  }
  return false;
}

function parseDownloadLinks(doc, url) {
  const rows = all(doc, el => ['div','li','article','section'].includes(el.tag) &&
    (hasAnyClass(el, ['link-row','download-row','download-item','download-link']) || /download/i.test(`${getAttr(el, 'id')} ${getAttr(el, 'aria-label')}`)));
  const result = [];
  const seen = new Set();
  const add = (anchor, container, index) => {
    const raw = getAttr(anchor, 'href') || mediaUrl(anchor, url);
    const resolved = absoluteUrl(raw, url);
    if (!resolved || new URL(resolved).origin === new URL(url).origin || seen.has(resolved)) return;
    const label = text(anchor) || cleanText(getAttr(anchor, 'aria-label') || getAttr(anchor, 'title')) || 'Download';
    const context = text(container || anchor.parent || anchor);
    const tags = findAllClass(container || anchor.parent || anchor, 'tag1').map(text).filter(Boolean);
    const tokens = [...tags, context].join(' ');
    const server = text(first(container || anchor.parent || anchor, el => hasAnyClass(el, ['server-name','server','provider']))) || `Download ${index + 1}`;
    result.push({
      number: result.length + 1, server, label, url: resolved, tags,
      quality: tokens.match(/(?:\d{3,4}p|4k|uhd|fhd|hd)/i)?.[0] || null,
      language: tokens.match(/multi|hindi|tamil|telugu|english|japanese|audio/i)?.[0] || null,
      discoverySource: 'download-dom'
    });
    seen.add(resolved);
  };
  for (const row of rows) {
    for (const anchor of all(row, el => el.tag === 'a' && getAttr(el, 'href'))) {
      if (/download|\b\d{3,4}p\b|4k|\bhd\b|fhd/i.test(`${text(anchor)} ${getAttr(anchor, 'class')} ${getAttr(anchor, 'aria-label')}`)) add(anchor, row, result.length);
    }
  }
  // Semantic fallback: download-labelled links work even after modal/row CSS
  // classes are renamed or the source removes its modal wrapper entirely.
  for (const anchor of all(doc, el => el.tag === 'a' && getAttr(el, 'href') &&
    /download|\b\d{3,4}p\b|4k|\bhd\b|fhd/i.test(`${text(el)} ${getAttr(el, 'class')} ${getAttr(el, 'aria-label')} ${getAttr(el, 'download')}`))) {
    add(anchor, nearestCardContainer(anchor), result.length);
  }
  return result;
}


function parseEpisodeNavigation(doc, url) {
  const seriesAnchor = all(doc, el => el.tag === 'a' && /\/series\//i.test(getAttr(el, 'href')) && /season|series|episodes/i.test(text(el)))[0]
    || all(doc, el => el.tag === 'a' && /\/series\//i.test(getAttr(el, 'href')))[0];
  const nav = findClass(doc, 'epsdsnv') || first(doc, el => el.tag === 'nav' && /episode|navigation/i.test(`${getAttr(el, 'aria-label')} ${getAttr(el, 'class')}`));
  const scope = nav || doc;
  const navEpisodes = all(scope, el => el.tag === 'a' && isInternalContentLink(el, url) && /\/episode\//i.test(getAttr(el, 'href')))
    .map(a => new URL(getAttr(a, 'href'), url).pathname)
    .filter((path, index, values) => values.indexOf(path) === index);
  const previousLink = first(scope, el => el.tag === 'a' && /prev/i.test(`${getAttr(el, 'rel')} ${getAttr(el, 'aria-label')} ${getAttr(el, 'class')}`));
  const nextLink = first(scope, el => el.tag === 'a' && /next/i.test(`${getAttr(el, 'rel')} ${getAttr(el, 'aria-label')} ${getAttr(el, 'class')}`));
  const previous = previousLink ? new URL(getAttr(previousLink, 'href'), url).pathname : navEpisodes[0] || null;
  const next = nextLink ? new URL(getAttr(nextLink, 'href'), url).pathname : navEpisodes[1] || null;
  return {
    seriesUrl: seriesAnchor ? absoluteUrl(getAttr(seriesAnchor, 'href'), url) : null,
    navigation: { previousEpisodeUrl: previous, nextEpisodeUrl: next }
  };
}

export function parseEpisode(html, url, serverConfigs = []) {
  const doc = parseHTML(html);
  const detail = parseDetail(html, url, { kind: 'episode' });
  const titleNode = findClass(findClass(doc, 'single', 'article') || doc, 'entry-title') || first(doc, el => el.tag === 'h1');
  const pageHeading = text(titleNode) || detail.title;
  const numberMatch = pageHeading.match(/(\d+)\s*x\s*(\d+)/i) || new URL(url).pathname.match(/-(\d+)x(\d+)\/?$/i) || [];
  const season = Number(numberMatch[1] || 0) || 0;
  const episode = Number(numberMatch[2] || 0) || 0;
  const title = cleanText(pageHeading.replace(/\s+\d+\s*x\s*\d+\s*$/i, '')) || detail.title;
  const { seriesUrl, navigation } = parseEpisodeNavigation(doc, url);
  const { seasons: _seasons, episodes: _episodes, ...episodeDetail } = detail;
  const playerServers = parsePlayerServers(doc, url, serverConfigs);
  const downloads = parseDownloadLinks(doc, url);
  return {
    ...episodeDetail, kind: 'episode', title, season, episode,
    number: season && episode ? `${season}x${episode}` : null,
    seriesUrl, navigation, playerServers, downloads,
    streamCount: playerServers.length, downloadCount: downloads.length
  };
}

export function parseMovie(html, url, serverConfigs = []) {
  const doc = parseHTML(html);
  const detail = parseDetail(html, url, { kind: 'movie' });
  const { seasons: _seasons, episodes: _episodes, ...movieDetail } = detail;
  const playerServers = parsePlayerServers(doc, url, serverConfigs);
  const downloads = parseDownloadLinks(doc, url);
  return {
    ...movieDetail, kind: 'movie', playerServers, downloads,
    streamCount: playerServers.length, downloadCount: downloads.length
  };
}

export function parseSeason(html, url, itemId, seasonNumber) {
  const doc = parseHTML(html);
  const season = Number(seasonNumber) || 1;
  const items = parseEpisodeCards(doc, url, itemId).map(item => ({ ...item, season }));
  if (!items.length) {
    const fallback = all(doc, el => el.tag === 'a' && /\/episode\//i.test(getAttr(el, 'href')));
    for (const anchor of fallback) {
      const card = anchor.parent || anchor;
      const episodeUrl = absoluteUrl(getAttr(anchor, 'href'), url);
      const number = text(first(card, el => hasClass(el, 'num-epi') || el.tag === 'h5' || el.tag === 'h4'));
      const match = number.match(/(\d+)\s*x\s*(\d+)/i) || [];
      const episode = Number(match[2] || 0);
      if (!episodeUrl || !episode) continue;
      items.push({ id: new URL(episodeUrl).pathname, itemId, season, episode, number: number || `${season}x${episode}`, title: text(first(card, el => hasClass(el, 'entry-title1'))) || number || `Episode ${episode}`, url: episodeUrl, poster: parseImage(first(card, el => el.tag === 'img'), url) });
    }
  }
  const unique = [...new Map(items.map(item => [item.url, item])).values()].sort((a, b) => a.episode - b.episode);
  return { itemId, season, url, count: unique.length, episodes: unique };
}



export function parseServerConfigJson(value) {
  return normalizeServerConfig(value);
}
