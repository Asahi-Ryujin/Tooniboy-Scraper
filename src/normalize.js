const DROP_KEYS = new Set([
  'api', 'apiEndpoint', 'source', 'sourceUrl', 'retrievedAt', 'ratingSource',
  'canonicalUrl', 'seo', 'social', 'comments', 'url', 'embedUrl', 'originalUrl', 'originalEmbedUrl',
  'iframeAttributes', 'playerId', 'serverConfigCount', 'streamCount',
  'downloadCount', 'requestHeaders', 'mediaCandidates', 'trailerUrl',
  'moreUrl', 'href', 'src', 'target', 'rel', 'downloadAttribute',
  'oldUrl', 'newUrl', 'key', 'iframe', 'serverConfig', 'serverName',
  'serverUrl', 'player', 'players', 'playerUrl', 'stream', 'streamUrl',
  'streamingUrl', 'downloadUrl', 'fileUrl', 'embed', 'embedSrc',
  'iframeUrl', 'mediaUrl', 'mediaUrls'
]);

const IMAGE_KEYS = new Set(['poster', 'banner', 'image', 'thumbnail']);
const DEFAULT_MEDIA_HOSTS = [
  'rubystm.com',
  'filesforever.link',
  'cloudy.upns.one',
  'vidmoly.net',
  'vidmoly.me',
  'abyssplayer.com',
  'ravok.buzz',
  'turbonewvid.com',
  'download.openx.xyz',
  'blakiteapi.xyz',
  'strmup.to'
];
const ALLOWED_IMAGE_HOSTS = new Set([
  'image.tmdb.org', 'media.themoviedb.org', 'media.tmdb.org',
  'media.tenor.com', 'i.postimg.cc', 'i.imgur.com'
]);

function parseHostAllowlist(value) {
  const supplied = String(value || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const list = supplied.length ? supplied : DEFAULT_MEDIA_HOSTS;
  return list.map(host => host.replace(/^https?:\/\//, '').replace(/^\*\./, '.').replace(/\/$/, ''))
    .filter(host => /^[a-z0-9.-]+$/.test(host) && !host.startsWith('.') && !host.endsWith('.') && !host.includes('..'));
}

function hostMatches(hostname, allowedHosts) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

function safeInternalPath(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return '';
  try {
    const parsed = new URL(raw, 'https://internal.invalid');
    if (parsed.origin !== 'https://internal.invalid') return '';
    const segments = parsed.pathname.split('/');
    if (segments.some(part => part === '.' || part === '..')) return '';
    return parsed.pathname;
  } catch {
    return '';
  }
}

function safeImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return '';
    if (!hostMatches(parsed.hostname, [...ALLOWED_IMAGE_HOSTS])) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function safeMediaUrl(value, mediaHosts) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return '';
    if (!hostMatches(parsed.hostname, mediaHosts)) return '';
    if (parsed.hostname === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname.includes(':')) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function relativeInternalPath(rawUrl, baseUrl) {
  if (!rawUrl || !baseUrl) return '';
  try {
    const parsed = new URL(rawUrl, baseUrl);
    const base = new URL(baseUrl);
    if (parsed.protocol !== 'https:' || parsed.origin !== base.origin) return '';
    return parsed.pathname;
  } catch {
    return '';
  }
}

function cleanText(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s<>"']+/gi, '')
    .replace(/(^|\s)www\.[^\s<>"']+/gi, '$1')
    .replace(/(^|\s)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi, '$1')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCrew(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const crew = {};
  for (const [role, people] of Object.entries(value)) {
    const names = (Array.isArray(people) ? people : [])
      .map(person => typeof person === 'string' ? person : person?.name)
      .map(name => cleanText(name))
      .filter(Boolean);
    if (names.length) crew[cleanText(role)] = [...new Set(names)];
  }
  return Object.keys(crew).length ? crew : undefined;
}

function cleanEpisodes(rows, baseUrl) {
  return (Array.isArray(rows) ? rows : []).map(episode => {
    const path = safeInternalPath(episode?.path || episode?.id || relativeInternalPath(episode?.url, baseUrl));
    return {
      ...(path ? { path } : {}),
      ...(episode?.season != null ? { season: Number(episode.season) } : {}),
      ...(episode?.episode != null ? { episode: Number(episode.episode) } : {}),
      ...(episode?.number ? { number: cleanText(episode.number) } : {}),
      ...(episode?.title ? { title: cleanText(episode.title) } : {}),
      ...(safeImageUrl(episode?.poster) ? { poster: safeImageUrl(episode.poster) } : {})
    };
  }).filter(episode => episode.path || episode.title);
}

function cleanSeasons(rows) {
  return (Array.isArray(rows) ? rows : []).map(season => {
    const path = safeInternalPath(season?.path || season?.url);
    const count = Number(season?.episodeCount || 0);
    return {
      ...(Number.isFinite(Number(season?.season)) ? { season: Number(season.season) } : {}),
      ...(season?.label ? { label: cleanText(season.label) } : {}),
      episodeCount: Number.isFinite(count) ? Math.max(0, count) : 0,
      ...(path ? { path } : {})
    };
  }).filter(season => season.season != null);
}

function cleanCategories(rows) {
  return (Array.isArray(rows) ? rows : []).map(item => {
    const path = safeInternalPath(item?.path);
    return {
      ...(item?.name ? { name: cleanText(item.name) } : {}),
      ...(item?.slug ? { slug: cleanText(item.slug) } : {}),
      ...(path ? { path } : {}),
      ...(item?.group ? { group: cleanText(item.group) } : {})
    };
  }).filter(item => item.name && item.path);
}

function cleanPlayerServers(rows, mediaHosts) {
  const result = [];
  for (const server of Array.isArray(rows) ? rows : []) {
    const embedUrl = safeMediaUrl(server?.embedUrl, mediaHosts);
    if (!embedUrl) continue;
    const number = Number(server?.number);
    const order = Number(server?.order);
    result.push({
      ...(Number.isFinite(number) && number > 0 ? { number } : {}),
      name: cleanText(server?.name) || `Server ${result.length + 1}`,
      type: 'embed',
      embedUrl,
      ...(typeof server?.enabled === 'boolean' ? { enabled: server.enabled } : {}),
      order: Number.isFinite(order) ? order : result.length + 1
    });
  }
  return result.sort((a, b) => a.order - b.order || (a.number || 0) - (b.number || 0));
}

function cleanDownloads(rows, mediaHosts) {
  const result = [];
  for (const download of Array.isArray(rows) ? rows : []) {
    const url = safeMediaUrl(download?.url, mediaHosts);
    if (!url) continue;
    const tags = [...new Set((Array.isArray(download?.tags) ? download.tags : []).map(cleanText).filter(Boolean))];
    result.push({
      ...(Number.isFinite(Number(download?.number)) ? { number: Number(download.number) } : {}),
      server: cleanText(download?.server) || `Download ${result.length + 1}`,
      label: cleanText(download?.label) || 'Download',
      type: 'download',
      url,
      ...(tags.length ? { tags } : {}),
      ...(download?.quality ? { quality: cleanText(download.quality) } : {}),
      ...(download?.language ? { language: cleanText(download.language) } : {})
    });
  }
  return result;
}

function cleanObject(value, parentKey, baseUrl, mediaHosts) {
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) {
    if (parentKey === 'episodes') return cleanEpisodes(value, baseUrl);
    if (parentKey === 'seasons') return cleanSeasons(value);
    if (parentKey === 'genres' || parentKey === 'tags' || parentKey === 'categories') return cleanCategories(value);
    return value.map(item => cleanObject(item, parentKey, baseUrl, mediaHosts)).filter(item => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;

  const result = {};
  const hasPath = typeof value.path === 'string' && value.path.length > 0;
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'playerServers') {
      result.playerServers = cleanPlayerServers(raw, mediaHosts);
      continue;
    }
    if (key === 'downloads') {
      result.downloads = cleanDownloads(raw, mediaHosts);
      continue;
    }
    if (DROP_KEYS.has(key) || raw === null || raw === undefined || raw === '') continue;
    if (key === 'id' && hasPath && String(value.id) === String(value.path)) continue;
    if (key === 'path' || key === 'seriesPath' || key === 'previousEpisodePath' || key === 'nextEpisodePath' || key === 'morePath') {
      const path = safeInternalPath(raw);
      if (path) result[key] = path;
      continue;
    }
    if (key === 'seriesUrl' || key === 'itemId') {
      const path = safeInternalPath(raw) || relativeInternalPath(raw, baseUrl);
      if (path) result.seriesPath = path;
      continue;
    }
    if (IMAGE_KEYS.has(key)) {
      const image = safeImageUrl(raw);
      if (image) result[key] = image;
      continue;
    }
    if (key === 'navigation' && raw && typeof raw === 'object') {
      const previous = relativeInternalPath(raw.previousEpisodeUrl || raw.previousEpisodePath, baseUrl)
        || safeInternalPath(raw.previousEpisodePath);
      const next = relativeInternalPath(raw.nextEpisodeUrl || raw.nextEpisodePath, baseUrl)
        || safeInternalPath(raw.nextEpisodePath);
      result.navigation = {
        ...(previous ? { previousEpisodePath: previous } : {}),
        ...(next ? { nextEpisodePath: next } : {})
      };
      continue;
    }
    if (key === 'episodes') { result.episodes = cleanEpisodes(raw, baseUrl); continue; }
    if (key === 'seasons') { result.seasons = cleanSeasons(raw); continue; }
    if (key === 'genres' || key === 'tags' || key === 'categories') { result[key] = cleanCategories(raw); continue; }
    if (key === 'groups' && raw && typeof raw === 'object') {
      const groups = {};
      for (const [group, entries] of Object.entries(raw)) {
        const items = cleanCategories(entries);
        if (items.length) groups[group] = items;
      }
      if (Object.keys(groups).length) result.groups = groups;
      continue;
    }
    if (key === 'crew') {
      const crew = cleanCrew(raw);
      if (crew) result.crew = crew;
      continue;
    }
    if (Array.isArray(raw) && raw.length === 0 && !['related', 'items', 'sections', 'playerServers', 'downloads'].includes(key)) continue;
    const normalized = cleanObject(raw, key, baseUrl, mediaHosts);
    if (normalized !== undefined) result[key] = normalized;
  }

  if (Array.isArray(value.playerServers)) result.playerCount = cleanPlayerServers(value.playerServers, mediaHosts).length;
  if (Array.isArray(value.downloads)) result.downloadCount = cleanDownloads(value.downloads, mediaHosts).length;
  return result;
}

export function toPublicData(data, baseUrl = '', mediaHostSetting = '') {
  const mediaHosts = parseHostAllowlist(mediaHostSetting);
  return cleanObject(data, 'data', baseUrl, mediaHosts);
}

export function filterPublicServerConfigs(configs) {
  return (Array.isArray(configs) ? configs : [])
    .map(server => ({
      name: cleanText(server.nickname || server.name),
      enabled: server.enabled !== false,
      order: Number.isFinite(Number(server.order)) ? Number(server.order) : 999
    }))
    .filter(server => server.name)
    .sort((a, b) => a.order - b.order);
}

export { relativeInternalPath, safeInternalPath, safeImageUrl, safeMediaUrl, DEFAULT_MEDIA_HOSTS };
