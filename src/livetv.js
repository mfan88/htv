// Jellyfin Live TV: an M3U tuner and an XMLTV guide built from the schedule, one channel
// per NHL game. A channel's URL is /live/<id>.m3u8 on the htv server, which picks a
// working link only when Jellyfin tunes in (see server.js).

const crypto = require("crypto");
const { NHL_LEAGUES } = require("./engine");

const GAME_MS = 3.5 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// NHL games in schedule order: { id, league, time, name, links }, links best first.
// The id only depends on the game, so a channel keeps it across scrapes.
function games(data, statuses = {}) {
  const map = new Map();
  for (const r of data?.streams || []) {
    if (!NHL_LEAGUES.includes(r.league.toLowerCase())) continue;
    const key = `${r.league}|${r.time}|${r.game}`;
    if (!map.has(key)) {
      const id = crypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
      map.set(key, { id, league: r.league, time: r.time, name: r.game, links: [] });
    }
    const g = map.get(key);
    if (!g.links.includes(r.link)) g.links.push(r.link);
  }
  const rank = l => ({ ok: 0, fail: 2 })[statuses[l]] ?? 1;
  return [...map.values()].map(g => ({ ...g, links: [...g.links].sort((a, b) => rank(a) - rank(b)) }));
}

// "CGY @ EDM" from the NHL API, else onhockey's own name.
const channelName = (g, label) => (label ? `${label.away} @ ${label.home}` : g.name);

// When a game starts (ms): the NHL API's time, else onhockey's "HH:MM" (in its own
// UTC offset, on the day of the scrape; a time long past means tomorrow).
function startTime(g, label, data) {
  if (label?.start) return Date.parse(label.start);
  const m = /^(\d{1,2}):(\d{2})$/.exec(g.time || "");
  if (!m) return null;
  const offset = data.source_utc_offset ?? 1;
  const ref = data.updated ? Date.parse(data.updated) : Date.now();
  const local = new Date(ref + offset * HOUR);
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), +m[1], +m[2]) - offset * HOUR;
  if (t < ref - 12 * HOUR) t += 24 * HOUR;
  return t;
}

function m3u(list, labels, base, token) {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  const lines = ["#EXTM3U"];
  list.forEach((g, i) => {
    const name = channelName(g, labels[g.name]).replace(/[",]/g, " ");
    lines.push(`#EXTINF:-1 tvg-id="htv-${g.id}" tvg-chno="${i + 1}" tvg-name="${name}" group-title="NHL",${name}`);
    lines.push(`${base}/live/${g.id}.m3u8${q}`);
  });
  return lines.join("\n") + "\n";
}

const xml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const xmltvTime = ms => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";

// Each channel gets the game itself plus a "starting soon" block before it, so the
// guide isn't empty while waiting for puck drop.
function xmltv(list, labels, data) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="htv">'];
  for (const g of list) {
    out.push(`  <channel id="htv-${g.id}"><display-name>${xml(channelName(g, labels[g.name]))}</display-name></channel>`);
  }
  for (const g of list) {
    const label = labels[g.name];
    const start = startTime(g, label, data);
    if (start == null) continue;
    const title = label ? `${label.awayName} at ${label.homeName}` : g.name;
    const ch = `channel="htv-${g.id}"`;
    out.push(`  <programme start="${xmltvTime(start - 12 * HOUR)}" stop="${xmltvTime(start)}" ${ch}>` +
      `<title>${xml(title)} (starting soon)</title><category>Sports</category></programme>`);
    out.push(`  <programme start="${xmltvTime(start)}" stop="${xmltvTime(start + GAME_MS)}" ${ch}>` +
      `<title>${xml(title)}</title><desc>${xml(`${g.league}: ${g.name}`)}</desc>` +
      `<category>Sports</category><category>Sports event</category></programme>`);
  }
  out.push("</tv>");
  return out.join("\n") + "\n";
}

module.exports = { games, m3u, xmltv };
