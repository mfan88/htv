// Background link checker: runs every NHL link through the extractor, a few at a
// time, so the UI can hide dead links and start verified ones instantly.

const RECHECK_MS = 10 * 60 * 1000; // links often come alive at puck drop
const HOT_RECHECK_MS = 3 * 60 * 1000; // games on or about to start: keep captures warm
const FRESH_CAPTURE_MS = 60 * 1000; // stream tokens expire; reuse captures only briefly
const RECENT_CAPTURE_MS = 15 * 60 * 1000; // for callers that probe the capture before trusting it

const results = new Map(); // link -> { status: "checking" | "ok" | "fail", capture, at }
let queue = [];
let running = 0;
let concurrency = 2;
let onStatus = () => {};
let extractFn = null; // (link) => Promise<capture | null>, set by init()

function setStatus(link, status, capture = null, at = Date.now()) {
  results.set(link, { status, capture, at });
  onStatus(link, status);
}

function pump() {
  while (running < concurrency && queue.length) {
    const link = queue.shift();
    running++;
    setStatus(link, "checking");
    extractFn(link)
      .then(capture => setStatus(link, capture ? "ok" : "fail", capture))
      .catch(() => setStatus(link, "fail"))
      .finally(() => { running--; pump(); });
  }
}

// Queue every link that has never been checked or, unless `recheck` is false, whose
// result is stale. Links no longer listed are dropped.
// `hot` links (a Set) are rechecked sooner and go first. Concurrency stays the same, so
// keeping them warm doesn't add load, it only reorders it.
// `idleMs` overrides how stale a non-hot result must be before it is rechecked.
function check(links, { recheck = true, hot = new Set(), idleMs = RECHECK_MS } = {}) {
  const listed = new Set(links);
  queue = queue.filter(l => listed.has(l));
  for (const l of [...results.keys()]) if (!listed.has(l)) results.delete(l);
  const now = Date.now();
  for (const link of listed) {
    const r = results.get(link);
    if (queue.includes(link) || r?.status === "checking") continue;
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
  record: setStatus,
  onStatusChange(fn) { onStatus = fn; },
};
