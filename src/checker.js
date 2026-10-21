// Background link checker: runs every NHL link through the extractor, a few at a
// time, so the UI can hide dead links and start verified ones instantly.

const RECHECK_MS = 10 * 60 * 1000; // links often come alive at puck drop
const HOT_RECHECK_MS = 5 * 60 * 1000; // games on or about to start: keep captures warm
const FRESH_CAPTURE_MS = 60 * 1000; // stream tokens expire; reuse captures only briefly
const RECENT_CAPTURE_MS = 15 * 60 * 1000; // for callers that probe the capture before trusting it

// A link that keeps failing (a dead mirror, or a host we can't verify) cost a few Chromium pages every
// time it was rechecked. After FAIL_BACKOFF_AFTER failures in a row it is skipped for a growing delay
// (10, 30, 60 min, then doubling up to FAIL_BACKOFF_MAX_MIN); any success resets it. A link someone
// tuned into is still tried while backed off, but at most once per DEMAND_RETRY_MS.
const FAIL_BACKOFF_AFTER = Math.max(1, +(process.env.HTV_FAIL_BACKOFF_AFTER || 3));
const FAIL_BACKOFF_MAX_MS = Math.max(1, +(process.env.HTV_FAIL_BACKOFF_MAX_MIN || 60)) * 60 * 1000;
const BACKOFF_LADDER_MS = [10, 30, 60].map(m => m * 60 * 1000);
const DEMAND_RETRY_MS = +(process.env.HTV_FAIL_DEMAND_RETRY_SEC || 120) * 1000;

const results = new Map(); // link -> { status: "checking" | "ok" | "fail", capture, at }
let queue = [];
let running = 0;
let concurrency = 2;
let onStatus = () => {};
let extractFn = null; // (link) => Promise<capture | null>, set by init()
let onBackoff = () => {};
const health = new Map(); // link -> { fails (in a row), until (no checks before), lastTry }

function backoffDelay(fails) {
  const i = fails - FAIL_BACKOFF_AFTER;
  const step = i < BACKOFF_LADDER_MS.length ? BACKOFF_LADDER_MS[i] : BACKOFF_LADDER_MS.at(-1) * 2 ** (i - BACKOFF_LADDER_MS.length + 1);
  return Math.min(step, FAIL_BACKOFF_MAX_MS);
}

function noteResult(link, ok) {
  const h = health.get(link) || { fails: 0, until: 0, lastTry: 0 };
  health.set(link, h);
  h.lastTry = Date.now();
  if (ok) {
    if (h.until) onBackoff(link, 0, 0);
    h.fails = 0;
    h.until = 0;
    return;
  }
  h.fails++;
  if (h.fails < FAIL_BACKOFF_AFTER) return;
  const wasBacked = h.until > 0;
  h.until = Date.now() + backoffDelay(h.fails);
  if (!wasBacked) onBackoff(link, h.fails, Math.round((h.until - Date.now()) / 60000));
}

// May `link` be extracted now? Not while backed off, except for a link someone is watching
// (`demanded`), which gets one attempt per DEMAND_RETRY_MS.
function mayTry(link, demanded = false, now = Date.now()) {
  const h = health.get(link);
  if (!h || now >= h.until) return true;
  return demanded && now - h.lastTry >= DEMAND_RETRY_MS;
}

// A caller outside the queue (a tune) is about to extract `link`.
function noteTry(link) {
  const h = health.get(link) || { fails: 0, until: 0, lastTry: 0 };
  health.set(link, h);
  h.lastTry = Date.now();
}

function setStatus(link, status, capture = null, at = Date.now()) {
  results.set(link, { status, capture, at });
  onStatus(link, status);
}

// A finished check (from the queue or a tune): store it and update the failure count.
function record(link, status, capture = null) {
  setStatus(link, status, capture);
  noteResult(link, status === "ok");
}

function pump() {
  while (running < concurrency && queue.length) {
    const link = queue.shift();
    running++;
    const prior = results.get(link)?.capture || null; // setStatus below clears it
    setStatus(link, "checking");
    extractFn(link, { prior })
      .then(capture => record(link, capture ? "ok" : "fail", capture))
      .catch(() => record(link, "fail"))
      .finally(() => { running--; pump(); });
  }
}

// Queue every link that has never been checked or, unless `recheck` is false, whose
// result is stale. Links no longer listed are dropped.
// `hot` links (a Set) are rechecked sooner and go first. Concurrency stays the same, so
// keeping them warm doesn't add load, it only reorders it.
// `idleMs` overrides how stale a non-hot result must be before it is rechecked.
// `demand` (a Set) are links someone is watching: they may be retried while backed off.
function check(links, { recheck = true, hot = new Set(), idleMs = RECHECK_MS, demand = new Set() } = {}) {
  const listed = new Set(links);
  queue = queue.filter(l => listed.has(l));
  for (const l of [...results.keys()]) if (!listed.has(l)) results.delete(l);
  for (const l of [...health.keys()]) if (!listed.has(l)) health.delete(l);
  const now = Date.now();
  for (const link of listed) {
    const r = results.get(link);
    if (queue.includes(link) || r?.status === "checking") continue;
    if (!mayTry(link, demand.has(link), now)) continue;
    const stale = now - (r?.at ?? 0) > (hot.has(link) ? HOT_RECHECK_MS : idleMs);
    if (!r || (recheck && stale)) queue.push(link);
  }
  queue.sort((a, b) => hot.has(b) - hot.has(a));
  pump();
}

// A capture verified moments ago, if any (saves a second extraction on click).
function freshCapture(link) {
  const r = results.get(link);
  return r?.status === "ok" && r.capture && Date.now() - r.at < FRESH_CAPTURE_MS ? r.capture : null;
}

// The last good capture if it's recent; its token may still have lapsed, so probe it.
function recentCapture(link) {
  const r = results.get(link);
  return r?.status === "ok" && r.capture && Date.now() - r.at < RECENT_CAPTURE_MS ? r.capture : null;
}

function statuses() {
  return Object.fromEntries([...results].map(([l, r]) => [l, r.status]));
}

// Finished results with their check time: { link: { status, at } }. Used for the
// on-disk cache and the server API.
function snapshot() {
  const out = {};
  for (const [link, r] of results) if (r.status !== "checking") out[link] = { status: r.status, at: r.at };
  return out;
}

// Adopt results checked elsewhere (the disk cache or an htv server) when they're newer
// than what we have. Links being checked right now are left alone.
function seed(checks) {
  for (const [link, c] of Object.entries(checks || {})) {
    if (!c || !["ok", "fail"].includes(c.status) || typeof c.at !== "number") continue;
    const r = results.get(link);
    if (r?.status === "checking" || (r && r.at >= c.at)) continue;
    setStatus(link, c.status, null, c.at);
  }
}

module.exports = {
  init(fn) { extractFn = fn; },
  setConcurrency(n) { concurrency = Math.max(1, n | 0); pump(); },
  check,
  freshCapture,
  recentCapture,
  statuses,
  snapshot,
  seed,
  record,
  mayTry,
  noteTry,
  onStatusChange(fn) { onStatus = fn; },
  // fn(link, fails, minutes) when a link enters backoff; fn(link, 0, 0) when it recovers from one
  onBackoff(fn) { onBackoff = fn; },
};
