// Background link checker: runs every NHL link through the extractor, a couple at a
// time, so the UI can hide dead links and start verified ones instantly.

const CONCURRENCY = 2;
const RECHECK_MS = 10 * 60 * 1000; // links often come alive at puck drop
const FRESH_CAPTURE_MS = 60 * 1000; // stream tokens expire; reuse captures only briefly

const results = new Map(); // link -> { status: "checking" | "ok" | "fail", capture, at }
let queue = [];
let running = 0;
let onStatus = () => {};
let extractFn = null; // (link) => Promise<capture | null>, set by init()

function setStatus(link, status, capture = null) {
  results.set(link, { status, capture, at: Date.now() });
  onStatus(link, status);
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const link = queue.shift();
    running++;
    setStatus(link, "checking");
    extractFn(link)
      .then(capture => setStatus(link, capture ? "ok" : "fail", capture))
      .catch(() => setStatus(link, "fail"))
      .finally(() => { running--; pump(); });
  }
}

// Queue every link that has never been checked or whose result is stale.
// Links no longer listed are dropped.
function check(links) {
  const listed = new Set(links);
  queue = queue.filter(l => listed.has(l));
  for (const l of [...results.keys()]) if (!listed.has(l)) results.delete(l);
  const now = Date.now();
  for (const link of listed) {
    const r = results.get(link);
    if (queue.includes(link) || r?.status === "checking") continue;
    if (!r || now - r.at > RECHECK_MS) queue.push(link);
  }
  pump();
}

// A capture verified moments ago, if any (saves a second extraction on click).
function freshCapture(link) {
  const r = results.get(link);
  return r?.status === "ok" && r.capture && Date.now() - r.at < FRESH_CAPTURE_MS ? r.capture : null;
}

function statuses() {
  return Object.fromEntries([...results].map(([l, r]) => [l, r.status]));
}

module.exports = {
  init(fn) { extractFn = fn; },
  check,
  freshCapture,
  statuses,
  record: setStatus,
  onStatusChange(fn) { onStatus = fn; },
};
