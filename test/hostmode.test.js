const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const extractor = require("../src/extractor");

const url = n => `https://lb${n}.strmd.st/secure/TOKEN/x/stream/1/playlist.m3u8`;
const cap = (n, playlist = true) => ({ url: url(n), headers: {}, page: { status: playlist ? 200 : 403, playlist } });
const probe = (status, ok = status === 200) => { const f = async () => (f.calls++, { ok, status }); f.calls = 0; return f; };

test.beforeEach(() => extractor.browserOnly.clear());

test("a host that probes fine is never flagged", async () => {
  assert.equal(await extractor.verify(cap(1), probe(200)), true);
  assert.equal(extractor.isBrowserOnly(url(1)), false);
});

test("page got a playlist but the probe got 403: working, and the stream host is flagged", async t => {
  const log = t.mock.method(console, "log", () => {});
  const p = probe(403);
  assert.equal(await extractor.verify(cap(1), p), true);
  assert.equal(extractor.isBrowserOnly(url(1)), true);
  assert.equal(extractor.isBrowserOnly(url(2)), false, "per stream host, not per embed host");
  assert.equal(log.mock.calls.length, 1);
  assert.match(log.mock.calls[0].arguments[0], /^lb1\.strmd\.st: .*403/);
});

test("401 flags too; other failures do not", async () => {
  assert.equal(await extractor.verify(cap(1), probe(401)), true);
  assert.equal(await extractor.verify(cap(2), probe(500)), false);
  assert.equal(await extractor.verify(cap(3), probe(0)), false);
  assert.equal(extractor.isBrowserOnly(url(2)), false);
  assert.equal(extractor.isBrowserOnly(url(3)), false);
});

test("a 403 is not flagged when the page itself got no playlist (a dead mirror)", async () => {
  assert.equal(await extractor.verify(cap(1, false), probe(403)), false);
  assert.equal(await extractor.verify({ url: url(1), headers: {}, page: null }, probe(403)), false);
  assert.equal(extractor.isBrowserOnly(url(1)), false);
});

test("flagged hosts skip the probe and trust the page, except on every RELEARN_EVERY-th extraction", async t => {
  t.mock.method(console, "log", () => {});
  await extractor.verify(cap(1), probe(403)); // flags
  const p = probe(403);
  let probed = 0;
  for (let i = 1; i <= 16; i++) {
    const before = p.calls;
    assert.equal(await extractor.verify(cap(1), p), true);
    if (p.calls > before) probed++;
  }
  assert.equal(probed, 2, "16 extractions with RELEARN_EVERY = 8");
  assert.equal(await extractor.verify(cap(1, false), p), false, "page got no playlist: not working");
  assert.equal(extractor.isBrowserOnly(url(1)), true, "a failing relearn probe keeps the flag");
});

test("a relearn probe that works drops the flag and logs it", async t => {
  const log = t.mock.method(console, "log", () => {});
  await extractor.verify(cap(1), probe(403));
  for (let i = 1; i < 8; i++) await extractor.verify(cap(1), probe(200));
  assert.equal(extractor.isBrowserOnly(url(1)), true);
  assert.equal(await extractor.verify(cap(1), probe(200)), true); // 8th: probes
  assert.equal(extractor.isBrowserOnly(url(1)), false);
  assert.match(log.mock.calls.at(-1).arguments[0], /^lb1\.strmd\.st: .*no longer browser-only/);
});

test("flagged hosts are saved under the data dir and reloaded", async t => {
  t.mock.method(console, "log", () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "htv-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  extractor.loadBrowserOnly(dir);
  await extractor.verify(cap(1), probe(403));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "browser-hosts.json"), "utf8"))), ["lb1.strmd.st"]);
  extractor.browserOnly.clear();
  extractor.loadBrowserOnly(dir);
  assert.equal(extractor.isBrowserOnly(url(1)), true);
});
