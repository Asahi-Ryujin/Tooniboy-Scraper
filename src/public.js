const HIDDEN_TAXONOMY = new Set(['bengali', 'hindi', 'telugu']);
const IMAGE_EXT = /\.(?:avif|gif|jpe?g|png|webp)$/i;

const hasValue = value => value !== undefined && value !== null && value !== '';

function sourceBrand(siteBase) {
  try {
    const labels = new URL(siteBase).hostname.toLowerCase().replace(/^www\./, '').split('.');
    const commonSecondLevelSuffixes = new Set(['co.uk', 'com.au', 'co.in', 'com.br', 'co.nz', 'com.sg', 'co.jp']);
    const registeredLabels = commonSecondLevelSuffixes.has(labels.slice(-2).join('.')) ? labels.slice(-3) : labels.slice(-2);
    return registeredLabels[0] || labels[0] || '';
  } catch {
    return '';
  }
}

function cleanString(value, siteBase = '') {
  if (typeof value !== 'string') return value;
  const brand = sourceBrand(siteBase);
  let output = value;
  if (brand) {
    const escapedBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      const host = new URL(siteBase).hostname.toLowerCase().replace(/^www\./, '');
      const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      output = output.replace(new RegExp(`https?:\\/\\/(?:www\\.)?${escapedHost}(?:\\/[^\\s<>"']*)?`, 'gi'), ' ');
      output = output.replace(new RegExp(`\\b(?:www\\.)?${escapedHost}\\b`, 'gi'), ' ');
    } catch { /* Invalid configuration is handled before normalization. */ }
    output = output.replace(new RegExp(`\\b${escapedBrand}(?:\\.[a-z]{2,})?\\b`, 'gi'), ' ');
  }
  return output.replace(/\s+/g, ' ').replace(/\s*[-|–—:]\s*$/g, '').trim();
}

function toInternalPath(raw, siteBase) {
  if (!hasValue(raw)) return '';
  try {
    const url = /^https?:\/\//i.test(String(raw))
      ? new URL(String(raw))
      : new URL(String(raw).startsWith('/') ? String(raw) : `/${raw}`, siteBase);
    return url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  } catch {
    return '';
  }
}

function encodePath(path) {
  return String(path || '/').split('/').filter(Boolean).map(part => {
    try { return encodeURIComponent(decodeURIComponent(part)); }
    catch { return encodeURIComponent(part); }
  }).join('/');
}

export function endpointForPath(rawPath, siteBase) {
  const path = toInternalPath(rawPath, siteBase);
  if (!path) return null;
  const seasonMatch = path.match(/^\/series\/([^/]+)\/season\/(\d+)\/?$/i);
  if (seasonMatch) return `/api/season/${encodePath(seasonMatch[1])}/${Number(seasonMatch[2])}`;
  const match = path.match(/^\/(series|movies|movie|episode|category)\/(.+)$/i);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const rest = encodePath(match[2]);
  if (type === 'series') return `/api/series/${rest}`;
  if (type === 'movies' || type === 'movie') return `/api/movie/${rest}`;
  if (type === 'episode') return `/api/episode/${rest}`;
  return `/api/genre/${rest}`;
}

function isUpstreamUrl(raw, siteBase, allowedHosts) {
  try {
    const url = new URL(raw, siteBase);
    return url.protocol === 'https:' && allowedHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function publicMediaUrl(raw, siteBase, allowedHosts) {
  if (!hasValue(raw)) return null;
  try {
    const url = new URL(String(raw), siteBase);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (isUpstreamUrl(url.href, siteBase, allowedHosts)) {
      if (!IMAGE_EXT.test(url.pathname)) return null;
      return `/api/asset?path=${encodeURIComponent(url.pathname)}`;
    }
    return url.href;
  } catch {
    return null;
  }
}

function publicLink(raw, siteBase, allowedHosts) {
  if (!hasValue(raw)) return null;
  try {
    const url = new URL(String(raw), siteBase);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (isUpstreamUrl(url.href, siteBase, allowedHosts)) {
      return endpointForPath(url.pathname, siteBase);
    }
    return url.href;
  } catch {
    return null;
  }
}

function publicSeriesEndpoint(raw, siteBase, allowedHosts) {
  if (!hasValue(raw)) return null;
  try {
    const url = new URL(String(raw), siteBase);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (isUpstreamUrl(url.href, siteBase, allowedHosts)) {
      const seriesPath = url.pathname.replace(/\/season\/\d+\/?$/i, '');
      return endpointForPath(seriesPath, siteBase);
    }
    return url.href;
  } catch {
    return null;
  }
}

function hiddenTaxonomy(item) {
  const name = String(item?.name || '').trim().toLowerCase();
  const slug = String(item?.slug || '').toLowerCase();
  const tokens = `${name} ${slug}`.split(/[^a-z]+/).filter(Boolean);
  return HIDDEN_TAXONOMY.has(name) || tokens.some(token => HIDDEN_TAXONOMY.has(token));
}

function cleanTaxonomy(item, siteBase) {
  if (!item || typeof item !== 'object' || hiddenTaxonomy(item)) return null;
  const slug = String(item.slug || '').trim();
  if (!slug) return null;
  const encoded = encodePath(slug);
  const path = `/api/genre/${encoded}`;
  return {
    name: cleanString(item.name, siteBase) || cleanString(slug, siteBase),
    slug,
    ...(item.group ? { group: cleanString(item.group, siteBase) } : {}),
    apiEndpoint: path
  };
}

function cleanTags(items, siteBase) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => {
    if (hiddenTaxonomy(item)) return false;
    const slug = String(item?.slug || '').toLowerCase();
    const name = String(item?.name || '').toLowerCase();
    return !/(?:^|[-/])(bengali|hindi|telugu)(?:$|[-/])/.test(slug)
      && !/\b(?:in|dubbed in)\s+(bengali|hindi|telugu)\b/.test(name);
  }).map(item => ({
    name: cleanString(item.name, siteBase),
    ...(hasValue(item.slug) ? { slug: item.slug } : {})
  })).filter(item => item.name);
}

function compactObject(value, siteBase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === '') continue;
    if (Array.isArray(item) && item.length === 0) continue;
    if (typeof item === 'object' && !Array.isArray(item)) {
      const nested = compactObject(item, siteBase);
      if (Object.keys(nested).length) out[key] = nested;
    } else {
      out[key] = typeof item === 'string' ? cleanString(item, siteBase) : item;
    }
  }
  return out;
}

function cleanCard(item, siteBase, allowedHosts) {
  if (!item || typeof item !== 'object') return null;
  const path = toInternalPath(item.path || item.id || item.url, siteBase);
  const endpoint = endpointForPath(path, siteBase);
  const title = cleanString(item.title || item.episodeTitle, siteBase);
  if (!title && !path) return null;
  const out = {
    ...(endpoint || path ? { path: endpoint || path } : {}),
    ...(title ? { title } : {}),
    ...(item.kind ? { kind: cleanString(item.kind, siteBase) } : {})
  };
  const poster = publicMediaUrl(item.poster, siteBase, allowedHosts);
  if (poster) out.poster = poster;
  if (Number.isFinite(Number(item.rating)) && item.rating !== null && item.rating !== '') out.rating = Number(item.rating);
  if (hasValue(item.ratingSource)) out.ratingSource = cleanString(item.ratingSource, siteBase);
  if (hasValue(item.number)) out.number = cleanString(item.number, siteBase);
  if (hasValue(item.episodeTitle) && item.episodeTitle !== title) out.episodeTitle = cleanString(item.episodeTitle, siteBase);
  return out;
}

export function cleanListing(data, options, siteBase, allowedHosts) {
  const items = (Array.isArray(data?.items) ? data.items : [])
    .map(item => cleanCard(item, siteBase, allowedHosts)).filter(Boolean);
  const rawPage = Number(data?.pagination?.currentPage || data?.page || options.page || 1);
  const currentPage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawMax = Number(data?.pagination?.maxPage);
  const maxPage = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : null;
  const hasPrevious = currentPage > 1 || Boolean(data?.pagination?.previousPageUrl);
  const hasNext = maxPage !== null
    ? currentPage < maxPage
    : Boolean(data?.pagination?.nextPageUrl);
  const makePageEndpoint = page => {
    const params = new URLSearchParams(options.params || {});
    params.set('page', String(page));
    return `${options.endpoint}?${params.toString()}`;
  };
  return {
    ...(hasValue(data?.title) ? { title: cleanString(data.title, siteBase) } : {}),
    ...(hasValue(data?.category) ? { category: cleanString(data.category, siteBase) } : {}),
    type: cleanString(data?.type || options.type || 'all', siteBase),
    page: currentPage,
    count: items.length,
    items,
    pagination: {
      currentPage,
      ...(maxPage !== null ? { maxPage } : {}),
      hasPrevious,
      hasNext,
      previousPage: hasPrevious ? makePageEndpoint(Math.max(1, currentPage - 1)) : null,
      nextPage: hasNext ? makePageEndpoint(currentPage + 1) : null
    }
  };
}

export function cleanGenres(data, siteBase) {
  const rawGroups = data?.groups && typeof data.groups === 'object' ? data.groups : {};
  const groups = {};
  let count = 0;
  for (const [groupName, values] of Object.entries(rawGroups)) {
    const unique = new Map();
    for (const item of Array.isArray(values) ? values : []) {
      const cleaned = cleanTaxonomy({ ...item, group: item.group || groupName }, siteBase);
      if (cleaned && !unique.has(cleaned.slug)) unique.set(cleaned.slug, cleaned);
    }
    const list = [...unique.values()];
    if (list.length) {
      groups[groupName] = list;
      count += list.length;
    }
  }
  return { count, groups };
}

export function cleanHome(data, siteBase, allowedHosts) {
  const sections = (Array.isArray(data?.sections) ? data.sections : []).map(section => {
    const items = (Array.isArray(section.items) ? section.items : [])
      .map(item => cleanCard(item, siteBase, allowedHosts)).filter(Boolean);
    const more = publicLink(section.moreUrl, siteBase, allowedHosts);
    return {
      title: cleanString(section.title || 'Untitled', siteBase),
      type: section.type || 'other',
      count: items.length,
      items,
      ...(more ? { moreEndpoint: more } : {})
    };
  });
  const categorySource = Array.isArray(data?.categories) ? data.categories : [];
  const categories = [];
  const seen = new Set();
  for (const item of categorySource) {
    const cleaned = cleanTaxonomy(item, siteBase);
    if (cleaned && !seen.has(cleaned.slug)) {
      seen.add(cleaned.slug);
      categories.push(cleaned);
    }
  }
  return { title: 'Home', sections, categories };
}


function cleanDownloadLanguage(value, siteBase) {
  if (!hasValue(value)) return null;
  const visible = String(cleanString(String(value), siteBase)).split(/[,/|;+\s-]+/).map(part => part.trim()).filter(Boolean)
    .filter(part => !HIDDEN_TAXONOMY.has(part.toLowerCase()));
  return visible.length ? visible.join('-') : null;
}

function cleanCrew(crew, siteBase) {
  if (!crew || typeof crew !== 'object') return {};
  const out = {};
  for (const [role, members] of Object.entries(crew)) {
    const names = [...new Set((Array.isArray(members) ? members : [])
      .map(member => cleanString(typeof member === 'string' ? member : member?.name, siteBase))
      .filter(Boolean))];
    if (names.length) out[cleanString(role, siteBase)] = names;
  }
  return out;
}

function cleanSeason(item, seriesPath, siteBase) {
  const season = Number(item?.season);
  if (!Number.isInteger(season) || season < 1) return null;
  const basePath = toInternalPath(seriesPath, siteBase);
  const seriesSlug = basePath.replace(/^\/series\//i, '');
  const endpoint = seriesSlug
    ? `/api/season/${encodePath(seriesSlug)}/${season}`
    : null;
  return {
    season,
    label: cleanString(item.label || `Season ${season}`, siteBase),
    episodeCount: Number.isFinite(Number(item.episodeCount)) ? Number(item.episodeCount) : 0,
    hasPreExtracted: Boolean(item.hasPreExtracted),
    ...(endpoint ? { endpoint } : {})
  };
}

export function cleanEpisode(item, siteBase, allowedHosts) {
  const card = cleanCard({ ...item, kind: 'episode' }, siteBase, allowedHosts);
  if (!card) return null;
  const itemEndpoint = endpointForPath(item.itemId, siteBase);
  const out = {
    ...(itemEndpoint ? { itemId: itemEndpoint } : {}),
    ...(Number.isFinite(Number(item.season)) && Number(item.season) > 0 ? { season: Number(item.season) } : {}),
    ...(Number.isFinite(Number(item.episode)) && Number(item.episode) > 0 ? { episode: Number(item.episode) } : {}),
    ...(item.number ? { number: cleanString(item.number, siteBase) } : {}),
    title: cleanString(item.title || card.title, siteBase),
    ...(card.path ? { path: card.path } : {}),
    ...(card.poster ? { poster: card.poster } : {})
  };
  return out;
}

export function cleanDetail(data, siteBase, allowedHosts) {
  const path = toInternalPath(data?.path || data?.id || data?.url, siteBase);
  const endpoint = endpointForPath(path, siteBase);
  const poster = publicMediaUrl(data?.poster, siteBase, allowedHosts);
  const banner = publicMediaUrl(data?.banner, siteBase, allowedHosts);
  const genres = (Array.isArray(data?.genres) ? data.genres : [])
    .map(item => cleanTaxonomy(item, siteBase)).filter(Boolean);
  const seasons = (Array.isArray(data?.seasons) ? data.seasons : [])
    .map(item => cleanSeason(item, path, siteBase)).filter(Boolean);
  const episodes = (Array.isArray(data?.episodes) ? data.episodes : [])
    .map(item => cleanEpisode(item, siteBase, allowedHosts)).filter(Boolean);
  const related = (Array.isArray(data?.related) ? data.related : [])
    .map(item => cleanCard(item, siteBase, allowedHosts)).filter(Boolean);
  const metadata = compactObject(data?.metadata, siteBase);
  const trailer = publicMediaUrl(data?.trailerUrl, siteBase, allowedHosts);
  const tags = cleanTags(data?.tags, siteBase);
  const cleanDescription = Array.isArray(data?.description)
    ? [...new Set(data.description.map(item => cleanString(item, siteBase)).filter(Boolean))]
    : [];
  const crew = cleanCrew(data?.crew, siteBase);
  return {
    ...(endpoint || path ? { path: endpoint || path } : {}),
    kind: cleanString(data?.kind || 'series', siteBase),
    title: cleanString(data?.title, siteBase) || null,
    ...(poster ? { poster } : {}),
    ...(banner && banner !== poster ? { banner } : {}),
    ...(genres.length ? { genres } : {}),
    ...(tags.length ? { tags } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(cleanDescription.length ? { description: cleanDescription } : {}),
    ...(Object.keys(crew).length ? { crew } : {}),
    ...(seasons.length ? { seasons } : {}),
    ...(episodes.length ? { episodes } : {}),
    ...(trailer ? { trailerUrl: trailer } : {}),
    ...(related.length ? { related } : {})
  };
}

export function cleanEpisodeDetail(data, siteBase, allowedHosts) {
  const base = cleanDetail(data, siteBase, allowedHosts);
  const playerServers = (Array.isArray(data?.playerServers) ? data.playerServers : []).map(server => {
    const embedUrl = publicMediaUrl(server.embedUrl, siteBase, allowedHosts)
      || publicLink(server.embedUrl, siteBase, allowedHosts);
    if (!embedUrl) return null;
    return {
      number: Number(server.number) || 1,
      name: cleanString(server.name || `Server ${Number(server.number) || 1}`, siteBase),
      embedUrl,
      ...(typeof server.enabled === 'boolean' ? { enabled: server.enabled } : {}),
      ...(Number.isFinite(Number(server.order)) ? { order: Number(server.order) } : {})
    };
  }).filter(Boolean);
  const downloads = (Array.isArray(data?.downloads) ? data.downloads : []).map(download => {
    const url = publicLink(download.url, siteBase, allowedHosts);
    if (!url || url.startsWith('/api/')) return null;
    const tags = (Array.isArray(download.tags) ? download.tags : [])
      .filter(tag => !/\b(?:bengali|hindi|telugu)\b/i.test(String(tag)))
      .map(tag => cleanString(String(tag), siteBase)).filter(Boolean);
    const language = cleanDownloadLanguage(download.language, siteBase);
    return {
      number: Number(download.number) || 1,
      server: cleanString(download.server || 'Download', siteBase),
      label: cleanString(download.label || 'Download', siteBase),
      url,
      ...(download.quality ? { quality: cleanString(String(download.quality), siteBase) } : {}),
      ...(language ? { language } : {}),
      ...(tags.length ? { tags } : {})
    };
  }).filter(Boolean);
  const previousEpisode = publicLink(data?.navigation?.previousEpisodeUrl, siteBase, allowedHosts);
  const nextEpisode = publicLink(data?.navigation?.nextEpisodeUrl, siteBase, allowedHosts);
  const seriesEndpoint = publicSeriesEndpoint(data?.seriesUrl, siteBase, allowedHosts);
  return {
    ...base,
    ...(data?.episodeTitle ? { episodeTitle: data.episodeTitle } : {}),
    ...(Number.isFinite(Number(data?.season)) && Number(data.season) > 0 ? { season: Number(data.season) } : {}),
    ...(Number.isFinite(Number(data?.episode)) && Number(data.episode) > 0 ? { episode: Number(data.episode) } : {}),
    ...(data?.number ? { number: data.number } : {}),
    ...(seriesEndpoint ? { seriesEndpoint } : {}),
    ...(playerServers.length ? { playerServers, streamCount: playerServers.length } : {}),
    ...(downloads.length ? { downloads, downloadCount: downloads.length } : {}),
    ...(previousEpisode || nextEpisode ? { navigation: {
      ...(previousEpisode ? { previousEpisode } : {}),
      ...(nextEpisode ? { nextEpisode } : {})
    } } : {})
  };
}

export function cleanServerList(configs, siteBase) {
  const servers = (Array.isArray(configs) ? configs : []).map((server, index) => ({
    name: cleanString(server.nickname || server.name || `Server ${index + 1}`, siteBase),
    order: Number.isFinite(Number(server.order)) ? Number(server.order) : index + 1,
    enabled: server.enabled !== false
  }));
  return { count: servers.length, servers };
}

export function isUpstreamAssetPath(rawPath) {
  return typeof rawPath === 'string'
    && rawPath.startsWith('/')
    && !rawPath.startsWith('//')
    && IMAGE_EXT.test(rawPath.split('?')[0])
    && !rawPath.includes('\\')
    && !rawPath.includes('\0')
    && !/(?:^|\/)\.\.(?:\/|$)/.test(rawPath);
}
