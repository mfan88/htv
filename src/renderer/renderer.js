const LEAGUES = ["nhl", "nhl preseason"];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let openGame = null;
let scoreLabels = {};         // onhockey game name -> { away, home, awayScore, homeScore, state }

// "CGY-EDM 0-3" (away left, home right) from the NHL API; onhockey's name if unmatched.
function gameLabel(name) {
  const l = scoreLabels[name];
  if (!l) return name;
  const score = l.awayScore != null && l.homeScore != null ? ` ${l.awayScore}-${l.homeScore}` : "";
  return `${l.away}-${l.home}${score}`;
}
let lastData = { streams: [] };
let statuses = {};            // link -> "checking" | "ok" | "fail" (from the background checker)
const gameLinks = new Map();  // gid -> playable links for that game, best first

/* ---------------- Sidebar ---------------- */

// onhockey lists times in GMT+1; convert to the viewer's local time.
function localTime(t, srcOffset) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
  if (!m) return t;
  let mins = (+m[1] - srcOffset) * 60 + +m[2] - new Date().getTimezoneOffset();
  mins = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
}

// "(feed) (channel)", e.g. "Home SN". Falls back to the source name when both are missing.
function linkTitle(r) {
  const feed = cap((r.feed || "").replace(/\s*feed$/i, ""));
  return [feed, r.channel].filter(Boolean).join(" ") || r.name;
}

const STATUS_RANK = { ok: 0, checking: 1, undefined: 1, fail: 2 };

function render(data = lastData) {
  lastData = data;
  const streams = (data.streams || []).filter(r => LEAGUES.includes(r.league.toLowerCase()));
  const srcOffset = data.source_utc_offset ?? 1;

  const links = [...new Set(streams.map(r => r.link))];
  const working = links.filter(l => statuses[l] === "ok").length;
  const pending = links.filter(l => statuses[l] !== "ok" && statuses[l] !== "fail").length;
  const updated = data.updated ? new Date(data.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never";
  $("status").innerHTML = `Updated ${esc(updated)} · ${working} working`
    + (pending ? ` · checking ${pending} more…` : "")
    + (data.error ? `<span class="err">Refresh failed: ${esc(data.error)}</span>` : "");

  const leagues = new Map(); // league -> (time|game -> {time, game, links})
  for (const r of streams) {
    if (!leagues.has(r.league)) leagues.set(r.league, new Map());
    const games = leagues.get(r.league);
    const key = r.time + "|" + r.game;
    if (!games.has(key)) games.set(key, { time: r.time, game: r.game, links: [] });
    games.get(key).links.push(r);
  }

  const box = $("games");
  if (!leagues.size) {
    box.innerHTML = `<div class="empty">No NHL games listed right now.</div>`;
    return;
  }

  const activeLink = player.current?.link;
  gameLinks.clear();
  let html = "";
  for (const [league, games] of leagues) {
    html += `<div class="league">${esc(league)}</div>`;
    for (const [key, g] of games) {
      const gid = league + "|" + key;
      // Dead links are skipped entirely; verified ones sort ahead of unchecked ones.
      const alive = g.links.filter(l => statuses[l.link] !== "fail");
      gameLinks.set(gid, [...alive].sort((a, b) => STATUS_RANK[statuses[a.link]] - STATUS_RANK[statuses[b.link]]));
      const feeds = new Map();
      for (const l of alive) {
        if (!feeds.has(l.feed)) feeds.set(l.feed, []);
        feeds.get(l.feed).push(l);
      }
      let linksHtml = "";
      for (const [feed, links] of feeds) {
        if (feed) linksHtml += `<div class="feed-label">${esc(feed)}</div>`;
        linksHtml += `<div class="pills">` + links.map(l => {
          const ok = statuses[l.link] === "ok";
          return `
          <button class="pill${l.link === activeLink ? " active" : ""}${ok ? "" : " pending"}"
                  data-link="${esc(l.link)}" data-gid="${esc(gid)}"
                  data-title="${esc(linkTitle(l))}" data-game="${esc(g.game)}" data-src="${esc(l.name)}"
                  title="${ok ? "Verified working" : "Still checking this link"}">
            <span class="title">${esc(linkTitle(l))}</span><span class="src">${esc(l.name)}</span>
          </button>`;
        }).join("") + `</div>`;
      }
      if (!alive.length) linksHtml = `<div class="no-links">No working links right now. htv will keep checking.</div>`;
      const okCount = alive.filter(l => statuses[l.link] === "ok").length;
      const extra = alive.length - okCount;
      html += `<div class="game${gid === openGame ? " open" : ""}${alive.length ? "" : " dead"}" data-gid="${esc(gid)}">
        <button class="game-head">
          <span class="time">${esc(localTime(g.time, srcOffset))}</span>
          <span class="teams${scoreLabels[g.game] ? " scored" : ""}" title="${esc(g.game)}">${esc(gameLabel(g.game))}</span>
          <span class="count" title="working + still checking">${okCount}${extra ? `<span class="dim">+${extra}</span>` : ""}</span>
          <svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
        </button>
        <div class="links">${linksHtml}</div>
      </div>`;
    }
  }
  box.innerHTML = html;
}

$("games").addEventListener("click", e => {
  const pill = e.target.closest(".pill");
  if (pill) {
    document.querySelectorAll(".pill.active").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    player.tried.clear();
    player.play(itemFrom(pill.dataset));
    return;
  }
  const head = e.target.closest(".game-head");
  if (!head) return;
  const game = head.parentElement;
  const wasOpen = game.classList.contains("open");
  document.querySelectorAll(".game.open").forEach(g => g.classList.remove("open"));
  if (!wasOpen) game.classList.add("open");
  openGame = wasOpen ? null : game.dataset.gid;
});

const itemFrom = d => ({ link: d.link, gid: d.gid, game: d.game, title: d.title, src: d.src });

let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 150);
}

async function load(refresh) {
  const btn = $("refresh");
  btn.disabled = true;
  btn.classList.add("loading");
  try {
    const data = await (refresh ? window.htv.refresh() : window.htv.getStreams());
    statuses = { ...data.statuses };
    render(data);
    refreshLabels();
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

/* ---------------- Player ---------------- */

const video = $("video");
const playerEl = $("player");

const player = {
  current: null,   // { link, game, title, src }
  mode: null,      // "native" | "embed"
  hls: null,
  session: 0,      // bumps on every play() so stale async results are ignored
  retries: 0,
  startTimer: null,
  tried: new Set(), // links that failed for the current game; skipped when advancing

  overlay(kind, title, text) {
    $("overlay").hidden = kind === "none";
    $("overlaySpinner").hidden = kind !== "loading";
    $("overlayTitle").textContent = title || "";
    $("overlayText").textContent = text || "";
  },

  teardown() {
    clearTimeout(this.startTimer);
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    video.pause();
    video.removeAttribute("src");
    video.load();
    $("embedHost").innerHTML = "";
    $("controls").hidden = true;
  },

  async play(item, { forceEmbed = false, isRetry = false, skipped = null } = {}) {
    const my = ++this.session;
    if (!isRetry) this.retries = 0;
    this.teardown();
    this.current = item;
    stats.show(item.game);
    $("nowTitle").textContent = gameLabel(item.game);
    $("nowTitle").title = item.game;
    $("nowSub").textContent = `${item.title} · ${item.src}`;
    $("linkText").textContent = item.link;
    $("linkbar").hidden = false;

    if (forceEmbed) return this.startEmbed();

    this.setMode("native");
    this.overlay("loading",
      isRetry ? "Reconnecting…" : skipped ? `That link didn't work. Trying ${item.title}…` : "Finding the stream…",
      skipped ? item.src : "Grabbing the video feed in the background.");
    const res = await window.htv.extract(item.link, { fresh: isRetry });
    if (my !== this.session || res.cancelled) return;
    if (res.ok) this.startNative(res.src, my);
    else this.skip();
  },

  // The current link is dead: remember that, then move on to the next link for this game.
  skip() {
    const failed = this.current;
    this.tried.add(failed.link);
    statuses[failed.link] = "fail";
    window.htv.markFailed(failed.link);
    render();
    const next = (gameLinks.get(failed.gid) || []).find(l => !this.tried.has(l.link));
    if (next) {
      document.querySelectorAll(".pill.active").forEach(p => p.classList.remove("active"));
      document.querySelector(`.pill[data-link="${CSS.escape(next.link)}"]`)?.classList.add("active");
      const item = { link: next.link, gid: failed.gid, game: failed.game, title: linkTitle(next), src: next.name };
      return this.play(item, { skipped: failed });
    }
    this.teardown();
    this.overlay("error", "No working stream right now",
      "Every link for this game failed. htv keeps re-checking in the background, or try the original player below.");
  },

  startNative(src, my) {
    if (!window.Hls || !Hls.isSupported()) return this.startEmbed("HLS playback isn't supported here.");
    const hls = new Hls({ backBufferLength: 90, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4 });
    this.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (my !== this.session) return;
      this.fillQuality();
      video.play().catch(() => { video.muted = true; syncMute(); video.play().catch(() => {}); });
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, () => this.fillQuality());
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal || my !== this.session) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
      // Network failures usually mean the stream's token expired: grab a fresh one once.
      if (this.retries < 1) {
        this.retries++;
        return this.play(this.current, { isRetry: true });
      }
      this.skip();
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    $("controls").hidden = false;
    this.overlay("loading", "Connecting…", "");
    this.startTimer = setTimeout(() => {
      if (my === this.session && video.readyState < 3) this.skip();
    }, 25000);
  },

  startEmbed(reason) {
    this.teardown();
    this.setMode("embed");
    const url = "https://" + this.current.link;
    $("embedHost").innerHTML = `<iframe src="${esc(url)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    this.overlay("none");
    if (reason) $("nowSub").textContent = `${this.current.title} · ${this.current.src} · original player (${reason})`;
  },

  setMode(mode) {
    this.mode = mode;
    const label = $("modeLabel");
    label.textContent = mode === "native" ? "htv player" : "original player";
    label.classList.toggle("embed", mode === "embed");
    $("btnMode").textContent = mode === "native" ? "Use original player" : "Try htv player";
  },

  fillQuality() {
    const sel = $("quality");
    const levels = this.hls?.levels || [];
    sel.hidden = levels.length < 2;
    const auto = this.hls?.autoLevelEnabled;
    const cur = this.hls?.currentLevel;
    const autoLabel = auto && levels[cur]?.height ? `Auto (${levels[cur].height}p)` : "Auto";
    sel.innerHTML = `<option value="-1">${autoLabel}</option>` + levels
      .map((l, i) => ({ i, h: l.height, b: l.bitrate }))
      .sort((a, b) => (b.h || 0) - (a.h || 0) || b.b - a.b)
      .map(l => `<option value="${l.i}">${l.h ? l.h + "p" : Math.round(l.b / 1000) + " kbps"}</option>`)
      .join("");
    sel.value = auto ? "-1" : String(cur);
  },
};

/* ---------------- Controls ---------------- */

function syncPlay() { $("btnPlay").classList.toggle("playing", !video.paused); }
function syncMute() {
  $("btnMute").classList.toggle("muted", video.muted || video.volume === 0);
  $("volume").value = video.muted ? 0 : video.volume;
}
function togglePlay() { video.paused ? video.play().catch(() => {}) : video.pause(); }
function toggleMute() { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 0.5; }
function setVolume(v) { video.volume = Math.min(1, Math.max(0, v)); video.muted = video.volume === 0; }
function toggleFullscreen() { document.fullscreenElement ? document.exitFullscreen() : playerEl.requestFullscreen(); }
function liveEdge() { return player.hls?.liveSyncPosition ?? (video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null); }

video.volume = +(store.get("volume") ?? 1);
video.muted = store.get("muted") === "1";
syncMute();

video.addEventListener("play", syncPlay);
video.addEventListener("pause", syncPlay);
video.addEventListener("playing", () => { clearTimeout(player.startTimer); player.overlay("none"); });
video.addEventListener("waiting", () => { if (player.mode === "native") player.overlay("loading", "Buffering…", ""); });
video.addEventListener("volumechange", () => {
  syncMute();
  store.set("volume", String(video.volume));
  store.set("muted", video.muted ? "1" : "0");
});
video.addEventListener("timeupdate", () => {
  const edge = liveEdge();
  $("btnLive").classList.toggle("at-edge", edge != null && edge - video.currentTime < 12);
});
video.addEventListener("click", togglePlay);
video.addEventListener("dblclick", toggleFullscreen);

$("btnPlay").addEventListener("click", togglePlay);
$("btnMute").addEventListener("click", toggleMute);
$("volume").addEventListener("input", e => setVolume(+e.target.value));
$("btnFull").addEventListener("click", toggleFullscreen);
$("btnLive").addEventListener("click", () => {
  const edge = liveEdge();
  if (edge != null) video.currentTime = edge;
  video.play().catch(() => {});
});
$("btnPip").addEventListener("click", () => {
  document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture().catch(() => {});
});
$("quality").addEventListener("change", e => { if (player.hls) player.hls.currentLevel = +e.target.value; });

$("btnMode").addEventListener("click", () => {
  if (!player.current) return;
  player.play(player.current, { forceEmbed: player.mode === "native" });
});
$("btnExternal").addEventListener("click", () => { if (player.current) window.htv.openExternal(player.current.link); });

// Auto-hide controls and cursor while watching.
let idleTimer = null;
function wake() {
  $("controls").classList.remove("idle");
  playerEl.classList.remove("hide-cursor");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!video.paused && player.mode === "native") {
      $("controls").classList.add("idle");
      playerEl.classList.add("hide-cursor");
    }
  }, 2500);
}
playerEl.addEventListener("mousemove", wake);
playerEl.addEventListener("mouseleave", () => { if (!video.paused) $("controls").classList.add("idle"); });

document.addEventListener("keydown", e => {
  if (player.mode !== "native" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest("input, select")) return;
  const k = e.key.toLowerCase();
  if (k === " " || k === "k") togglePlay();
  else if (k === "m") toggleMute();
  else if (k === "f") toggleFullscreen();
  else if (k === "arrowup") setVolume(video.volume + 0.05);
  else if (k === "arrowdown") setVolume(video.volume - 0.05);
  else return;
  e.preventDefault();
  wake();
});

/* ---------------- Live stats ---------------- */

const STATS_POLL_MS = 15000;
const PERIOD = { 1: "1st", 2: "2nd", 3: "3rd" };
const periodLabel = (n, type) => type === "SO" ? "SO" : type === "OT" ? (n > 4 ? `${n - 3}OT` : "OT") : PERIOD[n] || `P${n}`;
const TAGS = { pp: "PPG", sh: "SHG" };
const MODS = { "empty-net": "EN", "penalty-shot": "PS", "own-goal": "OG" };

const stats = {
  game: null,   // onhockey game name currently shown
  timer: null,

  show(gameName) {
    if (gameName === this.game) return;
    this.game = gameName;
    $("stats").hidden = true;
    clearInterval(this.timer);
    this.poll();
    this.timer = setInterval(() => this.poll(), STATS_POLL_MS);
  },

  async poll() {
    const name = this.game;
    const g = name ? await window.htv.gameStats(name) : null;
    if (name !== this.game) return;
    if (!g) { $("stats").hidden = true; return; }
    this.render(g);
    $("stats").hidden = false;
  },

  render(g) {
    let state;
    if (g.state === "FUT" || g.state === "PRE") {
      state = "Starts " + new Date(g.startTimeUTC).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } else if (g.state === "FINAL" || g.state === "OFF") {
      state = "Final" + (g.periodType === "OT" ? "/OT" : g.periodType === "SO" ? "/SO" : "");
    } else {
      const p = periodLabel(g.period, g.periodType);
      state = g.intermission ? `${p} INT` : `${p} · ${g.clock}`;
    }
    const live = g.state === "LIVE" || g.state === "CRIT";
    const sog = g.away.sog != null ? `<span class="sog">SOG ${g.away.sog}–${g.home.sog}</span>` : "";
    const team = t => `<span class="team">${t.logo ? `<img src="${esc(t.logo)}" alt="">` : ""}${esc(t.abbrev)}</span>`;
    $("scorebug").innerHTML = `
      ${team(g.away)}<span class="score">${g.away.score ?? "–"}</span>
      <span class="dash">–</span>
      <span class="score">${g.home.score ?? "–"}</span>${team(g.home)}
      <span class="state${live ? " live" : ""}">${esc(state)}${sog}</span>`;

    const list = $("goals");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 4;
    list.innerHTML = g.goals.map(x => {
      const tags = [TAGS[x.strength], MODS[x.modifier]].filter(Boolean).map(t => `<span class="tag">${t}</span>`).join("");
      const ast = x.assists.length ? x.assists.map(esc).join(", ") : "Unassisted";
      const when = x.periodType === "SO" ? "SO" : `${periodLabel(x.period, x.periodType)} ${esc(x.time)}`;
      return `<li class="goal">
        <span class="when">${when}</span>
        <span class="tm">${esc(x.team)}</span>
        <span class="who"><b>${esc(x.scorer)}</b>${x.scorerTotal != null ? ` (${x.scorerTotal})` : ""}${tags}
          <span class="ast">${ast}</span></span>
      </li>`;
    }).join("");
    if (atBottom) list.scrollTop = list.scrollHeight; // follow new goals unless the user scrolled up
  },
};

// Stats are for regular view only; fullscreen shows just the video.
document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("fullscreen", !!document.fullscreenElement);
});

/* ---------------- Scoreboard labels ---------------- */

const LABELS_POLL_MS = 20000;
async function refreshLabels() {
  const names = [...new Set((lastData.streams || [])
    .filter(r => LEAGUES.includes(r.league.toLowerCase())).map(r => r.game))];
  if (!names.length) return;
  const next = await window.htv.gameLabels(names).catch(() => null);
  if (!next || JSON.stringify(next) === JSON.stringify(scoreLabels)) return;
  scoreLabels = next;
  render();
  if (player.current) $("nowTitle").textContent = gameLabel(player.current.game);
}
setInterval(refreshLabels, LABELS_POLL_MS);

/* ---------------- Sidebar collapse ---------------- */

function setSidebar(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  store.set("sidebarCollapsed", collapsed ? "1" : "0");
}
setSidebar(store.get("sidebarCollapsed") === "1");
$("btnSidebar").addEventListener("click", () => setSidebar(!document.body.classList.contains("sidebar-collapsed")));
document.addEventListener("keydown", e => {
  if (e.key.toLowerCase() !== "s" || e.ctrlKey || e.metaKey || e.altKey || e.target.closest("input, select")) return;
  setSidebar(!document.body.classList.contains("sidebar-collapsed"));
});

/* ---------------- Startup ---------------- */

$("refresh").addEventListener("click", () => load(true));
window.htv.onRefreshShortcut(() => load(true));
window.htv.onLinkStatus(({ link, status }) => { statuses[link] = status; renderSoon(); });
// Background re-fetch (every 5 min) pushes a fresh list with the checker's statuses.
window.htv.onStreams(data => { statuses = { ...data.statuses }; render(data); });
load(false); // the main process already scraped on startup
