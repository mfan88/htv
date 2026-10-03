// Live game stats from the NHL's public web API (the one NHL.com uses; free, no key,
// but unofficial). One scoreboard call covers every game of the day, including each
// goal's scorer and assists.

const SCOREBOARD_URL = "https://api-web.nhle.com/v1/score/now";
const CACHE_MS = 12000;

// Names onhockey.tv might use for each team (city, nickname, common short forms).
const TEAMS = {
  ANA: ["anaheim", "ducks"], BOS: ["boston", "bruins"], BUF: ["buffalo", "sabres"],
  CGY: ["calgary", "flames"], CAR: ["carolina", "hurricanes"], CHI: ["chicago", "blackhawks"],
  COL: ["colorado", "avalanche"], CBJ: ["columbus", "blue jackets"], DAL: ["dallas", "stars"],
  DET: ["detroit", "red wings"], EDM: ["edmonton", "oilers"], FLA: ["florida", "panthers"],
  LAK: ["los angeles", "la kings", "kings"], MIN: ["minnesota", "wild"], MTL: ["montreal", "canadiens"],
  NSH: ["nashville", "predators"], NJD: ["new jersey", "devils"], NYI: ["ny islanders", "new york islanders", "islanders"],
  NYR: ["ny rangers", "new york rangers", "rangers"], OTT: ["ottawa", "senators"], PHI: ["philadelphia", "flyers"],
  PIT: ["pittsburgh", "penguins"], SJS: ["san jose", "sharks"], SEA: ["seattle", "kraken"],
  STL: ["st. louis", "st louis", "blues"], TBL: ["tampa bay", "tampa", "lightning"], TOR: ["toronto", "maple leafs"],
  UTA: ["utah", "mammoth"], VAN: ["vancouver", "canucks"], VGK: ["vegas", "golden knights"],
  WSH: ["washington", "capitals"], WPG: ["winnipeg", "jets"],
};

const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Which team abbreviations appear in an onhockey game name like "San Jose Sharks - Vegas".
function teamsIn(gameName) {
  const sides = norm(gameName).split(/\s+-\s+/);
  const found = [];
  for (const side of sides) {
    const hit = Object.entries(TEAMS).find(([, names]) => names.some(n => side.includes(n)));
    if (hit) found.push(hit[0]);
  }
  return found;
}

let cache = { at: 0, data: null, pending: null };

async function scoreboard() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (!cache.pending) {
    cache.pending = fetch(SCOREBOARD_URL, { signal: AbortSignal.timeout(10000) })
      .then(r => { if (!r.ok) throw new Error(`NHL API HTTP ${r.status}`); return r.json(); })
      .then(d => { cache = { at: Date.now(), data: d, pending: null }; return d; })
      .catch(e => { cache.pending = null; throw e; });
  }
  return cache.pending;
}

const text = v => (v && typeof v === "object" ? v.default : v) || "";
// "Flames": the scoreboard usually has only the nickname (with the city when it has one).
const fullName = t => [text(t.placeName), text(t.name)].filter(Boolean).join(" ") || t.abbrev;

function simplify(g) {
  const team = t => ({ abbrev: t.abbrev, name: text(t.name), score: t.score ?? null, sog: t.sog ?? null, logo: t.logo || null });
  return {
    id: g.id,
    state: g.gameState, // FUT, PRE, LIVE, CRIT, OFF, FINAL
    startTimeUTC: g.startTimeUTC,
    period: g.periodDescriptor?.number ?? null,
    periodType: g.periodDescriptor?.periodType ?? null, // REG, OT, SO
    clock: g.clock?.timeRemaining ?? null,
    intermission: !!g.clock?.inIntermission,
    away: team(g.awayTeam),
    home: team(g.homeTeam),
    goals: (g.goals || []).map(x => ({
      period: x.periodDescriptor?.number ?? x.period,
      periodType: x.periodDescriptor?.periodType ?? "REG",
      time: x.timeInPeriod,
      team: x.teamAbbrev,
      scorer: text(x.name),
      scorerTotal: x.goalsToDate ?? null,
      assists: (x.assists || []).map(a => text(a.name)),
      strength: x.strength, // ev, pp, sh
      modifier: x.goalModifier, // none, empty-net, penalty-shot, own-goal
      awayScore: x.awayScore,
      homeScore: x.homeScore,
    })),
  };
}

function findGame(games, gameName) {
  const wanted = teamsIn(gameName);
  if (wanted.length < 2) return null;
  // onhockey lists "away - home"; prefer that exact pairing (split-squad days can have
  // the same two teams playing twice, once at each rink), else either order.
  return games.find(g => g.awayTeam.abbrev === wanted[0] && g.homeTeam.abbrev === wanted[1])
    || games.find(g => wanted.includes(g.awayTeam.abbrev) && wanted.includes(g.homeTeam.abbrev))
    || null;
}

// Stats for the NHL game matching an onhockey game name, or null if none matches today.
async function forGame(gameName) {
  const game = findGame((await scoreboard()).games || [], gameName);
  return game ? simplify(game) : null;
}

// Short scoreboard labels for many onhockey game names at once:
// { "Calgary - Edmonton Oilers": { away: "CGY", home: "EDM", awayScore: 0, homeScore: 3, state: "LIVE",
//   awayName: "Flames", homeName: "Oilers", start: "2026-10-03T01:00:00Z" } }
async function labels(gameNames) {
  const games = (await scoreboard()).games || [];
  const out = {};
  for (const name of gameNames) {
    const g = findGame(games, name);
    if (!g) continue;
    const started = !["FUT", "PRE"].includes(g.gameState);
    out[name] = {
      away: g.awayTeam.abbrev,
      home: g.homeTeam.abbrev,
      awayScore: started ? g.awayTeam.score ?? null : null,
      homeScore: started ? g.homeTeam.score ?? null : null,
      state: g.gameState,
      awayName: fullName(g.awayTeam),
      homeName: fullName(g.homeTeam),
      start: g.startTimeUTC || null,
    };
  }
  return out;
}

module.exports = { forGame, labels, teamsIn, scoreboard };
