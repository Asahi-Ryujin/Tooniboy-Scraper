import {
  parseHTML, getAttr, textOf, cleanText, allElements, firstElement,
  directChildren, hasClass, byId, mediaUrl, absoluteUrl, getMeta, linksFrom
} from './html.js';

const FALLBACK_CATEGORIES = [
  ['Anime', 'anime', 'primary'],
  ['Animation & Cartoon', 'cartoon', 'primary'],
  ['Movies', 'movies', 'primary'],
  ['Networks', 'networks', 'networks'],
  ['Crunchyroll', 'crunchyroll', 'networks'],
  ['ETV Bal Bharti', 'etv-bal-bharti', 'networks'],
  ['Hungama', 'hungama', 'networks'],
  ['NetFlix', 'netflix', 'networks'],
  ['Nickelodean', 'nickelodean', 'networks'],
  ['Cartoon Network', 'cartoon-network', 'networks'],
  ['Kinds Zone Pluse', 'kinds-zone-pluse', 'networks'],
  ['Disney', 'disney', 'networks'],
  ['Sony Yay', 'sony-yay', 'networks'],
  ['Genre', 'gener', 'genre'],
  ['Action', 'action', 'genre'],
  ['Adventure', 'adventure', 'genre'],
  ['Animation', 'animation', 'genre'],
  ['Comedy', 'comedy', 'genre'],
  ['Crime', 'crime', 'genre'],
  ['Drama', 'drama', 'genre'],
  ['Family', 'family', 'genre'],
  ['Fantasy', 'fantasy', 'genre'],
  ['Horror', 'horror', 'genre'],
  ['Kids', 'kids', 'genre'],
  ['Martial ART', 'martial-art', 'genre'],
  ['Mystery', 'mystery', 'genre'],
  ['Romance', 'romance', 'genre'],
  ['Sci-fi', 'sci-fi', 'genre'],
  ['Sci-Fi & Fantasy', 'sci-fi-fantasy', 'genre'],
  ['Sci-Fi & Fantasy', 'sci-fi-&-fantasy', 'detail-genre'],
  ['Superhero', 'superhero', 'genre'],
  ['Thriller', 'thriller', 'genre'],
  ['War', 'war', 'genre'],
  ['Action & Adventure', 'action-&-adventure', 'detail-genre'],
  ['Anime Series', 'anime-series', 'detail-genre'],
  ['Anime Movies', 'anime-movies', 'detail-genre'],
  ['Language', 'language', 'language'],
  ['Hindi', 'language/hindi-language', 'language'],
  ['Tamil', 'language/tamil-language', 'language'],
  ['Telugu', 'language/telugu', 'language'],
  ['Fan Hindi', 'language/fan-hindi', 'language'],
  ['Malyalam', 'language/malyalam', 'language'],
  ['Kannada', 'language/kannada', 'language'],
  ['Bengali', 'language/bengali', 'language'],
  ['Marathi', 'language/marathi', 'language'],
  ['English', 'language/english', 'language'],
  ['Japaneses', 'language/japaneses', 'language'],
  ['Korean', 'language/korean', 'language'],
  ['Chinese', 'language/chinese', 'language'],
  ['Anime Series - Crunchyroll', 'anime-series', 'detail-genre'],
  ['Hindi', 'hindi', 'detail-genre'],
  ['Tamil', 'tamil', 'detail-genre'],
  ['Telugu', 'telugu', 'detail-genre'],
  ['English', 'english', 'detail-genre'],
  ['Japaneses', 'japaneses', 'detail-genre']
];

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
  const path = String(href || '').split(/[?#]/)[0];
  const match = path.match(/^\/category\/(.+?)\/?$/i);
  if (!match) return null;
  const slug = match[1].replace(/^\/+|\/+$/g, '');
  if (!slug) return null;
  return { name: cleanText(label) || slug.replace(/[-&]+/g, ' '), slug, path: `/category/${slug}/`, url: absoluteUrl(href, baseUrl), apiEndpoint: `/api/genre/${slug}`, group, source };
}

export function parseGenres(html, url) {
  const doc = parseHTML(html);
  const categories = new Map();
  const menu = first(doc, el => el.tag === 'ul' && hasClass(el, 'menu'));
  if (menu) {
    for (const li of direct(menu, 'li')) {
      const anchors = direct(li, 'a');
      const parentAnchor = anchors[0];
      const sub = direct(li, 'ul', el => hasClass(el, 'sub-menu'))[0] || null;
      const groupName = text(parentAnchor) || 'primary';
      const groupKey = /genre/i.test(groupName) ? 'genre' : /language/i.test(groupName) ? 'language' : /network/i.test(groupName) ? 'networks' : 'primary';
      if (parentAnchor) {
        const record = categoryFromHref(text(parentAnchor), getAttr(parentAnchor, 'href'), url, sub ? groupKey : 'primary');
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
  // Detail-page captures expose extra taxonomies not present in the top navigation.
  for (const a of all(doc, el => el.tag === 'a' && getAttr(el, 'href').startsWith('/category/'))) {
    const record = categoryFromHref(text(a), getAttr(a, 'href'), url, 'detail-genre', 'page-metadata');
    if (record && !categories.has(record.slug.toLowerCase())) categories.set(record.slug.toLowerCase(), record);
  }
  for (const [name, slug, group] of FALLBACK_CATEGORIES) {
    if (!categories.has(slug.toLowerCase())) {
      categories.set(slug.toLowerCase(), {
        name, slug, path: `/category/${slug}/`, url: absoluteUrl(`/category/${slug}/`, url), apiEndpoint: `/api/genre/${slug}`, group, source: 'captured-navigation-fallback'
      });
    }
  }
  const items = [...categories.values()];
  const groups = {};
  for (const item of items) (groups[item.group] ||= []).push(item);
  return { count: items.length, groups, genres: items, sourceUrl: url };
}

function parseImage(node, baseUrl) {
  return mediaUrl(node, baseUrl) || '';
}

function parseCard(article, baseUrl) {
  const anchor = first(article, el => el.tag === 'a' && getAttr(el, 'href') && (
    hasClass(el, 'lnk-blk') || /\/(?:series|movies)\//i.test(getAttr(el, 'href'))
  ));
  if (!anchor) return null;
  const href = getAttr(anchor, 'href');
  const url = absoluteUrl(href, baseUrl);
  if (!url) return null;
  const titleNode = first(article, el => hasClass(el, 'entry-title') || hasClass(el, 'entry-title1')) || first(article, el => el.tag === 'h2' || el.tag === 'h3' || el.tag === 'h5');
  const title = text(titleNode) || decodeSlug(href);
  const img = first(article, el => el.tag === 'img');
  const voteNode = first(article, el => hasClass(el, 'vote'));
  const voteText = text(voteNode);
  const ratingMatch = voteText.match(/([0-9]+(?:\.[0-9]+)?)/);
  const path = cleanPath(new URL(url).pathname);
  const kind = /\/movies\//i.test(path) ? 'movie' : /\/episode\//i.test(path) ? 'episode' : 'series';
  const number = text(first(article, el => hasClass(el, 'num-epi')));
  const episodeTitle = text(first(article, el => hasClass(el, 'entry-title1')));
  return {
    title, path, url, kind, poster: parseImage(img, baseUrl),
    rating: ratingMatch ? Number(ratingMatch[1]) : null,
    ratingSource: voteText ? (voteText.match(/TMDB/i) ? 'TMDB' : 'unknown') : null,
    number: number || null, episodeTitle: episodeTitle || null
  };
}

function parseCards(root, baseUrl, mode = 'content') {
  const out = [];
  const seen = new Set();
  for (const article of all(root, el => el.tag === 'article' && hasClass(el, 'post'))) {
    if (mode === 'episode' && !hasClass(article, 'episodes')) continue;
    if (mode === 'content' && !hasAnyClass(article, ['movies', 'episodes'])) continue;
    const item = parseCard(article, baseUrl);
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function parsePagination(doc, baseUrl) {
  const nav = first(doc, el => el.tag === 'nav' && hasClass(el, 'pagination'));
  if (!nav) return { currentPage: null, maxPage: null, nextPageUrl: null, previousPageUrl: null, pages: [] };
  const links = all(nav, el => el.tag === 'a' && getAttr(el, 'href')).map(a => {
    const href = getAttr(a, 'href');
    const parsed = absoluteUrl(href, baseUrl);
    const number = Number(new URL(parsed).searchParams.get('page') || 0) || null;
    return { label: text(a), url: parsed, page: number };
  }).filter(x => x.url);
  const numericPages = links.map(x => x.page).filter(Boolean);
  const next = links.find(x => /^(?:next|›|»|>|next page)$/i.test(x.label));
  const previous = links.find(x => /^(?:previous|prev|‹|«|<|previous page)$/i.test(x.label));
  const current = Number(new URL(baseUrl).searchParams.get('page') || 1);
  return {
    currentPage: current, maxPage: numericPages.length ? Math.max(...numericPages) : null,
    nextPageUrl: next?.url || null, previousPageUrl: previous?.url || null, pages: links
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
    count: articles.length, items: articles, pagination,
    canonicalUrl: absoluteUrl(getMeta(doc, 'og:url') || getAttr(first(doc, el => el.tag === 'link' && String(getAttr(el, 'rel')).toLowerCase() === 'canonical'), 'href') || url, url)
  };
}

export function parseHome(html, url) {
  const doc = parseHTML(html);
  const sections = [];
  for (const section of all(doc, el => el.tag === 'section' && hasAnyClass(el, ['wdgt-home', 'widget_list_episodes', 'widget_list_movies_series']))) {
    const heading = first(section, el => (el.tag === 'h3' || el.tag === 'h2') && hasClass(el, 'section-title'));
    const title = text(heading);
    if (!title) continue;
    const type = hasClass(section, 'widget_list_episodes') ? 'episodes'
      : /series/i.test(title) ? 'series'
      : /movie/i.test(title) ? 'movies' : 'other';
    const items = parseCards(section, url, type === 'episodes' ? 'episode' : 'content');
    const more = first(section, el => el.tag === 'a' && /view more/i.test(text(el)) && getAttr(el, 'href'));
    sections.push({ title, type, count: items.length, items, moreUrl: more ? absoluteUrl(getAttr(more, 'href'), url) : null });
  }
  return {
    title: 'Tooniboy Home', sections,
    latestEpisodes: sections.filter(x => x.type === 'episodes').flatMap(x => x.items),
    latestSeries: sections.filter(x => x.type === 'series' && /^latest/i.test(x.title)).flatMap(x => x.items),
    latestMovies: sections.filter(x => x.type === 'movies' && /^latest/i.test(x.title)).flatMap(x => x.items),
    categories: parseGenres(html, url).genres,
    seo: parseSeo(doc, url)
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
  const node = findClass(root, 'description');
  if (!node) return [];
  const out = [];
  for (const child of node.children || []) {
    if (child.type === 'text') {
      const value = cleanText(child.value);
      if (value) out.push(value);
    } else if (child.type === 'element' && child.tag !== 'hr' && child.tag !== 'br') {
      const value = text(child);
      if (value && !/^(?:language|quality|running time)\s*:/i.test(value)) out.push(value);
    }
  }
  return [...new Set(out)];
}

function parseCrew(root, baseUrl) {
  const crew = {};
  const castRoot = findClass(root, 'cast-lst');
  if (!castRoot) return crew;
  for (const li of all(castRoot, el => el.tag === 'li')) {
    const label = directChildren(li, 'span')[0] || first(li, el => el.tag === 'span');
    const key = text(label).toLowerCase();
    if (!key) continue;
    crew[key] = all(li, el => el.tag === 'a' && getAttr(el, 'href')).map(a => ({
      name: text(a), url: absoluteUrl(getAttr(a, 'href'), baseUrl), path: getAttr(a, 'href')
    })).filter(x => x.name);
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
  if (!nodes.length) nodes = all(doc, el => el.tag === 'li' && all(el, x => x.tag === 'a' && /\/episode\//i.test(getAttr(x, 'href'))).length > 0);
  const map = new Map();
  for (const node of nodes) {
    const anchor = first(node, el => el.tag === 'a' && getAttr(el, 'href') && (/\/episode\//i.test(getAttr(el, 'href')) || hasClass(el, 'lnk-blk')));
    if (!anchor) continue;
    const episodeUrl = absoluteUrl(getAttr(anchor, 'href'), baseUrl);
    if (!episodeUrl) continue;
    const number = text(first(node, el => hasClass(el, 'num-epi'))) || text(first(node, el => hasClass(el, 'entry-title1')));
    const match = number.match(/(\d+)\s*x\s*(\d+)/i) || String(getAttr(node, 'data-episode')).match(/(\d+)\s*x\s*(\d+)/i) || [];
    let seasonContainer = node;
    while (seasonContainer && getAttr(seasonContainer, 'id') !== 'episode_by_temp' && !getAttr(seasonContainer, 'data-season')) seasonContainer = seasonContainer.parent;
    const season = Number(getAttr(node, 'data-season') || getAttr(seasonContainer, 'data-season') || match[1] || 1) || 1;
    const episode = Number(getAttr(node, 'data-episode-number') || match[2] || 0) || (map.size + 1);
    const title = text(first(node, el => hasClass(el, 'entry-title1') || hasClass(el, 'entry-title'))) || number || `Episode ${episode}`;
    const img = first(node, el => el.tag === 'img');
    if (!map.has(episodeUrl)) map.set(episodeUrl, {
      id: new URL(episodeUrl).pathname, itemId, season, episode,
      number: number || `${season}x${episode}`, title,
      url: episodeUrl, poster: parseImage(img, baseUrl)
    });
  }
  return [...map.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function parseSeo(doc, url) {
  const canonical = first(doc, el => el.tag === 'link' && String(getAttr(el, 'rel')).toLowerCase().split(/\s+/).includes('canonical'));
  return {
    pageTitle: text(first(doc, el => el.tag === 'title')) || null,
    canonicalUrl: canonical ? absoluteUrl(getAttr(canonical, 'href'), url) : url,
    ogTitle: getMeta(doc, 'og:title'), ogDescription: getMeta(doc, 'og:description'),
    ogImage: absoluteUrl(getMeta(doc, 'og:image'), url), ogUrl: absoluteUrl(getMeta(doc, 'og:url'), url),
    twitterTitle: getMeta(doc, 'twitter:title', 'name'), twitterDescription: getMeta(doc, 'twitter:description', 'name'),
    twitterImage: absoluteUrl(getMeta(doc, 'twitter:image', 'name'), url),
    description: getMeta(doc, 'description', 'name'), robots: getMeta(doc, 'robots', 'name'),
    locale: getMeta(doc, 'og:locale'), ogType: getMeta(doc, 'og:type')
  };
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
  const title = text(findClass(root, 'entry-title')) || text(first(doc, el => el.tag === 'h1')) || text(first(doc, el => el.tag === 'title'));
  const path = new URL(url).pathname;
  const kind = options.kind || (/\/movies\//i.test(path) ? 'movie' : /\/episode\//i.test(path) ? 'episode' : 'series');
  const media = parseMediaCandidates(root, doc, url);
  const poster = media.poster[0] || mediaUrl(first(root, el => hasClass(el, 'post-thumbnail')), url) || media.banner[0] || '';
  const banner = media.banner.find(x => x !== poster) || media.banner[0] || poster;
  const genres = linksFrom(root, a => hasClass(a.parent, 'genres') || hasClass(a.parent, 'genre'), url).map(x => ({ name: x.name, slug: new URL(x.url).pathname.replace(/\/$/, '').split('/').pop(), path: new URL(x.url).pathname, url: x.url }));
  const tags = linksFrom(root, a => hasClass(a.parent, 'tag') || hasClass(a.parent, 'tags'), url).map(x => ({ name: x.name, slug: new URL(x.url).pathname.replace(/\/$/, '').split('/').pop(), path: new URL(x.url).pathname, url: x.url }));
  const year = text(findClass(root, 'year')) || '';
  const duration = text(findClass(root, 'duration')) || '';
  const ratingNode = findClass(first(root, el => el.tag === 'footer') || root, 'num') || findClass(root, 'vote');
  const ratingText = text(ratingNode).match(/[0-9]+(?:\.[0-9]+)?/)?.[0] || '';
  const description = parseDescription(root);
  const language = findLabelValue(root, 'Language');
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
  const trailerRoot = byId(doc, 'mdl-trailer');
  const trailerFrame = trailerRoot && first(trailerRoot, el => el.tag === 'iframe');
  const commentForm = byId(doc, 'comment-form');
  const postId = getAttr(byId(commentForm || doc, 'post_id'), 'value') || getAttr(byId(doc, 'post_id'), 'value') || '';
  const commentSlug = getAttr(byId(doc, 'slug'), 'value') || '';
  const socialLinks = all(doc, el => el.tag === 'a' && getAttr(el, 'href')).map(a => getAttr(a, 'href')).filter(href => /facebook\.com\/sharer|twitter\.com\/intent\/tweet/i.test(href));
  const relatedItems = parseRelated(doc, url).filter(x => x.url !== url);
  return {
    id: path, path, url, kind, title,
    poster, banner, mediaCandidates: [...new Set([banner, poster, ...media.banner, ...media.poster].filter(Boolean))],
    genres, tags,
    metadata: { year, duration, language, quality, runningTime, rating: ratingText ? Number(ratingText) : null, ratingSource: ratingText ? 'TMDB' : null },
    description,
    crew,
    seasons,
    episodes,
    trailerUrl: trailerFrame ? mediaUrl(trailerFrame, url) : '',
    related: relatedItems,
    social: { shareLinks: [...new Set(socialLinks)] },
    comments: { postId: postId || null, slug: commentSlug || null },
    seo: parseSeo(doc, url)
  };
}

function normalizeServerName(name) {
  return cleanText(name).toLowerCase().replace(/\s+/g, '').replace(/stream/gi, '').replace(/-.*$/g, '').trim();
}

export function normalizeServerConfig(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
  return rows.map(item => ({
    name: cleanText(item?.name || item?.nickname || ''),
    nickname: cleanText(item?.nickname || item?.name || ''),
    oldUrl: String(item?.oldUrl || ''), url: String(item?.url || ''),
    order: Number(item?.order ?? 999), enabled: item?.enabled !== false,
    key: normalizeServerName(item?.nickname || item?.name || '')
  })).filter(item => item.name);
}

function parsePlayerServers(doc, url, configs = []) {
  const serverLabels = new Map();
  const buttons = all(doc, el => el.tag === 'a' && getAttr(el, 'href').startsWith('#options-') && (
    hasClass(el.parent, 'aa-tbs-video') || hasClass(el.parent?.parent, 'aa-tbs-video') || !!first(el, child => hasClass(child, 'server'))
  ));
  for (const button of buttons) {
    const target = getAttr(button, 'href').slice(1);
    const serverSpan = first(button, el => hasClass(el, 'server'));
    const label = text(serverSpan) || text(button).replace(/server\s*\d+/i, '').trim();
    const numberText = text(first(button, el => el.tag === 'span' && /^\d+$/.test(text(el)))) || text(button).match(/server\s*(\d+)/i)?.[1] || '';
    serverLabels.set(target, { name: label || `Server ${serverLabels.size + 1}`, number: Number(numberText) || serverLabels.size + 1 });
  }
  const videoRoot = byId(doc, 'aa-options') || findClass(doc, 'video-player') || doc;
  let slots = all(videoRoot, el => el.tag === 'div' && hasClass(el, 'video') && getAttr(el, 'id').startsWith('options-'));
  if (!slots.length) slots = all(videoRoot, el => el.tag === 'iframe' || el.tag === 'video');
  const out = [];
  const seen = new Set();
  for (const slot of slots) {
    const iframe = slot.tag === 'iframe' ? slot : first(slot, el => el.tag === 'iframe');
    const video = slot.tag === 'video' ? slot : first(slot, el => el.tag === 'video');
    let embedUrl = mediaUrl(iframe || video, url);
    if (!embedUrl && video) embedUrl = mediaUrl(first(video, el => el.tag === 'source'), url);
    if (!embedUrl || seen.has(embedUrl)) continue;
    seen.add(embedUrl);
    const slotId = getAttr(slot, 'id') || '';
    const label = serverLabels.get(slotId) || serverLabels.get(`options-${getAttr(slot, 'data-index')}`) || {};
    const rawName = label.name || `Server ${out.length + 1}`;
    const matched = configs.find(x => x.key && x.key === normalizeServerName(rawName));
    let configuredUrl = embedUrl;
    if (matched?.oldUrl && matched?.url && configuredUrl.includes(matched.oldUrl)) configuredUrl = configuredUrl.replace(matched.oldUrl, matched.url);
    const iframeAttributes = iframe?.attrs ? { ...iframe.attrs } : video?.attrs ? { ...video.attrs } : {};
    out.push({
      number: label.number || out.length + 1,
      playerId: slotId || null,
      name: matched?.nickname || rawName,
      embedUrl: configuredUrl,
      originalEmbedUrl: embedUrl,
      iframeAttributes,
      enabled: matched ? matched.enabled : null,
      order: matched?.order ?? out.length + 1,
      source: 'player-iframe'
    });
  }
  // Fallback for nonstandard player layouts that place iframes outside .video slots.
  if (!out.length) {
    for (const iframe of all(doc, el => el.tag === 'iframe' && (
      closestPlayer(el) || getAttr(el, 'src') || getAttr(el, 'data-src')
    ))) {
      const embedUrl = mediaUrl(iframe, url);
      if (!embedUrl || seen.has(embedUrl)) continue;
      seen.add(embedUrl);
      out.push({ number: out.length + 1, playerId: getAttr(iframe.parent, 'id') || null, name: `Server ${out.length + 1}`, embedUrl, originalEmbedUrl: embedUrl, iframeAttributes: iframe.attrs ? { ...iframe.attrs } : {}, enabled: null, order: out.length + 1, source: 'iframe-fallback' });
    }
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
  const modal = byId(doc, 'cyberModal') || findClass(doc, 'cyber-modal');
  if (!modal) return [];
  const rows = all(modal, el => el.tag === 'div' && hasClass(el, 'link-row'));
  return rows.map((row, index) => {
    const link = first(row, el => el.tag === 'a' && hasClass(el, 'download-btn') && getAttr(el, 'href'));
    if (!link) return null;
    const server = text(first(row, el => hasClass(el, 'server-name')));
    const number = text(first(row, el => hasClass(el, 'hex-number')));
    const tags = findAllClass(row, 'tag1').map(text).filter(Boolean);
    return {
      number: Number(number) || index + 1,
      server: server || `Download ${index + 1}`,
      label: text(link) || 'Download',
      url: absoluteUrl(getAttr(link, 'href'), url),
      tags,
      quality: tags.find(x => /(?:\d{3,4}p|hd|fhd|uhd|4k)/i.test(x)) || null,
      language: tags.find(x => /multi|hindi|tamil|telugu|english|japanese|audio/i.test(x)) || null,
      target: getAttr(link, 'target') || null,
      rel: getAttr(link, 'rel') || null,
      downloadAttribute: getAttr(link, 'download') || null
    };
  }).filter(x => x?.url);
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
  const playerServers = parsePlayerServers(doc, url, serverConfigs);
  const downloads = parseDownloadLinks(doc, url);
  const seasonAnchor = all(doc, el => el.tag === 'a' && /\/series\//i.test(getAttr(el, 'href')) && /season/i.test(text(el)))[0]
    || all(doc, el => el.tag === 'a' && /\/series\//i.test(getAttr(el, 'href')))[0];
  const nav = findClass(doc, 'epsdsnv');
  const navEpisodes = nav ? all(nav, el => el.tag === 'a' && /\/episode\//i.test(getAttr(el, 'href'))).map(a => absoluteUrl(getAttr(a, 'href'), url)).filter(Boolean) : [];
  const prev = navEpisodes[0] || null;
  const next = navEpisodes[1] || null;
  return {
    ...detail,
    kind: 'episode', title, episodeTitle: title, season, episode,
    number: season && episode ? `${season}x${episode}` : null,
    seriesUrl: seasonAnchor ? absoluteUrl(getAttr(seasonAnchor, 'href'), url) : null,
    playerServers, downloads,
    navigation: { previousEpisodeUrl: prev, nextEpisodeUrl: next },
    serverConfigCount: serverConfigs.length,
    streamCount: playerServers.length, downloadCount: downloads.length
  };
}

export function parseMovie(html, url, serverConfigs = []) {
  const doc = parseHTML(html);
  const detail = parseDetail(html, url, { kind: 'movie' });
  const playerServers = parsePlayerServers(doc, url, serverConfigs);
  const downloads = parseDownloadLinks(doc, url);
  return {
    ...detail, kind: 'movie', playerServers, downloads,
    serverConfigCount: serverConfigs.length,
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

export function parseSeoFromHtml(html, url) {
  return parseSeo(parseHTML(html), url);
}
