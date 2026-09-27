// htv web player (served by server mode). The server extracts each stream and proxies
// it, so this page only plays a plain HLS URL. Safari plays it natively, which is also
// what lets AirPlay hand the stream to an Apple TV instead of mirroring the screen.

const LEAGUES = ["nhl", "nhl preseason"];
const LIST_POLL_MS = 60 * 1000;
const LABELS_POLL_MS = 30 * 1000;
const START_TIMEOUT_MS = 30 * 1000;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

/* ---------------- Server API ---------------- */

let token = store.get("htv-token") || "";
// A setup link like http://server:8787/#token=... saves the token and drops it from the URL.
const hashToken = /(?:^|&)token=([^&]+)/.exec(location.hash.slice(1));
if (hashToken) {
  token = decodeURIComponent(hashToken[1]);
  store.set("htv-token", token);
  history.replaceState(null, "", location.pathname);
}

class Unauthorized extends Error {}

async function api(path) {
  const res = await fetch(path, { headers: token ? { Authorization: "Bearer " + token } : {}, cache: "no-store" });
  if (res.status === 401) throw new Unauthorized("unauthorized");
  if (!res.ok) throw new Error(`the server returned HTTP ${res.status}`);
  return res.json();
}

$("login").addEventListener("submit", e => {
  e.preventDefault();
  token = $("token").value.trim();
  store.set("htv-token", token);
  $("login").hidden = true;
  load();
});

/* ---------------- Game list ---------------- */

let data = { streams: [] };
let checks = {};       // link -> { status, at }
let labels = {};       // onhockey game name -> { away, home, awayScore, homeScore, state }
let openGame = null;
const gameLinks = new Map(); // gid -> playable links for that game, best first

const status = link => checks[link]?.status;
const STATUS_RANK = { ok: 0, undefined: 1, fail: 2 };

// onhockey lists times in GMT+1; convert to the viewer's local time.
function localTime(t, srcOffset) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
  if (!m) return t;
  let mins = (+m[1] - srcOffset) * 60 + +m[2] - new Date().getTimezoneOffset();
  mins = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
}

// "Home SN" from "(feed) (channel)"; the source name when both are missing.
function linkTitle(r) {
  const feed = cap((r.feed || "").replace(/\s*feed$/i, ""));
  return [feed, r.channel].filter(Boolean).join(" ") || r.name;
}

// "CGY-EDM 0-3" (away left, home right) from the NHL API; onhockey's name if unmatched.
function gameLabel(name) {
  const l = labels[name];
  if (!l) return name;
  const score = l.awayScore != null && l.homeScore != null ? ` ${l.awayScore}-${l.homeScore}` : "";
  return `${l.away}-${l.home}${score}`;
}
const isLive = name => ["LIVE", "CRIT"].includes(labels[name]?.state);

function render() {
  const streams = (data.streams || []).filter(r => LEAGUES.includes(r.league.toLowerCase()));
  const srcOffset = data.source_utc_offset ?? 1;

  const links = [...new Set(streams.map(r => r.link))];
  const working = links.filter(l => status(l) === "ok").length;
  const updated = data.updated ? new Date(data.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  $("status").innerHTML = updated
    ? `${esc(updated)} · ${working} working` + (data.error ? ` · <span class="err">refresh failed</span>` : "")
    : "Loading…";

  const leagues = new Map(); // league -> (time|game -> { time, game, links })
  for (const r of streams) {
    if (!leagues.has(r.league)) leagues.set(r.league, new Map());
    const games = leagues.get(r.league);
    const key = r.time + "|" + r.game;
    if (!games.has(key)) games.set(key, { time: r.time, game: r.game, links: [] });
    games.get(key).links.push(r);
  }
  if (!leagues.size) {
    $("games").innerHTML = `<div class="empty">${data.updated ? "No NHL games listed right now." : "Loading games…"}</div>`;
    return;
  }

  const activeLink = player.current?.link;
  gameLinks.clear();
  let html = "";
  for (const [league, games] of leagues) {
    html += `<div class="league">${esc(league)}</div>`;
    for (const [key, g] of games) {
      const gid = league + "|" + key;
      // Dead links are hidden; verified ones sort ahead of unchecked ones.
      const alive = g.links.filter(l => status(l.link) !== "fail")
        .sort((a, b) => STATUS_RANK[status(a.link)] - STATUS_RANK[status(b.link)]);
      gameLinks.set(gid, alive);
      const feeds = new Map();
      for (const l of alive) {
        if (!feeds.has(l.feed)) feeds.set(l.feed, []);
        feeds.get(l.feed).push(l);
      }
      let linksHtml = "";
      for (const [feed, fl] of feeds) {
        if (feed) linksHtml += `<div class="feed-label">${esc(feed)}</div>`;
        linksHtml += `<div class="pills">` + fl.map(l => `
          <button class="pill${l.link === activeLink ? " active" : ""}${status(l.link) === "ok" ? "" : " pending"}"
                  data-link="${esc(l.link)}" data-gid="${esc(gid)}" data-game="${esc(g.game)}"
                  data-title="${esc(linkTitle(l))}" data-src="${esc(l.name)}">
            <span>${esc(linkTitle(l))}</span><span class="src">${esc(l.name)}</span>
          </button>`).join("") + `</div>`;
      }
      if (!alive.length) linksHtml = `<div class="no-links">No working links right now. The server keeps checking.</div>`;
      const ok = alive.filter(l => status(l.link) === "ok").length;
      const extra = alive.length - ok;
      html += `<div class="game${gid === openGame ? " open" : ""}${alive.length ? "" : " dead"}" data-gid="${esc(gid)}">
        <button class="game-head">
          <span class="time">${esc(localTime(g.time, srcOffset))}</span>
          <span class="teams">${esc(gameLabel(g.game))}${isLive(g.game) ? `<span class="live">LIVE</span>` : ""}</span>
          <span class="count">${ok}${extra ? `<span class="dim">+${extra}</span>` : ""}</span>
          <svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
        </button>
        <div class="links">${linksHtml}</div>
      </div>`;
    }
  }
  $("games").innerHTML = html;
}

$("games").addEventListener("click", e => {
  const pill = e.target.closest(".pill");
  if (pill) {
    player.tried.clear();
    player.play({ ...pill.dataset });
    return;
  }
  const head = e.target.closest(".game-head");
  if (!head) return;
  const gid = head.parentElement.dataset.gid;
  openGame = openGame === gid ? null : gid;
  render();
});

async function load() {
  const btn = $("refresh");
  btn.disabled = true;
  btn.classList.add("loading");
  try {
    data = await api("/api/streams");
    checks = data.checks || {};
    render();
    loadLabels();
  } catch (err) {
    if (err instanceof Unauthorized) {
      $("login").hidden = false;
      $("status").textContent = "Token needed";
    } else {
      $("status").innerHTML = `<span class="err">Can't reach the server</span>`;
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

async function loadLabels() {
  const next = await api("/api/labels").catch(() => null);
  if (!next || JSON.stringify(next) === JSON.stringify(labels)) return;
  labels = next;
  render();
  if (player.current) $("nowTitle").textContent = gameLabel(player.current.game);
}

$("refresh").addEventListener("click", load);
setInterval(() => { if (!document.hidden) load(); }, LIST_POLL_MS);
setInterval(() => { if (!document.hidden) loadLabels(); }, LABELS_POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

/* ---------------- Player ---------------- */

const video = $("video");
const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");

const player = {
  current: null,    // { link, gid, game, title, src }
  session: 0,       // bumps on every play() so stale async results are ignored
  hls: null,
  startTimer: null,
  tried: new Set(), // links that failed for the current game; skipped when advancing

  overlay(kind, title = "", text = "") {
    $("overlay").hidden = kind === "none";
    $("overlay").dataset.kind = kind;
    $("overlaySpinner").hidden = kind !== "loading";
    $("overlayTitle").textContent = title;
    $("overlayText").textContent = text;
  },

  teardown() {
    clearTimeout(this.startTimer);
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    video.pause();
    video.removeAttribute("src");
    video.load();
  },

  async play(item) {
    const my = ++this.session;
    this.teardown();
    this.current = item;
    $("player").hidden = false;
    $("nowTitle").textContent = gameLabel(item.game);
    $("nowSub").textContent = `${item.title} · ${item.src}`;
    render();
    this.overlay("loading", "Finding the stream…", "The server is opening this link. It can take up to 25 seconds.");

    let res;
    try {
      res = await api("/api/play?link=" + encodeURIComponent(item.link));
    } catch (err) {
      if (my === this.session) this.overlay("error", "Couldn't reach the server", err.message);
      return;
    }
    if (my !== this.session) return;
    if (!res.ok) return this.advance(res.error);
    await this.attach(res.src, my);
  },

  async attach(src, my) {
    if (nativeHls) {
      video.src = src;
    } else {
      await loadHlsJs();
      if (my !== this.session) return;
      this.hls = new Hls({ liveSyncDurationCount: 3 });
      this.hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal && my === this.session) this.advance("The stream stopped loading."); });
      this.hls.loadSource(src);
      this.hls.attachMedia(video);
    }
    this.startTimer = setTimeout(() => {
      if (my === this.session && video.readyState < 2) this.advance("The stream didn't start.");
    }, START_TIMEOUT_MS);
    this.overlay("loading", "Starting…");
    // The tap that picked the link was too long ago for iOS to allow sound, so autoplay
    // can be refused; then wait for a tap on the overlay.
    video.play().catch(() => {
      if (my === this.session) this.overlay("tap", "Ready", "Tap to play");
    });
  },

  // Try the game's next untried link, or give up with `reason`.
  advance(reason) {
    const cur = this.current;
    if (!cur) return;
    this.tried.add(cur.link);
    api("/api/streams").then(d => { data = d; checks = d.checks || {}; render(); }).catch(() => {});
    const next = (gameLinks.get(cur.gid) || []).find(l => !this.tried.has(l.link));
    if (!next) {
      this.teardown();
      this.overlay("error", "No working stream", reason || "Every link for this game failed. Try again in a bit.");
      return;
    }
    this.play({ link: next.link, gid: cur.gid, game: cur.game, title: linkTitle(next), src: next.name });
  },

  stop() {
    this.session++;
    this.teardown();
    this.current = null;
    $("player").hidden = true;
    render();
  },
};

$("overlay").addEventListener("click", () => {
  if ($("overlay").dataset.kind === "tap") video.play().catch(() => {});
});
$("btnClose").addEventListener("click", () => player.stop());

video.addEventListener("playing", () => { clearTimeout(player.startTimer); player.overlay("none"); });
video.addEventListener("error", () => {
  if (player.current && video.getAttribute("src")) player.advance("The stream stopped loading.");
});

let hlsJsLoading = null;
function loadHlsJs() {
  hlsJsLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "hls.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return hlsJsLoading;
}

/* ---------------- AirPlay ---------------- */

// Safari only. With a native HLS source, AirPlay sends the stream's URL to the Apple TV,
// which then fetches it from the server itself; the phone just acts as a remote.
if (window.WebKitPlaybackTargetAvailabilityEvent) {
  video.addEventListener("webkitplaybacktargetavailabilitychanged", e => {
    $("btnAirplay").hidden = e.availability !== "available";
  });
  video.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", () => {
    const wireless = video.webkitCurrentPlaybackTargetIsWireless;
    document.body.classList.toggle("airplaying", wireless);
    if (player.current) {
      $("nowSub").textContent = wireless ? "Playing on AirPlay" : `${player.current.title} · ${player.current.src}`;
    }
  });
  $("btnAirplay").addEventListener("click", () => video.webkitShowPlaybackTargetPicker());
}

load();
