// htvstream:// protocol: fetches a captured stream on the player's behalf and rewrites
// playlists so every segment, key and sub-playlist also goes through the proxy.
//
// Upstream requests go through the embed's own Chromium session (its cookies, TLS
// handling and network stack). A marker header tells that session's onBeforeSendHeaders
// hook (see decorate()) to add the Referer/Origin/User-Agent the embed used.
//
// URL shape: htvstream://s/<contextId>?u=<encoded upstream url>

const { protocol } = require("electron");
const crypto = require("crypto");

const SCHEME = "htvstream";
const MARKER = "x-htv-ctx";
const contexts = new Map(); // contextId -> headers
const MAX_CONTEXTS = 20;

function registerScheme() {
  // Must run before the app is ready.
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

function addContext(headers) {
  const id = crypto.randomBytes(8).toString("hex");
  contexts.set(id, headers);
  if (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value);
  return id;
}

function proxify(id, url) {
  return `${SCHEME}://s/${id}?u=${encodeURIComponent(url)}`;
}

function rewritePlaylist(text, baseUrl, id) {
  const abs = u => {
    try { return proxify(id, new URL(u, baseUrl).href); } catch { return u; }
  };
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u)}"`);
    return abs(t);
  }).join("\n");
}

function isPlaylist(url, contentType) {
  return /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(contentType);
}

// Chromium's fetch leaves Response.url empty, so fall back to the requested URL.
const finalUrl = (res, target) => res.url || target;

// Upstream fetch through the embed's session, tagged so decorate() adds its headers.
function upstream(fetchSession, id, target, extra = {}) {
  return fetchSession.fetch(target, {
    headers: { [MARKER]: id, ...extra },
    cache: "no-store",
    bypassCustomProtocolHandlers: true,
    signal: AbortSignal.timeout(15000),
  });
}

// True if the captured playlist actually loads (a request being made doesn't mean it works).
async function probe(fetchSession, id, url) {
  try {
    const res = await upstream(fetchSession, id, url);
    return res.ok && (await res.text()).trimStart().startsWith("#EXTM3U");
  } catch {
    return false;
  }
}

// For onBeforeSendHeaders on the fetching session: swap the marker for the real headers.
function decorate(requestHeaders) {
  const key = Object.keys(requestHeaders).find(k => k.toLowerCase() === MARKER);
  if (!key) return;
  const headers = contexts.get(requestHeaders[key]);
  delete requestHeaders[key];
  if (!headers) return;
  for (const [k, v] of Object.entries(headers)) {
    for (const existing of Object.keys(requestHeaders)) {
      if (existing.toLowerCase() === k.toLowerCase()) delete requestHeaders[existing];
    }
    requestHeaders[k] = v;
  }
}

const CORS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

async function handle(request, fetchSession) {
  const reqUrl = new URL(request.url);
  const id = reqUrl.pathname.slice(1);
  const target = reqUrl.searchParams.get("u");
  if (!contexts.has(id) || !target || !/^https?:\/\//i.test(target)) {
    return new Response("unknown stream", { status: 404, headers: CORS });
  }

  const range = request.headers.get("range");

  let res;
  try {
    res = await upstream(fetchSession, id, target, range ? { Range: range } : {});
  } catch (err) {
    return new Response(String(err), { status: 502, headers: CORS });
  }

  const contentType = res.headers.get("content-type") || "";
  if (res.ok && isPlaylist(target, contentType)) {
    const text = await res.text();
    if (text.trimStart().startsWith("#EXTM3U")) {
      return new Response(rewritePlaylist(text, finalUrl(res, target), id), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }
    return new Response(text, { status: res.status, headers: { ...CORS, "Content-Type": contentType } });
  }

  const outHeaders = { ...CORS };
  // fetch() transparently decompresses, so the upstream length only holds for identity bodies.
  const passthrough = ["content-type", "content-range", "accept-ranges"];
  if (!res.headers.get("content-encoding")) passthrough.push("content-length");
  for (const h of passthrough) {
    const v = res.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

// Serve htvstream:// in `ses` (the player's session), fetching upstream via `fetchSession`.
function install(ses, fetchSession) {
  ses.protocol.handle(SCHEME, request => handle(request, fetchSession));
}

module.exports = { registerScheme, install, addContext, proxify, rewritePlaylist, decorate, probe };
