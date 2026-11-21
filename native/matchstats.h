/* matchstats.h (2026-11-21, runtime 0.4.4): a match's kills, deaths, length and end, for the leaderboard (the user: "I want
 * it to work the same way as survival"; main.lua writes them into bridge/result.json for the server).
 *
 * Deaths are counted from the death messages each PC already handles, so both PCs count the same events:
 *   this pilot's deaths  = FLiveMessageDestroyedLocation sent by this PC's own plane (captured at Send, D1), about 6 s
 *                          after each death;
 *   the opponent's       = DestroyedLocation from the opponent routed into this game (the link's DATA, WireIn; on one
 *                          PC the mirror of this plane's own, LbMirrorOne).
 * (Not the planes' own state: the copy's health doesn't drop when the relay marks it destroyed, and its death flag
 * +0x3c2e stays set after the respawn: the damage test's log of 2026-11-19 22:18.) In a 1v1 a pilot's kills are the
 * other's deaths. Counted from GamePlaying (14) to the result at time-up or the forced end, once a second by the
 * always-on tick; each new death is kept with its time for the log's events. */
#define MS_MAX_EVENTS 64
static volatile int32_t g_msMatches, g_msDeaths[2], g_msSecs, g_msEnd, g_msN;
static int32_t g_msBase[2] = { -1, -1 };
static int32_t g_msT[MS_MAX_EVENTS];                 /* (tenths of a second since GamePlaying) */
static uint8_t g_msWho[MS_MAX_EVENTS];               /* (0 this pilot died, 1 the opponent) */
static int     g_msOn;                               /* 0 waiting for GamePlaying, 1 counting, 2 ended (until the next
                                                     * match's reset: the run of 14:05 counted again from zero) */

static void MatchStatsReset(void)
{
    g_msOn = 0; g_msBase[0] = g_msBase[1] = -1;           /* (MatchReset: a new match) */
}

/* the always-on tick, once a second while a match is armed */
static void MatchStatsTick(void)
{
    if (!g_s14At || g_msOn == 2) return;
    int32_t now[2] = { SentCount(L"FLiveMessageDestroyedLocation"), LoopedCount(L"FLiveMessageDestroyedLocation") };
    if (!g_msOn) {                                    /* (GamePlaying began: this match's counts start here) */
        g_msOn = 1;
        g_msBase[0] = now[0]; g_msBase[1] = now[1];
        g_msDeaths[0] = g_msDeaths[1] = 0; g_msN = 0; g_msSecs = 0; g_msEnd = 0;
        return;
    }
    int32_t t = (int32_t)((GetTickCount64() - g_s14At) / 100);
    for (int i = 0; i < 2; ++i) {
        while (now[i] - g_msBase[i] > g_msDeaths[i]) {
            ++g_msDeaths[i];
            if (g_msN < MS_MAX_EVENTS) { g_msT[g_msN] = t; g_msWho[g_msN] = (uint8_t)i; ++g_msN; }
            Log(L"match stats: %s died (%d) at %d.%d s", i == 0 ? L"this pilot" : L"the opponent", g_msDeaths[i], t / 10, t % 10);
        }
    }
}

/* the result (ResultCapture: time-up, or the forced end after a lost link) */
static void MatchStatsEnd(void)
{
    if (g_msOn != 1) return;
    MatchStatsTick();                                 /* (the last second's deaths too) */
    g_msSecs = g_s14At ? (int32_t)((GetTickCount64() - g_s14At) / 1000) : 0;
    g_msEnd = g_llFired ? 1 : 0;
    g_msOn = 2;
    __sync_add_and_fetch(&g_msMatches, 1);
    Log(L"match stats: %d s, ended by %s; this pilot died %d time(s), the opponent %d", g_msSecs,
        g_msEnd ? L"the lost link (the forced end)" : L"time-up", g_msDeaths[0], g_msDeaths[1]);
}

/* RVNG_MatchStat(k): (0) matches with stats so far, (1) this pilot's deaths, (2) the opponent's, (3) the match's length in
 * seconds (GamePlaying to the end), (4) how it ended (0 time-up, 1 the lost link), (5) death events kept */
static int L_MatchStat(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k == 0 ? g_msMatches : k == 1 ? g_msDeaths[0] : k == 2 ? g_msDeaths[1] : k == 3 ? g_msSecs :
                         k == 4 ? g_msEnd : k == 5 ? g_msN : -1);
    return 1;
}
/* RVNG_MatchEvent(i) -> "t,who": the i-th death (0-based): seconds since GamePlaying (one decimal), 0 this pilot died,
 * 1 the opponent; "" past the last */
static int L_MatchEvent(void* lua)
{
    double v = -1;
    ArgNumber(lua, &v);
    int i = (int)v;
    char b[32];
    size_t n = 0;
    if (i >= 0 && i < g_msN) {
        char d[12]; int dn = 0; uint32_t u = (uint32_t)(g_msT[i] / 10);
        do { d[dn++] = (char)('0' + u % 10); u /= 10; } while (u && dn < 11);
        while (dn) b[n++] = d[--dn];
        b[n++] = '.'; b[n++] = (char)('0' + g_msT[i] % 10);
        b[n++] = ','; b[n++] = (char)('0' + g_msWho[i]);
    }
    b[n] = 0;
    U.luaSetString(lua, b, n);
    return 1;
}
