// Jellyfin Live TV: an M3U tuner and an XMLTV guide built from the schedule, one channel
// per NHL game. A channel's URL is /live/<id>.m3u8 on the htv server, which picks a
// working link only when Jellyfin tunes in (see server.js).

const crypto = require("crypto");
const { NHL_LEAGUES } = require("./engine");

const GAME_MS = 3.5 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// One channel per game and feed/channel pair ("SN West", "NHL Network"), in schedule
// order: { id, gameId, league, time, name, feed, channel, start?, links }. links are that
// channel's mirrors, best first. Ids only depend on the game and channel, so a channel
// keeps its id across scrapes.
function games(data, statuses = {}) {
  const map = new Map();
  for (const r of data?.streams || []) {
    if (!NHL_LEAGUES.includes(r.league.toLowerCase())) continue;
    const gameKey = `${r.league}|${r.time}|${r.game}`;
    const key = `${gameKey}|${r.feed}|${r.channel}`;
    if (!map.has(key)) {
      const hash = k => crypto.createHash("sha1").update(k).digest("hex").slice(0, 10);
      map.set(key, { id: hash(key), gameId: hash(gameKey), league: r.league, time: r.time, name: r.game, feed: r.feed, channel: r.channel, start: r.start, links: [] });
    }
    const g = map.get(key);
    if (!g.links.includes(r.link)) g.links.push(r.link);
  }
  const rank = l => ({ ok: 0, fail: 2 })[statuses[l]] ?? 1;
  return [...map.values()].map(g => ({ ...g, links: [...g.links].sort((a, b) => rank(a) - rank(b)) }));
}

// "CGY @ EDM · SN West" from the NHL API, else onhockey's own name. A feed other than
// the home one is named too ("KONG (away feed)").
const channelSuffix = g => (g.channel ? ` · ${g.channel}${/^home/i.test(g.feed || "") ? "" : ` (${g.feed})`}` : "");
const channelName = (g, label) => (label ? `${label.away} @ ${label.home}` : g.name) + channelSuffix(g);

// Games on or near the air: the links worth keeping captured. With `teams` (lowercase
// substrings of the game name, e.g. "oilers") only those teams' games count, and the window
// opens `leadMs` before the start; without it every game counts, 3 hours ahead.
function hotLinks(data, { teams = [], leadMs = 3 * HOUR, now = Date.now() } = {}) {
  const hot = new Set();
  for (const g of games(data)) {
    if (teams.length && !teams.some(t => g.name.toLowerCase().includes(t))) continue;
    const start = startTime(g, null, data);
    if (start == null || now < start - leadMs || now > start + GAME_MS + HOUR) continue;
    g.links.forEach(l => hot.add(l));
  }
  return hot;
}

// When a game starts (ms): the NHL API's time, else onhockey's "HH:MM" (in its own
// UTC offset, on the day of the scrape; a time long past means tomorrow).
function startTime(g, label, data) {
  if (label?.start) return Date.parse(label.start);
  if (g.start) return Date.parse(g.start);
  const m = /^(\d{1,2}):(\d{2})$/.exec(g.time || "");
  if (!m) return null;
  const offset = data.source_utc_offset ?? 1;
  const ref = data.updated ? Date.parse(data.updated) : Date.now();
  const local = new Date(ref + offset * HOUR);
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), +m[1], +m[2]) - offset * HOUR;
  if (t < ref - 12 * HOUR) t += 24 * HOUR;
  return t;
}

// Channel group: IPTV apps (TiviMate) list channels by group, so split the games by state.
function groupOf(g, label, data, now) {
  const start = startTime(g, label, data);
  if (start == null) return "NHL";
  if (now >= start - 15 * 60 * 1000 && now <= start + GAME_MS) return "Live now";
  return now < start ? "Upcoming" : "Finished";
}

// `logo(label)` is the thumbnail URL for a game's NHL label, or null. With `edge` (the MediaMTX
// base URL) channels point at MediaMTX, which pulls /live/<id>.m3u8 itself and shares one pull.
function m3u(list, labels, base, token, logo = () => null, data = {}, now = Date.now(), edge = null) {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  const lines = ["#EXTM3U"];
  list.forEach((g, i) => {
    const name = channelName(g, labels[g.name]).replace(/[",]/g, " ");
    const icon = logo(labels[g.name]);
    lines.push(`#EXTINF:-1 tvg-id="htv-${g.id}" tvg-chno="${i + 1}" tvg-name="${name}"${icon ? ` tvg-logo="${icon}"` : ""} group-title="${groupOf(g, labels[g.name], data, now)}",${name}`);
    lines.push(edge ? `${edge}/ch_${g.id}/index.m3u8` : `${base}/live/${g.id}.m3u8${q}`);
  });
  return lines.join("\n") + "\n";
}

const xml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const xmltvTime = ms => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";

// Each channel gets the game itself plus a "starting soon" block before it, so the
// guide isn't empty while waiting for puck drop.
function xmltv(list, labels, data, logo = () => null) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="htv">'];
  for (const g of list) {
    const icon = logo(labels[g.name]);
    out.push(`  <channel id="htv-${g.id}"><display-name>${xml(channelName(g, labels[g.name]))}</display-name>${icon ? `<icon src="${xml(icon)}"/>` : ""}</channel>`);
  }
  for (const g of list) {
    const label = labels[g.name];
    const start = startTime(g, label, data);
    if (start == null) continue;
    const title = (label ? `${label.awayName} at ${label.homeName}` : g.name) + channelSuffix(g);
    const ch = `channel="htv-${g.id}"`;
    const icon = logo(label) ? `<icon src="${xml(logo(label))}"/>` : "";
    out.push(`  <programme start="${xmltvTime(start - 12 * HOUR)}" stop="${xmltvTime(start)}" ${ch}>` +
      `<title>${xml(title)} (starting soon)</title><category>Sports</category>${icon}</programme>`);
    out.push(`  <programme start="${xmltvTime(start)}" stop="${xmltvTime(start + GAME_MS)}" ${ch}>` +
      `<title>${xml(title)}</title><desc>${xml(`${g.league}: ${g.name}`)}</desc>` +
      `<category>Sports</category><category>Sports event</category>${icon}</programme>`);
  }
  out.push("</tv>");
  return out.join("\n") + "\n";
}

// A mirror can answer 200 and still be dead: the feed froze, so its playlist stops advancing and
// the player runs out of segments. `entry` carries the last playlist signature (media sequence + newest
// segment) and when it last changed; true once it has been frozen for 2.5 target durations (at least minMs).
function stalled(entry, text, now = Date.now(), minMs = 12000) {
  if (!text || /#EXT-X-ENDLIST/.test(text)) return false;
  const seq = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] || "0";
  const lastUri = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith("#")).pop() || "";
  const sig = `${seq}|${lastUri}`;
  if (sig !== entry.sig) { entry.sig = sig; entry.advancedAt = now; return false; }
  const target = +/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1] || 6;
  return now - entry.advancedAt > Math.max(minMs, 2.5 * target * 1000);
}

module.exports = { games, m3u, xmltv, hotLinks, stalled };
