const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const MIN = 60 * 1000;
const START = 1792800000 * 1000; // Montreal - Chicago in the captured hockey page

process.env.HTV_BYPARR_URL = "http://byparr.test:8191";
const sportsurge = require("../src/sportsurge");
const extractor = require("../src/extractor");

test("parseList reads the games, their titles and exact start times", () => {
  const rows = sportsurge.parseList(fixture("sportsurge-hockey.html"));
  assert.deepEqual(rows.map(r => r.title), ["Montreal Canadiens - Chicago Blackhawks", "Tampa Bay Lightning - Colorado Avalanche"]);
  assert.equal(rows[0].start, START);
  assert.equal(rows[0].url, "https://v2.sportsurge.net/watch-67299-hockey-montreal-canadiens-chicago-blackhawks-5/");
});

test("parseGame reads every stream link as a scheme-less extractor link, keeping http", () => {
  const links = sportsurge.parseGame(fixture("sportsurge-game.html"));
  assert.equal(links.length, 11);
  assert.ok(links.includes("sportsupa.st/event/?id=chicago-blackhawks-vs-montreal-canadiens-2591650&src=golf&sno=1&sid=2552"));
  assert.ok(links.includes("http://gstream24.fun/?stream_id=67299"), "http-only site keeps its scheme");
  assert.equal(sportsurge.toLink("javascript:alert(1)"), null);
  assert.equal(sportsurge.toLink("https://a.b/c#frag"), "a.b/c");
});

test("the extractor builds working URLs for http links", () => {
  assert.equal(extractor.wrapperUrl("http://gstream24.fun/?stream_id=1"), "https://onhockey.tv/np_stream400.php?channel=//gstream24.fun/?stream_id=1");
  assert.equal(extractor.wrapperUrl("embed.st/embed/a/1/1"), "https://onhockey.tv/np_stream400.php?channel=//embed.st/embed/a/1/1");
});

// An onhockey schedule with the same game, as scraper.js would hand it over.
const onhockey = [{ league: "NHL", game: "Montreal Canadiens - Chicago Blackhawks", time: "02:00", feed: "Home", name: "x", channel: "SN", link: "embed.st/a", start: new Date(START).toISOString() }];
const fakeSolve = calls => async url => { calls.push(url); return fixture(url.endsWith("watch-hockey-streams/") ? "sportsurge-hockey.html" : "sportsurge-game.html"); };

test("nothing is fetched until the game is within the lead window", async () => {
  sportsurge.reset();
  const calls = [];
  const out = await sportsurge.mirrors(onhockey, START - 3 * 60 * MIN, fakeSolve(calls));
  await sportsurge.idle();
  assert.deepEqual(out, []);
  assert.deepEqual(calls, []);
});

test("inside the window the pages are fetched in the background and added to onhockey's channel", async () => {
  sportsurge.reset();
  const calls = [];
  const solve = fakeSolve(calls);
  const now = START - 50 * MIN;
  assert.deepEqual(await sportsurge.mirrors(onhockey, now, solve), [], "first call returns the (empty) cache at once");
  await sportsurge.idle();
  // Only the game inside the window is fetched: Tampa - Colorado starts an hour later, outside the lead window.
  assert.ok(calls.includes("https://v2.sportsurge.net/watch-hockey-streams/"));
  assert.equal(calls.filter(u => u.includes("watch-67299")).length, 1);
  const out = await sportsurge.mirrors(onhockey, now + MIN, solve);
  await sportsurge.idle();
  assert.equal(out.length, 11);
  assert.ok(out.every(r => r.game === onhockey[0].game && r.channel === "SN" && r.name === "SportSurge"));
  assert.equal(calls.filter(u => u.includes("watch-67299")).length, 1, "cached: not fetched again within the refresh interval");
});

test("a game onhockey doesn't list gets its own channel with the exact start", async () => {
  sportsurge.reset();
  const solve = fakeSolve([]);
  const other = [{ ...onhockey[0], game: "Calgary - Edmonton Oilers", start: new Date(START).toISOString() }];
  await sportsurge.mirrors(other, START - 30 * MIN, solve); // the Calgary game is near, so the list is fetched
  await sportsurge.idle();
  const out = await sportsurge.mirrors(other, START - 29 * MIN, solve);
  await sportsurge.idle();
  assert.equal(out.length, 11);
  assert.ok(out.every(r => r.channel === "SportSurge" && r.start === new Date(START).toISOString()));
});

test("a Byparr failure leaves the schedule alone", async () => {
  sportsurge.reset();
  const out = await sportsurge.mirrors(onhockey, START - 30 * MIN, async () => { throw new Error("Byparr returned HTTP 401"); });
  await sportsurge.idle();
  assert.deepEqual(out, []);
  assert.deepEqual(await sportsurge.mirrors(onhockey, START - 29 * MIN, async () => { throw new Error("down"); }), []);
  await sportsurge.idle();
});

test("without HTV_BYPARR_URL nothing is fetched", async () => {
  const saved = process.env.HTV_BYPARR_URL;
  delete process.env.HTV_BYPARR_URL;
  sportsurge.reset();
  assert.deepEqual(await sportsurge.mirrors(onhockey, START - 30 * MIN), []);
  process.env.HTV_BYPARR_URL = saved;
});
