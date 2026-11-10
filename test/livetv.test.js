const test = require("node:test");
const assert = require("node:assert/strict");
const livetv = require("../src/livetv");

const MIN = 60 * 1000;
const START = Date.parse("2026-10-24T02:00:00Z");
const cfg = { gameMs: 210 * MIN, leadMs: 30 * MIN, postMs: 30 * MIN };
const rec = (over = {}) => ({ league: "NHL", game: "Calgary - Edmonton Oilers", time: "03:00", feed: "Home", name: "x", channel: "SN", link: "embed.st/a", start: new Date(START).toISOString(), ...over });
const data = { updated: new Date(START).toISOString(), source_utc_offset: 1, streams: [rec()] };
const [game] = livetv.games(data);
const phaseAt = (at, extra = {}) => livetv.phase(game, extra.label, data, { now: START + at * MIN, cfg, ...extra });

test("phase: before the lead, inside it, during the game, inside post-game, after it", () => {
  assert.equal(phaseAt(-31), "pre");
  assert.equal(phaseAt(-30), "warm");
  assert.equal(phaseAt(100), "warm");
  assert.equal(phaseAt(210 + 30), "warm");
  assert.equal(phaseAt(210 + 31), "over");
});

test("phase: a final game from the scoreboard ends earlier than HTV_GAME_MIN", () => {
  const label = { state: "FINAL" };
  const ended = new Map([[game.gameId, START + 150 * MIN]]);
  assert.equal(phaseAt(150 + 30, { label, ended }), "warm");
  assert.equal(phaseAt(150 + 31, { label, ended }), "over");
  assert.equal(livetv.endTime(game, label, data, { cfg, ended }), START + 150 * MIN);
  // Not seen final yet, or the scoreboard still says LIVE: the nominal length applies.
  assert.equal(phaseAt(150 + 31, { label }), "warm");
  assert.equal(phaseAt(150 + 31, { label: { state: "LIVE" }, ended }), "warm");
});

test("phase: demand keeps a game warm past its window", () => {
  assert.equal(phaseAt(400), "over");
  assert.equal(phaseAt(400, { demanded: true }), "warm");
});

test("phase: no start time is never dropped", () => {
  const g = { ...game, start: undefined, time: "soon" };
  assert.equal(livetv.phase(g, undefined, data, { now: START + 9999 * MIN, cfg }), "unknown");
  assert.equal(livetv.listed([g], {}, data, { now: START + 9999 * MIN, cfg }).length, 1);
});

test("settings: defaults, HTV_LEAD_MIN, and the old HTV_PRIORITY_LEAD_MIN as a fallback", () => {
  assert.deepEqual(livetv.settings({}), { gameMs: 210 * MIN, leadMs: 30 * MIN, postMs: 30 * MIN });
  assert.equal(livetv.settings({ HTV_PRIORITY_LEAD_MIN: "60" }).leadMs, 60 * MIN);
  assert.equal(livetv.settings({ HTV_PRIORITY_LEAD_MIN: "60", HTV_LEAD_MIN: "15" }).leadMs, 15 * MIN);
  assert.equal(livetv.settings({ HTV_POST_GAME_MIN: "5", HTV_GAME_MIN: "180" }).postMs, 5 * MIN);
});

test("hotLinks follows the same window, including demand", () => {
  const hot = (at, demanded) => livetv.hotLinks(data, { cfg, now: START + at * MIN, demanded: () => !!demanded });
  assert.equal(hot(-40).size, 0);
  assert.equal(hot(-10).size, 1);
  assert.equal(hot(300).size, 0);
  assert.equal(hot(300, true).size, 1);
});

const later = [rec({ game: "Vancouver - Edmonton Oilers", time: "04:00", start: new Date(START + 24 * 60 * MIN).toISOString(), link: "embed.st/b" })];
const both = { ...data, streams: [...data.streams, ...later] };
const win = (extra = {}) => ({ cfg, ended: new Map(), demanded: () => false, ...extra });

test("m3u and xmltv omit a finished game, keep upcoming ones, and include a demanded one", () => {
  const list = livetv.games(both);
  const now = START + 300 * MIN; // 90 min past the game's window; the next game is ~19 h away
  const m3u = livetv.m3u(list, {}, "http://h", "t", () => null, both, now, null, win());
  assert.ok(!m3u.includes("Calgary - Edmonton"), "finished game dropped");
  assert.ok(m3u.includes("Vancouver - Edmonton"), "upcoming game kept");
  const xml = livetv.xmltv(list, {}, both, () => null, now, win());
  assert.ok(!xml.includes("Calgary - Edmonton") && xml.includes("Vancouver - Edmonton"));

  const demanded = win({ demanded: g => g.name.startsWith("Calgary") });
  assert.ok(livetv.m3u(list, {}, "http://h", "t", () => null, both, now, null, demanded).includes("Calgary - Edmonton"));
  assert.ok(livetv.xmltv(list, {}, both, () => null, now, demanded).includes("Calgary - Edmonton"));
});

test("xmltv stops the programme at the real end time", () => {
  const list = livetv.games(data);
  const label = { state: "FINAL", away: "CGY", home: "EDM", awayName: "Flames", homeName: "Oilers", start: new Date(START).toISOString() };
  const ended = new Map([[list[0].gameId, START + 150 * MIN]]);
  const xml = livetv.xmltv(list, { [list[0].name]: label }, data, () => null, START + 160 * MIN, win({ ended }));
  assert.match(xml, /start="20261024020000 \+0000" stop="20261024043000 \+0000"/);
  assert.match(livetv.xmltv(list, {}, data, () => null, START, win()), /stop="20261024053000 \+0000"/);
});

test("without a window, m3u and xmltv list every game as before", () => {
  const list = livetv.games(both);
  assert.equal(livetv.m3u(list, {}, "http://h", "t", () => null, both, START + 999 * MIN).match(/#EXTINF/g).length, 2);
});
