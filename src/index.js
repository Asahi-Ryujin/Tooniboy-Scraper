import {
  parseGenres, parseListing, parseHome, parseDetail, parseEpisode,
  parseMovie, parseSeason, normalizeServerConfig, parseServerConfigJson
} from './parsers.js';

const VERSION = '1.0.0';
const SITE_HOSTS = new Set(['tooniboy.xyz', 'www.tooniboy.xyz']);
const encoder = new TextEncoder();
const MAX_PAGE_BYTES_DEFAULT = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CACHE_TTL = 120;

function asInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function siteBase(env) {
  const raw = env.SITE_BASE_URL || 'https://tooniboy.xyz';
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !SITE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('SITE_BASE_URL must use https://tooniboy.xyz or https://www.tooniboy.xyz');
  }
  return url.origin;
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
  return parts.map(part => encodeURIComponent(part).replace(/%3A/gi, ':').replace(/%27/gi, "'").replace(/%26/gi, '&').replace(/%2C/gi, ',').replace(/%21/gi, '!').replace(/%28/gi, '(').replace(/%29/gi, ')')).join('/');
}

function httpError(status, code, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const configured = String(env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);
  const allowAll = configured.includes('*');
  const allowed = !origin || allowAll || configured.includes(origin);
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  if (origin && allowed) headers.set('Access-Control-Allow-Origin', allowAll ? '*' : origin);
  else if (!origin && allowAll) headers.set('Access-Control-Allow-Origin', '*');
  return headers;
}

async function readLimitedText(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw httpError(502, 'upstream_too_large', 'The upstream page exceeded the configured response-size limit.');
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
        try { await reader.cancel('response_limit_exceeded'); } catch {}
        throw httpError(502, 'upstream_too_large', 'The upstream page exceeded the configured response-size limit.');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8').decode(bytes);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAes128Key(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  // SHA-256 gives 32 bytes. First 16 bytes provide the 128-bit AES key requested.
  const rawAes128 = new Uint8Array(digest).slice(0, 16);
  return crypto.subtle.importKey('raw', rawAes128, { name: 'AES-GCM' }, false, ['encrypt']);
}

async function encryptPayload(payload, secret) {
  if (!secret || String(secret).length < 16) {
    throw httpError(503, 'missing_aes_key', 'Worker secret AES_KEY is missing or too short. Configure a random secret of at least 16 characters.');
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

async function jsonResponse(request, env, payload, status = 200, extraHeaders = {}) {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-API-Encryption', 'AES-128-GCM');
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, String(value));
  let envelope;
  try {
    envelope = await encryptPayload(payload, env.AES_KEY);
  } catch (error) {
    if (error.code === 'missing_aes_key') {
      headers.delete('X-API-Encryption');
      return new Response(JSON.stringify({ success: false, error: { code: error.code, message: error.message } }), { status: 503, headers });
    }
    throw error;
  }
  return new Response(JSON.stringify(envelope), { status, headers });
}

async function plainJsonResponse(request, env, payload, status = 200) {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(payload), { status, headers });
}

async function fetchSite(path, env, options = {}) {
  const base = siteBase(env);
  let target = new URL(path, `${base}/`);
  if (target.origin !== base) throw httpError(400, 'invalid_upstream', 'Only the configured Tooniboy origin can be fetched.');
  const timeoutMs = asInt(env.REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 30_000);
  const maxBytes = asInt(env.MAX_HTML_BYTES, MAX_PAGE_BYTES_DEFAULT, 128 * 1024, 10 * 1024 * 1024);
  const ttl = options.xhr ? 0 : asInt(env.CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL, 0, 3600);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('upstream_timeout'), timeoutMs);
  const headers = new Headers({
    'Accept': options.json ? 'application/json,text/plain,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': env.ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
    'User-Agent': env.UPSTREAM_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  });
  if (options.xhr) headers.set('X-Requested-With', 'XMLHttpRequest');
  if (options.referer) headers.set('Referer', new URL(options.referer, `${base}/`).href);
  try {
    let response;
    let redirects = 0;
    while (true) {
      response = await fetch(target.href, {
        method: 'GET', headers, redirect: 'manual', signal: controller.signal,
        ...(ttl > 0 ? { cf: { cacheTtl: ttl, cacheEverything: true } } : {})
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || redirects >= 5) {
        try { await response.body?.cancel(); } catch {}
        throw httpError(502, 'redirect_limit', 'Upstream returned a missing redirect target or exceeded the redirect limit.');
      }
      const next = new URL(location, target.href);
      if (next.protocol !== 'https:' || !SITE_HOSTS.has(next.hostname.toLowerCase())) {
        try { await response.body?.cancel(); } catch {}
        throw httpError(502, 'unsafe_redirect', 'Upstream redirect target is outside the permitted HTTPS Tooniboy hosts.');
      }
      try { await response.body?.cancel(); } catch {}
      target = next;
      redirects++;
    }
    const finalUrl = response.url ? new URL(response.url) : target;
    if (!SITE_HOSTS.has(finalUrl.hostname.toLowerCase()) || finalUrl.protocol !== 'https:') {
      throw httpError(502, 'unsafe_redirect', 'Upstream response came from outside the permitted Tooniboy host.');
    }
    if (!response.ok) {
      throw httpError(response.status >= 400 && response.status < 500 ? 502 : 503, 'upstream_http_error', `Tooniboy returned HTTP ${response.status}.`, { upstreamStatus: response.status, path: target.pathname });
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw httpError(502, 'upstream_too_large', 'The upstream page exceeded the configured response-size limit.');
    const body = await readLimitedText(response, maxBytes);
    if (!options.json && /(?:Just a moment\.\.\.|cf-chl-|challenge-platform|Attention Required! \| Cloudflare)/i.test(body.slice(0, 150_000))) {
      throw httpError(502, 'upstream_challenge', 'Tooniboy returned a bot/challenge page instead of the requested HTML. The Worker does not attempt to bypass it.');
    }
    return { body, url: finalUrl.href, status: response.status, contentType: response.headers.get('content-type') || '' };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error === 'upstream_timeout') throw httpError(504, 'upstream_timeout', `Tooniboy request timed out after ${timeoutMs} ms.`);
    if (error?.status) throw error;
    throw httpError(502, 'upstream_fetch_failed', error?.message || 'Failed to fetch Tooniboy.');
  } finally {
    clearTimeout(timer);
  }
}

function categoryPagePath(slug, type, page) {
  const safeSlug = safePathPart(slug, true);
  const params = new URLSearchParams();
  params.set('type', type);
  params.set('page', String(page));
  return `/category/${safeSlug}?${params.toString()}`;
}

function listingType(value) {
  const type = String(value || 'all').toLowerCase();
  if (!['all', 'series', 'movies'].includes(type)) throw httpError(400, 'invalid_type', 'type must be all, series, or movies.');
  return type;
}

function wrapData(data, source, extra = {}) {
  return {
    success: true,
    api: 'tooniboy-worker',
    version: VERSION,
    source: { site: 'tooniboy.xyz', url: source, retrievedAt: new Date().toISOString() },
    data,
    ...extra
  };
}

async function getServerConfigs(base, env) {
  try {
    const result = await fetchSite('/public/servers', env, { json: true, referer: `${base}/` });
    let parsed;
    try { parsed = JSON.parse(result.body); }
    catch { return []; }
    return parseServerConfigJson(parsed);
  } catch {
    return [];
  }
}

function pathFromSlug(prefix, slug) {
  return `/${prefix}/${safePathPart(slug)}`;
}

async function routeApi(request, env, ctx) {
  const base = siteBase(env);
  const incoming = new URL(request.url);
  const path = incoming.pathname.replace(/\/+$/, '') || '/';
  const q = incoming.searchParams;

  if (path === '/api/health') {
    return jsonResponse(request, env, wrapData({ status: 'ok', encryption: 'AES-128-GCM', sourceHost: 'tooniboy.xyz' }, `${base}/`));
  }

  if (path === '/api/home') {
    const page = await fetchSite('/home', env);
    return jsonResponse(request, env, wrapData(parseHome(page.body, page.url), page.url));
  }

  if (path === '/api/genres') {
    const page = await fetchSite('/home', env);
    const data = parseGenres(page.body, page.url);
    const group = String(q.get('group') || '').toLowerCase();
    if (group) {
      if (!data.groups[group]) throw httpError(404, 'genre_group_not_found', `Unknown genre group: ${group}`);
      data.genres = data.groups[group];
      data.count = data.genres.length;
    }
    return jsonResponse(request, env, wrapData(data, page.url));
  }

  const genreMatch = path.match(/^\/api\/(?:genre|genres|category)\/(.+)$/i);
  if (genreMatch) {
    const slug = genreMatch[1];
    const type = listingType(q.get('type'));
    const pageNo = asInt(q.get('page'), 1, 1, 500);
    const upstreamPath = categoryPagePath(slug, type, pageNo);
    const page = await fetchSite(upstreamPath, env);
    const data = parseListing(page.body, page.url, { category: decodeURIComponent(slug), type });
    return jsonResponse(request, env, wrapData(data, page.url));
  }

  if (path === '/api/catalog') {
    const type = listingType(q.get('type'));
    const pageNo = asInt(q.get('page'), 1, 1, 500);
    const page = await fetchSite(`/category/anime?${new URLSearchParams({ type, page: String(pageNo) })}`, env);
    const data = parseListing(page.body, page.url, { category: 'anime', type });
    return jsonResponse(request, env, wrapData(data, page.url));
  }

  if (path === '/api/search') {
    const term = String(q.get('q') || q.get('s') || '').trim();
    if (term.length < 2 || term.length > 100) throw httpError(400, 'invalid_query', 'q must contain 2 to 100 characters.');
    const pageNo = asInt(q.get('page'), 1, 1, 500);
    const searchParams = new URLSearchParams({ s: term, ...(pageNo > 1 ? { page: String(pageNo) } : {}) });
    const page = await fetchSite(`/?${searchParams.toString()}`, env);
    const data = parseListing(page.body, page.url, { type: 'search' });
    data.query = term;
    return jsonResponse(request, env, wrapData(data, page.url));
  }

  if (path === '/api/servers') {
    const configs = await getServerConfigs(base, env);
    return jsonResponse(request, env, wrapData({ count: configs.length, servers: configs }, `${base}/public/servers`));
  }

  const seasonMatch = path.match(/^\/api\/season\/([^/]+)\/(\d+)$/i);
  if (seasonMatch) {
    const slug = safePathPart(seasonMatch[1]);
    const season = asInt(seasonMatch[2], 1, 1, 100);
    const seriesPath = `/series/${slug}`;
    const detailPage = await fetchSite(seriesPath, env);
    const detail = parseDetail(detailPage.body, detailPage.url, { kind: 'series' });
    const seasonRecord = detail.seasons.find(x => Number(x.season) === season);
    const seasonPath = seasonRecord?.path || `${seriesPath}/season/${season}`;
    const page = await fetchSite(seasonPath, env, { xhr: true, referer: detailPage.url });
    const data = parseSeason(page.body, page.url, seriesPath, season);
    data.series = { title: detail.title, url: detailPage.url };
    data.requestHeaders = { 'X-Requested-With': 'XMLHttpRequest' };
    return jsonResponse(request, env, wrapData(data, page.url));
  }

  const episodeMatch = path.match(/^\/api\/episode\/(.+)$/i);
  if (episodeMatch) {
    const episodePath = pathFromSlug('episode', episodeMatch[1]);
    const [page, configs] = await Promise.all([
      fetchSite(episodePath, env), getServerConfigs(base, env)
    ]);
    const data = parseEpisode(page.body, page.url, configs);
    return jsonResponse(request, env, wrapData(data, page.url));
  }

  const movieMatch = path.match(/^\/api\/(?:movie|movies)\/(.+)$/i);
  if (movieMatch) {
    const moviePath = pathFromSlug('movies', movieMatch[1]);
    const [page, configs] = await Promise.all([
      fetchSite(moviePath, env), getServerConfigs(base, env)
    ]);
    const data = parseMovie(page.body, page.url, configs);
    return jsonResponse(request, env, wrapData(data, page.url));
  }

  const seriesMatch = path.match(/^\/api\/series\/(.+)$/i);
  if (seriesMatch) {
    const seriesPath = pathFromSlug('series', seriesMatch[1]);
    const page = await fetchSite(seriesPath, env);
    const data = parseDetail(page.body, page.url, { kind: 'series' });
    return jsonResponse(request, env, wrapData(data, page.url));
  }

  if (path === '/api/details') {
    const raw = String(q.get('path') || '');
    if (!/^\/(?:series|movies|episode)\//i.test(raw)) throw httpError(400, 'invalid_detail_path', 'path must begin with /series/, /movies/, or /episode/.');
    const safe = safePathPart(raw.replace(/^\//, ''), true);
    const upstreamPath = `/${safe}`;
    const page = await fetchSite(upstreamPath, env);
    let data;
    if (/^\/episode\//i.test(upstreamPath)) {
      const configs = await getServerConfigs(base, env);
      data = parseEpisode(page.body, page.url, configs);
    } else if (/^\/movies\//i.test(upstreamPath)) {
      const configs = await getServerConfigs(base, env);
      data = parseMovie(page.body, page.url, configs);
    } else {
      data = parseDetail(page.body, page.url, { kind: 'series' });
    }
    return jsonResponse(request, env, wrapData(data, page.url));
  }

  throw httpError(404, 'route_not_found', 'Unknown endpoint. See README.md for supported routes.');
}

async function handle(request, env = {}, ctx = {}) {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    const headers = corsHeaders(request, env);
    return new Response(null, { status: 204, headers });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return jsonResponse(request, env, { success: false, api: 'tooniboy-worker', version: VERSION, error: { code: 'method_not_allowed', message: 'Only GET, HEAD, and OPTIONS are supported.' } }, 405);
  }
  const path = new URL(request.url).pathname;
  if (path === '/' || path === '/health' || path === '/healthz') {
    const response = await plainJsonResponse(request, env, { success: true, service: 'tooniboy-worker-api', version: VERSION, status: 'ok' });
    return method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }
  try {
    const response = await routeApi(request, env, ctx);
    if (method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
  } catch (error) {
    const status = Number(error?.status) || 500;
    const payload = {
      success: false,
      api: 'tooniboy-worker',
      version: VERSION,
      error: {
        code: error?.code || 'internal_error',
        message: error?.message || 'Unexpected Worker error.',
        ...(error?.details ? { details: error.details } : {})
      }
    };
    try { return await jsonResponse(request, env, payload, status); }
    catch (encryptionError) {
      return plainJsonResponse(request, env, {
        success: false,
        error: { code: encryptionError?.code || 'response_encryption_failed', message: encryptionError?.message || 'Could not encrypt API response.' }
      }, Number(encryptionError?.status) || 503);
    }
  }
}

export default { fetch: handle };
export { handle, encryptPayload, deriveAes128Key, fetchSite };
