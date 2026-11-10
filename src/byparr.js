// Byparr (captcha / Cloudflare solver, FlareSolverr-compatible /v1 API) client. Optional: with
// HTV_BYPARR_URL unset, enabled() is false and every caller keeps its plain fetch.
//
// Byparr drives a real browser per request, so calls are slow and heavy. They are queued
// (HTV_BYPARR_CONCURRENCY at once) and only made after a plain request was blocked or failed.
const fs = require("fs");
const path = require("path");
const TIMEOUT_MS = Number(process.env.HTV_BYPARR_TIMEOUT_SEC || 60) * 1000;
const CONCURRENCY = Math.max(1, Number(process.env.HTV_BYPARR_CONCURRENCY || 2));

// Address and token: the environment, else <HTV_DATA>/byparr.json ({ "url": "...", "token": "..." }), the
// same places sportsurge.js looks, so one setting serves both.
function config() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(process.env.HTV_DATA || "htv-data", "byparr.json"), "utf8")); } catch {}
  return { url: (process.env.HTV_BYPARR_URL || file.url || "").replace(/\/+$/, ""), token: process.env.HTV_BYPARR_TOKEN || file.token || "" };
}

const enabled = () => !!config().url;

// Challenge pages answer 403/503, or return a "just a moment" interstitial with a 200.
const looksBlocked = (status, body) =>
  status === 403 || status === 503 || status === 429 || /<title>\s*(just a moment|attention required|access denied)/i.test(body || "");

let active = 0;
const waiting = [];
async function slot(signal) {
  if (active >= CONCURRENCY) {
    await new Promise((resolve, reject) => {
      const w = { resolve };
      waiting.push(w);
      signal?.addEventListener("abort", () => {
        const i = waiting.indexOf(w);
        if (i >= 0) waiting.splice(i, 1);
        reject(new Error("aborted"));
      }, { once: true });
    });
  } else active++;
  return () => { const next = waiting.shift(); if (next) next.resolve(); else active--; };
}

// -> { html, status, url, cookies (Playwright shape), userAgent, contentType }
async function solve(url, { signal } = {}) {
  if (!enabled()) throw new Error("byparr is not configured");
  if (signal?.aborted) throw new Error("aborted");
  const { url: api, token } = config();
  const release = await slot(signal);
  try {
    const res = await fetch(/\/v1$/.test(api) ? api : `${api}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Byparr-Token": token } : {}) },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout: TIMEOUT_MS, blockMedia: true }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS + 10000)]) : AbortSignal.timeout(TIMEOUT_MS + 10000),
    });
    if (!res.ok) throw new Error(`byparr HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== "ok" || !data.solution) throw new Error(`byparr: ${data.message || "no solution"}`);
    const s = data.solution;
    return { html: s.response || "", status: s.status, url: s.url, cookies: s.cookies || [], userAgent: s.userAgent || "", contentType: s.contentType || "" };
  } finally {
    release();
  }
}

// Browsers wrap a bare JSON body in <pre>...</pre> (and escape it); undo that.
function jsonText(body) {
  const m = /<pre[^>]*>([\s\S]*)<\/pre>/i.exec(body);
  const raw = m ? m[1] : body;
  return raw.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Plain fetch first; if it fails, is blocked, or (json) isn't JSON, retry through Byparr.
// `decode(res)` turns the Response into text; `json: true` parses and returns the JSON instead.
// Throws the plain error when Byparr is off or fails too.
async function fetchPage(url, init, { decode = r => r.text(), json = false, signal } = {}) {
  let plainErr;
  try {
    const res = await fetch(url, init);
    const body = await decode(res);
    if (res.ok && !looksBlocked(res.status, body)) {
      if (!json) return body;
      try { return JSON.parse(body); } catch { plainErr = new Error(`${new URL(url).host} did not return JSON`); }
    } else plainErr = new Error(`${new URL(url).host} returned HTTP ${res.status}`);
  } catch (err) {
    plainErr = err;
  }
  if (!enabled()) throw plainErr;
  try {
    const s = await solve(url, { signal });
    console.log(`byparr: ${new URL(url).host}${new URL(url).pathname} (plain fetch: ${plainErr.message})`);
    return json ? JSON.parse(jsonText(s.html)) : s.html;
  } catch (err) {
    throw new Error(`${plainErr.message}; byparr: ${err.message}`);
  }
}

module.exports = { enabled, solve, fetchPage, looksBlocked };
