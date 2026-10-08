// Scrapes stream links from onhockey.tv's schedule sidebar.
// The site loads the sidebar from schedule_table.php, which already contains every
// link (clicking a game only un-hides them), so a plain HTTP request is enough.

const fs = require("fs");
const { Parser } = require("htmlparser2");
const gkstreams = require("./gkstreams");

const SCHEDULE_URL = "https://onhockey.tv/schedule_table.php";
const FULL_PREFIX = "https://onhockey.tv/index.php?place=np_stream400&channel=//";
const HREF_MARKER = "np_stream400.php?channel=//";
const SOURCE_UTC_OFFSET = 1; // onhockey lists times in GMT+1

function trimLink(href) {
  if (href.startsWith(FULL_PREFIX)) return href.slice(FULL_PREFIX.length);
  const idx = href.indexOf(HREF_MARKER);
  return idx === -1 ? null : href.slice(idx + HREF_MARKER.length);
}

function parseSchedule(html) {
  const records = [];
  let league = "", inBold = false;
  let inGame = false, tdIndex = -1, game = null;
  let inLinks = false, feed = "";
  let anchor = null; // { link, channel, text } while inside a stream <a>

  const parser = new Parser({
    onopentag(tag, attrs) {
      const cls = (attrs.class || "").split(/\s+/);
      if (tag === "tr") {
        inGame = cls.includes("game");
        tdIndex = -1;
        inLinks = false;
        if (inGame) game = { time: "", name: "" };
      } else if (tag === "td" && inGame) {
        tdIndex++;
      } else if (tag === "b" && !inGame) {
        inBold = true;
        league = "";
      } else if (tag === "div" && cls.includes("gamelinks")) {
        inLinks = true;
        feed = "";
      } else if (tag === "a" && inLinks) {
        const link = trimLink(attrs.href || "");
        if (link) anchor = { link, channel: (attrs.title || "").trim(), text: "" };
      }
    },
    onclosetag(tag) {
      if (tag === "b") {
        inBold = false;
      } else if (tag === "div" && inLinks) {
        inLinks = false;
      } else if (tag === "a" && anchor) {
        records.push({
          league: league.trim(),
          game: game.name.split(/\s+/).filter(Boolean).join(" "),
          time: game.time.trim(),
          feed,
          name: anchor.text.trim(),
          channel: anchor.channel,
          link: anchor.link,
        });
        anchor = null;
      } else if (tag === "tr") {
        inGame = false;
      }
    },
    ontext(data) {
      if (inBold) league += data;
      else if (anchor) anchor.text += data;
      else if (inLinks) {
        const text = data.trim();
        if (text.endsWith(":")) feed = text.slice(0, -1).trim();
      } else if (inGame && game) {
        if (tdIndex === 0) game.time += data;
        else if (tdIndex === 1) game.name += data;
      }
    },
  }, { decodeEntities: true });

  parser.write(html);
  parser.end();
  return records;
}

async function fetchSchedule() {
  const res = await fetch(SCHEDULE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Referer: "https://onhockey.tv/",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`onhockey.tv returned HTTP ${res.status}`);
  return new TextDecoder("windows-1251").decode(await res.arrayBuffer());
}

// GKStreams links are extra mirrors; if that site is down the onhockey schedule still stands.
async function extraMirrors(streams) {
  try {
    const have = new Set(streams.map(r => `${r.game}|${r.feed}|${r.channel}|${r.link}`));
    return (await gkstreams.mirrors(streams)).filter(r => !have.has(`${r.game}|${r.feed}|${r.channel}|${r.link}`));
  } catch (err) {
    console.error("gkstreams failed:", err.message || err);
    return [];
  }
}

async function scrape(outputPath) {
  const streams = parseSchedule(await fetchSchedule());
  const data = {
    updated: new Date().toISOString(),
    source_utc_offset: SOURCE_UTC_OFFSET,
    streams: [...streams, ...await extraMirrors(streams)],
  };
  if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf8");
  return data;
}

module.exports = { scrape, parseSchedule, trimLink };

// `node src/scraper.js [out.json]` runs it standalone.
if (require.main === module) {
  const out = process.argv[2] || "streams.json";
  scrape(out).then(d => console.log(`${d.streams.length} links -> ${out}`), e => {
    console.error(e);
    process.exit(1);
  });
}
