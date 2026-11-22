import {
  parseGenres,
  parseListing,
  parseHome,
  parseDetail,
  parseEpisode,
  parseMovie,
  parseSeason,
  parseServerConfigJson
} from './parsers.js';
import { toPublicData, safeInternalPath, filterPublicServerConfigs } from './normalize.js';

const VERSION = '1.3.0';
const encoder = new TextEncoder();
const MAX_HTML_BYTES_DEFAULT = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CACHE_TTL = 120;
const MAX_REDIRECTS = 5;

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function asInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin, env) {
  if (!origin) return true;
  const list = allowedOrigins(env);
  return list.includes('*') || list.includes(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  if (origin && isOriginAllowed(origin, env)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function authorize(request, env) {
  const configured = String(env.API_ACCESS_TOKEN || '');
  if (!configured) return;
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !constantTimeEqual(match[1], configured)) {
    throw httpError(401, 'unauthorized', 'A valid bearer token is required.');
  }
}

async function enforceRateLimit(request, env, path) {
  const limiter = env.API_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') {
    throw httpError(503, 'rate_limiter_unavailable', 'The API rate-limit binding is not configured.');
  }
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown-client';
  const delta = path === '/api/search' ? 3
    : /^\/api\/season\//.test(path) || /^\/api\/series\/[^/]+\/season\//.test(path) ? 4
      : /^\/api\/(?:series|movie|movies|episode)\//.test(path) ? 2 : 1;
  let result;
  try {
    result = await limiter.limit({ key: clientIp, delta });
  } catch {
    throw httpError(503, 'rate_limiter_error', 'The API rate-limit service is temporarily unavailable.');
  }
  if (!result?.success) throw httpError(429, 'rate_limit_exceeded', 'Request limit exceeded. Retry later.');
}

function siteBase(env) {
  const raw = String(env.UPSTREAM_BASE_URL || '').trim();
  if (!raw) throw httpError(503, 'upstream_not_configured', 'The upstream origin is not configured.');
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw httpError(503, 'upstream_not_configured', 'The upstream origin configuration is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw httpError(503, 'upstream_not_configured', 'UPSTREAM_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  return parsed.origin;
}

function safePathPart(raw, allowNested = false) {
  let decoded;
  try { decoded = decodeURIComponent(String(raw || '')); }
  catch { throw httpError(400, 'invalid_path', 'Path contains invalid URL encoding.'); }
  if (!decoded || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('?') || decoded.includes('#')) {
    throw httpError(400, 'invalid_path', 'Invalid path segment.');
  }
  const parts = allowNested ? decoded.split('/') : [decoded];
  if (parts.some(part => !part || part === '.' || part === '..' || !/^[\p{L}\p{N}_.,!()'’&:+% -]+$/u.test(part))) {
    throw httpError(400, 'invalid_path', 'Path contains unsupported characters.');
  }
  return parts.map(part => encodeURIComponent(part)
    .replace(/%3A/gi, ':').replace(/%27/gi, "'").replace(/%26/gi, '&')
    .replace(/%2C/gi, ',').replace(/%21/gi, '!').replace(/%28/gi, '(')
    .replace(/%29/gi, ')')).join('/');
}

function listingType(value) {
  const type = String(value || 'all').toLowerCase();
  if (!['all', 'series', 'movies'].includes(type)) {
    throw httpError(400, 'invalid_type', 'type must be all, series, or movies.');
  }
  return type;
}

function pageNumber(value) {
  if (value != null && !/^\d+$/.test(String(value))) {
    throw httpError(400, 'invalid_page', 'page must be a positive integer.');
  }
  return asInt(value, 1, 1, 500);
}

function categoryPagePath(slug, type, page) {
  const safeSlug = safePathPart(slug, true);
  const params = new URLSearchParams({ type, page: String(page) });
  return `/category/${safeSlug}?${params.toString()}`;
}

async function readLimitedText(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (encoder.encode(text).byteLength > maxBytes) {
      throw httpError(502, 'upstream_too_large', 'Upstream content exceeded the configured size limit.');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('response_limit_exceeded'); } catch { /* ignore */ }
        throw httpError(502, 'upstream_too_large', 'Upstream content exceeded the configured size limit.');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function fetchSite(path, env, options = {}) {
  const base = siteBase(env);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw httpError(400, 'invalid_upstream_path', 'Only relative paths on the configured upstream origin are allowed.');
  }
  const target = new URL(path, `${base}/`);
  if (target.protocol !== 'https:' || target.origin !== base) {
    throw httpError(400, 'invalid_upstream_path', 'The requested path resolves outside the configured upstream origin.');
  }

  const timeoutMs = asInt(env.REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 30_000);
  const maxBytes = asInt(env.MAX_HTML_BYTES, MAX_HTML_BYTES_DEFAULT, 128 * 1024, 10 * 1024 * 1024);
  const ttl = options.xhr ? 0 : asInt(env.CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL, 0, 3600);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('upstream_timeout'), timeoutMs);
  const headers = new Headers({
    'Accept': options.json ? 'application/json,text/plain,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': env.ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
    'User-Agent': env.UPSTREAM_USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  });
  if (options.xhr) headers.set('X-Requested-With', 'XMLHttpRequest');
  if (options.referer) {
    const referer = new URL(options.referer, `${base}/`);
    if (referer.protocol !== 'https:' || referer.origin !== base) {
      throw httpError(400, 'invalid_referer', 'The XHR referer must belong to the configured upstream origin.');
    }
    headers.set('Referer', referer.href);
  }

  let current = target;
  try {
    let response;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(current.href, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
        ...(ttl > 0 ? { cf: { cacheTtl: ttl, cacheEverything: true } } : {})
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || redirects >= MAX_REDIRECTS) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        throw httpError(502, 'redirect_limit', 'Upstream redirect limit exceeded.');
      }
      const next = new URL(location, current.href);
      if (next.protocol !== 'https:' || next.origin !== base) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        throw httpError(502, 'unsafe_redirect', 'Upstream attempted to redirect outside the configured origin.');
      }
      try { await response.body?.cancel(); } catch { /* ignore */ }
      current = next;
    }

    const finalUrl = response.url ? new URL(response.url) : current;
    if (finalUrl.protocol !== 'https:' || finalUrl.origin !== base) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw httpError(502, 'unsafe_redirect', 'Upstream response came from an unexpected origin.');
    }
    if (response.status === 404) throw httpError(404, 'content_not_found', 'The requested upstream content was not found.');
    if (response.status === 429) throw httpError(503, 'upstream_throttled', 'The upstream service is rate-limiting requests.');
    if (!response.ok) {
      throw httpError(response.status >= 500 ? 503 : 502, 'upstream_http_error', `Upstream returned HTTP ${response.status}.`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw httpError(502, 'upstream_too_large', 'Upstream content exceeded the configured size limit.');
    const body = await readLimitedText(response, maxBytes);
    if (!options.json && /(?:Just a moment\.\.\.|cf-chl-|challenge-platform|Attention Required! \| Cloudflare)/i.test(body.slice(0, 150_000))) {
      throw httpError(502, 'upstream_challenge', 'Upstream returned an access challenge rather than the requested content.');
    }
    return { body, url: finalUrl.href, status: response.status, contentType: response.headers.get('content-type') || '' };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error === 'upstream_timeout') {
      throw httpError(504, 'upstream_timeout', `Upstream request timed out after ${timeoutMs} ms.`);
    }
    if (error?.status) throw error;
    throw httpError(502, 'upstream_fetch_failed', 'Could not retrieve the requested content from the upstream service.');
  } finally {
    clearTimeout(timer);
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function deriveAes128Key(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  const rawKey = new Uint8Array(digest).slice(0, 16);
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
}

async function encryptPayload(payload, secret) {
  if (!secret || String(secret).length < 32) {
    throw httpError(503, 'missing_aes_key', 'AES_KEY must be configured as a high-entropy secret of at least 32 characters.');
  }
  const key = await deriveAes128Key(String(secret));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plaintext);
  return {
    encrypted: true,
    version: 1,
    algorithm: 'AES-128-GCM',
    kdf: 'SHA-256(AES_KEY), first 16 bytes',
    encoding: 'base64',
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted))
  };
}

async function jsonResponse(request, env, payload, status = 200) {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-API-Encryption', 'AES-128-GCM');
  try {
    const envelope = await encryptPayload(payload, env.AES_KEY);
    return new Response(JSON.stringify(envelope), { status, headers });
  } catch (error) {
    headers.delete('X-API-Encryption');
    if (error?.code === 'missing_aes_key') {
      return new Response(JSON.stringify({ success: false, error: { code: error.code, message: error.message } }), {
        status: 503, headers
      });
    }
    throw error;
  }
}

async function plainJsonResponse(request, env, payload, status = 200) {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(payload), { status, headers });
}

function wrapData(data, baseUrl = '', env = {}) {
  return { success: true, version: VERSION, data: toPublicData(data, baseUrl, env.MEDIA_ALLOWED_HOSTS || '') };
}

async function getServerConfigs(base, env) {
  try {
    const result = await fetchSite('/public/servers', env, { json: true, referer: `${base}/` });
    const parsed = JSON.parse(result.body);
    return parseServerConfigJson(parsed);
  } catch {
    // The server mapping service is an optional upstream helper. Player URLs
    // found directly in the page remain usable when this endpoint is absent.
    return [];
  }
}

function detailRoutePath(prefix, slug) {
  return `/${prefix}/${safePathPart(slug)}`;
}

async function detailResponse(request, env, base, upstreamPath, kind) {
  const needsServerConfig = kind === 'episode' || kind === 'movie';
  const [page, configs] = await Promise.all([
    fetchSite(upstreamPath, env),
    needsServerConfig ? getServerConfigs(base, env) : Promise.resolve([])
  ]);
  let data;
  if (kind === 'episode') data = parseEpisode(page.body, page.url, configs);
  else if (kind === 'movie') data = parseMovie(page.body, page.url, configs);
  else data = parseDetail(page.body, page.url, { kind: 'series' });
  return jsonResponse(request, env, wrapData(data, base, env));
}

async function routeApi(request, env) {
  const incoming = new URL(request.url);
  const path = incoming.pathname.replace(/\/+$/, '') || '/';
  const query = incoming.searchParams;

  if (path === '/api/health') {
    return jsonResponse(request, env, wrapData({ status: 'ok', apiVersion: VERSION, encryption: 'AES-128-GCM' }, '', env));
  }

  const base = siteBase(env);

  if (path === '/api/home' || path === '/api/homepage') {
    const page = await fetchSite('/home', env);
    return jsonResponse(request, env, wrapData(parseHome(page.body, page.url), base, env));
  }

  if (path === '/api/genres' || path === '/api/categories' || path === '/api/languages' || path === '/api/networks') {
    const page = await fetchSite('/home', env);
    const parsed = parseGenres(page.body, page.url);
    if (path === '/api/languages' || path === '/api/networks') {
      const group = path === '/api/languages' ? 'language' : 'networks';
      const items = parsed.groups[group] || [];
      return jsonResponse(request, env, wrapData({ group, count: items.length, items }, base, env));
    }
    const group = String(query.get('group') || '').trim().toLowerCase();
    if (group) {
      if (!Object.hasOwn(parsed.groups, group)) throw httpError(404, 'genre_group_not_found', 'The requested category group was not found.');
      const items = parsed.groups[group];
      return jsonResponse(request, env, wrapData({ group, count: items.length, items }, base, env));
    }
    return jsonResponse(request, env, wrapData(parsed, base, env));
  }

  const genreMatch = path.match(/^\/api\/(?:genre|category|genres|categories|network|networks)\/(.+)$/i);
  if (genreMatch) {
    const slug = safePathPart(genreMatch[1], true);
    const type = listingType(query.get('type'));
    const pageNo = pageNumber(query.get('page'));
    const upstreamPath = categoryPagePath(slug, type, pageNo);
    const page = await fetchSite(upstreamPath, env);
    const data = parseListing(page.body, page.url, { category: slug, type });
    return jsonResponse(request, env, wrapData(data, base, env));
  }

  const languageMatch = path.match(/^\/api\/(?:language|languages)\/(.+)$/i);
  if (languageMatch) {
    let slug = safePathPart(languageMatch[1], true);
    if (!slug.toLowerCase().startsWith('language/')) slug = `language/${slug}`;
    const type = listingType(query.get('type'));
    const pageNo = pageNumber(query.get('page'));
    const upstreamPath = categoryPagePath(slug, type, pageNo);
    const page = await fetchSite(upstreamPath, env);
    const data = parseListing(page.body, page.url, { category: slug, type });
    return jsonResponse(request, env, wrapData(data, base, env));
  }

  if (path === '/api/movies' || path === '/api/series') {
    const defaultType = path === '/api/movies' ? 'movies' : 'series';
    const type = listingType(query.get('type') || defaultType);
    const pageNo = pageNumber(query.get('page'));
    // The captured taxonomy uses the shared /category/anime endpoint with a
    // type filter; it does not establish a dedicated /category/movies route.
    const category = 'anime';
    const params = new URLSearchParams({ type, page: String(pageNo) });
    const page = await fetchSite(`/category/${category}?${params.toString()}`, env);
    const data = parseListing(page.body, page.url, { category, type });
    return jsonResponse(request, env, wrapData(data, base, env));
  }

  if (path === '/api/catalog') {
    const type = listingType(query.get('type'));
    const pageNo = pageNumber(query.get('page'));
    const category = safePathPart(query.get('category') || 'anime', true);
    const params = new URLSearchParams({ type, page: String(pageNo) });
    const page = await fetchSite(`/category/${category}?${params.toString()}`, env);
    const data = parseListing(page.body, page.url, { category, type });
    return jsonResponse(request, env, wrapData(data, base, env));
  }

  if (path === '/api/listing') {
    const rawPath = String(query.get('path') || '');
    if (!rawPath.startsWith('/category/')) throw httpError(400, 'invalid_listing_path', 'path must begin with /category/.');
    const clean = safeInternalPath(rawPath);
    if (!clean || clean.split('/').filter(Boolean).length < 2) throw httpError(400, 'invalid_listing_path', 'Invalid category path.');
    const slug = safePathPart(clean.replace(/^\/category\//, '').replace(/\/$/, ''), true);
    const type = listingType(query.get('type'));
    const pageNo = pageNumber(query.get('page'));
    const page = await fetchSite(categoryPagePath(slug, type, pageNo), env);
    const data = parseListing(page.body, page.url, { category: slug, type });
    return jsonResponse(request, env, wrapData(data, base, env));
  }

  if (path === '/api/search') {
    const term = String(query.get('q') || query.get('s') || '').trim();
    if (term.length < 2 || term.length > 100 || /[\u0000-\u001f]/.test(term)) {
      throw httpError(400, 'invalid_query', 'q must contain 2 to 100 printable characters.');
    }
    const pageNo = pageNumber(query.get('page'));
    const params = new URLSearchParams({ q: term });
    if (pageNo > 1) params.set('page', String(pageNo));
    const page = await fetchSite(`/s?${params.toString()}`, env);
    const data = parseListing(page.body, page.url, { type: 'search' });
    data.query = term;
    return jsonResponse(request, env, wrapData(data, base, env));
  }

  const seasonMatch = path.match(/^\/api\/season\/([^/]+)\/(\d+)$/i)
    || path.match(/^\/api\/series\/([^/]+)\/season\/(\d+)$/i);
  if (seasonMatch) {
    const seriesSlug = safePathPart(seasonMatch[1]);
    const season = asInt(seasonMatch[2], 1, 1, 100);
    const seriesPath = `/series/${seriesSlug}`;
    const detailPage = await fetchSite(seriesPath, env);
    const detail = parseDetail(detailPage.body, detailPage.url, { kind: 'series' });
    const record = detail.seasons.find(item => Number(item.season) === season);
    if (!record) throw httpError(404, 'season_not_found', 'The requested season is not listed for this series.');
    const seasonPath = safeInternalPath(record.path) || `${seriesPath}/season/${season}`;
    const page = await fetchSite(seasonPath, env, { xhr: true, referer: detailPage.url });
    const data = parseSeason(page.body, page.url, seriesPath, season);
    data.series = { title: detail.title, path: seriesPath };
    return jsonResponse(request, env, wrapData(data, base, env));
  }

  const episodeMatch = path.match(/^\/api\/episode\/(.+)$/i);
  if (episodeMatch) {
    const upstreamPath = detailRoutePath('episode', episodeMatch[1]);
    return detailResponse(request, env, base, upstreamPath, 'episode');
  }

  const movieMatch = path.match(/^\/api\/(?:movie|movies)\/(.+)$/i);
  if (movieMatch) {
    const upstreamPath = detailRoutePath('movies', movieMatch[1]);
    return detailResponse(request, env, base, upstreamPath, 'movie');
  }

  const seriesMatch = path.match(/^\/api\/series\/(.+)$/i);
  if (seriesMatch) {
    const upstreamPath = detailRoutePath('series', seriesMatch[1]);
    return detailResponse(request, env, base, upstreamPath, 'series');
  }

  if (path === '/api/details') {
    const rawPath = String(query.get('path') || '');
    const clean = safeInternalPath(rawPath);
    if (!clean) throw httpError(400, 'invalid_detail_path', 'A valid relative detail path is required.');
    const parts = clean.split('/').filter(Boolean);
    if (parts.length !== 2 || !['series', 'movies', 'episode'].includes(parts[0])) {
      throw httpError(400, 'invalid_detail_path', 'path must be /series/:slug, /movies/:slug, or /episode/:slug.');
    }
    const upstreamPath = `/${parts[0]}/${safePathPart(parts[1])}`;
    const kind = parts[0] === 'series' ? 'series' : parts[0] === 'movies' ? 'movie' : 'episode';
    return detailResponse(request, env, base, upstreamPath, kind);
  }

  if (path === '/api/servers') {
    const configs = await getServerConfigs(base, env);
    const servers = filterPublicServerConfigs(configs);
    return jsonResponse(request, env, wrapData({ count: servers.length, servers }, base, env));
  }

  throw httpError(404, 'route_not_found', 'The requested API endpoint does not exist.');
}

async function handle(request, env = {}) {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const path = url.pathname;

  if (!isOriginAllowed(request.headers.get('Origin'), env)) {
    return plainJsonResponse(request, env, { success: false, error: { code: 'origin_not_allowed', message: 'This origin is not permitted.' } }, 403);
  }

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

  if (path === '/' || path === '/health' || path === '/healthz') {
    if (method !== 'GET' && method !== 'HEAD') {
      const response = await plainJsonResponse(request, env, { success: false, error: { code: 'method_not_allowed', message: 'Only GET, HEAD, and OPTIONS are supported.' } }, 405);
      return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    const response = await plainJsonResponse(request, env, { success: true, service: 'media-catalog-api', version: VERSION, status: 'ok' });
    return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }

  if (!path.startsWith('/api/')) {
    const response = await plainJsonResponse(request, env, { success: false, error: { code: 'route_not_found', message: 'The requested endpoint does not exist.' } }, 404);
    return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    const response = await jsonResponse(request, env, { success: false, version: VERSION, error: { code: 'method_not_allowed', message: 'Only GET, HEAD, and OPTIONS are supported.' } }, 405);
    return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }

  try {
    if (path.startsWith('/api/')) {
      authorize(request, env);
      if (path !== '/api/health') await enforceRateLimit(request, env, path);
    }
    const response = await routeApi(request, env);
    return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  } catch (error) {
    const status = Number(error?.status) || 500;
    const payload = {
      success: false,
      version: VERSION,
      error: {
        code: error?.code || 'internal_error',
        message: error?.message || 'Unexpected Worker error.'
      }
    };
    try {
      const response = await jsonResponse(request, env, payload, status);
      return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    } catch (encryptionError) {
      const response = await plainJsonResponse(request, env, {
        success: false,
        error: {
          code: encryptionError?.code || 'response_encryption_failed',
          message: encryptionError?.message || 'Could not encrypt the API response.'
        }
      }, Number(encryptionError?.status) || 503);
      return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
  }
}

export default { fetch: handle };
export { handle, encryptPayload, deriveAes128Key, fetchSite };
