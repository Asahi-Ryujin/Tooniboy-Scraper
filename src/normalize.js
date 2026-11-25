const DROP_KEYS = new Set([
  'api', 'source', 'sourceUrl', 'retrievedAt', 'ratingSource', 'canonicalUrl',
  'seo', 'social', 'comments', 'developer', 'latestEpisodes', 'latestSeries',
  'latestMovies', 'originalEmbedUrl', 'iframeAttributes', 'playerId',
  'serverConfigCount', 'streamCount', 'downloadCount', 'requestHeaders',
  'apiEndpoint', 'moreUrl', 'mediaCandidates'
]);

const LANGUAGE_TERMS = new Set([
  'language', 'bengali', 'bangla', 'hindi', 'tamil', 'telugu', 'english',
  'japanese', 'japaneses', 'japan', 'korean', 'kannada', 'malayalam',
  'malyalam', 'marathi', 'chinese', 'fan-hindi'
]);

function languageCategory(item) {
  if (!item || typeof item !== 'object') return false;
  const name = String(item.name || '').trim().toLowerCase();
  const slug = String(item.slug || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  const lastSlug = slug.split('/').at(-1) || slug;
  return item.group === 'language' || slug.startsWith('language/') ||
    LANGUAGE_TERMS.has(name.replace(/\s+/g, '-')) || LANGUAGE_TERMS.has(lastSlug);
}

function relativeInternalPath(rawUrl, baseUrl) {
  if (!rawUrl || !baseUrl) return '';
  try {
    const url = new URL(rawUrl, baseUrl);
    const base = new URL(baseUrl);
    if (url.origin !== base.origin) return '';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '';
  }
}

function compactObject(value, parentKey, baseUrl) {
  if (Array.isArray(value)) {
    const rows = value
      .filter(item => !(parentKey === 'genres' || parentKey === 'categories') || !languageCategory(item))
      .map(item => publicValue(item, parentKey, baseUrl))
      .filter(item => item !== undefined);
    return rows;
  }
  if (!value || typeof value !== 'object') return value;

  const result = {};
  const hasPath = typeof value.path === 'string' && value.path.length > 0;

  for (const [key, raw] of Object.entries(value)) {
    if (DROP_KEYS.has(key)) continue;
    if (key === 'genres' && value.groups) continue;
    if (key === 'itemId' && typeof raw === 'string') { result.seriesPath = raw; continue; }
    if (key === 'url' && (hasPath || relativeInternalPath(raw, baseUrl))) continue;
    if (key === 'id' && hasPath && value.id === value.path) continue;
    if (key === 'path' && ['genres', 'categories', 'tags', 'seasons'].includes(parentKey)) continue;
    if (key === 'url' && ['genres', 'categories', 'tags', 'seasons', 'crew'].includes(parentKey)) continue;
    if (key === 'runningTime' && value.duration && String(value.duration).trim() === String(raw).trim()) continue;
    if (key === 'episodeTitle' && value.title && String(value.title).trim() === String(raw).trim()) continue;

    if (key === 'groups' && raw && typeof raw === 'object') {
      const groups = {};
      for (const [groupName, entries] of Object.entries(raw)) {
        if (groupName.toLowerCase() === 'language') continue;
        groups[groupName] = compactObject(entries, 'categories', baseUrl);
      }
      if (Object.keys(groups).length) result.groups = groups;
      continue;
    }

    if (key === 'crew' && raw && typeof raw === 'object') {
      const crew = {};
      for (const [role, people] of Object.entries(raw)) {
        const names = (Array.isArray(people) ? people : [])
          .map(person => typeof person === 'string' ? person : person?.name)
          .filter(Boolean);
        if (names.length) crew[role] = names;
      }
      if (Object.keys(crew).length) result.crew = crew;
      continue;
    }

    if (key === 'seasons' && Array.isArray(raw)) {
      result.seasons = raw.map(season => ({
        season: season.season,
        label: season.label,
        episodeCount: season.episodeCount,
        hasPreExtracted: season.hasPreExtracted
      }));
      continue;
    }

    if (key === 'episodes' && Array.isArray(raw)) {
      result.episodes = raw.map(episode => {
        const path = episode.path || episode.id || relativeInternalPath(episode.url, baseUrl);
        const out = {
          ...(path ? { path } : {}),
          ...(episode.season != null ? { season: episode.season } : {}),
          ...(episode.episode != null ? { episode: episode.episode } : {}),
          ...(episode.number ? { number: episode.number } : {}),
          ...(episode.title ? { title: episode.title } : {}),
          ...(episode.poster ? { poster: episode.poster } : {})
        };
        return out;
      });
      continue;
    }

    if (key === 'playerServers' && Array.isArray(raw)) {
      result.playerServers = raw.map(server => ({
        ...(server.number != null ? { number: server.number } : {}),
        ...(server.name ? { name: server.name } : {}),
        ...(server.embedUrl ? { embedUrl: server.embedUrl } : {}),
        ...(typeof server.enabled === 'boolean' ? { enabled: server.enabled } : {}),
        ...(server.order != null ? { order: server.order } : {})
      }));
      continue;
    }

    if (key === 'downloads' && Array.isArray(raw)) {
      result.downloads = raw.map(download => ({
        ...(download.number != null ? { number: download.number } : {}),
        ...(download.server ? { server: download.server } : {}),
        ...(download.label ? { label: download.label } : {}),
        ...(download.url ? { url: download.url } : {}),
        ...(Array.isArray(download.tags) && download.tags.length ? { tags: download.tags } : {}),
        ...(download.quality ? { quality: download.quality } : {}),
        ...(download.language ? { language: download.language } : {})
      }));
      continue;
    }

    if (key === 'navigation' && raw && typeof raw === 'object') {
      const previous = relativeInternalPath(raw.previousEpisodeUrl, baseUrl);
      const next = relativeInternalPath(raw.nextEpisodeUrl, baseUrl);
      result.navigation = {
        ...(previous ? { previousEpisodePath: previous } : {}),
        ...(next ? { nextEpisodePath: next } : {})
      };
      continue;
    }

    if (key === 'seriesUrl') {
      const path = relativeInternalPath(raw, baseUrl);
      if (path) result.seriesPath = path;
      continue;
    }

    if (raw === null || raw === undefined || raw === '') continue;
    if (Array.isArray(raw) && raw.length === 0 && !['playerServers', 'downloads', 'episodes', 'genres', 'related'].includes(key)) continue;

    const normalized = publicValue(raw, key, baseUrl);
    if (normalized !== undefined) result[key] = normalized;
  }

  if (value.groups && result.groups) {
    result.count = Object.values(result.groups).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
  }

  // Keep an empty stream/download list: clients can distinguish an empty result from a missing field.
  if (Array.isArray(value.playerServers) && !('playerServers' in result)) result.playerServers = [];
  if (Array.isArray(value.downloads) && !('downloads' in result)) result.downloads = [];
  return result;
}

function publicValue(value, key, baseUrl) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return compactObject(value, key, baseUrl);
  return value;
}

export function toPublicData(data, baseUrl) {
  return publicValue(data, 'data', baseUrl);
}

export function filterPublicServerConfigs(configs) {
  return (Array.isArray(configs) ? configs : []).map(server => ({
    name: server.nickname || server.name,
    enabled: server.enabled !== false,
    order: Number.isFinite(Number(server.order)) ? Number(server.order) : 999
  })).filter(server => server.name);
}

export { languageCategory, relativeInternalPath };
