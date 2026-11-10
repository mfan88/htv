// Extra mirrors from SportSurge (v2.sportsurge.net). Its hockey page lists the games; a game's page lists
// links to third-party player pages, which the extractor loads like any other embed. The site sits behind a
// Cloudflare challenge, so pages are fetched through a Byparr instance (HTV_BYPARR_URL, a FlareSolverr-style
// API) and only for games close to their start: a solve costs several seconds of someone's browser.
//
// Records have the same shape as scraper.js's. A game onhockey also lists gets its links added to each of
// onhockey's channels for that game, as extra mirrors; any other game gets its own channel.
// mirrors() never waits for Byparr: it returns what earlier refreshes cached and starts a refresh in the
// background, so a slow solve can't hold up the schedule scrape.

const fs = require("fs");
const path = require("path");
const { Parser } = require("htmlparser2");
const { teamsIn, isTeamGame } = require("./stats");

const BASE = "https://v2.sportsurge.net/";
const LIST_URL = BASE + "watch-hockey-streams/";
const SOURCE_UTC_OFFSET = 1; // keeps the "HH:MM" we write in the same offset as onhockey's
const LEAD_MS = +(process.env.HTV_SPORTSURGE_LEAD_MIN || 60) * 60 * 1000; // pages are fetched from this long before the start
const REFRESH_MS = +(process.env.HTV_SPORTSURGE_REFRESH_MIN || 15) * 60 * 1000; // a cached page is refetched after this
const SOLVE_TIMEOUT_MS = 90 * 1000;

const cache = { list: null, games: new Map(), running: null }; // list: { at, rows }; games: page url -> { at, links }

// Byparr's address and token: the environment, else <HTV_DATA>/byparr.json ({ "url": "...", "token": "..." }).
// The file lives on the data volume, so a deployment needs no compose change and the token stays out of the image.
function config() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(process.env.HTV_DATA || "htv-data", "byparr.json"), "utf8")); } catch {}
  return { url: process.env.HTV_BYPARR_URL || file.url || "", token: process.env.HTV_BYPARR_TOKEN || file.token || "" };
}

// One Byparr request: the page's HTML once the challenge is solved.
async function byparr(url) {
  const { url: api, token } = config();
  if (!api) throw new Error("no Byparr address (HTV_BYPARR_URL or byparr.json in the data folder)");
  const res = await fetch(/\/v1\/?$/.test(api) ? api : api.replace(/\/$/, "") + "/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Byparr-Token": token } : {}) },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
    signal: AbortSignal.timeout(SOLVE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Byparr returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.solution?.status !== 200 || typeof body.solution.response !== "string") throw new Error(`${url}: ${body.message || "not solved"}`);
  return body.solution.response;
}

// The hockey page's games: [{ url, title: "Away - Home", start (ms) }].
function parseList(html) {
  const rows = [];
  let row = null;
  const parser = new Parser({
    onopentag(tag, attrs) {
      const cls = (attrs.class || "").split(/\s+/);
      if (tag === "a" && cls.includes("match-row") && attrs.href) row = { url: new URL(attrs.href, BASE).href, title: (attrs.title || "").trim(), start: null };
      else if (row && cls.includes("match-time") && row.start == null && +attrs["data-timestamp"]) row.start = +attrs["data-timestamp"] * 1000;
    },
    onclosetag(tag) {
      if (tag === "a" && row) { if (row.title && row.start != null) rows.push(row); row = null; }
    },
  });
  parser.write(html);
  parser.end();
  return rows;
}

// A stream's page as an extractor link: no scheme for https (like onhockey's "embed.st/embed/..."), kept for http.
function toLink(href) {
  try {
    const u = new URL(href);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return (u.protocol === "http:" ? "http://" : "") + u.host + u.pathname + u.search;
  } catch {
    return null;
  }
}

// A game page's stream links, each on a `.stream-item` as data-href.
function parseGame(html) {
  const links = [];
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (!(attrs.class || "").split(/\s+/).includes("stream-item")) return;
      const link = toLink(attrs["data-href"] || "");
      if (link && !links.includes(link)) links.push(link);
    },
  });
  parser.write(html);
  parser.end();
  return links;
}

const hhmm = ms => {
  const d = new Date(ms + SOURCE_UTC_OFFSET * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

// "Montreal Canadiens - Chicago Blackhawks" -> ["MTL", "CHI"], or null if either side isn't an NHL team.
function pairOf(title) {
  const abbrs = teamsIn(title);
  return abbrs.length === 2 && abbrs[0] !== abbrs[1] ? abbrs : null;
}

// Is a game starting at `start` inside the window in which its pages are fetched?
function inWindow(start, now, cfg) {
  return now >= start - LEAD_MS && now <= start + cfg.gameMs + cfg.postMs;
}

const wanted = (row, now, cfg) => inWindow(row.start, now, cfg) && pairOf(row.title) && isTeamGame(row.title);

// Fetch what is due: the hockey page (only when an onhockey game is inside the window), then the page of each
// game in the window. Stale entries are refetched after REFRESH_MS; a failure keeps the old entry.
async function refresh(onhockey, now, solve) {
  const livetv = require("./livetv"); // not at load: livetv pulls in the whole browser engine
  const cfg = livetv.settings();
  const data = { updated: new Date(now).toISOString(), source_utc_offset: SOURCE_UTC_OFFSET, streams: onhockey };
  const near = livetv.games(data).some(g => livetv.phase(g, undefined, data, { now, cfg: { ...cfg, leadMs: LEAD_MS } }) === "warm");
  if (!near) { cache.list = null; cache.games.clear(); return; }

  if (!cache.list || now - cache.list.at > REFRESH_MS) {
    try {
      cache.list = { at: now, rows: parseList(await solve(LIST_URL)) };
    } catch (err) {
      console.error("sportsurge:", err.message || err);
      if (!cache.list) return;
    }
  }
  const rows = cache.list.rows.filter(r => wanted(r, now, cfg));
  for (const url of [...cache.games.keys()]) if (!rows.some(r => r.url === url)) cache.games.delete(url);
  for (const row of rows) {
    const have = cache.games.get(row.url);
    if (have && now - have.at <= REFRESH_MS) continue;
    try {
      const links = parseGame(await solve(row.url));
      cache.games.set(row.url, { at: now, links });
      console.log(`sportsurge: ${row.title}: ${links.length} streams`);
    } catch (err) {
      console.error("sportsurge:", err.message || err);
    }
  }
}

// onhockey's records plus the cached SportSurge mirrors; returns just the new records. `solve(url)` -> HTML.
async function mirrors(onhockey, now = Date.now(), solve = byparr) {
  if (!config().url && solve === byparr) return [];
  cache.running ||= refresh(onhockey, now, solve)
    .catch(err => console.error("sportsurge:", err.message || err))
    .finally(() => { cache.running = null; });

  const out = [];
  for (const row of cache.list?.rows || []) {
    const links = cache.games.get(row.url)?.links;
    const pair = pairOf(row.title);
    if (!links?.length || !pair) continue;
    // One entry per onhockey channel for this matchup.
    const channels = new Map();
    for (const r of onhockey) {
      const t = teamsIn(r.game).sort();
      if (t.length === 2 && t.join() === [...pair].sort().join()) channels.set(`${r.league}|${r.time}|${r.game}|${r.feed}|${r.channel}`, r);
    }
    const targets = channels.size
      ? [...channels.values()].map(r => ({ league: r.league, time: r.time, game: r.game, feed: r.feed, channel: r.channel }))
      : [{ league: "NHL", time: hhmm(row.start), game: row.title, feed: "Home", channel: "SportSurge", start: new Date(row.start).toISOString() }];
    for (const t of targets) for (const link of links) out.push({ ...t, name: "SportSurge", link });
  }
  return out;
}

module.exports = { config, mirrors, parseList, parseGame, toLink, pairOf, idle: () => cache.running, reset() { cache.list = null; cache.games.clear(); } };
