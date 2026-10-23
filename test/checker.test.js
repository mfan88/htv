const test = require("node:test");
const assert = require("node:assert/strict");

const MIN = 60 * 1000;
const LINK = "embed.st/embed/admin/ppv-x/1";

// A fresh checker module, a fake clock and an extractor that succeeds or fails on demand.
function setup(t, env = {}) {
  Object.assign(process.env, { HTV_FAIL_BACKOFF_AFTER: "3", HTV_FAIL_BACKOFF_MAX_MIN: "60", HTV_FAIL_DEMAND_RETRY_SEC: "120" }, env);
  delete require.cache[require.resolve("../src/checker")];
  const checker = require("../src/checker");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const calls = [];
  let ok = false;
  checker.init(async link => { calls.push(link); return ok ? { id: "c", url: "u" } : null; });
  checker.setConcurrency(1);
  const events = [];
  checker.onBackoff((link, fails, min) => events.push([link, fails, min]));
  const settle = () => new Promise(r => setImmediate(r));
  // One scheduling round: stale results are rechecked every 10 min.
  const round = async (opts = {}) => { checker.check([LINK], opts); await settle(); await settle(); };
  return { checker, calls, events, round, setOk: v => (ok = v), tick: ms => t.mock.timers.tick(ms) };
}

test("a link is rechecked normally until it has failed N times in a row", async t => {
  const { calls, round, tick } = setup(t);
  for (let i = 0; i < 3; i++) { await round(); tick(11 * MIN); }
  assert.equal(calls.length, 3);
});

test("after N failures the link is skipped for 10, then 30, then 60 minutes", async t => {
  const { checker, calls, events, round, tick } = setup(t);
  for (let i = 0; i < 3; i++) { await round(); tick(11 * MIN); }
  assert.equal(calls.length, 3);
  assert.deepEqual(events, [[LINK, 3, 10]]);
  // The third failure was 11 min ago, so the 10 min backoff is over: one more try.
  await round();
  assert.equal(calls.length, 4);
  assert.equal(checker.mayTry(LINK), false);
  tick(29 * MIN); await round();
  assert.equal(calls.length, 4, "still in the 30 min backoff");
  tick(2 * MIN); await round();
  assert.equal(calls.length, 5);
  tick(59 * MIN); await round();
  assert.equal(calls.length, 5, "60 min backoff");
  tick(2 * MIN); await round();
  assert.equal(calls.length, 6);
  tick(59 * MIN); await round();
  assert.equal(calls.length, 6, "the default cap keeps it at 60 min");
});

test("the cap is configurable", async t => {
  const { checker, calls, round, tick } = setup(t, { HTV_FAIL_BACKOFF_MAX_MIN: "15" });
  for (let i = 0; i < 3; i++) { await round(); tick(11 * MIN); }
  await round(); // 4th failure -> would be 30 min, capped at 15
  const n = calls.length;
  tick(14 * MIN); assert.equal(checker.mayTry(LINK), false);
  tick(2 * MIN); assert.equal(checker.mayTry(LINK), true);
  assert.equal(calls.length, n);
});

test("one log event when a link enters backoff, none for skipped checks", async t => {
  const { events, round, tick } = setup(t);
  for (let i = 0; i < 3; i++) { await round(); tick(11 * MIN); }
  for (let i = 0; i < 10; i++) { await round(); tick(MIN); } // skipped checks
  assert.equal(events.filter(e => e[1] > 0).length, 1);
});

test("a success resets the count and the backoff", async t => {
  const { checker, calls, events, round, setOk, tick } = setup(t);
  for (let i = 0; i < 3; i++) { await round(); tick(11 * MIN); }
  await round(); // 4th failure, backed off 30 min
  setOk(true);
  tick(31 * MIN); await round();
  assert.equal(checker.statuses()[LINK], "ok");
  assert.deepEqual(events.at(-1), [LINK, 0, 0]);
  setOk(false);
  tick(11 * MIN); await round(); // fails once: 1 in a row, so not backed off
  tick(11 * MIN); await round();
  assert.equal(checker.mayTry(LINK), true);
});

test("a watched link is still tried while backed off, at most once per interval", async t => {
  const { checker, calls, round, tick } = setup(t);
  for (let i = 0; i < 3; i++) { await round(); tick(11 * MIN); }
  await round(); // fail 4, backed off 30 min
  const n = calls.length;
  const demand = new Set([LINK]);
  await round({ demand, hot: demand });
  assert.equal(calls.length, n, "just tried: too soon");
  tick(5 * MIN + 1); // hot links go stale after 5 min; the demand interval is 2 min
  await round({ demand, hot: demand });
  assert.equal(calls.length, n + 1);
  await round({ demand, hot: demand });
  assert.equal(calls.length, n + 1, "once per interval");
  assert.equal(checker.mayTry(LINK, false), false, "unwatched stays backed off");
});

test("tunes outside the queue count: record() and noteTry() limit demand retries", async t => {
  const { checker, tick } = setup(t);
  for (let i = 0; i < 3; i++) checker.record(LINK, "fail");
  assert.equal(checker.mayTry(LINK), false);
  assert.equal(checker.mayTry(LINK, true), false, "just tried");
  tick(2 * MIN);
  assert.equal(checker.mayTry(LINK, true), true);
  checker.noteTry(LINK);
  assert.equal(checker.mayTry(LINK, true), false);
});
