const test = require("node:test");
const assert = require("node:assert/strict");

const livetv = require("../src/livetv");

const rec = (feed, channel, link, game = "Calgary - Edmonton") => ({ league: "NHL", game, time: "02:00", feed, name: "x", channel, link });
const data = streams => ({ streams, updated: new Date().toISOString() });
const names = list => list.map(c => `${c.role}:${c.channel}`);

test("one home, one away and one French channel per game; foreign languages are dropped", () => {
  const list = livetv.condense(data([
    rec("home feed", "SN West", "a/1"), rec("home feed", "Go3", "b/1"), rec("home feed", "V Sport Vinter", "c/1"),
    rec("away feed", "ESPN+", "d/1"), rec("away feed", "MSG", "e/1"),
    rec("french", "TVA Sports", "f/1"), rec("czech", "Nova Sport 1", "g/1"), rec("russian", "", "h/1"),
    rec("TSN", "TSN 4", "i/1"),
  ]));
  assert.deepEqual(names(list), ["home:SN West", "away:ESPN+", "french:TVA Sports"]);
  assert.deepEqual(list[0].links, ["a/1"], "foreign home broadcasters are not merged in");
});

test("a role keeps working when it has no English feed: both sides stay covered", () => {
  const list = livetv.condense(data([
    rec("home feed", "Viaplay 1 Urheilu", "a/1"), rec("away feed", "ESPN+", "b/1"),
  ]));
  assert.deepEqual(names(list), ["home:Viaplay 1 Urheilu", "away:ESPN+"]);
});

test("national English feeds only fill in for a missing side", () => {
  const both = livetv.condense(data([rec("home feed", "SN West", "a/1"), rec("away feed", "MSG", "b/1"), rec("NHLN", "NHL Network", "c/1")]));
  assert.equal(both.length, 2);
  const none = livetv.condense(data([rec("NHLN", "NHL Network", "c/1"), rec("TSN", "TSN 4", "d/1"), rec("czech", "Nova Sport 1", "e/1")]));
  assert.deepEqual(names(none), ["national:NHL Network"]);
  assert.deepEqual(none[0].links.sort(), ["c/1", "d/1"], "national channels merge into one");
});

test("a game with only foreign feeds is kept, not dropped", () => {
  const list = livetv.condense(data([rec("czech", "Nova Sport 1", "a/1"), rec("russian", "", "b/1")]));
  assert.equal(list.length, 1);
});

test("mirrors are ordered by stability and merged across same-role broadcasters", () => {
  const score = l => ({ "x/1": 0.2, "y/1": 0.9, "z/1": 0.6 })[l];
  const list = livetv.condense(data([rec("home feed", "SN West", "x/1"), rec("home feed", "ESPN+", "y/1"), rec("home feed", "NBCS California", "z/1")]), {}, score);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].links, ["y/1", "z/1", "x/1"]);
  assert.equal(list[0].channel, "ESPN+", "named after the most stable broadcaster");
});

test("channel ids depend on game and role only", () => {
  const a = livetv.condense(data([rec("home feed", "SN West", "a/1"), rec("home feed", "ESPN+", "b/1")]), {}, l => (l === "a/1" ? 1 : 0));
  const b = livetv.condense(data([rec("home feed", "SN West", "a/1"), rec("home feed", "ESPN+", "b/1")]), {}, l => (l === "b/1" ? 1 : 0));
  assert.equal(a[0].id, b[0].id);
  assert.notEqual(a[0].channel, b[0].channel);
});
