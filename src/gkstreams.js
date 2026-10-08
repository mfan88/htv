// Extra mirrors from GKStreams. Its site is a front end for the streamed.pk JSON API, which lists
// every hockey game with embed.st links, the same kind of embed onhockey.tv links to. (Sportsurge
// itself sits behind a Cloudflare challenge that headless Chromium can't pass.)
//
// Records have the same shape as scraper.js's. A game onhockey also lists gets its links added to
// each of onhockey's channels for that game, as extra mirrors; any other game gets its own channel.

const { teamsIn } = require("./stats");

const API = "https://streamed.pk/api";
const SOURCE_UTC_OFFSET = 1; // keeps the "HH:MM" we write in the same offset as onhockey's
const BEFORE_MS = 5 * 60 * 60 * 1000; // a game this long past its start is over
const AHEAD_MS = 36 * 60 * 60 * 1000; // streams for games further out don't exist yet
const CONCURRENCY = 4;

async function getJSON(path) {
  const res = await fetch(API + path, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://gkstreams.click/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`streamed.pk ${path} returned HTTP ${res.status}`);
  return res.json();
}

const hhmm = ms => {
  const d = new Date(ms + SOURCE_UTC_OFFSET * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

// "Winnipeg Jets vs Colorado Avalanche" -> ["WPG", "COL"], or null if either side isn't an NHL team
// (KHL games, "NHL Network" and the like).
function pairOf(title) {
  const abbrs = teamsIn(title.replace(/\s+vs\.?\s+/i, " - "));
  return abbrs.length === 2 && abbrs[0] !== abbrs[1] ? abbrs : null;
}

// Embed links ("embed.st/embed/golf/2106/1", no scheme) for one match, over all its sources.
async function matchLinks(match) {
  const links = [];
  for (const { source, id } of match.sources || []) {
    try {
      for (const s of await getJSON(`/stream/${source}/${id}`)) {
        const link = String(s.embedUrl || "").replace(/^https?:\/\//, "");
        if (link && !links.includes(link)) links.push(link);
      }
    } catch (err) {
      console.error(`gkstreams: ${source}/${id}: ${err.message}`);
    }
  }
  return links;
}

// onhockey's records, merged with GKStreams mirrors. Returns just the new records.
async function mirrors(onhockey, now = Date.now()) {
  const matches = (await getJSON("/matches/hockey")).filter(m =>
    m.date && m.date > now - BEFORE_MS && m.date < now + AHEAD_MS && m.sources?.length && pairOf(m.title));

  const lists = [];
  for (let i = 0; i < matches.length; i += CONCURRENCY) {
    lists.push(...await Promise.all(matches.slice(i, i + CONCURRENCY).map(matchLinks)));
  }

  const out = [];
  matches.forEach((m, i) => {
    const pair = pairOf(m.title).sort().join();
    // One entry per onhockey channel for this matchup.
    const channels = new Map();
    for (const r of onhockey) {
      const t = teamsIn(r.game).sort();
      if (t.length === 2 && t.join() === pair) channels.set(`${r.league}|${r.time}|${r.game}|${r.feed}|${r.channel}`, r);
    }
    const targets = channels.size
      ? [...channels.values()].map(r => ({ league: r.league, time: r.time, game: r.game, feed: r.feed, channel: r.channel }))
      : [{
          league: "NHL",
          time: hhmm(m.date),
          game: m.teams?.away && m.teams?.home ? `${m.teams.away.name} - ${m.teams.home.name}` : m.title.replace(/\s+vs\.?\s+/i, " - "),
          feed: "Home",
          channel: "GKStreams",
          start: new Date(m.date).toISOString(), // an "HH:MM" alone can't say which day
        }];
    for (const t of targets) for (const link of lists[i]) out.push({ ...t, name: "GKStreams", link });
  });
  return out;
}

module.exports = { mirrors, pairOf };
