/* =============================================================================
 *  Project RVNG -- native runtime (UE4SS C++ mod: Mods\ProjectRVNG\dlls\main.dll)
 *
 *  0.1.x is the in-game TEST LOGGER for tests 1 and 2 of docs/re/DEATHMATCH_NATIVE.md section 9. It is off unless
 *  Mods\ProjectRVNG\rvng_test.ini says probe=1 (docs/IN_GAME_TESTS.md). Turned on, it:
 *    - logs the "stay offline" flags once a second (test 1): the Strix client global, StrixManager +0x1f8/+0x1f9/+0x1fa
 *      and +0x30, the EOS P2P object's +0x28, GI+0x970 (LiveWebAPI), UserDataManager +0x12a0/+0xfb0;
 *    - hooks the two LiveWebAPI gates and logs what the game's own gate answered; in block mode RVNG answers false;
 *    - logs every online game-mode state change (SetState / NextState) with the deathmatch fields (test 2);
 *    - on Ctrl+F6 in the hangar, arms a solo deathmatch sortie (UserDataManager +0xf38 = the DM MissionID) and logs the
 *      travel (the menu transition, RequestChangeMap);
 *    - optionally answers the SyncStartMatch phaseIndex gate (d2=1) and writes GM+0x80c = 2 on entering
 *      GameTerminating (w1=1), the two RVNG changes test 2 checks one at a time.
 *  It never sends anything anywhere and never sets a Strix flag. Every address is found by signature (sigs.h).
 *
 *  Started from a copy of Survival Mode's runtime skeleton (UE4SS mod object, Lua bridge, log, code scan, inline
 *  hooks): RVNG's own copy, not a shared library. Plain C, no C runtime, builds with LLVM alone (build.sh).
 * ============================================================================= */

#include "win32_min.h"
#include "sigs.h"

#define RT_VERSION    L"0.4.4"
#define RT_VERSION_A  "0.4.4"
#define MOD_NAME      L"ProjectRVNG"
#define PATH_CAP      1024
#define EXPORT        __declspec(dllexport)

/* GameInstance members and the fields the logger reads (docs/re/DEATHMATCH_NATIVE.md; 2026-11-02 build) */
#define GI_UDM        0x8E0     /* ULiveUserDataManager        */
#define GI_STRIX      0x910     /* StrixManager                */
#define GI_NM         0x928     /* ULiveNetworkManager         */
#define GI_P2P        0x930     /* ULiveNetworkP2P (EOS invite) */
#define GI_WEBAPI     0x970     /* LiveWebAPI                  */
#define GM_STATE      0x758     /* u8  ELiveOnlineGameModeState */
#define LEVEL_ONLINE_STARTUP 0x18697   /* ELiveLevelID OnlineStartup: what the online flow puts in UDM+0xf3c */

/* ---- freestanding helpers ---------------------------------------------- */
int   _fltused = 0;
void* memset(void* dst, int c, size_t n);
void* memcpy(void* dst, const void* src, size_t n);
int   memcmp(const void* a, const void* b, size_t n);
void* memset(void* dst, int c, size_t n) { uint8_t* d = dst; while (n--) *d++ = (uint8_t)c; return dst; }
void* memcpy(void* dst, const void* src, size_t n) { uint8_t* d = dst; const uint8_t* s = src; while (n--) *d++ = *s++; return dst; }
int memcmp(const void* a, const void* b, size_t n)
{
    const uint8_t *x = a, *y = b;
    for (; n; --n, ++x, ++y) if (*x != *y) return *x < *y ? -1 : 1;
    return 0;
}
static size_t WLen(const wchar_t* s) { size_t n = 0; while (s[n]) ++n; return n; }
static size_t WLenA(const char* s) { size_t n = 0; while (s[n]) ++n; return n; }
static int WEq(const wchar_t* a, const wchar_t* b) { while (*a && *a == *b) { ++a; ++b; } return *a == *b; }

typedef struct { int32_t index; int32_t number; } FNameRaw;
typedef struct { wchar_t* data; int32_t num; int32_t max; } FString;                     /* num counts the NUL */
typedef uintptr_t (*Fn8)(uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t);
typedef struct { union { wchar_t buf[8]; wchar_t* ptr; } u; size_t size; size_t cap; } MsvcWString;   /* std::wstring */
typedef struct { union { char buf[16]; char* ptr; } u; size_t size; size_t cap; } MsvcString;      /* std::string  */
typedef struct { const char* p; size_t n; } StrView;                                     /* std::string_view  */
typedef struct { const wchar_t* p; size_t n; } WStrView;                                 /* std::wstring_view */
typedef int (*LuaFn)(void* lua);
_Static_assert(sizeof(MsvcWString) == 32, "std::wstring layout");
_Static_assert(sizeof(MsvcString) == 32, "std::string layout");

#include "vfmt.h"

/* ---- paths and log: <mod folder>\logs\RVNG_<date>_<time>.log, one file per game session ------------------- */
static HANDLE           g_hModule;
static HANDLE           g_log = INVALID_HANDLE_VALUE;
static volatile int32_t g_logLock;
static wchar_t          g_modRoot[PATH_CAP];       /* ...\Mods\ProjectRVNG */

static int ModPaths(void)
{
    DWORD n = GetModuleFileNameW(g_hModule, g_modRoot, PATH_CAP);
    if (!n || n >= PATH_CAP) return 0;
    for (int cut = 0; cut < 2; ++cut) {                    /* ...\ProjectRVNG\dlls\main.dll -> ...\ProjectRVNG */
        wchar_t* s = g_modRoot + WLen(g_modRoot);
        while (s > g_modRoot && *s != L'\\' && *s != L'/') --s;
        *s = 0;
    }
    return 1;
}

static int PathJoin(wchar_t* out, const wchar_t* dir, const wchar_t* rel)
{
    size_t a = WLen(dir), b = WLen(rel);
    if (a + b + 2 >= PATH_CAP) return 0;
    memcpy(out, dir, a * 2); out[a] = L'\\'; memcpy(out + a + 1, rel, (b + 1) * 2);
    return 1;
}

static void Digits(wchar_t** s, int v, int n) { for (int i = n - 1; i >= 0; --i) { (*s)[i] = (wchar_t)(L'0' + v % 10); v /= 10; } *s += n; }

static void OpenLog(void)
{
    static wchar_t dir[PATH_CAP], path[PATH_CAP];
    if (!PathJoin(dir, g_modRoot, L"logs")) return;
    CreateDirectoryW(dir, NULL);
    uint16_t st[8];
    GetLocalTime(st);
    wchar_t name[48], *s = name;
    memcpy(s, L"RVNG_", 10); s += 5;
    Digits(&s, st[0], 4); Digits(&s, st[1], 2); Digits(&s, st[3], 2); *s++ = L'_';
    Digits(&s, st[4], 2); Digits(&s, st[5], 2); Digits(&s, st[6], 2);
    memcpy(s, L".log", 10);
    if (!PathJoin(path, dir, name)) return;
    g_log = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
}

/* One line: "hh:mm:ss.mmm text". WriteFile hands it to Windows' file cache, which keeps it through a game crash. */
static void Log(const wchar_t* fmt, ...)
{
    static wchar_t wide[1024];
    static char    utf8[1024 * 3 + 32];
    if (g_log == INVALID_HANDLE_VALUE) return;
    while (__sync_lock_test_and_set(&g_logLock, 1)) Sleep(0);
    uint16_t st[8];
    GetLocalTime(st);
    wchar_t stamp[16], *s = stamp;
    Digits(&s, st[4], 2); *s++ = L':'; Digits(&s, st[5], 2); *s++ = L':'; Digits(&s, st[6], 2); *s++ = L'.';
    Digits(&s, st[7], 3); *s++ = L' '; *s = 0;
    va_list ap;
    va_start(ap, fmt);
    VFmt(wide, 1024, fmt, ap);
    va_end(ap);
    int n = WideCharToMultiByte(CP_UTF8, 0, stamp, (int)WLen(stamp), utf8, 32, NULL, NULL);
    int m = WideCharToMultiByte(CP_UTF8, 0, wide, (int)WLen(wide), utf8 + n, (int)sizeof(utf8) - n - 2, NULL, NULL);
    if (m > 0) {
        n += m;
        utf8[n++] = '\r'; utf8[n++] = '\n';
        DWORD put = 0;
        WriteFile(g_log, utf8, (DWORD)n, &put, NULL);
    }
    __sync_lock_release(&g_logLock);
}

/* ---- settings: <mod folder>\rvng_test.ini (key=value lines, # comments) ------------------------------------- */
enum { GATES_OFF, GATES_OBSERVE, GATES_BLOCK };
static struct {
    int     probe;          /* 0: the logger is off (nothing hooked)               */
    int     gates;          /* always GATES_BLOCK (0.2.4): RVNG's web gates answer false in every install; a
                             * gates=observe/off line is ignored and logged                                       */
    int     d2;             /* 1: the phaseIndex gate answers true (solo release)  */
    int     w1;             /* 1: GM+0x80c = 2 on entering state 15                */
    int     d6;             /* 1: the Result map's travel goes to the main menu (it crashes offline) */
    int32_t mission;        /* Ctrl+F6's MissionID (160010 = PL_DM_001)                 */
    int32_t f3c;            /* written to UDM+0xf3c at the transition when it is a campaign level (19..49) */
    int32_t fullEvery;      /* seconds between full watch lines (changes are logged at once) */
    int     d7;             /* 1 (default): the boot login gate B refused is ended through the game's own "login
                             * failed" exit, so the boot main menu shows its rows (9.2); with or without probe  */
    int     gatesAsked;     /* a gates= line asked for something other than block (ignored)                  */
    int     faction;        /* test 6: 1..8 = the local user's deathmatch faction (2 Bravo), written at the travel; 0 off */
    int     opponent;       /* test 3: 1 = a fake second member in the room tables, so the remote spawn makes a copy */
    int     loopback;       /* test 4: 1 = the local plane's Physics messages flown by the copy (needs opponent=1)     */
    int32_t lbOff;          /* test 4: the mirror's distance ahead of the local plane, cm (default 15000 = 150 m)     */
    int     lbRole3;        /* test 5: 1 = the local plane is role 3 (as online) instead of RVNG refreshing its Physics */
    int     hit;            /* test 7: 1 = the local plane "hits" the copy through its own TakeDamage (needs lb_role3)   */
    int     guest;          /* 1 = this PC plays the guest (player 2; the copy is the host, player 1): D3 and D4 on    */
    int32_t linkloss;       /* test: N = a lost link simulated N s into GamePlaying (14): the forced end; 0 off        */
    int     netlog;         /* test (D9): 1 = netlog.h observes and logs the process's network calls (never blocks)    */
    int     eosAsked;       /* an eosblock= line asked for 0 (ignored: the EOS SDK's outside calls are refused in every
                             * install since 2026-11-19, the user's decision)                                       */
    int     wire;           /* test 4's transport: 0 RVNG's in-memory ring, 1 a pair of links in this process (link.h,
                             * one PC), 2 Steam to the other PC (link_peer, link_player, link_tag)                   */
    uint64_t linkPeer;      /* wire=2: the other PC's SteamID64                                                      */
    int     linkPlayer;     /* wire=2: this PC's player number (1 host, 2 guest)                                     */
    char    linkTag[64];    /* wire=2: the match's id, the same text on both PCs                                     */
    int     rehearse;       /* test (the kit's dm_p, probe=0 only): a normal install's match rehearsed on one PC: the
                             * ready-up and the match on the in-process link pair (wire 1, a stand-in peer) instead of
                             * Steam; the match hooks still idle until the launch arms the match, as in every install  */
    int     hangar;         /* test (2026-11-21, the kit's hangar suite): the stock pre-sortie hangar from the main menu,
                             * the pages pressed by the self-test, the opponent's plane on the wingman's spot (hangar.h) */
} g_cfg = { 0, GATES_BLOCK, 0, 0, 0, 160010, LEVEL_ONLINE_STARTUP, 10, 1, 0, 0, 0, 0, 15000, 0, 0, 0, 0, 0, 0, 0, 0, 0, { 0 }, 0, 0 };

/* The RVNG match in a normal install (probe=0; the user's decision of 2026-11-19): the match hooks go in at the start in
 * every install and pass the game's calls straight on until the ready-up screen's launch arms a match (MatchArm, from
 * RVNG_TravelDM with the Steam link up: d2, w1, d6, opponent, loopback and wire 2 for that one match). The game's travel
 * away from the deathmatch's map disarms it 8 s later (MatchDisarm, from the always-on tick): the settings above again.
 * LIVE(): a match hook does RVNG's work (the test logger, or an armed match); otherwise it only passes the call on. */
static volatile int32_t g_matchOn;
static __typeof__(g_cfg) g_cfgIdle;      /* the settings before the match was armed */
static int g_matchCore, g_matchGuest;    /* (Worker) the match hooks all in; the guest's D3/D4 hooks in */
#define LIVE() (g_cfg.probe || g_matchOn)

static int KeyIs(const char* k, size_t n, const char* want)
{
    size_t i = 0;
    for (; i < n && want[i]; ++i) {
        char c = k[i];
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        if (c != want[i]) return 0;
    }
    return i == n && !want[i];
}

static int32_t ParseInt(const char* v, size_t n)
{
    int32_t x = 0; int neg = 0; size_t i = 0;
    if (i < n && v[i] == '-') { neg = 1; ++i; }
    for (; i < n && v[i] >= '0' && v[i] <= '9'; ++i) x = x * 10 + (v[i] - '0');
    return neg ? -x : x;
}

static void ReadSettings(void)
{
    static wchar_t path[PATH_CAP];
    static char buf[4096];
    if (!PathJoin(path, g_modRoot, L"rvng_test.ini")) return;
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) { Log(L"settings: no rvng_test.ini; the test logger is off"); return; }
    DWORD got = 0;
    ReadFile(h, buf, sizeof(buf) - 1, &got, NULL);
    CloseHandle(h);
    buf[got] = 0;
    for (char* line = buf; *line; ) {
        char* end = line; while (*end && *end != '\n') ++end;
        char* next = *end ? end + 1 : end;
        char* hash = line; while (hash < end && *hash != '#') ++hash;
        end = hash;
        char* eq = line; while (eq < end && *eq != '=') ++eq;
        if (eq < end) {
            char* k = line; char* ke = eq; char* v = eq + 1; char* ve = end;
            while (k < ke && (*k == ' ' || *k == '\t' || *k == '\r')) ++k;
            while (ke > k && (ke[-1] == ' ' || ke[-1] == '\t')) --ke;
            while (v < ve && (*v == ' ' || *v == '\t')) ++v;
            while (ve > v && (ve[-1] == ' ' || ve[-1] == '\t' || ve[-1] == '\r')) --ve;
            size_t kn = (size_t)(ke - k), vn = (size_t)(ve - v);
            if (KeyIs(k, kn, "probe")) g_cfg.probe = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "d2")) g_cfg.d2 = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "w1")) g_cfg.w1 = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "d6")) g_cfg.d6 = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "d7")) g_cfg.d7 = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "opponent")) g_cfg.opponent = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "loopback")) g_cfg.loopback = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "lb_off")) g_cfg.lbOff = ParseInt(v, vn);
            else if (KeyIs(k, kn, "lb_role3")) g_cfg.lbRole3 = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "hit")) g_cfg.hit = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "guest")) g_cfg.guest = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "netlog")) g_cfg.netlog = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "eosblock")) g_cfg.eosAsked = ParseInt(v, vn) == 0;     /* (always on) */
            else if (KeyIs(k, kn, "rehearse")) g_cfg.rehearse = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "hangar")) g_cfg.hangar = ParseInt(v, vn) != 0;
            else if (KeyIs(k, kn, "linkloss")) { int32_t l = ParseInt(v, vn); g_cfg.linkloss = l > 0 ? l : 0; }
            else if (KeyIs(k, kn, "faction")) { int32_t f = ParseInt(v, vn); g_cfg.faction = f >= 1 && f <= 8 ? f : 0; }
            else if (KeyIs(k, kn, "mission")) g_cfg.mission = ParseInt(v, vn);
            else if (KeyIs(k, kn, "f3c")) g_cfg.f3c = ParseInt(v, vn);
            else if (KeyIs(k, kn, "full_every")) { int32_t s = ParseInt(v, vn); g_cfg.fullEvery = s < 1 ? 1 : s; }
            else if (KeyIs(k, kn, "gates")) g_cfg.gatesAsked = !KeyIs(v, vn, "block");   /* (always block) */
            else if (KeyIs(k, kn, "wire")) { int32_t w = ParseInt(v, vn); g_cfg.wire = w >= 0 && w <= 2 ? w : 0; }
            else if (KeyIs(k, kn, "link_player")) { int32_t pl = ParseInt(v, vn); g_cfg.linkPlayer = pl == 1 || pl == 2 ? pl : 0; }
            else if (KeyIs(k, kn, "link_peer")) {
                uint64_t id = 0; size_t i = 0;
                for (; i < vn && v[i] >= '0' && v[i] <= '9'; ++i) id = id * 10 + (uint64_t)(v[i] - '0');
                g_cfg.linkPeer = i == vn ? id : 0;
            }
            else if (KeyIs(k, kn, "link_tag")) {
                size_t i = 0;
                for (; i < vn && i < sizeof(g_cfg.linkTag) - 1; ++i) g_cfg.linkTag[i] = v[i];
                g_cfg.linkTag[i] = 0;
            }
        }
        line = next;
    }
    g_cfg.gates = GATES_BLOCK;
    if (g_cfg.loopback && !g_cfg.opponent) g_cfg.loopback = 0;   /* (the mirror is the opponent's copy) */
    if (g_cfg.wire && !g_cfg.loopback) g_cfg.wire = 0;          /* (the wire carries test 4's messages) */
    if (g_cfg.wire == 2 && (!g_cfg.linkPeer || !g_cfg.linkPlayer || !g_cfg.linkTag[0])) {
        Log(L"settings: wire=2 needs link_peer, link_player and link_tag: wire 0");
        g_cfg.wire = 0;
    }
    if (g_cfg.wire == 2) g_cfg.guest = g_cfg.linkPlayer == 2;   /* (the guest's half: D3/D4) */
    if (g_cfg.rehearse && !g_cfg.probe && !g_cfg.loopback) g_cfg.wire = 1;   /* (the pair for the ready-up and the match) */
    else g_cfg.rehearse = 0;
    Log(L"settings: probe=%d gates=block d2=%d w1=%d d6=%d d7=%d faction=%d opponent=%d loopback=%d lb_off=%d lb_role3=%d hit=%d guest=%d linkloss=%d netlog=%d eosblock=1 wire=%d link_player=%d mission=%d f3c=%d full_every=%d hangar=%d",
        g_cfg.probe, g_cfg.d2, g_cfg.w1, g_cfg.d6, g_cfg.d7, g_cfg.faction, g_cfg.opponent, g_cfg.loopback, g_cfg.lbOff,
        g_cfg.lbRole3, g_cfg.hit, g_cfg.guest, g_cfg.linkloss, g_cfg.netlog, g_cfg.wire, g_cfg.linkPlayer, g_cfg.mission, g_cfg.f3c, g_cfg.fullEvery,
        g_cfg.hangar);
    if (g_cfg.gatesAsked) Log(L"settings: a gates= line other than block is ignored: RVNG's web gates always answer false");
    if (g_cfg.rehearse) Log(L"settings: rehearse=1: a normal install's match on one PC, on the in-process link pair (a stand-in peer)");
    if (g_cfg.eosAsked) Log(L"settings: eosblock=0 is ignored: the EOS SDK's outside calls are refused in every install");
}

/* ---- memory checks and reads -------------------------------------------- */
/* p .. p+n committed and accessible (and writable when `write`), across as many regions as it spans: pages of one
 * object can sit in neighbouring regions with different protections (an image's written vs copy-on-write pages) */
static int Accessible(const void* p, size_t n, int write)
{
    if (!p || (uintptr_t)p < 0x10000 || (uintptr_t)p + n < (uintptr_t)p) return 0;
    const uint8_t* at = (const uint8_t*)p;
    const uint8_t* end = at + (n ? n : 1);
    while (at < end) {
        MEMORY_BASIC_INFORMATION mi;
        if (!VirtualQuery(at, &mi, sizeof(mi))) return 0;
        if (mi.State != MEM_COMMIT || (mi.Protect & (PAGE_NOACCESS | PAGE_GUARD))) return 0;
        if (write && !(mi.Protect & (PAGE_READWRITE | 0x08 | PAGE_EXECUTE_READWRITE | 0x80))) return 0;
        at = (const uint8_t*)mi.BaseAddress + mi.RegionSize;
    }
    return 1;
}
static int Readable(const void* p, size_t n) { return Accessible(p, n, 0); }
static int Writable(const void* p, size_t n) { return Accessible(p, n, 1); }

static int Rd(const void* base, size_t off, void* out, size_t n)
{
    const uint8_t* p = (const uint8_t*)base + off;
    if (!base || !Readable(p, n)) { memset(out, 0, n); return 0; }
    memcpy(out, p, n);
    return 1;
}
static uint8_t  R8(const void* b, size_t off)  { uint8_t v;  Rd(b, off, &v, 1); return v; }
static int32_t  R32(const void* b, size_t off) { int32_t v;  Rd(b, off, &v, 4); return v; }
static uint64_t R64(const void* b, size_t off) { uint64_t v; Rd(b, off, &v, 8); return v; }
static void*    RP(const void* b, size_t off)  { return (void*)(uintptr_t)R64(b, off); }
static int32_t  RMilli(const void* b, size_t off) { float f; Rd(b, off, &f, 4); return (f > -2.0e6f && f < 2.0e6f) ? (int32_t)(f * 1000.0f) : -1; }

static int W64(void* base, size_t off, uint64_t v)
{
    uint8_t* p = (uint8_t*)base + off;
    if (!base || !Writable(p, 8)) return 0;
    memcpy(p, &v, 8);
    return 1;
}

static int W32(void* base, size_t off, int32_t v)
{
    uint8_t* p = (uint8_t*)base + off;
    if (!base || !Writable(p, 4)) return 0;
    memcpy(p, &v, 4);
    return 1;
}

#include "netlog.h"      /* (D9, test only: netlog=1) */
#include "eoswall.h"     /* (D9, every install since 2026-11-19: the EOS SDK's outside calls refused) */
#include "link.h"        /* the two PCs' link: Steam ISteamNetworkingMessages, relay-only (2026-11-19) */

/* ---- game image and code scan ------------------------------------------- */
typedef struct { uint8_t* start; size_t len; uint32_t ch; } Section;
static Section  g_sec[64];
static int      g_nsec;
static uint8_t* g_exe;
static size_t   g_exeSize;
static uint32_t g_exeStamp;

static int ReadImage(void)
{
    g_exe = (uint8_t*)GetModuleHandleW(NULL);
    if (!g_exe) return 0;
    uint32_t pe = *(uint32_t*)(g_exe + 0x3C);
    uint16_t nsec = *(uint16_t*)(g_exe + pe + 6), optsz = *(uint16_t*)(g_exe + pe + 20);
    g_exeStamp = *(uint32_t*)(g_exe + pe + 8);
    g_exeSize = *(uint32_t*)(g_exe + pe + 24 + 56);
    uint8_t* sh = g_exe + pe + 24 + optsz;
    for (int i = 0; i < nsec && g_nsec < 64; ++i, sh += 40) {
        uint32_t vsize = *(uint32_t*)(sh + 8), va = *(uint32_t*)(sh + 12), ch = *(uint32_t*)(sh + 36);
        g_sec[g_nsec++] = (Section){ g_exe + va, vsize, ch };
    }
    return 1;
}

static int InGame(const void* p) { return (const uint8_t*)p >= g_exe && (const uint8_t*)p < g_exe + g_exeSize; }

/* the target of the E8 call at p, or NULL when p isn't one */
static uint8_t* CallTarget(uint8_t* p)
{
    if (!p || !Readable(p, 5) || p[0] != 0xE8) return NULL;
    int32_t d; memcpy(&d, p + 1, 4);
    uint8_t* t = p + 5 + d;
    return InGame(t) ? t : NULL;
}

typedef void (*RegionFn)(uint8_t* p, size_t n, void* ctx);
static void ForRegions(uint8_t* start, size_t len, RegionFn fn, void* ctx)
{
    uint8_t* end = start + len;
    for (uint8_t* p = start; p < end; ) {
        MEMORY_BASIC_INFORMATION mi;
        if (!VirtualQuery(p, &mi, sizeof(mi))) return;
        uint8_t* rend = (uint8_t*)mi.BaseAddress + mi.RegionSize;
        if (rend > end) rend = end;
        if (rend <= p) return;
        if (mi.State == MEM_COMMIT && !(mi.Protect & (PAGE_NOACCESS | PAGE_GUARD))) fn(p, (size_t)(rend - p), ctx);
        p = rend;
    }
}

/* A byte pattern; mask[i] == 0 is a wildcard (byte 0 must be fixed). It only counts when it occurs exactly once. */
typedef struct { const wchar_t* name; const uint8_t* b; const uint8_t* mask; size_t n; uint8_t* hit; int count; } Pattern;
#define SCAN_MAX 128
/* the patterns bucketed by their first byte (head[b] .. next[k], -1 ends), so each code byte is compared only with the
 * patterns that start with it (the hooks go in a few seconds sooner after the game starts) */
typedef struct { Pattern* pats; int npat; int16_t head[256]; int16_t next[SCAN_MAX]; } ScanCtx;

static void ScanRegion(uint8_t* p, size_t n, void* vctx)
{
    ScanCtx* c = (ScanCtx*)vctx;
    uint8_t* end = p + n;
    for (; p < end; ++p) {
        for (int k = c->head[p[0]]; k >= 0; k = c->next[k]) {
            Pattern* t = &c->pats[k];
            if (p + t->n > end) continue;
            size_t i = 1;
            for (; i < t->n; ++i) if ((!t->mask || t->mask[i]) && p[i] != t->b[i]) break;
            if (i == t->n) { if (!t->hit) t->hit = p; ++t->count; }
        }
    }
}

static void ScanIndex(ScanCtx* c, Pattern* pats, int npat)
{
    c->pats = pats; c->npat = npat < SCAN_MAX ? npat : SCAN_MAX;
    for (int b = 0; b < 256; ++b) c->head[b] = -1;
    for (int k = c->npat - 1; k >= 0; --k) {          /* (pushed from the end: each bucket lists the lowest index first) */
        pats[k].hit = NULL; pats[k].count = 0;
        if (pats[k].n == 0 || (pats[k].mask && !pats[k].mask[0])) continue;   /* (none starts with a wildcard) */
        c->next[k] = c->head[pats[k].b[0]]; c->head[pats[k].b[0]] = (int16_t)k;
    }
    if (npat > SCAN_MAX) Log(L"scan: %d signatures, only the first %d looked for", npat, SCAN_MAX);
}

static void ScanCode(Pattern* pats, int npat)
{
    static ScanCtx c;
    uint64_t t0 = GetTickCount64();
    ScanIndex(&c, pats, npat);
    for (int s = 0; s < g_nsec; ++s)
        if (g_sec[s].ch & IMAGE_SCN_MEM_EXECUTE) ForRegions(g_sec[s].start, g_sec[s].len, ScanRegion, &c);
    Log(L"scan: %d signatures looked for in %d ms", npat, (int32_t)(GetTickCount64() - t0));
    for (int k = 0; k < npat; ++k) {
        if (pats[k].count != 1) {
            Log(L"signature %s: %d matches (needs exactly 1); not used", pats[k].name, pats[k].count);
            pats[k].hit = NULL;
        } else {
            Log(L"signature %s: found at exe+%x", pats[k].name, (uint32_t)(pats[k].hit - g_exe));
        }
    }
}

/* ---- code patching (other threads held off the patched bytes) ------------ */
#define MAX_THREADS 1024
static HANDLE s_threads[MAX_THREADS];
static int    s_threadCount;

static void Thaw(void)
{
    for (int i = 0; i < s_threadCount; ++i) { ResumeThread(s_threads[i]); CloseHandle(s_threads[i]); }
    s_threadCount = 0;
}

static int Freeze(const uint8_t* lo, size_t len)
{
    static DWORD ids[MAX_THREADS];
    DWORD pid = GetCurrentProcessId(), tid = GetCurrentThreadId();
    for (int attempt = 0; attempt < 100; ++attempt) {
        int count = 0;
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if (snap == INVALID_HANDLE_VALUE) return 0;
        THREADENTRY32 te; memset(&te, 0, sizeof(te)); te.dwSize = sizeof(te);
        if (Thread32First(snap, &te)) {
            do {
                if (te.th32OwnerProcessID == pid && te.th32ThreadID != tid && count < MAX_THREADS)
                    ids[count++] = te.th32ThreadID;
                te.dwSize = sizeof(te);
            } while (Thread32Next(snap, &te));
        }
        CloseHandle(snap);
        s_threadCount = 0;
        for (int i = 0; i < count; ++i) {
            HANDLE th = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, 0, ids[i]);
            if (!th) continue;
            if (SuspendThread(th) == 0xFFFFFFFFu) { CloseHandle(th); continue; }
            s_threads[s_threadCount++] = th;
        }
        int busy = 0;
        for (int i = 0; i < s_threadCount; ++i) {
            CONTEXT64 c; c.ContextFlags = CONTEXT_CONTROL; c.Rip = 0;
            if (GetThreadContext(s_threads[i], &c)) {
                const uint8_t* rip = (const uint8_t*)(uintptr_t)c.Rip;
                if (rip >= lo && rip < lo + len) busy = 1;
            }
        }
        if (!busy) return 1;
        Thaw();
        Sleep(1);
    }
    return 0;
}

static int WriteMem(void* addr, const void* bytes, size_t len)
{
    DWORD old = 0, ignored = 0; int ok = 0;
    if (!Freeze(addr, len)) return 0;
    if (VirtualProtect(addr, len, PAGE_EXECUTE_READWRITE, &old)) {
        memcpy(addr, bytes, len);
        VirtualProtect(addr, len, old, &ignored);
        FlushInstructionCache(GetCurrentProcess(), addr, len);
        ok = 1;
    }
    Thaw();
    return ok;
}

static void PutAbsJump(uint8_t* at, const void* target)    /* jmp [rip+0]; dq target : 14 bytes */
{
    uint64_t t = (uint64_t)(uintptr_t)target;
    at[0] = 0xFF; at[1] = 0x25; at[2] = at[3] = at[4] = at[5] = 0;
    memcpy(at + 6, &t, 8);
}

/* Inline hook. lens lists the prologue's instruction lengths ("2,4,c5,3": c = an E8 call, rewritten in the trampoline
 * as call [rip+2]; jmp +8; dq target). The trampoline runs the moved instructions and jumps back after them. */
static int HookInline(uint8_t* fn, const char* lens, void* detour, void** orig, const wchar_t* what)
{
    *orig = NULL;
    if (!fn) { Log(L"%s: not found; not hooked", what); return 0; }
    if (fn[0] == 0xFF && fn[1] == 0x25 && !(lens[0] == '1' && lens[1] == '4' && lens[2] == ',')) {
        Log(L"%s: already hooked by something else at %p; not hooked", what, fn); return 0;
    }
    uint8_t* tramp = (uint8_t*)VirtualAlloc(NULL, 128, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!tramp) return 0;
    size_t in = 0, out = 0;
    for (const char* s = lens; *s; ) {
        int call = 0, len = 0;
        if (*s == 'c') { call = 1; ++s; }
        while (*s >= '0' && *s <= '9') len = len * 10 + (*s++ - '0');
        if (*s == ',') ++s;
        if (call) {
            if (len != 5 || fn[in] != 0xE8) { Log(L"%s: prologue byte %d is not a call; not hooked", what, (int32_t)in); return 0; }
            int32_t rel; memcpy(&rel, fn + in + 1, 4);
            uint64_t target = (uint64_t)(uintptr_t)(fn + in + 5 + rel);
            static const uint8_t callAbs[8] = { 0xFF, 0x15, 0x02, 0x00, 0x00, 0x00, 0xEB, 0x08 };
            memcpy(tramp + out, callAbs, 8); memcpy(tramp + out + 8, &target, 8);
            out += 16;
        } else {
            memcpy(tramp + out, fn + in, (size_t)len);
            out += (size_t)len;
        }
        in += (size_t)len;
    }
    if (in < 14 || in > 32) { Log(L"%s: prologue of %d bytes; not hooked", what, (int32_t)in); return 0; }
    PutAbsJump(tramp + out, fn + in);
    DWORD ignored;
    VirtualProtect(tramp, 128, PAGE_EXECUTE_READ, &ignored);
    FlushInstructionCache(GetCurrentProcess(), tramp, 128);
    uint8_t patch[32];
    PutAbsJump(patch, detour);
    for (size_t i = 14; i < in; ++i) patch[i] = 0x90;
    *orig = tramp;
    if (!WriteMem(fn, patch, in)) { *orig = NULL; Log(L"%s: could not patch %p", what, fn); return 0; }
    Log(L"%s: hooked at exe+%x", what, (uint32_t)(fn - g_exe));
    return 1;
}

/* ---- UE4SS 3.0.1 exports, by name -------------------------------------- */
static struct {
    void*     (*nameToString)(const FNameRaw* self, MsvcWString* out);
    void      (*luaRegister)(void* lua, const MsvcString* name, const LuaFn* fn);
    uint8_t   (*luaIsString)(void* lua, int32_t idx);
    StrView*  (*luaGetString)(void* lua, StrView* out, int32_t idx);
    uint8_t   (*luaIsNumber)(void* lua, int32_t idx);
    double    (*luaGetNumber)(void* lua, int32_t idx);
    int32_t   (*luaStackSize)(void* lua);
    void      (*luaSetInteger)(void* lua, int64_t v);
    void      (*luaSetString)(void* lua, const char* s, size_t n);
} U;
static int g_ue4ss;              /* 0 not tried, 1 found, -1 missing */

static int ResolveUE4SS(void)
{
    if (g_ue4ss) return g_ue4ss > 0;
    static const struct { size_t off; const char* name; } kExports[] = {
#define UX(f, n) { __builtin_offsetof(__typeof__(U), f), n }
        UX(nameToString, "?ToString@FName@Unreal@RC@@QEBA?BV?$basic_string@_WU?$char_traits@_W@std@@V?$allocator@_W@2@@std@@XZ"),
        UX(luaRegister,  "?register_function@Lua@LuaMadeSimple@RC@@QEBAXAEBV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@AEBQ6AHAEBV123@@Z@Z"),
        UX(luaIsString,  "?is_string@Lua@LuaMadeSimple@RC@@QEBA_NH@Z"),
        UX(luaGetString, "?get_string@Lua@LuaMadeSimple@RC@@QEBA?AV?$basic_string_view@DU?$char_traits@D@std@@@std@@H@Z"),
        UX(luaIsNumber,  "?is_number@Lua@LuaMadeSimple@RC@@QEBA_NH@Z"),
        UX(luaGetNumber, "?get_number@Lua@LuaMadeSimple@RC@@QEBANH@Z"),
        UX(luaStackSize, "?get_stack_size@Lua@LuaMadeSimple@RC@@QEBAHXZ"),
        UX(luaSetInteger,"?set_integer@Lua@LuaMadeSimple@RC@@QEBAX_J@Z"),
        UX(luaSetString, "?set_string@Lua@LuaMadeSimple@RC@@QEBAXPEBD_K@Z"),
#undef UX
    };
    HANDLE ue4ss = GetModuleHandleW(L"UE4SS.dll");
    g_ue4ss = ue4ss ? 1 : -1;
    for (size_t i = 0; ue4ss && i < sizeof(kExports) / sizeof(kExports[0]); ++i) {
        void* f = GetProcAddress(ue4ss, kExports[i].name);
        if (!f) { Log(L"UE4SS export %d missing", (int32_t)i); g_ue4ss = -1; }
        *(void**)((uint8_t*)&U + kExports[i].off) = f;
    }
    return g_ue4ss > 0;
}

static const wchar_t* NameText(const FNameRaw* n, wchar_t* out, size_t cap)
{
    out[0] = 0;
    if (!U.nameToString || !Readable(n, sizeof(*n))) return out;
    MsvcWString s; memset(&s, 0, sizeof(s));
    U.nameToString(n, &s);
    const wchar_t* p = s.cap > 7 ? s.u.ptr : s.u.buf;
    size_t k = s.size < cap - 1 ? s.size : cap - 1;
    if (p) { memcpy(out, p, k * 2); out[k] = 0; }
    if (s.cap > 7 && s.u.ptr) free(s.u.ptr);
    return out;
}

static const wchar_t* FStringText(const FString* f, wchar_t* out, size_t cap)
{
    out[0] = 0;
    if (!Readable(f, sizeof(*f)) || !f->data || f->num <= 0 || f->num > 4096) return out;
    size_t k = (size_t)f->num - 1 < cap - 1 ? (size_t)f->num - 1 : cap - 1;
    if (!Readable(f->data, k * 2)) return out;
    memcpy(out, f->data, k * 2); out[k] = 0;
    return out;
}

/* ---- game state the logger follows -------------------------------------- */
static uint8_t*  g_gi;                /* the GameInstance, from Lua (RVNG_Watch)                        */
static uint8_t*  g_gm;                /* the online game mode last seen in SetState / NextState         */
static void*     g_gmVt;              /* its vtable then: a different one means the object is gone      */
static uint8_t** g_clientGlobal;      /* the Strix client global (Send's first load)                     */
static int       g_armed;             /* Ctrl+F6: the next transition is RVNG's solo deathmatch test          */
/* the LiveWebAPI gates: A and B (D5, 0.2.4) and D9's nine more (0.3.6). All answer false in every install. */
enum { GATE_A, GATE_B, GATE_USER, GATE_LOBBY, GATE_ITEM, GATE_GUILD, GATE_MASTER, GATE_FRIENDS, GATE_SETTINGS, GATE_BLOCKS,
       GATE_CURRENCIES, GATE_N };
static volatile int32_t g_gateCalls[GATE_N], g_gateTrue[GATE_N], g_phaseCalls;
static volatile int32_t g_hooked = -1; /* hooks installed once the worker is done; -1 before                 */
static volatile int32_t g_lastHookState = -1; /* the last state SetState/NextState left (kept after the game mode goes) */
static volatile int32_t g_mapRequests; /* RequestChangeMap calls seen                                        */
static wchar_t   g_lastMap[256];      /* the last RequestChangeMap's package name                            */

/* D7 (sigs.h kSigFinishLogin): the boot login that gate B refuses is ended through the game's own failure exit */
typedef void (*FinishLoginFn)(void* gac, int32_t code);
static FinishLoginFn g_finishLogin;
static uint8_t*  g_slGateRet;         /* where StartLogin's gate-B call returns (0x147955ab8)                  */
static void*     g_task7CbVt;         /* the boot login callback's vtable (0x14cbb7968)                       */
static void*     g_pathACbVt;         /* the startup part manager's (0x14cb68558): never ended, only logged    */
static uint8_t*  g_slGac;             /* the GeneralAPIController of the refused call                          */
static volatile int32_t g_slPend, g_slEnded, g_slRefused;
#define UDM_GAC        0xfb0
#define UDM_LOGIN_DATA 0xfb8

/* the game's own mission-by-ID travel, called by RVNG_TravelDM (sigs.h: kSigLevelRow, kSigNmPrepare) */
typedef uint8_t*  (*LevelRowFn)(void* infoMgr, uint32_t missionId);
typedef uintptr_t (*NmPrepareFn)(void* nm);
static LevelRowFn  g_levelRow;
static uint8_t*    g_levelRowDefault;  /* the lookup's "no such row" answer                                   */
static NmPrepareFn g_nmPrepare;
static uint8_t*    g_fChangeMap;       /* RequestChangeMap's entry (hooked: calls go through OnChangeMap)      */
#define GI_INFO_MGR   0x878
#define GI_MAP_CHANGE 0x888

static uint8_t* LiveGM(void)
{
    if (!g_gm || !Readable(g_gm, GM_STATE + 1) || *(void**)g_gm != g_gmVt) return NULL;
    return g_gm;
}

static void LogGM(const wchar_t* why, uint8_t* gm)
{
    uint8_t* nm = g_gi ? RP(g_gi, GI_NM) : NULL;
    Log(L"  %s: state %d | +0x5f1 %d | +0x498 %d ms | +0x80c %d | +0x804 %d | +0x521 %d | +0x538 %d | NM+0x538 %d NM+0x3d8 %d NM+0x740 %d ms",
        why, (int32_t)R8(gm, GM_STATE), (int32_t)R8(gm, 0x5f1), RMilli(gm, 0x498), R32(gm, 0x80c), R32(gm, 0x804),
        (int32_t)R8(gm, 0x521), (int32_t)R8(gm, 0x538), R32(nm, 0x538), R32(nm, 0x3d8), (int32_t)(R64(nm, 0x740) / 10000));
}

/* ---- test 6: factions (docs/re/DEATHMATCH_NATIVE.md 6.3 step 4, 9.3; sigs.h kSigFaction*) ------------------
 * NM+0x4d0 is a TMap<FString userId, {u8 faction; FString name "BRAVO1"; i32 number}> (TSet element stride 0x38: key
 * +0x00, faction +0x10, name +0x18, number +0x28; slots in use flagged in the bit array at +0x10, or its heap words at
 * +0x20). Offline the travel's prepare step seeds it with the local user as faction 1 (Alpha, "ALPHA1"); the DM faction
 * assigner (state 5) reads it into plane+0x3b2, and the start-point picker and the callsigns follow that. With faction=N
 * RVNG writes the local user's entry right after the prepare step (again before state 3: harmless), through the game's
 * own FindOrAdd and FString copy, so the map never holds RVNG memory. The next travel's prepare step re-seeds it. */
typedef uint32_t (*StrihashFn)(int32_t len, const wchar_t* s);
typedef uint8_t* (*FindOrAddFn)(void* map, uint32_t hash, const FString* key);
typedef FString* (*FStrAssignFn)(FString* dst, const FString* src);
typedef uint8_t* (*Ptr1Fn)(void* obj);
static StrihashFn   g_strihash;
static FindOrAddFn  g_facFindOrAdd;
static FStrAssignFn g_fstrAssign;
static Ptr1Fn       g_getWorld, g_worldSub;
static volatile int32_t g_facWritten, g_facPlane = -1, g_facNear = -1, g_facNearM = -1;
static volatile int32_t g_oppPlanes, g_oppRole = -1, g_oppNetId = -1;   /* (test 3: the copy, as LogPlanes saw it) */
#define NM_FACTIONS   0x4d0
#define FAC_STRIDE    0x38
#define UDM_USER      0xfd0      /* -> {FString userId, ...} */
#define PLANE_FACTION 0x3b2
#define PLANE_USER    0x2200
#define PLANE_CALL    0x6e8
#define ACTOR_ROOT    0x1a0
#define SCENE_LOC     0x128      /* RelativeLocation, 3 doubles (cm) */
static const wchar_t* const kFacNames[9] = { L"NONE", L"ALPHA", L"BRAVO", L"CHARLIE", L"DELTA", L"LIMA", L"OSCAR", L"ROMEO", L"ZULU" };

static const wchar_t* FacName(int32_t f) { return f >= 0 && f <= 8 ? kFacNames[f] : L"?"; }

/* the entry for uid (added if missing) set to {fac, name, num}; the value pointer, or NULL */
static uint8_t* SetFaction(uint8_t* nm, const FString* uid, uint8_t fac, const wchar_t* name, int32_t num)
{
    if (!g_strihash || !g_facFindOrAdd || !g_fstrAssign || !nm || !uid || !Readable(uid, sizeof(FString))) return NULL;
    int32_t n = uid->num;
    if (n < 0 || n > 256 || (n > 0 && (!uid->data || !Readable(uid->data, (size_t)n * 2)))) return NULL;
    uint8_t* v = g_facFindOrAdd(nm + NM_FACTIONS, g_strihash(n > 0 ? n - 1 : 0, n > 0 ? uid->data : L""), uid);
    if (!v) return NULL;
    v[0] = fac;                                         /* element+0x10 */
    int32_t len = (int32_t)WLen(name) + 1;
    FString src = { (wchar_t*)name, len, len };
    g_fstrAssign((FString*)(v + 0x08), &src);          /* element+0x18: the game allocates its own copy */
    W32(v, 0x18, num);                                  /* element+0x28 */
    return v;                                           /* (moves on the next FindOrAdd) */
}

static void DumpFactions(uint8_t* nm, const wchar_t* why)
{
    uint8_t* map = nm + NM_FACTIONS;
    uint8_t* data = RP(map, 0);
    int32_t num = R32(map, 8), nfree = R32(map, 0x34);
    uint8_t* heap = RP(map, 0x20);
    const uint8_t* words = heap ? heap : map + 0x10;
    Log(L"  factions (%s): NM+0x4d0 has %d slot(s), %d free", why, num, nfree);
    if (!data || num < 0 || num > 64) return;
    static wchar_t key[96], name[32];
    for (int32_t i = 0; i < num; ++i) {
        if (!(((uint32_t)R32(words, (size_t)(i / 32) * 4) >> (i % 32)) & 1)) continue;
        uint8_t* e = data + (size_t)i * FAC_STRIDE;
        int32_t f = R8(e, 0x10);
        Log(L"    [%d] user \"%s\": faction %d (%s), name \"%s\", number %d", i, FStringText((const FString*)e, key, 96), f,
            FacName(f), FStringText((const FString*)(e + 0x18), name, 32), R32(e, 0x28));
    }
}

static void ApplyFaction(uint8_t* nm, const wchar_t* why)
{
    if (!g_cfg.faction || !g_gi || !nm) return;
    const FString* me = (const FString*)RP(RP(g_gi, GI_UDM), UDM_USER);
    wchar_t name[16];
    const wchar_t* fn = kFacNames[g_cfg.faction];
    size_t k = WLen(fn);
    memcpy(name, fn, k * 2); name[k] = L'1'; name[k + 1] = 0;
    uint8_t* v = SetFaction(nm, me, (uint8_t)g_cfg.faction, name, 1);
    if (v) __sync_add_and_fetch(&g_facWritten, 1);
    Log(L"test 6 (%s): the local user's faction -> %d (%s)%s", why, g_cfg.faction, name,
        v ? L"" : L": NOT WRITTEN (a signature or the user id is missing)");
    DumpFactions(nm, why);
}

static uint64_t ISqrt(uint64_t v) { uint64_t r = 0, b = 1ull << 62; while (b > v) b >>= 2;
    while (b) { if (v >= r + b) { v -= r + b; r = (r >> 1) + b; } else r >>= 1; b >>= 2; } return r; }

static int ActorLoc(uint8_t* a, double out[3])
{
    uint8_t* root = RP(a, ACTOR_ROOT);
    if (!root || !Readable(root + SCENE_LOC, 24)) return 0;
    memcpy(out, root + SCENE_LOC, 24);
    return 1;
}

/* the planes' factions, callsigns and positions, and the start point nearest the local plane */
static void LogPlanes(uint8_t* gm, int32_t to)
{
    if (!(g_cfg.faction || g_cfg.opponent) || !g_getWorld || !g_worldSub || !g_gi) return;
    uint8_t* world = g_getWorld(gm);
    uint8_t* sub = world ? g_worldSub(world) : NULL;
    if (!sub || !Readable(sub + 0x1d8, 4)) { Log(L"test 6 at state %d: the online world subsystem not found", to); return; }
    uint8_t* planes = RP(sub, 0x138);
    uint8_t* pts = RP(sub, 0x1d0);
    int32_t np = R32(sub, 0x140), npt = R32(sub, 0x1d8);
    static wchar_t me[96], uid[96], call[32];
    FStringText((const FString*)RP(RP(g_gi, GI_UDM), UDM_USER), me, 96);
    Log(L"planes at state %d: %d plane(s), %d start point(s); local user \"%s\"", to, np, npt, me);
    if (np > g_oppPlanes) g_oppPlanes = np;
    if (np < 0 || np > 16 || npt < 0 || npt > 128) return;
    for (int32_t i = 0; i < np; ++i) {
        uint8_t* p = RP(planes, (size_t)i * 8);
        if (!p || !Readable(p + PLANE_USER, 16)) continue;
        FStringText((const FString*)(p + PLANE_USER), uid, 96);
        int32_t f = R8(p, PLANE_FACTION);
        double at[3] = { 0, 0, 0 };
        int have = ActorLoc(p, at);
        int local = WEq(uid, me);
        static wchar_t uname[64];
        uint8_t* netObj = RP(p, 0xed0);
        Log(L"  plane %p user \"%s\" (\"%s\")%s: faction %d (%s), callsign \"%s\", role %d, netId %d, N+0x28 %p, slot+1 %d, at (%d, %d, %d) m",
            p, uid, FStringText((const FString*)(p + 0x2210), uname, 64), local ? L" (local)" : L"", f, FacName(f),
            FStringText((const FString*)(p + PLANE_CALL), call, 32), (int32_t)R8(p, 0xed8), R32(p, 0x53b8),
            RP(netObj, 0x28), R32(p, 0x3c00),
            (int32_t)(at[0] / 100), (int32_t)(at[1] / 100), (int32_t)(at[2] / 100));
        if (!local) { g_oppRole = R8(p, 0xed8); g_oppNetId = R32(p, 0x53b8); continue; }
        g_facPlane = f;
        if (!have || to < 10) continue;
        uint64_t best = ~0ull; int32_t bestF = -1, bestJ = -1;
        for (int32_t j = 0; j < npt; ++j) {
            uint8_t* q = RP(pts, (size_t)j * 8);
            double qa[3];
            if (!q || !Readable(q + 0x2da, 1) || !ActorLoc(q, qa)) continue;
            double dx = (qa[0] - at[0]) / 100, dy = (qa[1] - at[1]) / 100, dz = (qa[2] - at[2]) / 100;
            uint64_t d2 = (uint64_t)(dx * dx + dy * dy + dz * dz);
            if (to == 10)
                Log(L"    start point %d: +0x2d8 %d faction %d (%s) +0x2da %d at (%d, %d, %d) m, %d m away", j,
                    (int32_t)R8(q, 0x2d8), (int32_t)R8(q, 0x2d9), FacName(R8(q, 0x2d9)), (int32_t)R8(q, 0x2da),
                    (int32_t)(qa[0] / 100), (int32_t)(qa[1] / 100), (int32_t)(qa[2] / 100), (int32_t)ISqrt(d2));
            if (d2 < best) { best = d2; bestF = R8(q, 0x2d9); bestJ = j; }
        }
        if (bestJ >= 0) {
            g_facNear = bestF; g_facNearM = (int32_t)ISqrt(best);
            Log(L"  nearest start point: %d, faction %d (%s), %d m away", bestJ, bestF, FacName(bestF), g_facNearM);
        }
    }
}

static void LbRegister(uint8_t* gm);
static uint64_t g_s14At;                 /* when GamePlaying (14) began (the lost-link test) */
static void LbDisarm(const wchar_t* why);
static void ResultCapture(void);         /* (the result screen's scores, at time-up) */
static void LbClasses(void);
static volatile int32_t g_lbReady;
/* (NextState calls SetState, so both detours run AfterState for one change: the plane lists once, from SetState's) */
static int wcmp_how_setstate(const wchar_t* how) { return how && how[0] == L'S'; }

static void AfterState(uint8_t* gm, const wchar_t* how, int32_t from)
{
    int32_t to = R8(gm, GM_STATE);
    g_lastHookState = to;
    Log(L"state %d -> %d (%s) gm %p", from, to, how, gm);
    if (to == 15 && g_cfg.w1) {
        int32_t was = R32(gm, 0x80c);
        int ok = W32(gm, 0x80c, 2);
        Log(L"W1: GameTerminating entered: GM+0x80c %d -> 2%s", was, ok ? L"" : L" (NOT WRITABLE)");
    }
    LogGM(L"after", gm);
    if ((g_cfg.faction || g_cfg.opponent) && wcmp_how_setstate(how) && (to == 5 || to == 6 || to == 10 || to == 12 || to == 14))
        LogPlanes(gm, to);
    if (to == 14 && wcmp_how_setstate(how)) g_s14At = GetTickCount64();
    if (g_cfg.loopback && wcmp_how_setstate(how)) {
        if (to == 14) LbRegister(gm);
        else if (to >= 15 && g_lbReady) { ResultCapture(); LbDisarm(L"time-up"); LbClasses(); }
    }
}

/* ---- test 3: the opponent's copy through the game's own remote spawn (DEATHMATCH_NATIVE.md 6.3 step 3, 9.4) ----
 * Before state 3 of an RVNG-travelled deathmatch (opponent=1), the room tables get a fake second member: the game's
 * SetConfirmed fills NM+0x3d8 = 2 and NM+0x410 {local: slot 0, "RVNG_TEST_2": slot 1}; the MRMM builds one aircraft
 * selector per member and FillFromUdm copies the local airset into both (the opponent clones it; its weapons and parts
 * arrays are copied with the game's TArray copy). RVNG writes the netIds (local 1, opponent 2: the remote loop skips the
 * slot whose netId is the local one), the "joined" bytes and the names, and the faction entries (local Alpha, opponent
 * Bravo). State 4's Enter then runs the local spawn and the remote loop, whose spawn 0x1471b84f0 makes the role-2 copy.
 * The tables are emptied again (TerminateAircraftSelector, ResetMatchedInfo) 8 s after the travel back to the menu, once
 * the deathmatch world is gone: leftovers would leak into the next campaign or Survival sortie. */
typedef void    (*SetConfirmedFn)(void* nm, const void* confirmed);
typedef uint8_t (*MrmmFn)(void* mrmm);
typedef void    (*FillSelFn)(void* mrmm, const FString* userId, uint8_t confirmed);
typedef void*   (*TArrCopyFn)(void* dst, const void* src);
typedef void    (*NmResetFn)(void* nm, uint8_t kind);
static SetConfirmedFn g_setConfirmed;
static MrmmFn    g_buildSel, g_terminateSel;
static FillSelFn g_fillSel;
static TArrCopyFn g_tarrCopy;
static NmResetFn g_nmReset;
static volatile int32_t g_oppFilled, g_oppSpawns, g_oppSlot = -1, g_oppCleaned;
static int       g_oppArmed;          /* RVNG_TravelDM with opponent=1: the next state 3 fills the tables */
static uint8_t   g_oppKind = 0xff;    /* NM+0x3a8 before the fill (ResetMatchedInfo's argument) */
static uint64_t  g_oppCleanAt;        /* GetTickCount64 when the cleanup is due (0: not yet asked) */
#define GI_MRMM 0x958
static wchar_t kOppUserText[] = L"RVNG_TEST_2";
static FString g_oppUser = { kOppUserText, 12, 12 };   /* the opponent's user id: the room tables' key, never shown */
/* the opponent's shown name (RVNG_OppName, from the server's match: the pilot's RVNG name); the user id when unset */
#define OPP_NAME_MAX 32
static wchar_t g_oppNameText[OPP_NAME_MAX];
static FString g_oppName = { kOppUserText, 12, 12 };
static wchar_t g_oppShown[OPP_NAME_MAX];                /* read back from the game's selector after the fill */

/* UTF-8 (from Lua) -> UTF-16, at most cap-1 units, always terminated; returns the units written. Bad bytes become '?' */
static int Utf8To16(const char* s, size_t n, wchar_t* out, int cap)
{
    int k = 0;
    for (size_t i = 0; i < n && k < cap - 1;) {
        uint8_t c = (uint8_t)s[i];
        uint32_t cp; int len;
        if (c < 0x80) { cp = c; len = 1; }
        else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; len = 2; }
        else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; len = 3; }
        else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; len = 4; }
        else { cp = '?'; len = 1; }
        if (len > 1) {
            if (i + (size_t)len > n) { cp = '?'; len = (int)(n - i); }
            else for (int j = 1; j < len; ++j) {
                uint8_t d = (uint8_t)s[i + (size_t)j];
                if ((d & 0xC0) != 0x80) { cp = '?'; len = j; break; }
                cp = (cp << 6) | (d & 0x3F);
            }
        }
        i += (size_t)len;
        if (cp < 0x20 || (cp >= 0xD800 && cp < 0xE000) || cp > 0x10FFFF) cp = '?';
        if (cp >= 0x10000) {
            if (k + 2 > cap - 1) break;
            cp -= 0x10000;
            out[k++] = (wchar_t)(0xD800 + (cp >> 10));
            out[k++] = (wchar_t)(0xDC00 + (cp & 0x3FF));
        } else out[k++] = (wchar_t)cp;
    }
    out[k] = 0;
    return k;
}
static void SetOppName(const char* s, size_t n)
{
    int k = s && n ? Utf8To16(s, n, g_oppNameText, OPP_NAME_MAX) : 0;
    if (k > 0) { g_oppName.data = g_oppNameText; g_oppName.num = k + 1; g_oppName.max = k + 1; }
    else g_oppName = g_oppUser;
}
static uint8_t g_members[2][0xc0];    /* FChronicleMatchmakerConfirmedResult members (read only by SetConfirmed) */
static uint8_t g_confirmed[0x38];

static int32_t SetCount(const uint8_t* set) { return R32(set, 8) - R32(set, 0x34); }

/* the i-th slot of a TSet/TMap at `set` with stride `stride`, or NULL when that slot is free */
static uint8_t* SetSlot(uint8_t* set, int32_t i, size_t stride)
{
    uint8_t* data = RP(set, 0);
    uint8_t* heap = RP(set, 0x20);
    const uint8_t* words = heap ? heap : set + 0x10;
    if (!data || !(((uint32_t)R32(words, (size_t)(i / 32) * 4) >> (i % 32)) & 1)) return NULL;
    return data + (size_t)i * stride;
}

static void LogRoomTables(const wchar_t* why)
{
    uint8_t* nm = RP(g_gi, GI_NM);
    uint8_t* mrmm = RP(g_gi, GI_MRMM);
    if (!nm || !mrmm) return;
    static wchar_t a[64], b[64];
    int32_t n410 = R32(nm + 0x410, 8), nsel = R32(mrmm + 0x40, 8);
    Log(L"test 3 (%s): NM+0x3d8 %d, NM+0x410 %d member(s), %d selector(s), MRMM+0xe0 %d, MRMM+0x90 %d", why,
        R32(nm, 0x3d8), SetCount(nm + 0x410), SetCount(mrmm + 0x40), (int32_t)R8(mrmm, 0xe0), SetCount(mrmm + 0x90));
    for (int32_t i = 0; i < n410 && i < 16; ++i) {
        uint8_t* e = SetSlot(nm + 0x410, i, 0xb8);
        if (!e) continue;
        Log(L"  member [%d] slot %d user \"%s\" name \"%s\" team %d", i, R32(e, 0x10),
            FStringText((const FString*)(e + 0x18), a, 64), FStringText((const FString*)(e + 0x28), b, 64), R32(e, 0x38));
    }
    for (int32_t i = 0; i < nsel && i < 16; ++i) {
        uint8_t* e = SetSlot(mrmm + 0x40, i, 0x20);
        uint8_t* sel = e ? RP(e, 0x10) : NULL;
        if (!sel) continue;
        Log(L"  selector %p slot %d netId %d joined %d key \"%s\" name \"%s\": aircraft %d skin %d, weapons %d parts %d specials %d emblems %d, callsign \"%s\"",
            sel, R32(sel, 0x30), R32(sel, 0x2c), (int32_t)R8(sel, 0x28), FStringText((const FString*)(sel + 0x38), a, 64),
            FStringText((const FString*)(sel + 0x48), b, 64), R32(sel, 0x78), R32(sel, 0xa8), R32(sel, 0x90), R32(sel, 0xa0),
            R32(sel, 0xc8), R32(sel, 0xe8), FStringText((const FString*)(sel + 0xf0), a, 64));
    }
}

static void OppLoadoutToSel(uint8_t* sel);   /* (lobby.h) */

static void FillOpponent(void)
{
    g_oppArmed = 0;
    uint8_t* nm = RP(g_gi, GI_NM);
    uint8_t* mrmm = RP(g_gi, GI_MRMM);
    uint8_t* udm = RP(g_gi, GI_UDM);
    uint8_t* me = RP(udm, UDM_USER);
    if (!nm || !mrmm || !udm || !me || !g_setConfirmed || !g_buildSel || !g_fillSel || !g_tarrCopy || !g_fstrAssign) {
        Log(L"test 3: not ready (NM %p, MRMM %p, UDM %p, user %p, or a signature missing): no opponent", nm, mrmm, udm, me);
        return;
    }
    g_oppKind = R8(nm, 0x3a8);
    Log(L"test 3: NM+0x3a8 %d, NM+0x3c0 %d", (int32_t)g_oppKind, R32(nm, 0x3c0));
    LogRoomTables(L"before the fill");
    if (R32(nm, 0x3d8) != 0 || SetCount(nm + 0x410) != 0 || SetCount(mrmm + 0x40) != 0 || R8(mrmm, 0xe0) != 0) {
        Log(L"test 3: the room tables are not empty, or the MRMM runs bots: no opponent");
        return;
    }
    memset(g_members, 0, sizeof(g_members));
    memset(g_confirmed, 0, sizeof(g_confirmed));
    memcpy(g_members[0] + 0x00, me + 0x00, sizeof(FString));    /* userId (shallow: SetConfirmed copies it) */
    memcpy(g_members[0] + 0x10, me + 0x10, sizeof(FString));    /* user name */
    memcpy(g_members[1] + 0x00, &g_oppUser, sizeof(FString));
    memcpy(g_members[1] + 0x10, &g_oppName, sizeof(FString));  /* the shown name (SetConfirmed copies it) */
    *(int32_t*)(g_members[1] + 0x20) = 1;                       /* team */
    *(int32_t*)(g_confirmed + 0x10) = 2;                        /* Players */
    struct { void* p; int32_t n, m; } arr = { g_members, 2, 2 };
    memcpy(g_confirmed + 0x20, &arr, sizeof(arr));              /* Members */
    *(int32_t*)(g_confirmed + 0x30) = R32(nm, 0x3c0);           /* MissionProgramId */
    g_setConfirmed(nm, g_confirmed);
    uint8_t built = g_buildSel(mrmm);
    g_fillSel(mrmm, (const FString*)me, 1);
    g_fillSel(mrmm, &g_oppUser, 1);
    int32_t nsel = R32(mrmm + 0x40, 8), done = 0;
    for (int32_t i = 0; i < nsel && i < 16; ++i) {
        uint8_t* e = SetSlot(mrmm + 0x40, i, 0x20);
        uint8_t* sel = e ? RP(e, 0x10) : NULL;
        if (!sel || !Writable(sel + 0x28, 0x100)) continue;
        int32_t slot = R32(sel, 0x30);
        W32(sel, 0x2c, slot == 0 ? (g_cfg.guest ? 2 : 1) : (g_cfg.guest ? 1 : 2));   /* (this PC's number, the peer's) */
        sel[0x28] = 1;
        if (slot == 1) {
            g_tarrCopy(sel + 0x88, udm + 0xdd8);                  /* weapons */
            g_tarrCopy(sel + 0x98, udm + 0xde8);                  /* parts */
            OppLoadoutToSel(sel);                                 /* the opponent's own plane (lobby.h, LOADOUT) */
            g_fstrAssign((FString*)(sel + 0x48), &g_oppName);
            const FString* got = (const FString*)(sel + 0x48);     /* (read back: what the game holds now) */
            int32_t gn = got->num > 0 && got->num <= OPP_NAME_MAX ? got->num : 0;
            g_oppShown[0] = 0;
            if (gn && Readable(got->data, (size_t)gn * 2)) { memcpy(g_oppShown, got->data, (size_t)gn * 2); g_oppShown[gn - 1] = 0; }
        } else {
            g_fstrAssign((FString*)(sel + 0x48), (const FString*)(me + 0x10));
        }
        ++done;
    }
    int32_t myF = g_cfg.guest ? 2 : 1;                     /* (the host Alpha, the guest Bravo) */
    if (!SetFaction(nm, (const FString*)me, (uint8_t)myF, myF == 1 ? L"ALPHA1" : L"BRAVO1", 1) ||
        !SetFaction(nm, &g_oppUser, (uint8_t)(3 - myF), myF == 1 ? L"BRAVO1" : L"ALPHA1", 1))
        Log(L"test 3: the faction entries could not be written");
    g_oppFilled = 1;
    Log(L"test 3: room tables filled (selector build %d, %d selector(s) set; the opponent shown as \"%s\")", (int32_t)built, done,
        g_oppShown);
    LogRoomTables(L"after the fill");
    DumpFactions(nm, L"test 3");
}

static void CleanupOpponent(const wchar_t* why)
{
    if (!g_oppFilled || g_oppCleaned || !g_gi) return;
    uint8_t* nm = RP(g_gi, GI_NM);
    uint8_t* mrmm = RP(g_gi, GI_MRMM);
    if (!nm || !mrmm) return;
    g_oppCleaned = 1;
    if (g_terminateSel) g_terminateSel(mrmm);
    if (g_nmReset) g_nmReset(nm, g_oppKind);
    Log(L"test 3: room tables emptied (%s; TerminateAircraftSelector %s, ResetMatchedInfo(%d) %s)", why,
        g_terminateSel ? L"run" : L"MISSING", (int32_t)g_oppKind, g_nmReset ? L"run" : L"MISSING");
    LogRoomTables(L"after the cleanup");
}

static Fn8 g_origRemoteSpawn;
static uintptr_t OnRemoteSpawn(uintptr_t gm, uintptr_t slot, uintptr_t cls, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{
    int32_t n = __sync_add_and_fetch(&g_oppSpawns, 1);
    g_oppSlot = (int32_t)slot;
    static wchar_t name[128];
    NameText((const FNameRaw*)((uint8_t*)cls + 0x18), name, 128);
    Log(L"remote spawn %d: gm %p slot %d class %p (%s), from exe+%x", n, (void*)gm, (int32_t)slot, (void*)cls, name,
        (uint32_t)((uint8_t*)__builtin_return_address(0) - g_exe));
    uintptr_t r = g_origRemoteSpawn(gm, slot, cls, d, e, f, g, h);
    Log(L"remote spawn %d returned", n);
    return r;
}

/* ---- D1's filter (docs/re/D1_FILTER.md): what crosses the link between the two PCs -------------------------------
 * Every message class is looked up once by its metaclass name (the part after "FLiveMessage") and cached by class id.
 * Default deny. Player numbers: the host is 1, the guest 2 (DEATHMATCH_NATIVE.md 6.4: plane keys 2<<56|n on both PCs). */
enum { POL_DROP, POL_PLANE, POL_GM_HIT, POL_DAMAGE, POL_DAMAGE_CLIENT, POL_SCORE_UPDATE };
static const struct { const wchar_t* name; int pol; } kPolicy[] = {
    /* plane-keyed state and events: relayed with the sender's own key, injected with the peer's */
    { L"Physics", POL_PLANE }, { L"PhysicsOld", POL_PLANE }, { L"AirCurrentStates", POL_PLANE }, { L"Health", POL_PLANE },
    { L"LandingGear", POL_PLANE }, { L"BeginTakeoff", POL_PLANE }, { L"EscapeInClouds", POL_PLANE },
    { L"EscapeByFlare", POL_PLANE }, { L"SelectedTarget", POL_PLANE }, { L"SelectedEmlTarget", POL_PLANE },
    { L"LockedTarget", POL_PLANE }, { L"ExplosiveWeaponFire", POL_PLANE }, { L"InstantWeaponFire", POL_PLANE },
    { L"BulletWeaponFire", POL_PLANE }, { L"ElectronicMeasureFire", POL_PLANE }, { L"ElectronicMeasureEffect", POL_PLANE },
    { L"SpecialWeaponArmed", POL_PLANE }, { L"HoldingMachineGunButton", POL_PLANE }, { L"PushFlare", POL_PLANE },
    { L"DestroyedLocation", POL_PLANE }, { L"Respawn", POL_PLANE },
    /* special cases */
    { L"ExplosiveWeaponHit", POL_GM_HIT }, { L"Damage", POL_DAMAGE }, { L"DamageClient", POL_DAMAGE_CLIENT },
    { L"ScoreUpdate", POL_SCORE_UPDATE },
};
#define HOST_NUM 1
/* this PC's player number and the peer's: the host is 1, the guest 2 (guest=1 makes this PC the guest) */
static int32_t Me(void)   { return g_cfg.guest ? 2 : HOST_NUM; }
static int32_t Peer(void) { return g_cfg.guest ? HOST_NUM : 2; }

static int PolicyOf(const wchar_t* cls)
{
    static const wchar_t pre[] = L"FLiveMessage";
    size_t n = sizeof(pre) / 2 - 1;
    if (!cls || memcmp(cls, pre, n * 2) != 0) return POL_DROP;
    for (size_t i = 0; i < sizeof(kPolicy) / sizeof(kPolicy[0]); ++i) if (WEq(cls + n, kPolicy[i].name)) return kPolicy[i].pol;
    return POL_DROP;
}

/* 1 = relay to the peer: a message this PC (player me) is about to send, of policy pol, keyed (type << 56) | id */
static int SendAllowed(int pol, uint8_t type, uint32_t id, int32_t me)
{
    int host = me == HOST_NUM;
    switch (pol) {
    case POL_PLANE:         return type == 2 && id == (uint32_t)me;
    case POL_GM_HIT:        return type == 6 && id == 0;
    case POL_DAMAGE:        return type == 2 && (host ? (id == 1 || id == 2) : id == (uint32_t)me);
    case POL_DAMAGE_CLIENT: return !host && type == 2 && id == HOST_NUM;
    default:                return 0;   /* (ScoreUpdate: the host puts it on the link itself, never through Send) */
    }
}

/* 1 = inject: a message from the peer, of policy pol, keyed (type << 56) | id */
static int RecvAllowed(int pol, uint8_t type, uint32_t id, int32_t me)
{
    int host = me == HOST_NUM;
    uint32_t peer = host ? 2u : (uint32_t)HOST_NUM;
    if (type == 2 && id == 0) return 0;                  /* (the offline default id: never) */
    switch (pol) {
    case POL_PLANE:         return type == 2 && id == peer;
    case POL_GM_HIT:        return type == 6 && id == 0;
    case POL_DAMAGE:        return type == 2 && (host ? id == peer : (id == (uint32_t)me || id == HOST_NUM));
    case POL_DAMAGE_CLIENT: return host && type == 2 && id == (uint32_t)me;
    case POL_SCORE_UPDATE:  return !host && type == 2 && (id == (uint32_t)me || id == HOST_NUM);
    default:                return 0;
    }
}

/* ---- test 4: the loopback mirror (DEATHMATCH_NATIVE.md 6.4, 6.5, 9.5; sigs.h kSigEncAnchor..kSigPump) -----------
 * On one PC, the transport RVNG will use between two PCs, end to end: at state 14 both planes get registered network
 * objects (the local plane: vf+0xc60 creates it, key 2<<56|1, +0x53b8 = 1, vf+0xc68 registers it in StrixManager+0x2e0;
 * the copy keeps its key 2<<56|2 from the remote spawn and only needs vf+0xc68). The local plane stays role 1, so RVNG
 * refreshes its Physics message each frame (the fill vf+0xc68 jumps to) and the game's slot pump sends it every 80 ms.
 * Send is replaced (D1: nothing ever reaches the original, so nothing leaves the PC): a Physics message keyed to the local
 * plane is serialized with the game's MessagePack code into RVNG's ring; everything else is counted and released. After
 * each pump, the ring's bytes are deserialized, re-keyed to the copy (+0x14 = 2), moved lb_off ahead along the plane's
 * direction, and delivered by the game's router as if the peer (player 2) sent them; the copy's Physics handler and
 * RemoteUpdate then fly it. Disarmed at time-up (state 15) or any map change. */
typedef void*   (*MsCtorFn)(void* ms, uint64_t cap);
typedef void*   (*EncInitFn)(void* enc);
typedef uint8_t (*SerializeFn)(void* err, void* enc, void* metaclass, void* obj);
typedef void*   (*DecCtorFn)(void* dec);
typedef void    (*DeserSpFn)(void* unused, void* dec, uintptr_t* sp);
typedef void    (*RouterFn)(void* sm, uintptr_t* sender, uintptr_t* sp);
typedef void    (*PhysFillFn)(void* n, void* src);
typedef void*   (*Obj1Fn)(void* self);
typedef void*   (*Obj2Fn)(void* self, uint64_t a);
typedef void*   (*Obj3Fn)(void* self, const void* a, uint64_t b);
static MsCtorFn g_msCtor;
static EncInitFn g_encInit;
static SerializeFn g_serialize;
static DecCtorFn g_decCtor;
static DeserSpFn g_deserSp;
static RouterFn g_router;
static PhysFillFn g_physFill;
static Fn8 g_origSend, g_origPump;
static uint8_t *g_lbLocal, *g_lbCopy, *g_lbLocalN, *g_lbCopyN;
static void*   g_lbPhysVt;            /* the local plane's Physics message vtable: what is captured */
static volatile int32_t g_lbSends, g_lbCaptured, g_lbInjected, g_lbApplied, g_lbEncFail, g_lbDecFail,
                        g_lbOverflow, g_lbOffThread, g_lbFills, g_lbErrM = -1, g_lbMovedM = -1, g_lbBytesMax;
static int     g_lbSkipSet, g_lbDepth;
/* the game's synced clock (D1_FILTER.md finding 5): now() + c[0x18] - c[0x8] + c[0x20], 100 ns; c = the clock singleton.
 * Both calls are the Physics fill's own (at +0x61 and +0x69). */
typedef uint8_t* (*ClockObjFn)(void);
typedef int64_t  (*ClockNowFn)(void);
static ClockObjFn g_clockObj;
static ClockNowFn g_clockNow;
static volatile int32_t g_clockSkewMs = -1, g_clockSkewMaxMs = -1, g_clockSamples;
static int64_t SyncedNow(void)
{
    uint8_t* c = g_clockObj ? g_clockObj() : NULL;
    if (!c || !g_clockNow) return 0;
    return g_clockNow() + (int64_t)R64(c, 0x18) - (int64_t)R64(c, 0x8) + (int64_t)R64(c, 0x20);
}
static double  g_lbStart[3];
static DWORD   g_gameThread;
#define LB_RING 256
#define LB_MAX  1024
static struct { uint32_t n; uint8_t b[LB_MAX]; } g_lbRing[LB_RING];
static int32_t g_lbHead, g_lbCount;
#define LB_CLS 24
static struct { uint32_t id; int32_t n, relay, looped; int pol; int loop; wchar_t name[40]; } g_lbCls[LB_CLS];
static int32_t g_lbNCls;
#define GI_STRIX_MGR 0x910
#define KEY_PLANE(n) (0x0200000000000000ull | (uint32_t)(n))

/* the class of a message (its metaclass: id at +0x48, name an MSVC std::string at +8), counted by id; returns its slot */
static int32_t CountClass(uint8_t* obj)
{
    uint8_t* mc = (uint8_t*)((Obj1Fn)(*(void***)obj)[0])(obj);
    if (!mc || !Readable(mc, 0x50)) return -1;
    uint32_t id = (uint32_t)R32(mc, 0x48);
    for (int32_t i = 0; i < g_lbNCls; ++i) if (g_lbCls[i].id == id) { ++g_lbCls[i].n; return i; }
    if (g_lbNCls == LB_CLS) return -1;
    int32_t i = g_lbNCls++;
    g_lbCls[i].id = id; g_lbCls[i].n = 1;
    uint64_t len = R64(mc, 0x18), cap = R64(mc, 0x20);
    const char* t = cap > 15 ? (const char*)RP(mc, 8) : (const char*)(mc + 8);
    size_t k = 0, from = 0;                                         /* (the name's end: "...message.<Class>") */
    if (t && len < 200 && Readable(t, (size_t)len)) {
        for (size_t j = 0; j < len; ++j) if (t[j] == '.') from = j + 1;
        if (len - from > 39) from = len - 39;
        for (; from + k < len && k < 39; ++k) g_lbCls[i].name[k] = (wchar_t)(uint8_t)t[from + k];
    }
    g_lbCls[i].name[k] = 0;
    g_lbCls[i].pol = PolicyOf(g_lbCls[i].name);
    /* the loopback mirrors these (the copy flies, dies and respawns as the local plane does) */
    g_lbCls[i].loop = WEq(g_lbCls[i].name, L"FLiveMessagePhysics") || WEq(g_lbCls[i].name, L"FLiveMessageDestroyedLocation") ||
                      WEq(g_lbCls[i].name, L"FLiveMessageRespawn");
    return i;
}

/* the first few of a class worth a closer look (FLiveMessageCheat): who sent it and what it says */
static void LogMessage(uint8_t* obj, int32_t cls, void* caller)
{
    static int32_t shown;
    if (cls < 0 || shown >= 16) return;
    if (!WEq(g_lbCls[cls].name, L"FLiveMessageCheat") && !WEq(g_lbCls[cls].name, L"FLiveMessageDamage") &&
        !WEq(g_lbCls[cls].name, L"FLiveMessageScoreAddition") && !WEq(g_lbCls[cls].name, L"FLiveMessageHealth")) return;
    ++shown;
    Log(L"Send: %s #%d from exe+%x: key %x/%x, sender %d, time %p", g_lbCls[cls].name, g_lbCls[cls].n,
        (uint32_t)((uint8_t*)caller - g_exe), (int32_t)R8(obj, 0x10), R32(obj, 0x14), R32(obj, 0x1c), RP(obj, 8));
    for (int r = 0; r < 4; ++r)
        Log(L"    +%x: %x %x %x %x %x %x %x %x", 0x20 + r * 0x20, R32(obj, 0x20 + r * 0x20), R32(obj, 0x24 + r * 0x20),
            R32(obj, 0x28 + r * 0x20), R32(obj, 0x2c + r * 0x20), R32(obj, 0x30 + r * 0x20), R32(obj, 0x34 + r * 0x20),
            R32(obj, 0x38 + r * 0x20), R32(obj, 0x3c + r * 0x20));
}

static int32_t SentCount(const wchar_t* name)
{
    for (int32_t i = 0; i < g_lbNCls; ++i) if (WEq(g_lbCls[i].name, name)) return g_lbCls[i].n;
    return 0;
}
static int32_t LoopedCount(const wchar_t* name)
{
    for (int32_t i = 0; i < g_lbNCls; ++i) if (WEq(g_lbCls[i].name, name)) return g_lbCls[i].looped;
    return 0;
}

static void SpRelease(uint8_t* ctl)
{
    if (!ctl) return;
    if (__sync_sub_and_fetch((volatile int32_t*)(ctl + 8), 1) == 0) {
        ((Obj1Fn)(*(void***)ctl)[0])(ctl);                         /* _Destroy */
        if (__sync_sub_and_fetch((volatile int32_t*)(ctl + 0xc), 1) == 0) ((Obj1Fn)(*(void***)ctl)[1])(ctl);   /* _Delete_this */
    }
}

/* obj -> MessagePack bytes, the game's own way (its channel at 0x14a3f5d3c); 0 when it failed or didn't fit */
static uint32_t LbEncode(uint8_t* obj, uint8_t* out, uint32_t cap)
{
    uint8_t ms[0x28], enc[0x18], err = 0;
    memset(ms, 0, sizeof(ms)); memset(enc, 0, sizeof(enc));
    g_msCtor(ms, 0x800);
    g_encInit(enc);
    *(void**)(enc + 8) = ms;
    void* mc = ((Obj1Fn)(*(void***)obj)[0])(obj);
    uint8_t ok = g_serialize(&err, enc, mc, obj);
    uint8_t* b = (uint8_t*)RP(ms, 8);
    uint8_t* e = (uint8_t*)RP(ms, 0x10);
    uint32_t n = 0;
    if (ok && b && e > b && (size_t)(e - b) <= cap) { n = (uint32_t)(e - b); memcpy(out, b, n); }
    if (ok && b && e > b && (int32_t)(e - b) > g_lbBytesMax) g_lbBytesMax = (int32_t)(e - b);
    ((Obj2Fn)(*(void***)ms)[0])(ms, 0);                            /* the stream's destructor (no free: on the stack) */
    return n;
}

/* bytes -> a new message {obj, ctl} (the caller releases ctl); 0 when it failed */
static int LbDecode(const uint8_t* b, uint32_t n, uintptr_t sp[2])
{
    uint8_t ms[0x28], dec[0x28];
    uint64_t scratch = 0;
    memset(ms, 0, sizeof(ms)); memset(dec, 0, sizeof(dec));
    g_msCtor(ms, 0x800);
    ((Obj3Fn)(*(void***)ms)[2])(ms, b, n);                       /* write */
    *(uint64_t*)(ms + 0x20) = 0;                                   /* read from the start */
    g_decCtor(dec);
    *(void**)(dec + 8) = ms;
    sp[0] = sp[1] = 0;
    g_deserSp(&scratch, dec, sp);
    ((Obj2Fn)(*(void***)dec)[0])(dec, 0);
    ((Obj2Fn)(*(void***)ms)[0])(ms, 0);
    return sp[0] != 0 && sp[1] != 0;
}

static void LbDisarm(const wchar_t* why)
{
    if (!g_lbReady) return;
    g_lbReady = 0;
    g_lbCount = 0;
    Log(L"test 4: loopback off (%s): sends %d, Physics captured %d, injected %d, applied %d, fills %d", why, g_lbSends,
        g_lbCaptured, g_lbInjected, g_lbApplied, g_lbFills);
    if (g_cfg.wire == 2 && (g_link.state == LS_UP || g_link.state == LS_WAITING)) {   /* the match is over here: a clean */
        LinkStopSteam(LB_MATCH_OVER);                                                  /* BYE, so the other PC never    */
        Log(L"wire 2: BYE sent to the other PC (%s)", why);                            /* takes it for a lost link      */
    }
}

/* the planes still the ones registered (their network objects unchanged) */
static int LbAlive(void)
{
    return g_lbLocal && g_lbCopy && Readable(g_lbLocal + 0xed0, 8) && Readable(g_lbCopy + 0xed0, 8) &&
           RP(g_lbLocal, 0xed0) == g_lbLocalN && RP(g_lbCopy, 0xed0) == g_lbCopyN;
}

static void LogKeys(uint8_t* sm, const wchar_t* why)
{
    int32_t num = R32(sm, 0x2e8), live = SetCount(sm + 0x2e0);
    Log(L"test 4 (%s): StrixManager+0x2e0 holds %d key(s)", why, live);
    for (int32_t i = 0; i < num && i < 32; ++i) {
        uint8_t* e = SetSlot(sm + 0x2e0, i, 0x18);
        if (e) Log(L"    key %p", RP(e, 0));
    }
}

static int SlotOk(uint8_t* plane, uint8_t** c60, uint8_t** c68)
{
    void** vt = *(void***)plane;
    if (!vt || !Readable(vt + 0xc68 / 8, 8)) return 0;
    *c60 = (uint8_t*)vt[0xc60 / 8]; *c68 = (uint8_t*)vt[0xc68 / 8];
    return InGame(*c60) && InGame(*c68) && Readable(*c60, 9) && Readable(*c68, 0x4a) &&
           !memcmp(*c60, kPlaneC60Head, 9) && !memcmp(*c68, kPlaneC68Head, 16) && !memcmp(*c68 + 0x40, kPlaneC68Tail, 6);
}

/* The game mode's network object (DEATHMATCH_NATIVE.md 6.4: vf+0xc48 creates it at GM+0x738, key 6<<56, vf+0xc50
 * registers it): without it the game never sends ExplosiveWeaponHit (role-3 audit). The slots' bytes are checked first. */
static const uint8_t kGmC48Target[8] = { 0x48, 0x83, 0xB9, 0x38, 0x07, 0x00, 0x00, 0x00 };   /* at the jmp target + 0x1b */
static const uint8_t kGmC50Head[10] = { 0x48, 0x8B, 0x89, 0x38, 0x07, 0x00, 0x00, 0x48, 0x85, 0xC9 };
static void LbRegisterGM(uint8_t* gm)
{
    void** vt = gm ? *(void***)gm : NULL;
    if (!vt || !Readable(vt + 0xc50 / 8, 8)) return;
    uint8_t* c48 = (uint8_t*)vt[0xc48 / 8];
    uint8_t* c50 = (uint8_t*)vt[0xc50 / 8];
    uint8_t* t = NULL;
    if (InGame(c48) && Readable(c48, 5) && c48[0] == 0xE9) { int32_t d; memcpy(&d, c48 + 1, 4); t = c48 + 5 + d; }
    if (!t || !InGame(t) || !Readable(t + 0x1b, 8) || memcmp(t + 0x1b, kGmC48Target, 8) || !InGame(c50) || !Readable(c50, 10) ||
        memcmp(c50, kGmC50Head, 10)) {
        Log(L"test 4: the game mode's network slots are not as expected: no game-mode object");
        return;
    }
    ((Obj1Fn)c48)(gm);
    uint8_t* n = RP(gm, 0x738);
    if (!n) { Log(L"test 4: vf+0xc48 made no game-mode network object"); return; }
    uint64_t was = R64(n, 0x28);
    if (!was) W64(n, 0x28, 0x0600000000000000ull);
    ((Obj1Fn)c50)(gm);
    Log(L"test 4: the game mode's network object %p, key %p (was %p), registered", n, RP(n, 0x28), (void*)(uintptr_t)was);
}

/* AfterState(14), game thread: register both planes' network objects and arm the mirror */
static void LbRegister(uint8_t* gm)
{
    if (!g_cfg.loopback || !g_oppFilled || g_lbReady || !g_getWorld || !g_worldSub || !g_gi) return;
    g_gameThread = GetCurrentThreadId();
    if (!g_msCtor || !g_encInit || !g_serialize || !g_decCtor || !g_deserSp || !g_router || !g_origSend || !g_origPump) {
        Log(L"test 4: a signature or hook is missing: no loopback"); return;
    }
    uint8_t* sub = g_worldSub(g_getWorld(gm));
    uint8_t* sm = RP(g_gi, GI_STRIX_MGR);
    if (!sub || !sm) { Log(L"test 4: no world subsystem or StrixManager: no loopback"); return; }
    uint8_t* planes = RP(sub, 0x138);
    int32_t np = R32(sub, 0x140);
    static wchar_t uid[96];
    uint8_t *local = NULL, *copy = NULL;
    for (int32_t i = 0; i < np && i < 16; ++i) {
        uint8_t* p = RP(planes, (size_t)i * 8);
        if (!p || !Readable(p + PLANE_USER, 16)) continue;
        FStringText((const FString*)(p + PLANE_USER), uid, 96);
        if (R8(p, 0xed8) == 2 && WEq(uid, kOppUserText)) copy = p;
        else if (R8(p, 0xed8) == 1 && uid[0] == 0) local = p;
    }
    uint8_t *c60, *c68, *cc60, *cc68;
    if (!local || !copy || !SlotOk(local, &c60, &c68) || !SlotOk(copy, &cc60, &cc68)) {
        Log(L"test 4: planes local %p copy %p, or their network slots not as expected: no loopback", local, copy);
        return;
    }
    uint8_t* copyN = RP(copy, 0xed0);
    if (!copyN || R64(copyN, 0x28) != KEY_PLANE(Peer())) { Log(L"test 4: the copy's network object %p is not 2<<56|%d: no loopback", copyN, Peer()); return; }
    LogKeys(sm, L"before");
    for (int32_t i = 0; i < R32(sm, 0x2e8) && i < 64; ++i) {
        uint8_t* e = SetSlot(sm + 0x2e0, i, 0x18);
        if (e && (R64(e, 0) == KEY_PLANE(Me()) || R64(e, 0) == KEY_PLANE(Peer()))) { Log(L"test 4: a plane key is already registered: no loopback"); return; }
    }
    ((Obj1Fn)c60)(local);
    uint8_t* n = RP(local, 0xed0);
    if (!n) { Log(L"test 4: vf+0xc60 made no network object: no loopback"); return; }
    W64(n, 0x28, KEY_PLANE(Me()));
    W32(local, 0x53b8, Me());
    if (g_cfg.lbRole3) { int32_t was = R8(local, 0xed8); local[0xed8] = 3; Log(L"test 5: the local plane's role %d -> 3", was); }
    ((Obj1Fn)c68)(local);                                          /* (not role 2: ends in the Physics fill) */
    ((Obj1Fn)cc68)(copy);
    LbRegisterGM(gm);
    int32_t d; memcpy(&d, c68 + 0x46, 4);
    g_physFill = (PhysFillFn)(void*)(c68 + 0x4a + d);
    uint8_t* phys = RP(n, 0x98);
    g_lbPhysVt = phys ? RP(phys, 0) : NULL;
    g_lbLocal = local; g_lbCopy = copy; g_lbLocalN = n; g_lbCopyN = copyN;
    ActorLoc(copy, g_lbStart);
    LogKeys(sm, L"after");
    Log(L"test 4: registered: local %p N %p (key %p), copy %p N %p (key %p); Physics fill exe+%x, Physics vtable exe+%x; mirror %d cm ahead",
        local, n, RP(n, 0x28), copy, copyN, RP(copyN, 0x28), (uint32_t)((uint8_t*)g_physFill - g_exe),
        g_lbPhysVt ? (uint32_t)((uint8_t*)g_lbPhysVt - g_exe) : 0, g_cfg.lbOff);
    if (!g_lbPhysVt || !InGame(g_physFill)) { Log(L"test 4: no Physics message or fill: no loopback"); return; }
    g_clockObj = (ClockObjFn)(void*)CallTarget((uint8_t*)g_physFill + 0x61);
    g_clockNow = (ClockNowFn)(void*)CallTarget((uint8_t*)g_physFill + 0x69);
    { uint8_t* c = g_clockObj ? g_clockObj() : NULL;
      Log(L"test 4: the synced clock: %s; object %p, +0x8 %p +0x18 %p +0x20 (RealTime's offset) %p", g_clockObj && g_clockNow ? L"found" : L"MISSING",
          c, RP(c, 0x8), RP(c, 0x18), RP(c, 0x20)); }
    g_lbReady = 1;
}

static Link g_lpA, g_lpB;                                         /* (the wire, below) */
static int g_standInLoadout;                                      /* (wire 1: the stand-in's LOADOUT sent) */
/* a Physics message's TriggerTime (+8) against RVNG's own read of the game's synced clock */
static void ClockSample(uint8_t* obj)
{
    int64_t now = *(void**)obj == g_lbPhysVt ? SyncedNow() : 0;
    if (!now) return;
    int64_t d = now - (int64_t)R64(obj, 8);
    int32_t ms = (int32_t)((d < 0 ? -d : d) / 10000);
    g_clockSkewMs = ms; if (ms > g_clockSkewMaxMs) g_clockSkewMaxMs = ms; ++g_clockSamples;
}
static void WireOut(Link* L, uint8_t* obj, int phys);
/* D1 in an RVNG match (loopback): Send replaced; nothing is ever passed on. Outside one the game's own Send runs */
static uintptr_t OnSend(uintptr_t a, uintptr_t spp, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{
    if (!g_cfg.loopback) return g_origSend(a, spp, c, d, e, f, g, h);
    uintptr_t* sp = (uintptr_t*)spp;
    if (!sp) return 0;
    uint8_t* obj = (uint8_t*)sp[0];
    uint8_t* ctl = (uint8_t*)sp[1];
    if (!ctl || (uintptr_t)obj < 0x10000) return 0;               /* the {0x10, NULL} form: nothing to release */
    __sync_add_and_fetch(&g_lbSends, 1);
    if (g_gameThread && GetCurrentThreadId() != g_gameThread) {
        __sync_add_and_fetch(&g_lbOffThread, 1);
    } else {
        int32_t cls = CountClass(obj);
        LogMessage(obj, cls, __builtin_return_address(0));
        /* D1's decision for this PC as the host (player 1): counted, so every class the game sends is checked against
         * the filter in game; the loopback below still mirrors Physics only */
        int allowed = cls >= 0 && SendAllowed(g_lbCls[cls].pol, R8(obj, 0x10), (uint32_t)R32(obj, 0x14), Me());
        if (allowed) ++g_lbCls[cls].relay;
        if (g_lbReady && g_cfg.wire == 2) {
            if (allowed) WireOut(&g_link, obj, *(void**)obj == g_lbPhysVt);
        } else if (g_lbReady && g_cfg.wire == 1 && cls >= 0 && g_lbCls[cls].loop && R8(obj, 0x10) == 2 &&
                   (uint32_t)R32(obj, 0x14) == (uint32_t)Me()) {
            WireOut(&g_lpA, obj, *(void**)obj == g_lbPhysVt);
        } else if (g_lbReady && cls >= 0 && g_lbCls[cls].loop && R8(obj, 0x10) == 2 && (uint32_t)R32(obj, 0x14) == (uint32_t)Me()) {
            if (g_lbCount == LB_RING) {
                __sync_add_and_fetch(&g_lbOverflow, 1);
            } else {
                int32_t slot = (g_lbHead + g_lbCount) % LB_RING;
                ClockSample(obj);
                uint32_t n = LbEncode(obj, g_lbRing[slot].b, LB_MAX);
                if (n) { g_lbRing[slot].n = n; ++g_lbCount; if (*(void**)obj == g_lbPhysVt) __sync_add_and_fetch(&g_lbCaptured, 1); }
                else __sync_add_and_fetch(&g_lbEncFail, 1);
            }
        }
    }
    SpRelease(ctl);                                                /* (the original's release at 0x1474a22b1) */
    return 0;
}

/* the mirror point: lb_off cm along the message's Direction (+0x20, f32 x3) */
static void MirrorOffset(uint8_t* obj)
{
    float dir[3];
    memcpy(dir, obj + 0x20, 12);
    float l2 = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
    if (!(l2 > 1e-6f) || !(l2 < 1e12f)) { dir[0] = 1; dir[1] = 0; dir[2] = 0; l2 = 1; }
    float r = 1.0f;                                                 /* 1/sqrt(l2), Newton from a power-of-two guess */
    while (r * r * l2 > 2.0f) r *= 0.5f;                            /* (r*r*l2 in [0.5, 2]: Newton converges below 3) */
    while (r * r * l2 < 0.5f) r *= 2.0f;
    for (int i = 0; i < 6; ++i) r = r * (1.5f - 0.5f * l2 * r * r);
    for (int k = 0; k < 3; ++k) {
        int32_t v = R32(obj, 0x2c + 4 * k);
        v += (int32_t)(dir[k] * r * (float)g_cfg.lbOff);
        memcpy(obj + 0x2c + 4 * k, &v, 4);
    }
}

static void LbMirrorOne(uint8_t* sm, const uint8_t* bytes, uint32_t nbytes);
static void LbDrain(uint8_t* sm)
{
    while (g_lbCount > 0) {
        int32_t slot = g_lbHead;
        g_lbHead = (g_lbHead + 1) % LB_RING; --g_lbCount;
        LbMirrorOne(sm, g_lbRing[slot].b, g_lbRing[slot].n);
    }
}

/* one captured message of the local plane, mirrored to the copy as if the peer sent it (wire 0 and wire 1) */
static void LbMirrorOne(uint8_t* sm, const uint8_t* bytes, uint32_t nbytes)
{
    static uint8_t uid[16];
    {
        uintptr_t sp[2];
        if (!LbDecode(bytes, nbytes, sp)) { __sync_add_and_fetch(&g_lbDecFail, 1); SpRelease((uint8_t*)sp[1]); return; }
        uint8_t* obj = (uint8_t*)sp[0];
        int32_t cls = -1;
        {   uint8_t* mc = (uint8_t*)((Obj1Fn)(*(void***)obj)[0])(obj);
            uint32_t id = mc ? (uint32_t)R32(mc, 0x48) : 0;
            for (int32_t c = 0; c < g_lbNCls; ++c) if (g_lbCls[c].id == id) cls = c; }
        int phys = *(void**)obj == g_lbPhysVt;
        if (cls < 0 || !g_lbCls[cls].loop || R8(obj, 0x10) != 2) { __sync_add_and_fetch(&g_lbDecFail, 1); SpRelease((uint8_t*)sp[1]); return; }
        W32(obj, 0x14, Peer());                                    /* re-keyed to the copy */
        obj[0x18] = 0; obj[0x19] = 0;
        if (!RecvAllowed(POL_PLANE, R8(obj, 0x10), (uint32_t)R32(obj, 0x14), Me())) {   /* (D1's receive rule) */
            __sync_add_and_fetch(&g_lbDecFail, 1); SpRelease((uint8_t*)sp[1]); return;
        }
        if (phys) MirrorOffset(obj);
        int32_t x = R32(obj, 0x2c);
        if (!phys) Log(L"test 4: %s from the local plane mirrored to the copy", g_lbCls[cls].name);
        ++g_lbCls[cls].looped;
        if (!g_lbSkipSet) { g_lbCopy[0x8b1] = 1; g_lbSkipSet = 1; }   /* the location check's one-shot skip */
        *(int32_t*)(uid + 8) = Peer();                             /* "sent by the peer", never 0 */
        uintptr_t sender[2] = { (uintptr_t)uid, 0 };
        g_router(sm, sender, sp);
        if (phys) {
            __sync_add_and_fetch(&g_lbInjected, 1);
            uint8_t* cp = RP(g_lbCopyN, 0x98);
            if (cp && R32(cp, 0x1c) == Peer() && R32(cp, 0x2c) == x) __sync_add_and_fetch(&g_lbApplied, 1);
        }
        SpRelease((uint8_t*)sp[1]);
    }
}

/* ---- the wire (2026-11-19): what carries test 4's captured messages -----------------------------------------------
 * wire 0: RVNG's in-memory ring above (the one-PC loopback).
 * wire 1: a pair of links in this process (link.h with its framing, hello, clock, GO and loss detection) carrying the
 *         game's real messages on one PC: this PC's link A sends, the stand-in peer's link B receives, and the mirror
 *         delivers B's messages to the copy as wire 0 does. D2's start waits for the pair's GO.
 * wire 2: Steam to the other PC (link.h's g_link, from link_peer/link_player/link_tag): every class D1 lets out is sent;
 *         what arrives goes through D1's receive rule to the router as the peer's own (each PC keys a plane by its
 *         player number, so nothing is re-keyed). D2's start waits for the link's GO; a lost link is the forced end. */
#define WQ 256
typedef struct { uint8_t b[WQ][LINK_MAX_MSG]; uint16_t n[WQ]; uint8_t ch[WQ]; uint32_t head, tail; } WireQ;
typedef struct { WireQ* out; WireQ* in; uint64_t from; } WireEnd;
static WireQ   g_wqAB, g_wqBA;
static WireEnd g_weA = { &g_wqAB, &g_wqBA, 2 }, g_weB = { &g_wqBA, &g_wqAB, 1 };
static volatile int32_t g_clockApplied, g_clockDeltaMs = -1;
static volatile int32_t g_wireOn, g_wireCut, g_wireSent, g_wireGot, g_wireRouted, g_wireDropped, g_wireReleased,
                        g_wireSendFail;

static int WqSend(void* c, int ch, const void* p, uint32_t n, int rel)
{
    WireEnd* e = (WireEnd*)c;
    (void)rel;
    if (g_wireCut) return 1;                                       /* (lost on the way: the lost-link test) */
    if (e->out->head - e->out->tail >= WQ || n > LINK_MAX_MSG) return 0;
    uint32_t i = e->out->head % WQ;
    memcpy(e->out->b[i], p, n); e->out->n[i] = (uint16_t)n; e->out->ch[i] = (uint8_t)ch;
    e->out->head++;
    return 1;
}
static int WqRecv(void* c, int ch, uint8_t* buf, int cap, uint64_t* from)
{
    WireEnd* e = (WireEnd*)c;
    WireQ* q = e->in;
    if (q->tail == q->head) return 0;
    uint32_t i = q->tail % WQ;
    if (q->ch[i] != ch) return 0;
    int n = q->n[i] <= cap ? q->n[i] : 0;
    if (n) memcpy(buf, q->b[i], (size_t)n);
    *from = e->from;
    q->tail++;
    return n ? n : -1;
}

/* this PC's link, and the one that plays the host (it sends GO) */
static Link* WireMine(void) { return g_cfg.wire == 1 ? &g_lpA : g_cfg.wire == 2 ? &g_link : NULL; }
static Link* WireHost(void) { return g_cfg.wire == 1 ? (Me() == 1 ? &g_lpA : &g_lpB) : g_cfg.wire == 2 && g_link.player == 1 ? &g_link : NULL; }

/* wire 1: the pair, made once per match (at the start gate or at state 14, whichever comes first) */
static void WireEnsure(void)
{
    if (g_cfg.wire != 1 || g_wireOn) return;
    memset(&g_wqAB, 0, sizeof(g_wqAB)); memset(&g_wqBA, 0, sizeof(g_wqBA));
    g_wireCut = 0;
    g_lpA.io = (LinkIo){ WqSend, WqRecv, StNow, &g_weA };
    g_lpB.io = (LinkIo){ WqSend, WqRecv, StNow, &g_weB };
    uint32_t tag = LinkTagOf("rvng-wire1", 10);
    LinkBegin(&g_lpA, 1 == Me() ? 1 : 2, 1 == Me() ? 2 : 1, Me(), tag, 0, 0, "this PC");
    LinkBegin(&g_lpB, 1 == Me() ? 2 : 1, 1 == Me() ? 1 : 2, Peer(), tag, 0, 0, "stand-in peer");
    g_weA.from = g_lpA.peer; g_weB.from = g_lpB.peer;
    g_wireOn = 1;
    g_standInLoadout = 0;
    Log(L"wire 1: a pair of links made in this process (this PC player %d, the stand-in peer player %d)", Me(), Peer());
}
static void WireTickPair(void)
{
    if (g_cfg.wire != 1 || !g_wireOn) return;
    g_lpB.localReady = g_lpA.localReady;                          /* (the stand-in peer readies with this PC) */
    LinkTick(&g_lpA); LinkTick(&g_lpB);
    if (g_lpB.state == LS_UP && !g_standInLoadout) {             /* (the stand-in flies an F-14A, the DLC plane) */
        LinkLoadout lo;
        memset(&lo, 0, sizeof(lo));
        lo.aircraft = 10034010; lo.skin = 34002001; lo.sp1 = 1; lo.sp2 = 2;
        memcpy(lo.names, "F-14A|XMAA|LAGB", 16);
        if (LinkSend(&g_lpB, LK_LOADOUT, &lo, sizeof(lo), 1)) {
            g_standInLoadout = 1;
            Log(L"wire 1: the stand-in peer's loadout sent (aircraft %d, skin %d)", lo.aircraft, lo.skin);
        }
    }
}

/* one captured message onto the wire (game thread): encoded the game's way, sent as DATA */
static void WireOut(Link* L, uint8_t* obj, int phys)
{
    uint8_t buf[LINK_MAX_MSG - sizeof(LinkHdr)];
    ClockSample(obj);
    uint32_t n = LbEncode(obj, buf, sizeof(buf));
    if (!n) { __sync_add_and_fetch(&g_lbEncFail, 1); return; }
    if (LinkSendData(L, buf, n, !phys)) {
        __sync_add_and_fetch(&g_wireSent, 1);
        if (phys) __sync_add_and_fetch(&g_lbCaptured, 1);
    } else {
        __sync_add_and_fetch(&g_wireSendFail, 1);
    }
}

/* wire 2: one message from the peer to the router, as the peer's own (game thread, after the pump) */
static void WireIn(uint8_t* sm, const uint8_t* b, int n)
{
    static uint8_t uid[16];
    uintptr_t sp[2];
    __sync_add_and_fetch(&g_wireGot, 1);
    if (!LbDecode(b, (uint32_t)n, sp)) { __sync_add_and_fetch(&g_lbDecFail, 1); SpRelease((uint8_t*)sp[1]); return; }
    uint8_t* obj = (uint8_t*)sp[0];
    int32_t cls = CountClass(obj);
    if (cls < 0 || !RecvAllowed(g_lbCls[cls].pol, R8(obj, 0x10), (uint32_t)R32(obj, 0x14), Me())) {
        __sync_add_and_fetch(&g_wireDropped, 1); SpRelease((uint8_t*)sp[1]); return;
    }
    ++g_lbCls[cls].looped;
    *(int32_t*)(uid + 8) = Peer();
    uintptr_t sender[2] = { (uintptr_t)uid, 0 };
    g_router(sm, sender, sp);
    __sync_add_and_fetch(&g_wireRouted, 1);
    SpRelease((uint8_t*)sp[1]);
}

/* this PC's game clock minus its link clock (x 10, 100 ns); 0 when the clock isn't found */
static int64_t ClockK(void)
{
    int64_t g = SyncedNow();
    return g ? g - (int64_t)StNow(NULL) * 10 : 0;
}

/* D2's answer with a wire: this PC is at the start gate; the host sends GO once the peer is there too and its clock is
 * synced; the gate opens at the agreed time on both PCs */
static int WireGate(void)
{
    Link* L = WireMine();
    if (!L) return 0;
    WireEnsure();
    WireTickPair();
    L->localStage = 12;
    if (g_cfg.wire == 1) g_lpB.localStage = 12;                    /* (the stand-in peer is at the gate too) */
    Link* H = WireHost();
    if (H && H->state == LS_UP && H->peerSynced && H->peerStage >= 12 && H->goState == LG_NONE) {
        if (g_cfg.wire == 2) LinkLock();
        int ok = LinkGoStart(H, 1500000, ClockK());
        if (g_cfg.wire == 2) LinkUnlock();
        Log(L"wire %d: both PCs at the start gate, the peer's clock synced: GO in 1.5 s %s", g_cfg.wire, ok ? L"sent" : L"NOT sent");
    }
    /* the guest runs the host's game clock from the GO on (as the server's RealTime sets c[0x20] online) */
    if (L->player == 2 && L->goState == LG_SET && !g_clockApplied) {
        g_clockApplied = 1;
        uint8_t* c = g_clockObj ? g_clockObj() : NULL;
        int64_t mine = ClockK();
        if (c && mine && L->peerClockK) {
            int64_t delta = LinkClockDelta(L->offsetUs, L->peerClockK, mine);
            W64(c, 0x20, (uint64_t)((int64_t)R64(c, 0x20) + delta));
            g_clockDeltaMs = (int32_t)(delta / 10000);
            Log(L"wire %d: this PC (the guest) now runs the host's game clock: c[0x20] += %d ms (link offset %d ms)", g_cfg.wire,
                g_clockDeltaMs, (int32_t)(L->offsetUs / 1000));
        } else {
            Log(L"wire %d: the game clock could not be aligned (clock %p, mine %d, host's %d): TriggerTimes stay on two clocks",
                g_cfg.wire, c, (int32_t)(mine != 0), (int32_t)(L->peerClockK != 0));
        }
    }
    int due = LinkGoDue(L);
    if (due && !g_wireReleased) {
        g_wireReleased = 1;
        Log(L"wire %d: the agreed start time came: D2 opens the start gate (clock offset %d ms, round trip %d ms)", g_cfg.wire,
            (int32_t)(L->offsetUs / 1000), (int32_t)(L->rttUs / 1000));
    }
    return due;
}

/* ---- test 7 on one PC: a hit through the game's own damage path (DEATHMATCH_NATIVE.md 9.6) -----------------------
 * With the mirror flying and the local plane role 3 (the host), RVNG calls the copy's own TakeDamage (vtable slot 0xa38)
 * with the local plane as the attacker and a missile's damage type (2), no causer. The game then runs the host's path
 * natively: CanBeDamagedBy (role 3 on role 2: allowed), CanTakeDamage, AuthoritativeApply (offline branch), the score
 * function for the attacker (a ScoreAddition reaches Send), BroadcastDamage (a Damage keyed to the copy reaches Send).
 * Steps, 25 s after the mirror is armed, on the game thread (the slot pump's pre-hook): a 30 % hit; 3 s later a lethal
 * one; 6 s later the copy is respawned through its own respawn slot 0xbf8 (online a Respawn message does this). */
typedef float (*TakeDamageFn)(void* self, float dmg, void* ev, void* attacker, void* causer);
typedef float (*TotalScoreFn)(void* plane);
typedef void  (*RespawnFn)(void* self, const double* loc, const double* rot, uint8_t flag);
static TotalScoreFn g_totalScore;
typedef void* (*MetaFn)(void);
static MetaFn g_dcMeta;                 /* the DamageClient metaclass getter */
static MetaFn g_suMeta;                 /* the ScoreUpdate metaclass getter */
static void*  g_scoreDataVt;            /* its element (ScoreData) vtable */
static volatile int32_t g_suBuilt, g_suBytes = -1, g_suInjected = -1, g_suLocal = -1, g_suCopy = -1;
static volatile int32_t g_deathLocalHp = -1, g_deathCopyFlag = -1, g_deathCopyHp = -1, g_deathLocalHp2 = -1;
static int g_deathWait;
static volatile int32_t g_hit7bHp0 = -1, g_hit7bHp1 = -1, g_hit7bScore0 = -1, g_hit7bScore1 = -1, g_hit7bInjected = -1;
static int      g_hitPhase;
static uint64_t g_hitAt;
static volatile int32_t g_hitR1 = -1, g_hitR2 = -1, g_hitHp0 = -1, g_hitHp1 = -1, g_hitHp2 = -1, g_hitHp3 = -1,
                        g_hitScore0 = -1, g_hitScore1 = -1, g_hitScore2 = -1;
#define PLANE_HP     0xda8      /* i32 health x10 */
#define PLANE_SHIELD 0x1400     /* i32 shield x10 */
#define PLANE_MAXHP  0x3b4      /* float */

static int32_t ScoreX10(uint8_t* plane) { return g_totalScore ? (int32_t)(g_totalScore(plane) * 10.0f) : -1; }

/* the result screen (Scripts/rvng_ready.lua): both planes' TotalScore at time-up (on the guest the host's ScoreUpdates
 * have set them), kept until the next match's */
static volatile int32_t g_resMatches, g_resMine = -1, g_resTheirs = -1;
static void MatchStatsEnd(void);           /* (matchstats.h: the match's deaths, length and end, for the leaderboard) */
static void ResultCapture(void)
{
    if (!g_lbLocal || !g_lbCopy || !g_totalScore || !Readable(g_lbLocal, 8) || !Readable(g_lbCopy, 8)) return;
    g_resMine = ScoreX10(g_lbLocal);
    g_resTheirs = ScoreX10(g_lbCopy);
    __sync_add_and_fetch(&g_resMatches, 1);
    Log(L"result: this pilot %d.%d, the opponent %d.%d (match %d)", g_resMine / 10, g_resMine % 10, g_resTheirs / 10,
        g_resTheirs % 10, g_resMatches);
    MatchStatsEnd();
}

static void LogHitState(const wchar_t* why)
{
    uint8_t* c = g_lbCopy;
    float maxhp; memcpy(&maxhp, c + PLANE_MAXHP, 4);
    Log(L"test 7 (%s): copy health %d shield %d max %d (x10), +0xdb8 %d +0xdb9 %d, protection +0xdfc %d, +0x3ae0 %p, death +0x3c2c %d +0x3c2e %d, last hit type %d; local score %d (x10)",
        why, R32(c, PLANE_HP), R32(c, PLANE_SHIELD), (int32_t)(maxhp * 10), (int32_t)R8(c, 0xdb8), (int32_t)R8(c, 0xdb9),
        (int32_t)R8(c, 0xdfc), RP(c, 0x3ae0), (int32_t)R8(c, 0x3c2c), (int32_t)R8(c, 0x3c2e), (int32_t)R8(c, 0x480),
        ScoreX10(g_lbLocal));
}

static float HitCopy(float dmg)
{
    uint8_t ev[0x40];
    memset(ev, 0, sizeof(ev));
    double at[3] = { 0, 0, 0 };
    ActorLoc(g_lbCopy, at);
    memcpy(ev, at, 24);                                  /* HitLoc (cosmetic without a causer) */
    ev[0x18] = 2;                                        /* DamageType: a missile's */
    TakeDamageFn td = (TakeDamageFn)(*(void***)g_lbCopy)[0xa38 / 8];
    return td(g_lbCopy, dmg, ev, g_lbLocal, NULL);
}


/* the weapon object in the plane's slot wn (vf+0x960's reads: +0x16a8 -> +0x2e0 -> +0xb0: count +0x30, data +0x28, stride
 * 0xa0, object +0x40), read only; NULL when the slot is out of range or empty. The host's cheat check calls this for the
 * attacker's copy and crashes on NULL, so a DamageClient must name a slot that exists. */
static uint8_t* WeaponIn(uint8_t* plane, int wn)
{
    uint8_t* list = RP(RP(RP(plane, 0x16a8), 0x2e0), 0xb0);
    if (!list || wn < 0 || wn >= R32(list, 0x30)) return NULL;
    uint8_t* data = RP(list, 0x28);
    return data ? (uint8_t*)RP(data + (size_t)wn * 0xa0, 0x40) : NULL;
}

/* 7b: a DamageClient as the guest's D3 will send it (victim the host's plane 2/1, attacker the guest 2/2), through the
 * game's encode/decode and the router as player 2; the host's native handler applies it to the local plane */
static int Inject7b(void)
{
    if (!g_dcMeta || !g_router) { Log(L"test 7b: the DamageClient metaclass or the router is missing"); return 0; }
    int wn = -1; uint8_t* w = NULL;
    for (int i = 0; i < 8 && !w; ++i) if ((w = WeaponIn(g_lbCopy, i)) != NULL) wn = i;
    if (!w) { Log(L"test 7b: the copy has no weapon slot to name: not sent (the host's check would crash)"); return 0; }
    uint8_t* mc = (uint8_t*)g_dcMeta();
    uint8_t* m = mc ? (uint8_t*)((Obj1Fn)(*(void***)mc)[3])(mc) : NULL;
    if (!m || ((Obj1Fn)(*(void***)m)[0])(m) != mc) { Log(L"test 7b: the DamageClient factory gave %p", m); return 0; }
    float maxhp; memcpy(&maxhp, g_lbLocal + PLANE_MAXHP, 4);
    *(int64_t*)(m + 0x08) = SyncedNow();
    m[0x10] = 2; *(uint32_t*)(m + 0x14) = 1;             /* victim: the host's plane */
    m[0x20] = 2; *(uint32_t*)(m + 0x24) = 2;             /* attacker: the guest (the copy here) */
    m[0x28] = (uint8_t)wn; m[0x29] = R8(w, 0x2b1); m[0x2a] = 2;
    *(int32_t*)(m + 0x2c) = (int32_t)((maxhp > 0 && maxhp < 1e6f ? maxhp : 100.0f) * 0.3f);
    m[0x30] = 0; m[0x31] = 0;
    static uint8_t buf[LB_MAX];
    uint32_t n = LbEncode(m, buf, LB_MAX);
    ((Obj2Fn)(*(void***)m)[2])(m, 1);                   /* the message's deleting destructor */
    uintptr_t sp[2];
    if (!n || !LbDecode(buf, n, sp)) { Log(L"test 7b: encode %d bytes / decode failed", n); return 0; }
    uint8_t* obj = (uint8_t*)sp[0];
    if (!RecvAllowed(POL_DAMAGE_CLIENT, R8(obj, 0x10), (uint32_t)R32(obj, 0x14), HOST_NUM)) {
        Log(L"test 7b: D1's receive rule refused it"); SpRelease((uint8_t*)sp[1]); return 0;
    }
    static uint8_t uid[16];
    *(int32_t*)(uid + 8) = 2;
    uintptr_t sender[2] = { (uintptr_t)uid, 0 };
    Log(L"test 7b: DamageClient %d bytes, weapon slot %d (id %d), damage %d: injected as player 2", n, wn, (int32_t)R8(w, 0x2b1),
        R32(obj, 0x2c));
    g_router(RP(g_gi, GI_STRIX_MGR), sender, sp);
    SpRelease((uint8_t*)sp[1]);
    return 1;
}

/* ---- the host's ScoreUpdate (DEATHMATCH_NATIVE.md 6.6) -----------------------------------------------------------
 * The host runs the score function natively; after it, the scorer's whole score list (TMap<u8, float> at plane+0xe08)
 * goes to the guest as a ScoreUpdate with absolute values, keyed to that plane, and the guest's own ScoreUpdate handler
 * sets it (SetScore, vf+0xc18). The message is the game's own (its metaclass's Create), its element array allocated with
 * the game's allocator (GMalloc, as Create itself does), since the message's destructor frees it. */
typedef void* (*MallocFn)(void* gm, uint64_t size, uint32_t align);
#define PLANE_SCORES 0xe08

static void* GMallocOf(void)
{
    /* the DamageClient Create (the metaclass's slot 3) starts push rbx; sub rsp, 0x20; mov rcx, [rip + GMalloc] */
    uint8_t* mc = g_dcMeta ? (uint8_t*)g_dcMeta() : NULL;
    uint8_t* cr = mc ? (uint8_t*)(*(void***)mc)[3] : NULL;
    if (!cr || !Readable(cr, 13) || cr[6] != 0x48 || cr[7] != 0x8B || cr[8] != 0x0D) return NULL;
    int32_t d; memcpy(&d, cr + 9, 4);
    return RP(cr + 13 + d, 0);
}

/* a ScoreUpdate keyed 2/keyId with the plane's score list; NULL when it can't be built (the caller deletes it) */
static uint8_t* BuildScoreUpdate(uint8_t* plane, uint32_t keyId)
{
    void* gm = GMallocOf();
    uint8_t* mc = g_suMeta ? (uint8_t*)g_suMeta() : NULL;
    if (!gm || !mc || !g_scoreDataVt) return NULL;
    uint8_t* set = plane + PLANE_SCORES;
    int32_t num = R32(set, 8), n = SetCount(set);
    if (num < 0 || num > 64 || n < 0 || n > 64) return NULL;
    uint8_t* m = (uint8_t*)((Obj1Fn)(*(void***)mc)[3])(mc);
    if (!m || ((Obj1Fn)(*(void***)m)[0])(m) != mc) return NULL;
    uint8_t* el = n ? (uint8_t*)((MallocFn)(*(void***)gm)[5])(gm, (uint64_t)n * 0x10, 8) : NULL;
    int32_t k = 0;
    for (int32_t i = 0; i < num && el && k < n; ++i) {
        uint8_t* e = SetSlot(set, i, 0x10);
        if (!e) continue;
        float v; memcpy(&v, e + 4, 4);
        memset(el + k * 0x10, 0, 0x10);
        *(void**)(el + k * 0x10) = g_scoreDataVt;
        el[k * 0x10 + 8] = e[0];
        *(int32_t*)(el + k * 0x10 + 0xc) = (int32_t)(v + (v >= 0 ? 0.5f : -0.5f));
        ++k;
    }
    struct { void* p; int32_t n, m; } arr = { el, k, n };
    memcpy(m + 0x20, &arr, sizeof(arr));
    *(int64_t*)(m + 0x08) = SyncedNow();
    m[0x10] = 2; *(uint32_t*)(m + 0x14) = keyId;
    return m;
}

/* one PC: the local plane's scores, as a ScoreUpdate keyed to the copy, through encode/decode and the router */
static int ScoreUpdateLoop(void)
{
    uint8_t* m = BuildScoreUpdate(g_lbLocal, (uint32_t)Peer());
    if (!m) { Log(L"ScoreUpdate: not built (allocator, metaclass or element vtable missing)"); return 0; }
    static uint8_t buf[LB_MAX];
    uint32_t n = LbEncode(m, buf, LB_MAX);
    int32_t entries = R32(m, 0x28);
    ((Obj2Fn)(*(void***)m)[2])(m, 1);
    uintptr_t sp[2];
    if (!n || !LbDecode(buf, n, sp)) { Log(L"ScoreUpdate: encode %d bytes / decode failed", n); return 0; }
    g_suBytes = (int32_t)n;
    static uint8_t uid[16];
    *(int32_t*)(uid + 8) = Peer();
    uintptr_t sender[2] = { (uintptr_t)uid, 0 };
    Log(L"ScoreUpdate: %d entries, %d bytes, keyed to the copy: injected (the guest's handler, standing in)", entries, n);
    g_router(RP(g_gi, GI_STRIX_MGR), sender, sp);
    SpRelease((uint8_t*)sp[1]);
    return 1;
}

static void HitStep(void)
{
    if (!g_cfg.hit || !g_cfg.lbRole3 || !g_lbReady || g_hitPhase >= 12) return;
    uint64_t t = GetTickCount64();
    if (g_hitPhase == 0) { g_hitPhase = 1; g_hitAt = t + 25000; return; }   /* (after the mirror's checks at 20 s) */
    if (t < g_hitAt) return;
    float maxhp; memcpy(&maxhp, g_lbCopy + PLANE_MAXHP, 4);
    if (g_hitPhase == 1) {                               /* a 30 % hit */
        LogHitState(L"before the first hit");
        g_hitHp0 = R32(g_lbCopy, PLANE_HP); g_hitScore0 = ScoreX10(g_lbLocal);
        float r = HitCopy(maxhp > 0 && maxhp < 1e6f ? maxhp * 0.3f : 10.0f);
        g_hitR1 = (int32_t)(r * 10.0f);
        g_hitHp1 = R32(g_lbCopy, PLANE_HP); g_hitScore1 = ScoreX10(g_lbLocal);   /* (guest: read again 3 s later) */
        Log(L"test 7: first hit: TakeDamage returned %d (x10)", g_hitR1);
        LogHitState(L"after the first hit");
        g_hitPhase = 2; g_hitAt = t + 3000;
    } else if (g_hitPhase == 2) {                        /* a lethal hit */
        if (g_cfg.guest) { g_hitHp1 = R32(g_lbCopy, PLANE_HP); g_hitScore1 = ScoreX10(g_lbLocal);
                           LogHitState(L"guest: 3 s after the first hit (the host stand-in applied it)"); }
        float lethal = (float)(R32(g_lbCopy, PLANE_HP) + R32(g_lbCopy, PLANE_SHIELD)) * 0.1f + 10.0f;
        float r = HitCopy(lethal);
        g_hitR2 = (int32_t)(r * 10.0f);
        g_hitHp2 = R32(g_lbCopy, PLANE_HP); g_hitScore2 = ScoreX10(g_lbLocal);
        Log(L"test 7: lethal hit (%d x10): TakeDamage returned %d (x10)", (int32_t)(lethal * 10.0f), g_hitR2);
        LogHitState(L"after the lethal hit");
        g_hitPhase = 3; g_hitAt = t + 6000;
    } else if (g_hitPhase == 3) {                        /* respawn the copy where it is */
        if (g_cfg.guest) { g_hitHp2 = R32(g_lbCopy, PLANE_HP); g_hitScore2 = ScoreX10(g_lbLocal); }
        LogHitState(L"before the respawn");
        double at[3] = { 0, 0, 0 }, rot[3] = { 0, 0, 0 };
        ActorLoc(g_lbCopy, at);
        RespawnFn rf = (RespawnFn)(*(void***)g_lbCopy)[0xbf8 / 8];
        rf(g_lbCopy, at, rot, 0);
        g_hitHp3 = R32(g_lbCopy, PLANE_HP);
        LogHitState(L"after the respawn");
        g_hitPhase = 4; g_hitAt = t + 7000;
    } else if (g_hitPhase == 4) {
        LogHitState(L"7 s after the respawn");
        g_hitPhase = 5;
    } else if (g_hitPhase == 5) {                        /* 7b: the guest's hit on the host, as a DamageClient */
        g_hit7bHp0 = R32(g_lbLocal, PLANE_HP); g_hit7bScore0 = ScoreX10(g_lbCopy);
        g_hit7bInjected = g_cfg.guest ? 0 : Inject7b();      /* (host only) */
        g_hitPhase = 6; g_hitAt = t + 2000;
    } else if (g_hitPhase == 6) {
        g_hit7bHp1 = R32(g_lbLocal, PLANE_HP); g_hit7bScore1 = ScoreX10(g_lbCopy);
        Log(L"test 7b: the local plane's health %d -> %d, the copy's score %d -> %d (x10)", g_hit7bHp0, g_hit7bHp1,
            g_hit7bScore0, g_hit7bScore1);
        g_hitPhase = 7;
    } else if (g_hitPhase == 7) {                        /* the host's ScoreUpdate, as the guest's handler applies it */
        g_suInjected = g_cfg.guest ? 0 : ScoreUpdateLoop();
        g_hitPhase = 8; g_hitAt = t + 1000;
    } else if (g_hitPhase == 8) {
        g_suLocal = ScoreX10(g_lbLocal); g_suCopy = ScoreX10(g_lbCopy);
        Log(L"ScoreUpdate: the local score %d, the copy's now %d (x10)", g_suLocal, g_suCopy);
        g_hitPhase = 9; g_hitAt = t + 2000;
    } else if (g_hitPhase == 9) {                        /* the local plane crashes: death and respawn relayed */
        float lethal = (float)(R32(g_lbLocal, PLANE_HP) + R32(g_lbLocal, PLANE_SHIELD)) * 0.1f + 10.0f;
        uint8_t ev[0x40];
        memset(ev, 0, sizeof(ev));
        ev[0x18] = 7;                                    /* crash damage: no attacker, no protection check */
        TakeDamageFn td = (TakeDamageFn)(*(void***)g_lbLocal)[0xa38 / 8];
        float r = td(g_lbLocal, lethal, ev, NULL, NULL);
        g_deathLocalHp = R32(g_lbLocal, PLANE_HP);
        Log(L"death relay: the local plane crashed (TakeDamage returned %d x10), its health %d", (int32_t)(r * 10.0f), g_deathLocalHp);
        g_hitPhase = 10; g_hitAt = t + 3000;
    } else if (g_hitPhase == 10) {                       /* the copy mirrored the death? (DestroyedLocation comes once the
                                                          * death sequence has played, about 6 s after the crash) */
        if (LoopedCount(L"FLiveMessageDestroyedLocation") < 1 && t < g_hitAt + 15000) return;
        if (!g_deathWait) { g_deathWait = 1; g_hitAt = t + 500; return; }   /* (its handler ran in the same pump) */
        g_deathWait = 0;
        g_deathCopyFlag = R8(g_lbCopy, 0x3c2e);
        LogHitState(L"death relay: the local plane's DestroyedLocation mirrored");
        g_hitPhase = 11; g_hitAt = t + 30000;             /* (the game's auto sortie respawns the local plane) */
    } else if (g_hitPhase == 11) {
        int32_t resp = SentCount(L"FLiveMessageRespawn");
        if (resp > 0 || t >= g_hitAt) {
            g_deathCopyHp = R32(g_lbCopy, PLANE_HP);
            g_deathLocalHp2 = R32(g_lbLocal, PLANE_HP);
            LogHitState(L"death relay: after the local respawn");
            Log(L"death relay: local health %d, copy health %d (x10); Respawn sent %d", g_deathLocalHp2, g_deathCopyHp, resp);
            if (resp > 0 && t < g_hitAt) { g_hitAt = t + 1500; g_hitPhase = 11; if (g_deathWait++ < 1) return; }
            g_hitPhase = 12;
        }
    }
}

/* ---- D3 / D4: the guest's half of the referee (DAMAGE_PATH.md B; guest=1) ---------------------------------------
 * D3: on the guest, a hit of its own plane on the host's copy is not applied here: AuthoritativeApply, when TakeDamage's
 * local branch calls it for that victim, becomes a FLiveMessageDamageClient (victim the host's plane 2/1, attacker the
 * guest 2/2) for the host, which applies it with its own handler and sends the Damage result back. Crash damage and any
 * other attacker on the host's copy are swallowed (the host decides those itself). D4: the guest's score function never
 * runs (the host's ScoreUpdate sets the scores). On one PC the DamageClient is handed to this PC's own DamageClient
 * handler as a stand-in for the host (the copy plays the host's plane), so the whole round trip runs in game. */
typedef void (*AuthApplyFn)(void* victim, void* info);
typedef void (*ScoreFnT)(void* victim, float dmg, void* attacker, uint8_t weaponId, uint8_t indirect);
typedef void (*InfoDtorFn)(void* info);
static AuthApplyFn g_origAuthApply;
static ScoreFnT    g_origScoreFn;
static InfoDtorFn  g_infoDtor;
static uint8_t*    g_tdLocalRet;
static volatile int32_t g_d3Taken, g_d3Swallowed, g_d4Blocked, g_d3Injected, g_suSent;
#define D3_RING 16
static struct { uint32_t n; uint8_t b[256]; } g_d3Ring[D3_RING];
static int32_t g_d3Count;

static uint8_t* BuildScoreUpdate(uint8_t* plane, uint32_t keyId);
static void OnScoreFn(void* victim, float dmg, void* attacker, uint8_t weaponId, uint8_t indirect)
{
    if (!g_cfg.loopback || (!g_cfg.guest && !g_cfg.hit) || (g_cfg.guest && !g_matchGuest)) {
        g_origScoreFn(victim, dmg, attacker, weaponId, indirect);                  /* (no RVNG match: the game's own) */
        return;
    }
    if (g_cfg.guest) { __sync_add_and_fetch(&g_d4Blocked, 1); return; }        /* D4 */
    g_origScoreFn(victim, dmg, attacker, weaponId, indirect);
    /* the host: the scorer's absolute scores for the guest (the link carries it; for now built and counted) */
    uint8_t* a = (uint8_t*)attacker;
    uint8_t* n = a ? RP(a, 0xed0) : NULL;
    uint64_t key = n ? R64(n, 0x28) : 0;
    if ((key >> 56) == 2 && (uint32_t)key != 0) {
        uint8_t* m = BuildScoreUpdate(a, (uint32_t)key);
        if (m) {
            static uint8_t buf[LB_MAX];
            uint32_t len = LbEncode(m, buf, LB_MAX);
            __sync_add_and_fetch(&g_suBuilt, 1);
            if (g_cfg.wire == 2 && len && LinkSendData(&g_link, buf, len, 1)) __sync_add_and_fetch(&g_suSent, 1);   /* (to the guest) */
            Log(L"ScoreUpdate (host): the scorer 2/%d's scores, %d entries, %d bytes, for the guest", (int32_t)(uint32_t)key,
                R32(m, 0x28), len);
            ((Obj2Fn)(*(void***)m)[2])(m, 1);
        }
    }
}

static void OnAuthApply(void* victim, void* infoP)
{
    uint8_t* v = (uint8_t*)victim;
    uint8_t* info = (uint8_t*)infoP;
    if (!g_cfg.guest || !g_cfg.loopback || (uint8_t*)__builtin_return_address(0) != g_tdLocalRet || !g_lbReady || R8(v, 0xed8) != 2 ||
        R64(RP(v, 0xed0), 0x28) != KEY_PLANE(HOST_NUM)) {
        g_origAuthApply(victim, infoP);
        return;
    }
    uint8_t type = info[4];
    if (type == 7 || type == 8 || type == 9 || RP(info, 8) != g_lbLocal || !g_dcMeta) {
        __sync_add_and_fetch(&g_d3Swallowed, 1);
        Log(L"D3: a hit on the host's plane (type %d, attacker %p) swallowed: the host decides it", (int32_t)type, RP(info, 8));
        g_infoDtor(infoP);
        return;
    }
    uint8_t* mc = (uint8_t*)g_dcMeta();
    uint8_t* m = mc ? (uint8_t*)((Obj1Fn)(*(void***)mc)[3])(mc) : NULL;
    if (m && ((Obj1Fn)(*(void***)m)[0])(m) == mc) {
        float dmg; memcpy(&dmg, info, 4);
        uint8_t wid = info[0x11];
        if (wid == 0x68) wid = 0x1b; else if (wid == 0x69) wid = 0x1a;          /* (BroadcastDamage's remap) */
        *(int64_t*)(m + 0x08) = SyncedNow();
        m[0x10] = 2; *(uint32_t*)(m + 0x14) = HOST_NUM;   /* victim: the host's plane */
        m[0x20] = 2; *(uint32_t*)(m + 0x24) = 2;          /* attacker: the guest's own key */
        m[0x28] = info[0x10]; m[0x29] = wid; m[0x2a] = type;
        *(int32_t*)(m + 0x2c) = (int32_t)(dmg + 1e-5f);
        m[0x30] = (uint8_t)((info[0x21] ? 1 : 0) | (info[0x22] ? 2 : 0) | (info[0x23] ? 8 : 0) | (info[0x24] ? 0x10 : 0));
        m[0x31] = info[0x20];
        if (g_d3Count < D3_RING) {
            uint32_t n = LbEncode(m, g_d3Ring[g_d3Count].b, sizeof(g_d3Ring[0].b));
            if (n) { g_d3Ring[g_d3Count].n = n; ++g_d3Count; }
        }
        __sync_add_and_fetch(&g_d3Taken, 1);
        Log(L"D3: the guest's hit on the host's plane (%d damage, type %d, weapon %d/%d) sent as a DamageClient", *(int32_t*)(m + 0x2c),
            (int32_t)type, (int32_t)m[0x28], (int32_t)wid);
        ((Obj2Fn)(*(void***)m)[2])(m, 1);
    }
    g_infoDtor(infoP);                                   /* (the callee owns the by-value info) */
}

/* wire 2: the guest's DamageClients go to the host over the link (reliable); on one PC (wire 0 / 1) this PC's
 * DamageClient handler stands in for the host (the copy is the host's plane here) */
static void D3Drain(uint8_t* sm)
{
    static uint8_t uid[16];
    if (g_cfg.wire == 2) {
        for (int32_t i = 0; i < g_d3Count; ++i)
            if (LinkSendData(&g_link, g_d3Ring[i].b, g_d3Ring[i].n, 1)) __sync_add_and_fetch(&g_d3Injected, 1);
        g_d3Count = 0;
        return;
    }
    for (int32_t i = 0; i < g_d3Count; ++i) {
        uintptr_t sp[2];
        if (!LbDecode(g_d3Ring[i].b, g_d3Ring[i].n, sp)) continue;
        *(int32_t*)(uid + 8) = 2;                            /* sent by the guest */
        uintptr_t sender[2] = { (uintptr_t)uid, 0 };
        g_router(sm, sender, sp);
        __sync_add_and_fetch(&g_d3Injected, 1);
        SpRelease((uint8_t*)sp[1]);
    }
    g_d3Count = 0;
}

static uintptr_t OnPump(uintptr_t sm, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{
    if (!g_cfg.loopback) return g_origPump(sm, b, c, d, e, f, g, h);             /* (no RVNG match: the game's own) */
    if (g_lbReady && !LbAlive()) LbDisarm(L"a plane or its network object changed");
    if (g_lbReady && g_physFill && !g_cfg.lbRole3) { g_physFill(g_lbLocalN, g_lbLocal + 0x2268); ++g_lbFills; }   /* (role 1: refresh) */
    if (g_lbReady && g_cfg.hit) HitStep();
    uintptr_t r = g_origPump(sm, b, c, d, e, f, g, h);
    if (g_lbReady && !g_lbDepth && g_lbCount) { g_lbDepth = 1; LbDrain((uint8_t*)sm); g_lbDepth = 0; }
    if (g_lbReady && !g_lbDepth && g_cfg.wire) {
        static uint8_t wb[LINK_MAX_MSG];
        int n;
        g_lbDepth = 1;
        if (g_cfg.wire == 1) {
            WireTickPair();
            while ((n = LinkRecvData(&g_lpB, wb, (int)sizeof(wb))) > 0) { __sync_add_and_fetch(&g_wireGot, 1); LbMirrorOne((uint8_t*)sm, wb, (uint32_t)n); }
        } else {
            while ((n = LinkRecvData(&g_link, wb, (int)sizeof(wb))) > 0) WireIn((uint8_t*)sm, wb, n);
        }
        g_lbDepth = 0;
    }
    if (g_lbReady && !g_lbDepth && g_d3Count) { g_lbDepth = 1; D3Drain((uint8_t*)sm); g_lbDepth = 0; }
    return r;
}

/* once a second (Watch): where the copy is against the mirror point */
static void LbWatch(int full)
{
    if (!g_lbReady) return;
    double a[3], b[3];
    if (!ActorLoc(g_lbLocal, a) || !ActorLoc(g_lbCopy, b)) return;
    double dx = b[0] - g_lbStart[0], dy = b[1] - g_lbStart[1], dz = b[2] - g_lbStart[2];
    g_lbMovedM = (int32_t)ISqrt((uint64_t)((dx * dx + dy * dy + dz * dz) / 10000));
    double ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
    int32_t sep = (int32_t)ISqrt((uint64_t)((ex * ex + ey * ey + ez * ez) / 10000));
    g_lbErrM = sep > g_cfg.lbOff / 100 ? sep - g_cfg.lbOff / 100 : g_cfg.lbOff / 100 - sep;
    if (!full) return;
    Log(L"test 4: sends %d (off thread %d), Physics captured %d (largest %d bytes), injected %d, applied %d, ring %d, overflow %d, enc fail %d, dec fail %d, fills %d",
        g_lbSends, g_lbOffThread, g_lbCaptured, g_lbBytesMax, g_lbInjected, g_lbApplied, g_lbCount, g_lbOverflow, g_lbEncFail,
        g_lbDecFail, g_lbFills);
    Log(L"test 4: the synced clock against Physics TriggerTimes: last %d ms, largest %d ms (%d samples)", g_clockSkewMs,
        g_clockSkewMaxMs, g_clockSamples);
    Log(L"test 4: local at (%d, %d, %d) m, copy at (%d, %d, %d) m: %d m apart (mirror %d m ahead), the copy %d m from its start",
        (int32_t)(a[0] / 100), (int32_t)(a[1] / 100), (int32_t)(a[2] / 100), (int32_t)(b[0] / 100), (int32_t)(b[1] / 100),
        (int32_t)(b[2] / 100), sep, g_cfg.lbOff / 100, g_lbMovedM);
}

static void LbClasses(void)
{
    for (int32_t i = 0; i < g_lbNCls; ++i)
        Log(L"  sent class %x \"%s\": %d, D1 would relay %d (policy %d)", g_lbCls[i].id, g_lbCls[i].name, g_lbCls[i].n,
            g_lbCls[i].relay, g_lbCls[i].pol);
}

/* Runs before the game enters state `to` (SetState writes GM+0x758 and then tail-jumps to that state's Enter;
 * NextState calls SetState, so every change passes here). The test steps that must be in place before a state's Enter
 * runs hang off this. */
static void BeforeState(uint8_t* gm, int32_t from, int32_t to)
{
    (void)gm; (void)from;
    if (to == 3 && g_oppArmed && g_cfg.opponent && g_gi) FillOpponent();
    if (to == 3 && g_cfg.faction && g_gi) ApplyFaction(RP(g_gi, GI_NM), L"before state 3");
}

/* ---- detours ------------------------------------------------------------ */
static Fn8 g_origGate[GATE_N], g_origPhase, g_origSetState, g_origNextState, g_origTransition, g_origChangeMap;

static uintptr_t Gate(int which, uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h,
                      void* ret)
{
    static const wchar_t* const kNames[GATE_N] = {
        L"A", L"B", L"user data (D9: Aircrafts, Notifications, Rankings ...)", L"lobbies and mails (D9)", L"items (D9)",
        L"guilds (D9)", L"master data (D9)", L"friends (D9)", L"settings (D9)", L"blocks (D9)", L"currencies (D9)",
    };
    uint8_t game = (uint8_t)g_origGate[which](a, b, c, d, e, f, g, h);  /* (it only caches GI+0x970 and reads a field) */
    int32_t n = __sync_add_and_fetch(&g_gateCalls[which], 1);
    if (game) __sync_add_and_fetch(&g_gateTrue[which], 1);
    if (n <= 20 || (game && g_gateTrue[which] <= 20) || (n & (n - 1)) == 0)   /* (then at powers of 2: the master-data
                                                                                  * gate is asked every frame, 2026-11-19) */
        Log(L"web gate %s call %d from exe+%x: the game's gate answered %d%s", kNames[which], n,
            (uint32_t)((uint8_t*)ret - g_exe), (int32_t)game,
            L", RVNG answered 0");
    if (which == GATE_B && g_slGateRet && (uint8_t*)ret == g_slGateRet) {
        __sync_add_and_fetch(&g_slRefused, 1);
        if (g_cfg.d7 && !g_slPend) { g_slGac = (uint8_t*)a; g_slPend = 1; }
        Log(L"StartLogin's gate-B call refused (GAC %p)%s", (void*)a,
            g_cfg.d7 ? L": D7 ends the login as failed on the next watch" : L": its callback stays waiting (d7=0)");
    }
    return 0;                                          /* D5: never the game's answer (no request leaves) */
}
static uintptr_t OnGateA(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ return Gate(0, a, b, c, d, e, f, g, h, __builtin_return_address(0)); }
static uintptr_t OnGateB(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ return Gate(1, a, b, c, d, e, f, g, h, __builtin_return_address(0)); }
#define GATE_THUNK(i)     static uintptr_t OnGate##i(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g,                                uintptr_t h) { return Gate(i, a, b, c, d, e, f, g, h, __builtin_return_address(0)); }
GATE_THUNK(2) GATE_THUNK(3) GATE_THUNK(4) GATE_THUNK(5) GATE_THUNK(6) GATE_THUNK(7) GATE_THUNK(8) GATE_THUNK(9) GATE_THUNK(10)
#undef GATE_THUNK
static const Fn8 kGateDetour[GATE_N] = {
    OnGateA, OnGateB, OnGate2, OnGate3, OnGate4, OnGate5, OnGate6, OnGate7, OnGate8, OnGate9, OnGate10,
};

/* ---- D8: the game's own cheat reports switched off (every install, 0.3.5; DEATHMATCH_NATIVE.md 9.9) ----------------
 * ReportCheat (0x1474b8bb0) sends a Cheat message, votes and, online, records the type for the match-end web report.
 * D1, D5 and the never-set online flags already keep all three from leaving the PC; D8 stops them at the source, so
 * nothing is made at all. Type 1 (client_eac_kick) comes from the game's anti-cheat manager: it is handed to the game
 * untouched, so RVNG stays out of anything anti-cheat (it can't fire in a modded game, which runs no anti-cheat). */
typedef void (*ReportCheatFn)(void* nm, int32_t id, uint8_t type, void* arg);
static ReportCheatFn g_origReportCheat;
static volatile int32_t g_cheatOff, g_cheatPassed, g_cheatByType[10];
static const wchar_t* const kCheatNames[10] = {
    L"none", L"client_eac_kick", L"client_npc_location", L"client_player_location", L"client_damage",
    L"client_weapon_cooltime", L"client_weapon_ammo", L"client_weapon_id", L"client_weapon_location", L"client_combat_zone",
};
static void OnReportCheat(void* nm, int32_t id, uint8_t type, void* arg)
{
    if (type < 10) __sync_add_and_fetch(&g_cheatByType[type], 1);
    if (type == 1) {
        __sync_add_and_fetch(&g_cheatPassed, 1);
        Log(L"D8: a cheat report of type 1 (client_eac_kick) left to the game");
        if (g_origReportCheat) g_origReportCheat(nm, id, type, arg);
        return;
    }
    int32_t n = __sync_add_and_fetch(&g_cheatOff, 1);
    if (n <= 5 || n % 50 == 0)
        Log(L"D8: cheat report %d (type %d, %s, id %d) switched off: no Cheat message, no vote, no record", n, (int32_t)type,
            type < 10 ? kCheatNames[type] : L"unknown", id);
}

/* ---- D9: the network wall (every install, 0.3.6; docs/re/ONLINE_UI.md 5, DEATHMATCH_NATIVE.md 9.10) ---------------
 * D5 shut the two web gates a session asks; D9 shuts the places every request to Bandai's services is sent from, so a
 * code path no test has walked (a screen, a timer, a Blueprint) can't reach them either:
 *   the LiveWebAPI queue's element start   every LiveWebAPI request (111 endpoints), dropped as the game's own "no request"
 *   Cosmos's sender                       all 20 Cosmos web APIs (login, telemetry, NG-word checks, purchases), "not sent"
 *   the engine's HTTP request start       every engine HTTP request: failed through the engine's own empty-URL path
 *   the WebSocket client connect          the matchmaker's WebSocket: the caller's "could not connect" path
 *   the game's Strix and Messenger set-up never made, so Strix and the Messenger stay as offline
 * and the other nine gates answer false like A and B. Measured before D9 (2026-11-19, tools/autotest/netwatch.py and
 * netlog.h): a whole session reaches none of these; the only outside contact is the EOS SDK's own (not the game's code). */
enum { W_LWA, W_COSMOS, W_HTTP, W_WS, W_STRIX, W_MESSENGER, W_N };
static volatile int32_t g_wallIn, g_wallGatesIn, g_wallRefused[W_N];
static volatile int32_t g_lwaQueued = -1;        /* the test logger's AddRequest count (-1: not hooked) */
static uint8_t* g_curlProcessFn;                  /* FCurlHttpRequest::ProcessRequest, to know its vtable */
typedef uint8_t (*CurlProcessFn)(void* req);
static CurlProcessFn g_origCurlProcess;
static void* g_origWall[W_N];                     /* (trampolines; only the HTTP one is ever called) */
static Fn8 g_origLwaAdd;

/* the count of this refusal, or 0 when it isn't logged (the first 20, then every 100th) */
static int32_t WallCount(int w)
{
    int32_t n = __sync_add_and_fetch(&g_wallRefused[w], 1);
    return n <= 20 || n % 100 == 0 ? n : 0;
}

/* a URL for the log: up to its query (which can hold a token), at most cap - 1 characters */
static const wchar_t* UrlText(const wchar_t* in, wchar_t* out, size_t cap)
{
    size_t k = 0;
    for (; in[k] && in[k] != L'?' && in[k] != L'#' && k < cap - 1; ++k) out[k] = in[k];
    out[k] = 0;
    return k ? out : L"no URL";
}
static const wchar_t* FUrlText(const FString* f, wchar_t* out, size_t cap)
{
    wchar_t tmp[256];
    return UrlText(FStringText(f, tmp, 256), out, cap);
}
/* a C string from the game's memory (ASCII), checked page by page */
static const wchar_t* CText(const char* p, wchar_t* out, size_t cap)
{
    size_t k = 0;
    for (; p && k < cap - 1; ++k) {
        if ((k == 0 || (((uintptr_t)(p + k)) & 0xFFF) == 0) && !Readable(p + k, 1)) break;
        char ch = p[k];
        if (!ch) break;
        out[k] = (wchar_t)(uint8_t)ch;
    }
    out[k] = 0;
    return out;
}

static uint32_t OnLwaStart(uint8_t* elem)
{
    int32_t type = -1;
    if (Readable(elem, LWA_ELEM_DONE + 1)) {
        type = *(int32_t*)(elem + LWA_ELEM_TYPE);
        elem[LWA_ELEM_STARTED] = 1; elem[LWA_ELEM_DONE] = 0;   /* as the game's own exit for an element with no request */
    }
    int32_t n = WallCount(W_LWA);
    if (n) {
        wchar_t name[96];
        Log(L"D9: LiveWebAPI request %d (%s, type %d) dropped at its start: no HTTP request, no callback", n,
            FStringText((const FString*)(elem + LWA_ELEM_NAME), name, 96), type);
    }
    return LWA_NO_REQUEST;
}

static uint8_t OnCosmosSend(void* self, const FString* url, void* body)
{
    (void)self; (void)body;
    int32_t n = WallCount(W_COSMOS);
    if (n) { wchar_t u[128]; Log(L"D9: Cosmos web API call %d (%s) refused: not sent", n, FUrlText(url, u, 128)); }
    return 0;
}

static uint8_t OnCurlProcess(uint8_t* req)
{
    void** vt = Readable(req, 8) ? *(void***)req : NULL;
    int known = vt && Readable(vt + CURL_VT_PROCESS, 8) && vt[CURL_VT_PROCESS] == (void*)g_curlProcessFn &&
                Readable(req + CURL_URL, sizeof(FString));
    FString* url = (FString*)(req + CURL_URL);
    int32_t n = WallCount(W_HTTP);
    if (n) {
        wchar_t u[128];
        Log(L"D9: engine HTTP request %d (%s) refused: %s", n, known ? FUrlText(url, u, 128) : L"?",
            known ? L"failed through the engine's own empty-URL path (a failure callback, nothing sent)"
                  : L"not a request as known, so returned unsent (no callback)");
    }
    if (!known || !g_origCurlProcess) return 0;
    url->num = 0;                                      /* PreProcess fails it before anything is queued or resolved */
    return g_origCurlProcess(req);
}

static void* OnLwsConnect(uint8_t* info)
{
    int32_t n = WallCount(W_WS);
    if (n) {
        wchar_t a[96], p[96];
        int ok = Readable(info, LWS_INFO_PATH + 8);
        Log(L"D9: WebSocket connect %d (%s:%d%s) refused: the caller's \"could not connect\" path", n,
            ok ? CText(*(const char**)(info + LWS_INFO_ADDRESS), a, 96) : L"?", ok ? *(int32_t*)(info + LWS_INFO_PORT) : 0,
            ok ? CText(*(const char**)(info + LWS_INFO_PATH), p, 96) : L"");
    }
    return NULL;
}

static void OnStrixInit(void* sm)
{
    (void)sm;
    int32_t n = WallCount(W_STRIX);
    if (n) Log(L"D9: the game's Strix start %d refused: no Strix client, no master server (as offline)", n);
}

static void OnMessengerInit(void* m)
{
    (void)m;
    int32_t n = WallCount(W_MESSENGER);
    if (n) Log(L"D9: the game's Messenger set-up %d refused: no Messenger client, so its connect returns at once", n);
}

/* the test logger: every LiveWebAPI request queued (the game's own AddRequest runs; Start drops it) */
static uintptr_t OnLwaAdd(uintptr_t lwa, uintptr_t sender, uintptr_t name, uintptr_t flag, uintptr_t e, uintptr_t f,
                          uintptr_t g, uintptr_t h)
{
    int32_t n = __sync_add_and_fetch(&g_lwaQueued, 1);
    if (n <= 50 || n % 100 == 0) {
        wchar_t w[96];
        Log(L"D9 logger: LiveWebAPI request %d queued: %s (from exe+%x)", n, FStringText((const FString*)name, w, 96),
            (uint32_t)((uint8_t*)__builtin_return_address(0) - g_exe));
    }
    return g_origLwaAdd(lwa, sender, name, flag, e, f, g, h);
}

static uintptr_t OnPhaseGate(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{
    static int32_t last = -1;
    int32_t n = __sync_add_and_fetch(&g_phaseCalls, 1);
    int32_t r;
    if (g_cfg.d2 && g_cfg.wire) {
        r = WireGate();
        if (last != r) Log(L"D2: phaseIndex gate call %d answered %d by the wire's agreed start", n, r);
    } else if (g_cfg.d2) {
        r = 1;
        if (last != r) Log(L"D2: phaseIndex gate call %d answered 1 by RVNG (solo release)", n);
    } else {
        r = (uint8_t)g_origPhase(a, b, c, d, e, f, g, h);
        if (last != r && LIVE()) Log(L"phaseIndex gate call %d: the game answered %d", n, r);
    }
    last = r;
    return (uintptr_t)r;
}

static uintptr_t OnSetState(uintptr_t gm, uintptr_t st, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{
    uint8_t* p = (uint8_t*)gm;
    if (!LIVE()) { if (p != g_gm) { g_gm = p; g_gmVt = RP(p, 0); } return g_origSetState(gm, st, c, d, e, f, g, h); }
    int32_t from = R8(p, GM_STATE);
    if (p != g_gm) { g_gm = p; g_gmVt = RP(p, 0); Log(L"game mode %p (vtable exe+%x)", p, (uint32_t)((uint8_t*)g_gmVt - g_exe)); }
    Log(L"SetState(%d) called from exe+%x", (int32_t)(uint8_t)st, (uint32_t)((uint8_t*)__builtin_return_address(0) - g_exe));
    BeforeState(p, from, (int32_t)(uint8_t)st);
    uintptr_t r = g_origSetState(gm, st, c, d, e, f, g, h);
    AfterState(p, L"SetState", from);
    return r;
}

static uintptr_t OnNextState(uintptr_t gm, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{
    uint8_t* p = (uint8_t*)gm;
    if (!LIVE()) { if (p != g_gm) { g_gm = p; g_gmVt = RP(p, 0); } return g_origNextState(gm, b, c, d, e, f, g, h); }
    int32_t from = R8(p, GM_STATE);
    if (p != g_gm) { g_gm = p; g_gmVt = RP(p, 0); Log(L"game mode %p (vtable exe+%x)", p, (uint32_t)((uint8_t*)g_gmVt - g_exe)); }
    uintptr_t r = g_origNextState(gm, b, c, d, e, f, g, h);
    AfterState(p, L"NextState", from);
    return r;
}

static uintptr_t OnTransition(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{
    uint8_t* udm = g_gi ? RP(g_gi, GI_UDM) : NULL;
    int32_t f38 = R32(udm, 0xf38), f3c = R32(udm, 0xf3c);
    Log(L"transition (exe+%x): UDM+0xf38 %d, +0xf3c %d, +0xf60 %d%s", (uint32_t)((uint8_t*)__builtin_return_address(0) - g_exe),
        f38, f3c, (int32_t)R8(udm, 0xf60), g_armed ? L" [RVNG test armed]" : L"");
    if (g_armed && udm) {
        if (f38 != g_cfg.mission) Log(L"  armed, but +0xf38 is %d, not %d: the game changed it after Ctrl+F6", f38, g_cfg.mission);
        if (f3c >= 19 && f3c <= 49) {
            int ok = W32(udm, 0xf3c, g_cfg.f3c);
            Log(L"  +0xf3c %d is a campaign level: set to %d so type 9 travels by MissionID%s", f3c, g_cfg.f3c, ok ? L"" : L" (NOT WRITABLE)");
        }
        g_armed = 0;
    }
    uintptr_t r = g_origTransition(a, b, c, d, e, f, g, h);
    Log(L"transition returned %p", (void*)r);
    return r;
}

/* D6 (the Result map half): the online Result map crashes offline. In the run of 2026-11-18 18:35 it divided 5590 by a
 * count from 0x14771a280 (date and season data from UDM+0xfb0's GeneralAPIController and a table) that is 0 offline:
 * EXCEPTION_INT_DIVIDE_BY_ZERO at 0x147725a84, 3 s after Ended's travel (0x1471c5d20 +0xb18). With d6=1 that travel
 * goes to the main menu instead, through the same RequestChangeMap with the main menu's own path (an FSoftObjectPath:
 * two FNames and an empty FString), kept from the game's own request at boot. */
static const wchar_t kMainMenuMap[] = L"/Game/Maps/Menu/PL_MainMenu";
static const wchar_t kResultMap[]   = L"/Game/OnlineMode/Maps/Menu/Result";
static uint64_t g_menuPath[4];        /* the main menu's FSoftObjectPath: PackageName, AssetName, empty SubPath */
static int      g_haveMenuPath;
static volatile int32_t g_resultRedirects;
static wchar_t  g_matchMap[256];      /* an armed match's deathmatch map (its own travel; any other map ends the match) */
static uint64_t g_matchEndAt;         /* GetTickCount64 when the armed match is disarmed (0: not yet asked) */


static uintptr_t OnChangeMap(uintptr_t mcm, uintptr_t path, uintptr_t opts, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{
    static wchar_t pkg[256], asset[128], op[256];
    NameText((const FNameRaw*)path, pkg, 256);
    NameText((const FNameRaw*)(path + 8), asset, 128);
    FStringText((const FString*)opts, op, 256);
    __sync_add_and_fetch(&g_mapRequests, 1);
    if (g_lbReady) LbDisarm(L"a map change");
    Log(L"RequestChangeMap from exe+%x: %s.%s options \"%s\"", (uint32_t)((uint8_t*)__builtin_return_address(0) - g_exe), pkg, asset, op);
    if (!g_haveMenuPath && WEq(pkg, kMainMenuMap) && Readable((void*)path, 16)) {
        memset(g_menuPath, 0, sizeof(g_menuPath));
        memcpy(g_menuPath, (void*)path, 16);            /* the two FNames; the SubPath FString stays empty */
        g_haveMenuPath = 1;
    }
    if (g_matchOn && !g_matchEndAt && g_matchMap[0] && !WEq(pkg, g_matchMap)) {
        g_matchEndAt = GetTickCount64() + 8500;          /* (after the room tables' cleanup at 8 s) */
        Log(L"match: the travel away from the deathmatch: the match hooks go back to passing the game's calls on in 8.5 s");
    }
    if (g_cfg.d6 && WEq(pkg, kResultMap)) {
        if (g_haveMenuPath) {
            __sync_add_and_fetch(&g_resultRedirects, 1);
            Log(L"D6: the Result map crashes offline: the main menu instead");
            if (g_oppFilled && !g_oppCleaned && !g_oppCleanAt) g_oppCleanAt = GetTickCount64() + 8000;
            memcpy(g_lastMap, kMainMenuMap, sizeof(kMainMenuMap));
            return g_origChangeMap(mcm, (uintptr_t)g_menuPath, opts, d, e, f, g, h);
        }
        Log(L"D6: no main menu path kept (no main menu since the start?): the Result map goes ahead");
    }
    memcpy(g_lastMap, pkg, sizeof(g_lastMap));
    if (g_oppFilled && !g_oppCleaned && !g_oppCleanAt) g_oppCleanAt = GetTickCount64() + 8000;
    return g_origChangeMap(mcm, path, opts, d, e, f, g, h);
}

/* ---- the lost link (DEATHMATCH_NATIVE.md 6.6, 9.8): the forced end ------------------------------------------------
 * When the other PC goes silent in GamePlaying (14), RVNG ends the match the way Bandai's server does: the game mode's
 * RecvPreparingMissionEnd (vf+0xdd0, 0x1471cb7e0)(gm, memberId, coopResult, matchResult) acts only when memberId is the
 * local one (0 offline; 0x1471cb91c) and GM+0x521 (vf+0xb80, "finishing") is 0; it then sets +0x804 from the ARGUMENT flags
 * (2 Finished if either is set, else 1 Aborted) and +0x538 = 4, then OnGameFinish (run of 2026-11-19 04:52: memberId 1
 * did nothing). Finished (>= 105 s played) runs
 * on through W1 and D6 to the main menu; Aborted takes the game's AbortPath to the online lobby, which D6 does not
 * redirect yet, so only Finished is used (test switch linkloss=N, N >= 105). */
typedef void (*ForcedEndFn)(void* gm, int32_t memberId, uint8_t coop, uint8_t match);
static const uint8_t kGmForcedEndHead[16] = { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x6C, 0x24, 0x18, 0x48, 0x89, 0x74, 0x24, 0x20, 0x57 };
static volatile int32_t g_llFired, g_ll804 = -1, g_ll538 = -1, g_llAtS = -1;

static void MatchStatsTick(void);          /* (matchstats.h: the deaths, for the leaderboard) */
static void LinkLossCheck(uint8_t* gm)
{
    if (g_llFired || !gm || R8(gm, GM_STATE) != 14 || !g_s14At) return;
    uint64_t now = GetTickCount64();
    if (g_cfg.wire) {                                              /* the link says when it is lost */
        if (g_cfg.wire == 1 && g_cfg.linkloss && !g_wireCut && now - g_s14At >= (uint64_t)g_cfg.linkloss * 1000) {
            g_wireCut = 1;
            Log(L"wire 1: the wire cut %d s into GamePlaying (the lost-link test): the link's own detection follows", g_cfg.linkloss);
        }
        Link* L = WireMine();
        if (!L || L->state != LS_LOST) return;
        Log(L"wire %d: the link is lost (no message for %d s)", g_cfg.wire, (int32_t)(LINK_LOST_US / 1000000));
    } else {
        if (!g_cfg.linkloss || now - g_s14At < (uint64_t)g_cfg.linkloss * 1000) return;
    }
    g_llFired = 1;
    int32_t played = (int32_t)((now - g_s14At) / 1000);
    g_llAtS = played;
    if (played < 105) { Log(L"lost link at %d s: Aborted would take the online lobby path (not redirected yet): not forced", played); return; }
    void** vt = *(void***)gm;
    uint8_t* f = vt && Readable(vt + 0xdd0 / 8, 8) ? (uint8_t*)vt[0xdd0 / 8] : NULL;
    if (!f || !InGame(f) || !Readable(f, 16) || memcmp(f, kGmForcedEndHead, 16)) { Log(L"lost link: the game mode's forced end is not as expected: not forced"); return; }
    Log(L"lost link at %d s into GamePlaying: the forced end (Finished), as Bandai's server would send it", played);
    ((ForcedEndFn)(void*)f)(gm, 0, 0, 1);
    g_ll804 = R32(gm, 0x804); g_ll538 = (int32_t)R8(gm, 0x538);
    Log(L"lost link: +0x804 %d (2 Finished), +0x538 %d (4 forced), state %d", g_ll804, g_ll538, (int32_t)R8(gm, GM_STATE));
}

/* ---- the watch (test 1), once a second from Lua on the game thread ------ */
static wchar_t g_line[1024], g_lastLine[1024];
static size_t  g_lineLen;

static void Cat(const wchar_t* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    VFmt(g_line + g_lineLen, sizeof(g_line) / 2 - g_lineLen, fmt, ap);
    va_end(ap);
    g_lineLen += WLen(g_line + g_lineLen);
}

/* D7, on the game thread (the watch), after the refused StartLogin has returned (firing inside the gate's detour would
 * re-enter the platform strategy's task 7). Only the boot authenticator's login is ended: same GAC, result still
 * pending (-1), mode 0 (path A passes 1), a bound callback with the task-7 vtable. FinishLogin(GAC, 1) then runs the
 * callback with ok = false; no login is faked (the login status UDM+0xfb8->+0x88 stays 0) and no gate is opened.
 * One try per refusal, at most 2 per process. 1 ended, 0 not. */
static int EndRefusedLogin(uint8_t* udm)
{
    if (!g_slPend) return 0;
    g_slPend = 0;
    uint8_t* gac  = RP(udm, UDM_GAC);
    uint8_t* inst = RP(gac, 0xd8);
    void* vt = RP(inst, 0);
    int32_t res = R32(gac, 0x194), mode = R32(gac, 0x138), bound = R32(gac, 0xe0);
    int32_t status = R32(RP(udm, UDM_LOGIN_DATA), 0x88);
    Log(L"D7: login stall: GAC %p (refused one %p) result %d mode %d bound %d callback %p vtable exe+%x; login status %d",
        gac, g_slGac, res, mode, bound, inst, vt ? (uint32_t)((uint8_t*)vt - g_exe) : 0, status);
    if (!g_finishLogin || !g_task7CbVt) {
        Log(L"D7: not ready (a signature missing): left alone");
        return 0;
    }
    if (!gac || gac != g_slGac || res != -1 || mode != 0 || bound == 0 || !inst || vt != g_task7CbVt) {
        Log(vt && vt == g_pathACbVt ? L"D7: the waiting callback is the startup part manager's (path A): left alone"
                                     : L"D7: not the boot authenticator's login: left alone");
        return 0;
    }
    if (g_slEnded >= 2) { Log(L"D7: already ended twice in this process: left alone"); return 0; }
    g_slEnded++;
    Log(L"D7: FinishLogin(GAC, 1), the game's own login-failed exit (%d)", g_slEnded);
    g_finishLogin(gac, 1);
    Log(L"D7: FinishLogin returned: result %d bound %d; login status %d", R32(gac, 0x194), R32(gac, 0xe0),
        R32(RP(udm, UDM_LOGIN_DATA), 0x88));
    return 1;
}

/* 0 all as expected, 1 a "stay offline" value is not zero, -1 the logger is off */
static int Watch(uint8_t* gi)
{
    static uint64_t lastFull;
    if (!g_cfg.probe) return -1;
    WireTickPair();                                               /* (wire 1: also between the gate and state 14) */
    if (g_cfg.wire == 2 && g_link.state == LS_OFF) {              /* the two-PC link, once Steam is there */
        static int tries;
        if (tries++ % 5 == 0 && LinkStartSteam(g_cfg.linkPeer, g_cfg.linkPlayer, LinkTagOf(g_cfg.linkTag, WLenA(g_cfg.linkTag)), "RVNG"))
            Log(L"wire 2: the link to the other PC started (this PC player %d)", g_cfg.linkPlayer);
    }
    if (gi && Readable(gi, GI_WEBAPI + 8)) g_gi = gi;
    gi = g_gi;
    uint8_t* sm  = gi ? RP(gi, GI_STRIX) : NULL;
    uint8_t* p2p = gi ? RP(gi, GI_P2P) : NULL;
    uint8_t* udm = gi ? RP(gi, GI_UDM) : NULL;
    uint8_t* nm  = gi ? RP(gi, GI_NM) : NULL;
    if (udm) EndRefusedLogin(udm);
    if (g_oppCleanAt && GetTickCount64() >= g_oppCleanAt) { g_oppCleanAt = 0; CleanupOpponent(L"8 s after the travel"); }
    if (!g_gameThread) g_gameThread = GetCurrentThreadId();
    { static uint64_t lbLast; uint64_t t = GetTickCount64(); int full = t - lbLast >= 10000; if (full) lbLast = t; LbWatch(full); }
    void* client = g_clientGlobal ? RP(g_clientGlobal, 0) : NULL;
    uint8_t f8 = R8(sm, 0x1f8), f9 = R8(sm, 0x1f9), fa = R8(sm, 0x1fa);
    uint64_t p28 = R64(p2p, 0x28);
    g_lineLen = 0;
    Cat(L"gi %s | client %p | SM %s 1f8 %d 1f9 %d 1fa %d +30 %p | P2P+28 %p | webapi %p | UDM+12a0 %p +fb0 %p f38 %d f3c %d",
        gi ? L"ok" : L"none", client, sm ? L"ok" : L"none", (int32_t)f8, (int32_t)f9, (int32_t)fa, RP(sm, 0x30), (void*)(uintptr_t)p28,
        gi ? RP(gi, GI_WEBAPI) : NULL, RP(udm, 0x12a0), RP(udm, 0xfb0), R32(udm, 0xf38), R32(udm, 0xf3c));
    Cat(L" | NM+538 %d +610 %d +614 %d", R32(nm, 0x538), RMilli(nm, 0x610), RMilli(nm, 0x614));
    uint8_t* gm = LiveGM();
    if (gm) Cat(L" | GM state %d", (int32_t)R8(gm, GM_STATE));
    LinkLossCheck(gm);
    MatchStatsTick();                              /* (the test logger's suites count deaths too) */
    int bad = client || f8 || f9 || fa || p28;
    uint64_t now = GetTickCount64();
    int changed = memcmp(g_line, g_lastLine, (g_lineLen + 1) * 2) != 0;
    if (changed || now - lastFull >= (uint64_t)g_cfg.fullEvery * 1000) {
        Log(L"watch: %s%s", g_line, changed ? L"" : L" (same)");
        if (bad) Log(L"watch: NOT OFFLINE: a Strix flag, the client global or the EOS P2P object is set");
        if (gm) LogGM(L"watch GM", gm);
        if (gm && g_oppFilled && !g_oppCleaned && R8(gm, GM_STATE) == 14) LogPlanes(gm, 14);
        Log(L"watch: web gate calls A %d (game true %d), B %d (game true %d), phaseIndex gate calls %d; StartLogin refused %d, D7 ended %d",
            g_gateCalls[0], g_gateTrue[0], g_gateCalls[1], g_gateTrue[1], g_phaseCalls, g_slRefused, g_slEnded);
        {
            int32_t asked = 0, yes = 0;
            for (int i = GATE_USER; i < GATE_N; ++i) { asked += g_gateCalls[i]; yes += g_gateTrue[i]; }
            Log(L"watch: D9 refused web API %d, Cosmos %d, HTTP %d, WebSocket %d, Strix %d, Messenger %d; the 9 more gates asked %d (game true %d); queued %d",
                g_wallRefused[W_LWA], g_wallRefused[W_COSMOS], g_wallRefused[W_HTTP], g_wallRefused[W_WS],
                g_wallRefused[W_STRIX], g_wallRefused[W_MESSENGER], asked, yes, g_lwaQueued);
        }
        memcpy(g_lastLine, g_line, (g_lineLen + 1) * 2);
        lastFull = now;
    }
    return bad;
}

/* Ctrl+F6: arm the solo deathmatch sortie (test 2). The pilot then presses Sortie in the hangar. */
static int ArmDM(void)
{
    if (!g_cfg.probe) { Log(L"Ctrl+F6: the test logger is off (rvng_test.ini)"); return 0; }
    uint8_t* udm = g_gi ? RP(g_gi, GI_UDM) : NULL;
    uint8_t* nm  = g_gi ? RP(g_gi, GI_NM) : NULL;
    if (!udm) { Log(L"Ctrl+F6: no UserDataManager yet"); return 0; }
    int32_t was38 = R32(udm, 0xf38), was538 = R32(nm, 0x538);
    int ok = W32(udm, 0xf38, g_cfg.mission);
    if (nm) W32(nm, 0x538, 0);
    g_armed = ok;
    Log(L"Ctrl+F6: armed the solo deathmatch test: UDM+0xf38 %d -> %d, +0xf3c %d, +0xf60 %d, NM+0x538 %d -> 0%s",
        was38, g_cfg.mission, R32(udm, 0xf3c), (int32_t)R8(udm, 0xf60), was538, ok ? L"" : L" (NOT WRITABLE)");
    return ok;
}

/* The self-test's fast path to the deathmatch (tools/autotest): the game's own mission-by-ID travel, as the menu
 * transition's default branch does it (0x147570f51..0x1475710d8 in the 2026-11-02 build): UDM+0xf38 = the MissionID,
 * NM+0x538 cleared (the stale-error hazard), row = LevelRow(GI+0x878, id), RequestChangeMap(GI+0x888, &row+0x48, an
 * empty FString, scratch, ..., an empty struct as the 7th argument), then the NetworkManager prepare step. Game thread
 * only (Lua's tick). 1 travel requested, 0 not (logged why). In a normal install (probe=0) it is the ready-up screen's
 * launch: it arms the match first (MatchArm). */

/* what one match changes, back to the start: a second match in the same session runs like the first */
static void MatchStatsReset(void);         /* (matchstats.h) */
static void MatchReset(void)
{
    MatchStatsReset();
    if (g_oppFilled && !g_oppCleaned) CleanupOpponent(L"before the next match");
    g_oppFilled = 0; g_oppCleaned = 0; g_oppCleanAt = 0; g_oppSlot = -1; g_oppSpawns = 0;
    g_wireReleased = 0; g_wireCut = 0; g_clockApplied = 0; g_clockDeltaMs = -1;
    g_llFired = 0; g_ll804 = -1; g_ll538 = -1; g_llAtS = -1; g_s14At = 0;
    g_d3Count = 0;
}

static void MatchDisarm(const wchar_t* why)
{
    if (!g_matchOn) return;
    if (g_lbReady) LbDisarm(why);
    if (g_oppFilled && !g_oppCleaned) CleanupOpponent(why);
    g_oppArmed = 0;
    g_cfg = g_cfgIdle;
    g_matchOn = 0; g_matchEndAt = 0; g_matchMap[0] = 0;
    Log(L"match: disarmed (%s): the match hooks pass the game's calls on again", why);
}

/* a normal install's match, from the ready-up screen's launch: the Steam link to the other PC is up, so this PC's role
 * is known (player 1 the host, 2 the guest). 1 armed */
static int MatchArm(void)
{
    Link* L = g_cfg.rehearse ? &g_lpA : &g_link;          /* (the rehearsal: the in-process pair's link A) */
    int st = L->state, pl = L->player;
    if (st != LS_UP || (pl != 1 && pl != 2)) { Log(L"match: the link to the other PC is not up (state %d): no travel", st); return 0; }
    if (!g_matchCore || (pl == 2 && !g_matchGuest)) {
        Log(L"match: a match hook is missing (all %d, the guest's D3/D4 %d; see the start of this log): no travel", g_matchCore,
            g_matchGuest);
        return 0;
    }
    if (!g_setConfirmed || !g_buildSel || !g_fillSel || !g_tarrCopy || !g_fstrAssign || !g_msCtor || !g_encInit ||
        !g_serialize || !g_decCtor || !g_deserSp || !g_router) {
        Log(L"match: a piece of the opponent's copy or of the message layer is missing (see the start of this log): no travel");
        return 0;
    }
    if (!g_matchOn) g_cfgIdle = g_cfg;
    g_cfg.d2 = 1; g_cfg.w1 = 1; g_cfg.d6 = 1; g_cfg.opponent = 1; g_cfg.loopback = 1; g_cfg.wire = g_cfg.rehearse ? 1 : 2;
    g_cfg.linkPlayer = pl; g_cfg.guest = pl == 2;
    g_cfg.hit = 0; g_cfg.lbRole3 = 0; g_cfg.linkloss = 0; g_cfg.faction = 0;
    g_matchEndAt = 0;
    g_matchOn = 1;
    Log(L"match: armed for an RVNG match (this PC player %d, the %s, wire %d): the match hooks act until the travel back", pl,
        pl == 1 ? L"host" : L"guest", g_cfg.wire);
    return 1;
}

static int TravelDMGo(void);
static int TravelDM(void)
{
    if (!g_cfg.probe && !MatchArm()) return 0;
    int ok = TravelDMGo();
    if (!ok) MatchDisarm(L"the travel could not start");
    return ok;
}
static int TravelDMGo(void)
{
    if (!g_gi || !g_levelRow || !g_levelRowDefault || !g_fChangeMap || !g_nmPrepare) {
        Log(L"travel: not ready (GameInstance %p, level row %p, RequestChangeMap %p, NM prepare %p)", g_gi,
            (void*)g_levelRow, g_fChangeMap, (void*)g_nmPrepare);
        return 0;
    }
    uint8_t* udm = RP(g_gi, GI_UDM);
    uint8_t* nm = RP(g_gi, GI_NM);
    void* info = RP(g_gi, GI_INFO_MGR);
    void* mcm = RP(g_gi, GI_MAP_CHANGE);
    if (!udm || !nm || !info || !mcm || !Writable(udm + 0xf38, 4) || !Writable(nm + 0x538, 4)) {
        Log(L"travel: UDM %p, NM %p, InformationManager %p or MapChangeManager %p missing", udm, nm, info, mcm);
        return 0;
    }
    uint8_t* row = g_levelRow(info, (uint32_t)g_cfg.mission);
    if (!row || row == g_levelRowDefault || !Readable(row + 0x48, 0x18)) {
        Log(L"travel: the level table has no row for MissionID %d", g_cfg.mission);
        return 0;
    }
    static wchar_t pkg[256];
    NameText((const FNameRaw*)(row + 0x48), pkg, 256);
    int32_t was38 = R32(udm, 0xf38), was538 = R32(nm, 0x538);
    W32(udm, 0xf38, g_cfg.mission);
    W32(nm, 0x538, 0);
    Log(L"travel: MissionID %d (UDM+0xf38 was %d, +0xf3c %d, +0xf60 %d; NM+0x538 was %d): map %s", g_cfg.mission, was38,
        R32(udm, 0xf3c), (int32_t)R8(udm, 0xf60), was538, pkg);
    MatchReset();
    memcpy(g_matchMap, pkg, sizeof(g_matchMap));
    g_matchEndAt = 0;
    FString empty; memset(&empty, 0, sizeof(empty));
    uint64_t scratch[4]; memset(scratch, 0, sizeof(scratch));
    uint64_t extra[4]; memset(extra, 0, sizeof(extra));
    ((Fn8)(void*)g_fChangeMap)((uintptr_t)mcm, (uintptr_t)(row + 0x48), (uintptr_t)&empty, (uintptr_t)scratch, 0, 0,
                               (uintptr_t)extra, 0);
    g_nmPrepare(nm);
    Log(L"travel: requested; NetworkManager prepared (NM+0x3d8 %d)", R32(nm, 0x3d8));
    ApplyFaction(nm, L"after the travel's prepare step");
    if (g_cfg.opponent) { g_oppArmed = 1; Log(L"test 3: armed: the room tables get a fake second member before state 3"); }
    return 1;
}

/* ---- the main-menu row "COMPETITIVE 1V1" (sigs.h kSigMenuBase .. kSigTextTail; Scripts/rvng_menu.lua) ---------
 * Lua turns the main menu's ONLINE row into RVNG's: StringArgs "RVNG_1v1", texts RVNG_Menu_Title / RVNG_Menu_Help. Here the
 * texts are answered (the game's text lookup, hooked for RVNG_ keys only) and a press on the row is taken (the main menu
 * widget's decide, vtable slot 0xEE swapped: other rows go on down the chain, so another mod's own rows keep working).
 * Lua then sees the press count rise and asks the companion app to queue (main.lua requestQueue, as F8). In every
 * install; Lua only repurposes the row when both hooks are in (RVNG_MenuReady), else it just takes ONLINE off. */
typedef uintptr_t (*Fn1)(void* self);
typedef uintptr_t (*TextFn)(void* table, uintptr_t flag, void* key, void* found);
static uint8_t* g_fMenuBase;
static uint8_t* g_fMainDecide;
static void**   g_vtMain;
static Fn1      g_nextMainDecide;
static Fn1      g_nextMainCancel;     /* the main menu's cancel (vtable slot 0xEF; the game's own answers "not handled") */
static Fn1      g_nextMainCanCancel;  /* its "can cancel" (slot 0xE5; the game's own answers no) */
static int32_t  g_cancelPendOff;      /* the menu's pending-cancel byte (+0x6c4), read from the cancel input's code */
static TextFn   g_nextText;
static volatile int32_t g_menuPicks, g_menuOther, g_textAnswers;
static struct { const wchar_t* key; const wchar_t* text; FString fs; } g_texts[] = {
    { L"RVNG_Menu_Title", L"MULTIPLAYER", { 0, 0, 0 } },
    { L"RVNG_Menu_Help",  L"Ranked and casual one-on-one deathmatches against other RVNG pilots.", { 0, 0, 0 } },
};
/* RVNG's menu pages (Scripts/rvng_pages.lua): while one is up every confirm press is RVNG's, with the selected row */
static volatile int32_t g_menuPage, g_menuPresses, g_menuPressRow = -1;
static volatile int32_t g_menuCancels;  /* B / Esc presses taken on RVNG's pages (BACK) */

static void InitTexts(void)
{
    for (size_t i = 0; i < sizeof(g_texts) / sizeof(g_texts[0]); ++i) {
        int32_t n = (int32_t)WLen(g_texts[i].text) + 1;
        g_texts[i].fs.data = (wchar_t*)g_texts[i].text; g_texts[i].fs.num = n; g_texts[i].fs.max = n;
    }
}
static volatile int32_t g_menuTextSets;
/* the row's texts from now on (NULL: its own default again); the buffers live as long as the DLL */
static void SetMenuTexts(const wchar_t* title, const wchar_t* help)
{
    static const wchar_t* const kDefault[2] = { L"MULTIPLAYER", L"Ranked and casual one-on-one deathmatches against other RVNG pilots." };
    const wchar_t* t[2] = { title ? title : kDefault[0], help ? help : kDefault[1] };
    for (int i = 0; i < 2; ++i) {
        int32_t n = (int32_t)WLen(t[i]) + 1;
        g_texts[i].text = t[i];
        g_texts[i].fs.data = (wchar_t*)t[i]; g_texts[i].fs.max = n;
        __atomic_store_n(&g_texts[i].fs.num, n, __ATOMIC_RELEASE);
    }
    __sync_add_and_fetch(&g_menuTextSets, 1);
}

static uintptr_t OnText(void* table, uintptr_t flag, void* keyp, void* found)
{
    const FString* key = (const FString*)keyp;
    if (key && key->data && key->num > 5 && key->num < 64 && !memcmp(key->data, L"RVNG_", 10)) {
        for (size_t i = 0; i < sizeof(g_texts) / sizeof(g_texts[0]); ++i) {
            size_t n = WLen(g_texts[i].key);
            if ((size_t)key->num == n + 1 && !memcmp(key->data, g_texts[i].key, n * 2)) {
                if (found) *(uint8_t*)found = 1;
                __sync_add_and_fetch(&g_textAnswers, 1);
                return (uintptr_t)&g_texts[i].fs;
            }
        }
    }
    return g_nextText(table, flag, keyp, found);
}

static void* VCall(void* obj, int slot)
{
    if (!Readable(obj, 8)) return NULL;
    void** vt = *(void***)obj;
    if (!Readable(vt + slot, 8)) return NULL;
    return (void*)((Fn1)vt[slot])(obj);
}

/* the selected row of the main menu (0 = the top visible row), -1 when it can't be read. The index's offset is taken from
 * the game's own getter (vtable slot 0xF3: movzx eax, word ptr [rcx+off]; ret), not hard-coded */
static int32_t g_selIdxOff = -1;
typedef uint8_t (*SetCmdIndexFn)(void* widget, int16_t index);
static SetCmdIndexFn g_setCmdIndex;
static int32_t g_hoverOff, g_hoverSelOff;      /* the hovered row's int16 and the selected one's, from the tick's sync */
static int32_t SelectedRow(void* widget)
{
    if (!Readable(widget, 8)) return -1;
    if (g_selIdxOff < 0) {
        void** vt = *(void***)widget;
        uint8_t* f = Readable(vt + VF_SELECTED_IDX, 8) ? (uint8_t*)vt[VF_SELECTED_IDX] : NULL;
        if (f && InGame(f) && Readable(f, 8) && f[0] == 0x0F && f[1] == 0xB7 && f[2] == 0x81 && f[7] == 0xC3) {
            int32_t off; memcpy(&off, f + 3, 4);
            if (off > 0 && off < 0x1000) g_selIdxOff = off;
        }
        if (g_selIdxOff < 0) { Log(L"main menu: the selected-index getter is not as expected: rows unknown"); g_selIdxOff = 0; }
        else Log(L"main menu: the selected row index is at +0x%x (from the game's getter)", g_selIdxOff);
    }
    if (g_selIdxOff <= 0 || !Readable((uint8_t*)widget + g_selIdxOff, 2)) return -1;
    return *(int16_t*)((uint8_t*)widget + g_selIdxOff);
}

static const FString* SelectedArgs(void* widget)
{
    uint8_t* cmd = (uint8_t*)VCall(widget, VF_SELECTED_CMD);
    if (!cmd || !Readable(cmd + CMD_STRING_ARGS, sizeof(FString))) return NULL;
    const FString* a = (const FString*)(cmd + CMD_STRING_ARGS);
    if (!a->data || a->num < 1 || a->num > 64 || !Readable(a->data, (size_t)a->num * 2)) return NULL;
    return a;
}

static uintptr_t OnMainDecide(void* widget)
{
    if (g_menuPage) {                                   /* an RVNG page is up: the press is RVNG's, whatever the row */
        int32_t row = SelectedRow(widget);
        g_menuPressRow = row;
        int32_t n = __sync_add_and_fetch(&g_menuPresses, 1);
        Log(L"main menu: press %d on RVNG's page, row %d", n, row);
        return 1;
    }
    const FString* a = SelectedArgs(widget);
    if (a && a->num == 9 && !memcmp(a->data, L"RVNG_1v1", 16)) {
        int32_t n = __sync_add_and_fetch(&g_menuPicks, 1);
        Log(L"main menu: COMPETITIVE 1V1 chosen (%d)", n);
        return 1;                                       /* taken: the stock decide would open the row's MenuID page */
    }
    __sync_add_and_fetch(&g_menuOther, 1);
    return g_nextMainDecide(widget);
}

/* B / Esc on the main menu: the menu's cancel input (vtable slot 0xE0) ends in slot 0xEF, which the main menu leaves as the
 * menu base's "not handled" (xor al, al; ret); its "can cancel" (0xE5) says no too, so the stock main menu has no cancel
 * at all (its footer shows only Confirm). While an RVNG page is up both answer for RVNG (OnMainCanCancel below) and the
 * press is the page's BACK (Lua); otherwise both go on down the chain unchanged. In game 2026-11-19 22:39: ui_pages. */
static uintptr_t OnMainCancel(void* widget)
{
    if (g_menuPage) {
        int32_t n = __sync_add_and_fetch(&g_menuCancels, 1);
        Log(L"main menu: B/Esc %d on RVNG's page: BACK", n);
        return 1;
    }
    return g_nextMainCancel(widget);
}
static uintptr_t OnMainCanCancel(void* widget)
{
    if (g_menuPage) return 1;                           /* (so the menu's tick runs its cancel path on a page) */
    return g_nextMainCanCancel(widget);
}

/* the main menu's vtable: [0xDF] the base, [0xEE] the decide (or another mod's handler in front of it, when that vtable's
 * [0x111] is still the game's: the difficulty page's [0x111] is hooked by Survival too) */
typedef struct { void** exact; int nExact; void** chained; int nChained; } VtFind;
static void VtRegion(uint8_t* p, size_t n, void* vctx)
{
    VtFind* c = (VtFind*)vctx;
    uint8_t* end = p + n;
    p = (uint8_t*)(((uintptr_t)p + 7) & ~(uintptr_t)7);
    for (; p + 8 * (VT_NEXT_SLOT + 1) <= end; p += 8) {
        void** v = (void**)p;
        if (v[VT_BASE_SLOT] != g_fMenuBase) continue;
        void* dec = v[VT_DECIDE_SLOT];
        if (dec == g_fMainDecide) { c->exact = v; ++c->nExact; }
        else if (dec && !InGame(dec) && InGame(v[VT_NEXT_SLOT])) { c->chained = v; ++c->nChained; }
    }
}

static void InstallMenuRow(uint8_t* base, uint8_t* decide, uint8_t* text, uint8_t* textHooked)
{
    InitTexts();
    g_fMenuBase = base; g_fMainDecide = decide;
    if (base && decide) {
        VtFind c = { NULL, 0, NULL, 0 };
        for (int s = 0; s < g_nsec; ++s)
            if (!(g_sec[s].ch & IMAGE_SCN_MEM_EXECUTE)) ForRegions(g_sec[s].start, g_sec[s].len, VtRegion, &c);
        g_vtMain = c.nExact == 1 ? c.exact : (c.nExact == 0 && c.nChained == 1) ? c.chained : NULL;
        Log(L"main menu vtable: %d exact, %d behind another mod's handler: %s", c.nExact, c.nChained, g_vtMain ? L"found" : L"NOT found");
    }
    if (g_vtMain) {
        void* next = g_vtMain[VT_DECIDE_SLOT];
        void* mine = (void*)OnMainDecide;
        if (WriteMem(&g_vtMain[VT_DECIDE_SLOT], &mine, 8)) {
            g_nextMainDecide = (Fn1)next;
            Log(L"main menu decide: vtable slot %p, next %p%s", (void*)&g_vtMain[VT_DECIDE_SLOT], next, InGame(next) ? L"" : L" (another mod's handler)");
        }
        /* the cancel: only when this build's cancel input (slot 0xE0) is seen to end in slot 0xEF (jmp [rax+0x778]) */
        uint8_t* in = (uint8_t*)g_vtMain[VT_CANCEL_INPUT_SLOT];
        int seen = 0;
        for (int i = 0; InGame(in) && Readable(in, 0xA0) && i + 6 <= 0xA0 && !seen; ++i)
            seen = !memcmp(in + i, kCancelJmp, sizeof(kCancelJmp));
        for (int i = 0; seen && i + 7 <= 0x40 && !g_cancelPendOff; ++i)      /* cmp byte [rbx+disp32], 0 */
            if (in[i] == 0x80 && in[i + 1] == 0xBB && in[i + 6] == 0x00) {
                int32_t d; memcpy(&d, in + i + 2, 4);
                if (d > 0x100 && d < 0x1000) g_cancelPendOff = d;
            }
        void* nextC = g_vtMain[VT_CANCEL_SLOT];
        void* mineC = (void*)OnMainCancel;
        void* nextK = g_vtMain[VT_CAN_CANCEL_SLOT];
        void* mineK = (void*)OnMainCanCancel;
        if (!seen) Log(L"main menu cancel: the cancel input (slot 0xE0, %p) does not end in slot 0xEF here: B/Esc left to the game", in);
        else if (WriteMem(&g_vtMain[VT_CANCEL_SLOT], &mineC, 8)) {
            g_nextMainCancel = (Fn1)nextC;
            if (WriteMem(&g_vtMain[VT_CAN_CANCEL_SLOT], &mineK, 8)) g_nextMainCanCancel = (Fn1)nextK;
            else { WriteMem(&g_vtMain[VT_CANCEL_SLOT], &nextC, 8); g_nextMainCancel = NULL; }   /* (both or neither) */
            Log(L"main menu cancel: vtable slots %p / %p, next %p / %p, pending byte +0x%x%s", (void*)&g_vtMain[VT_CANCEL_SLOT],
                (void*)&g_vtMain[VT_CAN_CANCEL_SLOT], nextC, nextK, g_cancelPendOff,
                g_nextMainCancel ? L"" : L": NOT both swapped, left to the game");
        }
    }
    if (text) HookInline(text, LENS_TEXT, (void*)OnText, (void**)&g_nextText, L"text lookup");
    else if (textHooked) HookInline(textHooked, LENS_TEXT_CHAINED, (void*)OnText, (void**)&g_nextText, L"text lookup (behind another mod's hook)");
    Log(L"main menu row: decide %s, cancel %s, texts %s", g_nextMainDecide ? L"hooked" : L"NOT hooked",
        g_nextMainCancel ? L"hooked" : L"NOT hooked", g_nextText ? L"hooked" : L"NOT hooked");
}

/* ---- Lua bridge ----------------------------------------------------------
 * UE4SS calls a C++ mod's on_lua_start(mod_name, lua, ...) when a Lua mod starts, before its main.lua runs. As in
 * Survival's runtime, every slot of the mod object is a small probe: when a call's first argument is a
 * std::wstring_view naming this mod, the second is its LuaMadeSimple::Lua and the RVNG_* functions are registered. */
static int ArgNumber(void* lua, double* v)
{
    if (U.luaStackSize(lua) < 1 || !U.luaIsNumber(lua, 1)) return 0;
    *v = U.luaGetNumber(lua, 1);
    return 1;
}
/* A Lua function's arguments, read in order. UE4SS's get_number and get_string take the value they read off the stack
 * (lua_remove), so the next argument is always at index 1: a read at index 2 after one at index 1 gets the third
 * argument, or nothing (measured 2026-11-19: RVNG_MenuSelect's row read at index 2 always came back 0). A value of the
 * wrong type is left where it is and ends the reading (*stop): the arguments after it keep their defaults. */
static int ArgNextNum(void* lua, double* v, int* stop)
{
    if (*stop || U.luaStackSize(lua) < 1 || !U.luaIsNumber(lua, 1)) { *stop = 1; return 0; }
    *v = U.luaGetNumber(lua, 1);
    return 1;
}
static int ArgNextStr(void* lua, char* out, size_t cap, int* stop)
{
    out[0] = 0;
    if (*stop || U.luaStackSize(lua) < 1 || !U.luaIsString(lua, 1)) { *stop = 1; return 0; }
    StrView sv = { NULL, 0 };
    U.luaGetString(lua, &sv, 1);
    size_t n = 0;
    for (; sv.p && n < sv.n && n < cap - 1; ++n) out[n] = sv.p[n];
    out[n] = 0;
    return (int)n;
}

#include "hangar.h"
#include "lobby.h"       /* RVNG's lobby in the hangar (0.4.3) */
#include "matchstats.h"  /* a match's kills, deaths, length and end, for the leaderboard (0.4.4) */

static int L_Version(void* lua) { U.luaSetString(lua, RT_VERSION_A, sizeof(RT_VERSION_A) - 1); return 1; }
static int L_ProbeOn(void* lua) { U.luaSetInteger(lua, g_cfg.probe); return 1; }
static int L_Watch(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    U.luaSetInteger(lua, Watch((uint8_t*)(uintptr_t)(uint64_t)v));
    return 1;
}
static int L_ArmDM(void* lua) { U.luaSetInteger(lua, ArmDM()); return 1; }
static int L_TravelDM(void* lua) { U.luaSetInteger(lua, TravelDM()); return 1; }
static int L_State(void* lua) { uint8_t* gm = LiveGM(); U.luaSetInteger(lua, gm ? (int64_t)R8(gm, GM_STATE) : -1); return 1; }
static int L_Hooks(void* lua) { U.luaSetInteger(lua, g_hooked); return 1; }
/* RVNG_MatchInfo(k): (0) the match hooks all in, (1) the guest's D3/D4 in, (2) a match armed (a normal install's),
 * (3) the disarm due (ms left, -1 not asked) */
static int L_MatchInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    uint64_t now = GetTickCount64();
    int64_t r = k == 0 ? g_matchCore : k == 1 ? g_matchGuest : k == 2 ? g_matchOn :
                k == 3 ? (g_matchEndAt ? (g_matchEndAt > now ? (int64_t)(g_matchEndAt - now) : 0) : -1) : -1;
    U.luaSetInteger(lua, r);
    return 1;
}
static int L_LastState(void* lua) { U.luaSetInteger(lua, g_lastHookState); return 1; }
/* The always-on tick (Scripts/rvng_native.lua, once a second on the game thread, with or without probe): keeps the
 * GameInstance and runs D7; without the test logger also an RVNG match's once-a-second steps (the lost link, the room
 * tables' cleanup, the disarm after the match). Returns how many refused boot logins D7 has ended. */
static int32_t AlwaysTick(uint8_t* gi)
{
    if (gi && Readable(gi, GI_WEBAPI + 8)) g_gi = gi;
    uint8_t* udm = g_gi ? RP(g_gi, GI_UDM) : NULL;
    if (udm) EndRefusedLogin(udm);
    if (!g_cfg.probe) {                              /* (with probe the test logger's Watch runs these) */
        uint64_t now = GetTickCount64();
        if (!g_gameThread) g_gameThread = GetCurrentThreadId();
        if (g_matchOn) {
            static uint64_t lbLast;
            int full = now - lbLast >= 10000;
            if (full) lbLast = now;
            if (g_cfg.wire == 1) WireTickPair();          /* (the rehearsal's pair: also between the gate and state 14) */
            LbWatch(full);                                /* (where the copy is; logged every 10 s) */
            LinkLossCheck(LiveGM());
            MatchStatsTick();                             /* (the deaths, for the leaderboard: matchstats.h) */
        }
        if (g_oppCleanAt && now >= g_oppCleanAt) { g_oppCleanAt = 0; CleanupOpponent(L"8 s after the travel"); }
        if (g_matchEndAt && now >= g_matchEndAt) MatchDisarm(L"the match is over");
    }
    return g_slEnded;
}
static int L_Tick(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    U.luaSetInteger(lua, AlwaysTick((uint8_t*)(uintptr_t)(uint64_t)v));
    return 1;
}
/* test 6: RVNG_FacInfo(0) entries written, (1) the local plane's faction, (2) the nearest start point's faction,
 * (3) its distance in metres; -1 = not seen yet */
static int L_FacInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k == 0 ? g_facWritten : k == 1 ? g_facPlane : k == 2 ? g_facNear : k == 3 ? g_facNearM : -1);
    return 1;
}
/* test 3: RVNG_OppInfo(0) filled, (1) remote spawn calls, (2) the last spawn's slot, (3) most planes seen, (4) the
 * copy's role, (5) the copy's netId, (6) cleaned up, (7) members + selectors left after the cleanup (-1 before) */
/* RVNG_OppName(name): the opponent's shown name for the next match (UTF-8; "" = the user id). RVNG_OppShown() -> the
 * name the game's selector holds after the last fill, UTF-8 ("" before a fill) */
static int L_OppName(void* lua)
{
    char b[4 * OPP_NAME_MAX];
    int stop = 0;
    int n = ArgNextStr(lua, b, sizeof(b), &stop);
    SetOppName(b, (size_t)(n > 0 ? n : 0));
    U.luaSetInteger(lua, 1);
    return 1;
}
static int L_OppShown(void* lua)
{
    char b[4 * OPP_NAME_MAX]; size_t k = 0;
    for (int i = 0; i < OPP_NAME_MAX && g_oppShown[i] && k + 4 < sizeof(b); ++i) {
        uint32_t c = g_oppShown[i];
        if (c >= 0xD800 && c < 0xDC00 && i + 1 < OPP_NAME_MAX && g_oppShown[i + 1] >= 0xDC00 && g_oppShown[i + 1] < 0xE000)
            { c = 0x10000 + ((c - 0xD800) << 10) + ((uint32_t)g_oppShown[i + 1] - 0xDC00); ++i; }
        if (c < 0x80) b[k++] = (char)c;
        else if (c < 0x800) { b[k++] = (char)(0xC0 | (c >> 6)); b[k++] = (char)(0x80 | (c & 0x3F)); }
        else if (c < 0x10000) { b[k++] = (char)(0xE0 | (c >> 12)); b[k++] = (char)(0x80 | ((c >> 6) & 0x3F)); b[k++] = (char)(0x80 | (c & 0x3F)); }
        else { b[k++] = (char)(0xF0 | (c >> 18)); b[k++] = (char)(0x80 | ((c >> 12) & 0x3F)); b[k++] = (char)(0x80 | ((c >> 6) & 0x3F)); b[k++] = (char)(0x80 | (c & 0x3F)); }
    }
    U.luaSetString(lua, b, k);
    return 1;
}
static int L_OppInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    int32_t left = -1;
    if (k == 7 && g_oppCleaned && g_gi) {
        uint8_t* nm = RP(g_gi, GI_NM);
        uint8_t* mrmm = RP(g_gi, GI_MRMM);
        left = R32(nm, 0x3d8) + SetCount(nm + 0x410) + SetCount(mrmm + 0x40);
    }
    U.luaSetInteger(lua, k == 0 ? g_oppFilled : k == 1 ? g_oppSpawns : k == 2 ? g_oppSlot : k == 3 ? g_oppPlanes :
                         k == 4 ? g_oppRole : k == 5 ? g_oppNetId : k == 6 ? g_oppCleaned : left);
    return 1;
}
/* test 4: RVNG_LbInfo(0) armed, (1) sends, (2) Physics captured, (3) injected, (4) applied, (5) the copy's distance from the
 * mirror point (m), (6) how far the copy moved from its start (m), (7) encode + decode failures */
static int L_LbInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k == 0 ? g_lbReady : k == 1 ? g_lbSends : k == 2 ? g_lbCaptured : k == 3 ? g_lbInjected :
                         k == 4 ? g_lbApplied : k == 5 ? g_lbErrM : k == 6 ? g_lbMovedM : k == 8 ? g_clockSkewMaxMs :
                         g_lbEncFail + g_lbDecFail);
    return 1;
}
/* the main-menu row: RVNG_MenuReady() 1 when both its hooks are in; RVNG_MenuPicks() presses taken so far;
 * RVNG_MenuInfo(k): (0) other rows' presses passed on, (1) RVNG texts answered */
static int L_MenuReady(void* lua) { U.luaSetInteger(lua, g_nextMainDecide && g_nextText ? 1 : 0); return 1; }
/* RVNG_MenuPage(0/1): an RVNG page is up (every confirm press is then RVNG's); RVNG_MenuPress(k): (0) presses taken on
 * a page so far, (1) the last one's row (0 = the top row; -1 unknown) */
static int L_MenuPage(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    if ((v != 0) != (g_menuPage != 0)) Log(L"main menu: RVNG's pages %s", v != 0 ? L"up (presses taken)" : L"down");
    g_menuPage = v != 0;
    return 0;
}
/* RVNG_MenuPress(k): (0) confirm presses taken on RVNG's pages, (1) the last one's row, (2) B/Esc presses taken there
 * (BACK), (3) the cancel hooked */
static int L_MenuPress(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k == 0 ? g_menuPresses : k == 1 ? g_menuPressRow : k == 2 ? g_menuCancels :
                         k == 3 ? (g_nextMainCancel && g_nextMainCanCancel) : -1);
    return 1;
}
/* RVNG_MenuBack(address of the main menu widget) -> 1: the menu's own pending-cancel byte set, so its next tick runs the
 * cancel path as a B / Esc press does (0xE5, the cancel input 0xE0, 0xEF): the self-test's way to press it (posted keys
 * don't reach an unfocused game). Only while an RVNG page is up and the cancel is RVNG's; 0 refused */
static int L_MenuBack(void* lua)
{
    double a = 0;
    ArgNumber(lua, &a);
    uint8_t* w = (uint8_t*)(uintptr_t)(uint64_t)a;
    int ok = g_menuPage && g_nextMainCancel && g_nextMainCanCancel && g_cancelPendOff && g_vtMain && w && Readable(w, 8) &&
             *(void***)w == g_vtMain && Writable(w + g_cancelPendOff, 1);
    if (ok) w[g_cancelPendOff] = 1;
    else Log(L"RVNG_MenuBack refused (page %d, cancel %p, widget %p)", (int32_t)g_menuPage, (void*)g_nextMainCancel, w);
    U.luaSetInteger(lua, ok);
    return 1;
}
/* RVNG_MenuSelect(address of the main menu widget, row) -> 1: the cursor moved there by the menu's own SetSelectedIndex
 * (game thread; only on the main menu widget RVNG hooked) */
static int L_MenuSelect(void* lua)
{
    double a = 0, r = -1; int stop = 0;
    ArgNextNum(lua, &a, &stop);
    ArgNextNum(lua, &r, &stop);
    uint8_t* w = (uint8_t*)(uintptr_t)(uint64_t)a;
    int ok = g_setCmdIndex && g_vtMain && w && Readable(w, 8) && *(void***)w == g_vtMain && r >= 0 && r < 32;
    if (ok) {
        /* (in mouse mode the tick selects the hovered row: it is set to the same row first, when the tick's own code
         * names the same selected-index offset as the getter) */
        if (g_hoverOff && (g_selIdxOff <= 0 || g_hoverSelOff == g_selIdxOff) && Writable(w + g_hoverOff, 2))
            *(int16_t*)(w + g_hoverOff) = (int16_t)r;
        uint8_t res = g_setCmdIndex(w, (int16_t)r);
        static int probes;
        if (probes++ < 4)
            Log(L"main menu: cursor to row %d (SetSelectedIndex answered %d; row now %d)", (int32_t)r, (int32_t)res,
                g_selIdxOff > 0 ? (int32_t)*(int16_t*)(w + g_selIdxOff) : -9);
    }
    static int logged;
    if (!ok && logged++ < 5)
        Log(L"main menu: cursor move to row %d refused (widget %p, its vtable %p, the main menu's %p, SetSelectedIndex %p)",
            (int32_t)r, w, w && Readable(w, 8) ? *(void**)w : NULL, (void*)g_vtMain, (void*)g_setCmdIndex);
    U.luaSetInteger(lua, ok);
    return 1;
}
/* RVNG_MenuRow(address of the main menu widget) -> its selected row now (0 = top; -1 unknown): the self-test reads the
 * cursor without pressing anything */
static int L_MenuRow(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    uint8_t* w = (uint8_t*)(uintptr_t)(uint64_t)v;
    int ok = w && Readable(w, 8) && (!g_vtMain || *(void***)w == g_vtMain);
    U.luaSetInteger(lua, ok ? SelectedRow(w) : -1);
    return 1;
}
static int L_MenuPicks(void* lua) { U.luaSetInteger(lua, g_menuPicks); return 1; }
static int L_MenuInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    U.luaSetInteger(lua, (int)v == 0 ? g_menuOther : g_textAnswers);
    return 1;
}
/* test 7: RVNG_HitInfo(k): 0 phase (5 = done), 1/2 TakeDamage's return for hit 1/2 (x10), 3/4/5/6 the copy's health
 * before hit 1 / after hit 1 / after the lethal hit / after the respawn (x10), 7/8/9 the local score before / after hit
 * 1 / after the lethal hit (x10), 10/11 Damage / ScoreAddition messages seen at Send */
static int L_HitInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    int32_t r = k == 0 ? g_hitPhase : k == 1 ? g_hitR1 : k == 2 ? g_hitR2 : k == 3 ? g_hitHp0 : k == 4 ? g_hitHp1 :
                k == 5 ? g_hitHp2 : k == 6 ? g_hitHp3 : k == 7 ? g_hitScore0 : k == 8 ? g_hitScore1 : k == 9 ? g_hitScore2 :
                k == 10 ? SentCount(L"FLiveMessageDamage") : k == 11 ? SentCount(L"FLiveMessageScoreAddition") :
                k == 12 ? g_hit7bInjected : k == 13 ? g_hit7bHp0 : k == 14 ? g_hit7bHp1 : k == 15 ? g_hit7bScore0 :
                k == 16 ? g_hit7bScore1 : k == 17 ? g_d3Taken : k == 18 ? g_d3Swallowed : k == 19 ? g_d4Blocked :
                k == 20 ? g_d3Injected : k == 21 ? g_suBuilt : k == 22 ? g_suInjected : k == 23 ? g_suLocal :
                k == 24 ? g_suCopy : k == 25 ? g_suBytes : k == 26 ? LoopedCount(L"FLiveMessageDestroyedLocation") :
                k == 27 ? LoopedCount(L"FLiveMessageRespawn") : k == 28 ? g_deathLocalHp : k == 29 ? g_deathCopyFlag :
                k == 30 ? g_deathCopyHp : k == 31 ? g_deathLocalHp2 : -1;
    U.luaSetInteger(lua, r);
    return 1;
}
/* the lost-link test: RVNG_LinkLoss(0) fired, (1) +0x804 after, (2) +0x538 after, (3) seconds into 14 when fired */
static int L_LinkLoss(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k == 0 ? g_llFired : k == 1 ? g_ll804 : k == 2 ? g_ll538 : g_llAtS);
    return 1;
}
/* D8: RVNG_CheatInfo(t) for t 0-9 = reports of that type seen; (10) switched off; (11) type 1 left to the game;
 * (12) 1 if hooked; (13) Cheat messages that still reached Send (loopback suites, where D1 counts them) */
static int L_CheatInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k >= 0 && k < 10 ? g_cheatByType[k] : k == 10 ? g_cheatOff : k == 11 ? g_cheatPassed :
                         k == 12 ? (g_origReportCheat != NULL) : k == 13 ? SentCount(L"FLiveMessageCheat") : -1);
    return 1;
}
/* D9's test-only network log (netlog=1): RVNG_NetInfo(k) for k 0 = on, 1 import slots observed, 2 modules seen,
 * 3 outside connect/send calls, 4 loopback ones, 5 outside name lookups, 6 HTTP-library connects/requests, 7 log lines,
 * 8 bind calls */
static int L_NetInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k == 0 ? g_nlOn : k == 1 ? g_nlSlots : k == 2 ? g_nlModules : k == 3 ? g_nlOutside :
                         k == 4 ? g_nlLoopback : k == 5 ? g_nlLookups : k == 6 ? g_nlHttp : k == 7 ? g_nlNewLines : k == 8 ? g_nlBinds : -1);
    return 1;
}
/* D9: RVNG_WallInfo(k): (0) send points hooked, (1) of how many; (2) more gates hooked, (3) of how many; refused:
 * (4) LiveWebAPI requests, (5) Cosmos calls, (6) engine HTTP requests, (7) WebSocket connects, (8) Strix starts,
 * (9) Messenger set-ups; (10) the nine more gates' calls, (11) of them the game would have answered true;
 * (12) LiveWebAPI requests queued (test logger; -1 when not watched) */
static int L_WallInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    int32_t r = -1;
    if (k == 0) r = g_wallIn; else if (k == 1) r = W_N; else if (k == 2) r = g_wallGatesIn; else if (k == 3) r = GATE_N - 2;
    else if (k >= 4 && k < 4 + W_N) r = g_wallRefused[k - 4];
    else if (k == 10 || k == 11) { r = 0; for (int i = GATE_USER; i < GATE_N; ++i) r += k == 10 ? g_gateCalls[i] : g_gateTrue[i]; }
    else if (k == 12) r = g_lwaQueued;
    U.luaSetInteger(lua, r);
    return 1;
}
/* the EOS block (D9, every install): RVNG_EosInfo(k): (0) on, (1) the EOS SDK patched, (2) its import slots pointed at
 * wrappers, (3) its reaching-out slots NOT pointed at a wrapper now (0 = the wall holds; -1 not loaded), refused:
 * (4) name lookups, (5) connects, (6) sends; (7) loopback calls let through; (8) another EOS module loaded;
 * netlog=1: (9) EOS functions the game looked up, (10) of them anti-cheat interface ones (counted, never named) */
static int L_EosInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    int32_t r = -1;
    if (k == 0) r = g_ewOn; else if (k == 1) r = g_ewLoaded; else if (k == 2) r = g_ewSlots; else if (k == 3) r = EwUnwrapped();
    else if (k == 4) r = g_ewRefused[EW_GAI] + g_ewRefused[EW_GAIW] + g_ewRefused[EW_GAIEXW] + g_ewRefused[EW_GAIEXA] +
                         g_ewRefused[EW_GHBN] + g_ewRefused[EW_CBNW] + g_ewRefused[EW_CBNA];
    else if (k == 5) r = g_ewRefused[EW_CONNECT] + g_ewRefused[EW_WSACONNECT] + g_ewRefused[EW_CONNECTEX];
    else if (k == 6) r = g_ewRefused[EW_SENDTO] + g_ewRefused[EW_WSASENDTO];
    else if (k == 7) r = g_ewLoopback; else if (k == 8) r = g_ewOtherEos;
    else if (k == 9) r = g_nlEosFns; else if (k == 10) r = g_nlEosAc;
    U.luaSetInteger(lua, r);
    return 1;
}
/* ---- the link (link.h) to Lua ------------------------------------------------------------------------------------ */
static uint64_t ParseU64(const char* s)
{
    uint64_t v = 0;
    for (; *s; ++s) { if (*s < '0' || *s > '9') return 0; v = v * 10 + (uint64_t)(*s - '0'); }
    return v;
}
/* RVNG_LinkStart(peer SteamID64 as text, player 1 host / 2 guest, match id text[, pilot name]) -> 1 started */
static int L_LinkStart(void* lua)
{
    char peer[32], tag[96], name[LINK_NAME];
    double pl = 0; int stop = 0;
    name[0] = 0;
    ArgNextStr(lua, peer, sizeof(peer), &stop);
    ArgNextNum(lua, &pl, &stop);
    int player = (int)pl;
    int nt = ArgNextStr(lua, tag, sizeof(tag), &stop);
    ArgNextStr(lua, name, sizeof(name), &stop);
    int ok = nt > 0 && LinkStartSteam(ParseU64(peer), player, LinkTagOf(tag, (size_t)nt), name);
    U.luaSetInteger(lua, ok);
    return 1;
}
static int L_LinkStop(void* lua) { (void)lua; LinkStopSteam(LB_STOPPED); return 0; }
/* RVNG_LinkSend(text[, reliable]) -> 1 sent as DATA; RVNG_LinkRecv() -> the next DATA received, as text ("" none).
 * (The two-PC link test's messages; the game's own go through the same queue once wired.) */
static int L_LinkSend(void* lua)
{
    static char buf[LINK_MAX_MSG];
    double r = 0; int stop = 0;
    int n = ArgNextStr(lua, buf, LINK_MAX_MSG - sizeof(LinkHdr), &stop);
    ArgNextNum(lua, &r, &stop);
    int rel = r != 0;
    U.luaSetInteger(lua, n > 0 && LinkSendData(&g_link, buf, (uint32_t)n, rel));
    return 1;
}
static int L_LinkRecv(void* lua)
{
    static uint8_t buf[LINK_MAX_MSG];
    int n = LinkRecvData(&g_link, buf, (int)sizeof(buf));
    U.luaSetString(lua, (const char*)buf, (size_t)(n > 0 ? n : 0));
    return 1;
}
/* RVNG_LinkGo(delay ms) on the host -> 1 sent */
static int L_LinkGo(void* lua)
{
    double v = 1500;
    ArgNumber(lua, &v);
    LinkLock();
    int ok = LinkGoStart(&g_link, (uint64_t)(v > 0 ? v : 0) * 1000, 0);
    LinkUnlock();
    U.luaSetInteger(lua, ok);
    return 1;
}
/* the link the ready-up screen works on: Steam (g_link), or on one PC (wire 1) this PC's half of the pair, made now */
static Link* ReadyLink(void)
{
    if (g_cfg.wire == 1) {
        /* (the one-PC pair, a test only: a new match after one whose launch has come and gone, with no match armed now,
         * gets a fresh pair, as a real match gets a fresh Steam link from RVNG_LinkStart) */
        if (g_wireOn && !g_matchOn && g_lpA.lnState != LG_NONE && LinkLaunchDue(&g_lpA)) {
            g_wireOn = 0;
            Log(L"wire 1: the pair made again for the next match (the last one's launch is over)");
        }
        WireEnsure();
        return &g_lpA;
    }
    return &g_link;
}
/* RVNG_WireCut() -> 1: the one-PC pair's wire cut now (a test only, wire 1: the stand-in opponent gone; both links see the
 * loss 6 s later, as with a closed game or a dropped connection) */
static int L_WireCut(void* lua)
{
    int ok = g_cfg.wire == 1 && g_wireOn;
    if (ok) { g_wireCut = 1; Log(L"wire 1: the wire cut (the self-test: the opponent gone)"); }
    U.luaSetInteger(lua, ok);
    return 1;
}
/* RVNG_LinkReady(0/1): this PC's ready flag (the ready-up screen) */
static int L_LinkReady(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    ReadyLink()->localReady = v <= 0 ? 0 : v >= 2 ? 2 : 1;      /* (2: ready and SORTIE pressed, the hangar lobby) */
    return 0;
}
/* RVNG_LinkLaunch(delay ms) on the host -> 1 once LAUNCH is sent (both ready, the guest's clock synced) */
static int L_LinkLaunch(void* lua)
{
    double v = 5000;
    ArgNumber(lua, &v);
    Link* L = ReadyLink();
    if (L == &g_link) LinkLock();
    int ok = LinkLaunchStart(L, (uint64_t)(v > 0 ? v : 0) * 1000);
    if (L == &g_link) LinkUnlock();
    if (ok) Log(L"ready-up: both pilots ready: LAUNCH in %d ms sent", (int32_t)v);
    U.luaSetInteger(lua, ok);
    return 1;
}
/* RVNG_ReadyInfo(k) on the ready-up link: (0) state (as RVNG_LinkInfo(0)), (1) player, (2) my ready, (3) the peer's,
 * (4) the peer's clock synced, (5) launch state (0 none, 1 sent, 2 acknowledged, 3 set), (6) ms to the launch (-1 not
 * set), (7) the launch is due */
static int L_ReadyInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    Link* L = g_cfg.wire == 1 ? &g_lpA : &g_link;
    if (g_cfg.wire == 1) WireTickPair();
    int64_t r = -1;
    switch (k) {
    case 0: r = L->state; break;          case 1: r = L->player; break;      case 2: r = L->localReady; break;
    case 3: r = L->peerReady; break;      case 4: r = L->player == 1 ? L->peerSynced : L->synced; break;
    case 5: r = L->lnState; break;        case 6: r = LinkLaunchLeftMs(L); break;
    case 7: r = LinkLaunchDue(L); break;
    case 8: r = g_menuTextSets; break;
    }
    U.luaSetInteger(lua, r);
    return 1;
}
/* RVNG_ResultInfo(k): (0) matches with a result so far, (1) this pilot's score x10, (2) the opponent's x10 */
static int L_ResultInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k == 0 ? g_resMatches : k == 1 ? g_resMine : k == 2 ? g_resTheirs : -1);
    return 1;
}
/* RVNG_MenuText(title, help): the COMPETITIVE 1V1 row's texts (the ready-up screen writes its state there) */
static wchar_t g_menuTitle[64], g_menuHelp[256];
static int L_MenuText(void* lua)
{
    char a[64], b[256];
    int stop = 0;
    int na = ArgNextStr(lua, a, sizeof(a), &stop);
    int nb = ArgNextStr(lua, b, sizeof(b), &stop);
    for (int i = 0; i <= na; ++i) g_menuTitle[i] = (wchar_t)(uint8_t)a[i];
    for (int i = 0; i <= nb; ++i) g_menuHelp[i] = (wchar_t)(uint8_t)b[i];
    SetMenuTexts(na ? g_menuTitle : NULL, nb ? g_menuHelp : NULL);
    return 0;
}
/* RVNG_LinkSelf() -> this PC's SteamID64 as text ("" when Steam isn't there) */
static int L_LinkSelf(void* lua)
{
    char s[24]; int n = 0;
    uint64_t v = SteamSelf();
    char t[24]; int k = 0;
    do { t[k++] = (char)('0' + v % 10); v /= 10; } while (v && k < 23);
    if (!SteamSelf()) k = 0;
    while (k) s[n++] = t[--k];
    s[n] = 0;
    U.luaSetString(lua, s, (size_t)n);
    return 1;
}
/* RVNG_Relay() -> Valve's relay network status (100 = ready; it is asked for on the first call) */
static int L_Relay(void* lua) { U.luaSetInteger(lua, SteamRelay()); return 1; }
/* RVNG_LinkInfo(k): (0) state 0 off 1 waiting 2 up 3 lost 4 closed, (1) player, (2) reason, (3) clock offset ms,
 * (4) round trip ms, (5) clock samples, (6) synced, (7) peer synced, (8) go state, (9) go due, (10) sent, (11) received,
 * (12) from another sender, (13) bad header, (14) another match's tag, (15) send failures, (16) DATA queued,
 * (17) DATA dropped (queue full), (18) Steam found (1, -1 missing, 0 not yet), (19) relay-only confirmed,
 * (20) relay status (-1000 not asked), (21) the last send's Steam result, (22) the peer's hello received */
static int L_LinkInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    Link* L = &g_link;
    int64_t r = -1;
    int32_t sent = 0, got = 0;
    for (int i = 0; i < LK_NTYPES; ++i) { sent += L->sent[i]; got += L->got[i]; }
    switch (k) {
    case 0: r = L->state; break;            case 1: r = L->player; break;          case 2: r = L->reason; break;
    case 3: r = L->offsetUs / 1000; break;  case 4: r = L->rttUs / 1000; break;    case 5: r = L->nSamples; break;
    case 6: r = L->synced; break;           case 7: r = L->peerSynced; break;      case 8: r = L->goState; break;
    case 9: r = LinkGoDue(L); break;        case 10: r = sent; break;              case 11: r = got; break;
    case 12: r = L->badPeer; break;         case 13: r = L->badHeader; break;      case 14: r = L->badTag; break;
    case 15: r = L->sendFail; break;        case 16: r = (int32_t)(L->ringHead - L->ringTail); break;
    case 17: r = L->ringFull; break;        case 18: r = S.bound; break;
    case 19: r = S.iceSet == 1 && S.iceRead == 0; break;
    case 20: r = S.bound > 0 && S.relayAsked ? S.relayStatus(S.utils, NULL) : -1000; break;
    case 21: r = S.lastSendResult; break;   case 22: r = L->gotPeerHello; break;
    }
    U.luaSetInteger(lua, r);
    return 1;
}
/* RVNG_WireInfo(k): (0) wire, (1) this PC's link state, (2) the peer's (wire 1: the stand-in's; wire 2: -1),
 * (3) DATA sent, (4) DATA received, (5) mirrored or routed, (6) dropped by D1's receive rule, (7) the start gate opened
 * by the agreed time, (8) the host link's GO state, (9) the wire cut (wire 1), (10) send failures, (11) bad messages,
 * (12) the guest's game-clock shift in ms (-1 none), (13) ScoreUpdates sent (host), (14) DamageClients sent (guest) */
static int L_WireInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    Link* L = WireMine();
    Link* H = WireHost();
    int32_t r = -1;
    switch (k) {
    case 0: r = g_cfg.wire; break;
    case 1: r = L ? L->state : -1; break;
    case 2: r = g_cfg.wire == 1 ? g_lpB.state : -1; break;
    case 3: r = g_wireSent; break;
    case 4: r = g_wireGot; break;
    case 5: r = g_cfg.wire == 1 ? g_lbInjected : g_wireRouted; break;
    case 6: r = g_wireDropped; break;
    case 7: r = g_wireReleased; break;
    case 8: r = H ? H->goState : -1; break;
    case 9: r = g_wireCut; break;
    case 10: r = g_wireSendFail; break;
    case 11: r = L ? L->badHeader + L->badTag + L->badPeer : -1; break;
    case 12: r = g_clockApplied ? g_clockDeltaMs : -1; break;
    case 13: r = g_suSent; break;
    case 14: r = g_d3Injected; break;
    }
    U.luaSetInteger(lua, r);
    return 1;
}
/* web gate calls seen (A + B) and how many the game itself would have answered true */
static int L_GateCalls(void* lua) { U.luaSetInteger(lua, g_gateCalls[0] + g_gateCalls[1]); return 1; }
static int L_MapRequests(void* lua) { U.luaSetInteger(lua, g_mapRequests); return 1; }
static int L_LastMap(void* lua)
{
    static char a[256];
    size_t n = 0;
    for (; n < sizeof(a) - 1 && g_lastMap[n]; ++n) a[n] = g_lastMap[n] < 0x80 ? (char)g_lastMap[n] : '?';
    U.luaSetString(lua, a, n);
    return 1;
}
/* RVNG_Log(text): a line in this log (the self-test's lines land between the runtime's, in order) */
static int L_Log(void* lua)
{
    static wchar_t w[512];
    if (U.luaStackSize(lua) < 1 || !U.luaIsString(lua, 1)) return 0;
    StrView sv = { NULL, 0 };
    U.luaGetString(lua, &sv, 1);
    size_t n = 0;
    for (; sv.p && n < sv.n && n < 511; ++n) w[n] = (wchar_t)(uint8_t)sv.p[n];
    w[n] = 0;
    Log(L"lua: %s", w);
    return 0;
}

static void RegisterLua(void* lua)
{
    static const struct { const char* name; LuaFn fn; } kFns[] = {
        { "RVNG_Version", L_Version }, { "RVNG_ProbeOn", L_ProbeOn }, { "RVNG_Watch", L_Watch }, { "RVNG_ArmDM", L_ArmDM },
        { "RVNG_TravelDM", L_TravelDM }, { "RVNG_State", L_State }, { "RVNG_Hooks", L_Hooks },
        { "RVNG_MapReqs", L_MapRequests }, { "RVNG_LastMap", L_LastMap }, { "RVNG_Log", L_Log },
        { "RVNG_LastState", L_LastState }, { "RVNG_Tick", L_Tick }, { "RVNG_GateCalls", L_GateCalls },
        { "RVNG_FacInfo", L_FacInfo }, { "RVNG_OppInfo", L_OppInfo },
        { "RVNG_LbInfo", L_LbInfo }, { "RVNG_MenuReady", L_MenuReady }, { "RVNG_MenuPicks", L_MenuPicks },
        { "RVNG_MenuInfo", L_MenuInfo }, { "RVNG_HitInfo", L_HitInfo }, { "RVNG_LinkLoss", L_LinkLoss },
        { "RVNG_CheatInfo", L_CheatInfo }, { "RVNG_NetInfo", L_NetInfo }, { "RVNG_WallInfo", L_WallInfo },
        { "RVNG_EosInfo", L_EosInfo }, { "RVNG_LinkStart", L_LinkStart }, { "RVNG_LinkStop", L_LinkStop },
        { "RVNG_LinkGo", L_LinkGo }, { "RVNG_LinkSelf", L_LinkSelf }, { "RVNG_Relay", L_Relay }, { "RVNG_LinkInfo", L_LinkInfo },
        { "RVNG_LinkSend", L_LinkSend }, { "RVNG_LinkRecv", L_LinkRecv }, { "RVNG_WireInfo", L_WireInfo },
        { "RVNG_LinkReady", L_LinkReady }, { "RVNG_LinkLaunch", L_LinkLaunch }, { "RVNG_ReadyInfo", L_ReadyInfo },
        { "RVNG_MenuText", L_MenuText }, { "RVNG_ResultInfo", L_ResultInfo }, { "RVNG_MenuPage", L_MenuPage },
        { "RVNG_MenuPress", L_MenuPress }, { "RVNG_MenuRow", L_MenuRow }, { "RVNG_MenuSelect", L_MenuSelect },
        { "RVNG_OppName", L_OppName }, { "RVNG_OppShown", L_OppShown }, { "RVNG_MatchInfo", L_MatchInfo }, { "RVNG_MenuBack", L_MenuBack },
        /* the hangar test (hangar.h; each refuses without hangar=1) */
        { "RVNG_HangarGo", L_HangarGo }, { "RVNG_HangarEnd", L_HangarEnd }, { "RVNG_HangarShow", L_HangarShow },
        { "RVNG_PageNow", L_PageNow }, { "RVNG_PageName", L_PageName }, { "RVNG_PagePress", L_PagePress },
        { "RVNG_PageInfo", L_PageInfo }, { "RVNG_PageBack", L_PageBack }, { "RVNG_PageRows", L_PageRows },
        { "RVNG_PageRow", L_PageRow }, { "RVNG_UdmDump", L_UdmDump },
        /* RVNG's lobby in the hangar (lobby.h) */
        { "RVNG_HgInfo", L_HgInfo }, { "RVNG_HgSortie", L_HgSortie }, { "RVNG_HgOpp", L_HgOpp }, { "RVNG_HgLeave", L_HgLeave },
        { "RVNG_LoSend", L_LoSend }, { "RVNG_LoPeer", L_LoPeer }, { "RVNG_LoNames", L_LoNames }, { "RVNG_LoPeerName", L_LoPeerNames },
        { "RVNG_WireCut", L_WireCut }, { "RVNG_MatchStat", L_MatchStat }, { "RVNG_MatchEvent", L_MatchEvent },
    };
    if (!ResolveUE4SS()) { Log(L"Lua bridge: UE4SS exports missing; no RVNG_* functions"); return; }
    for (size_t i = 0; i < sizeof(kFns) / sizeof(kFns[0]); ++i) {
        MsvcString s; memset(&s, 0, sizeof(s));
        size_t n = 0;
        while (kFns[i].name[n]) ++n;
        if (n > 15) continue;                         /* the small-string buffer holds 15 characters */
        memcpy(s.u.buf, kFns[i].name, n + 1);
        s.size = n; s.cap = 15;
        LuaFn fn = kFns[i].fn;
        U.luaRegister(lua, &s, &fn);
    }
    Log(L"Lua bridge: %d RVNG_* functions registered", (int32_t)(sizeof(kFns) / sizeof(kFns[0])));
}

#define MOD_SLOTS 16
static int32_t g_slotCalls[MOD_SLOTS];

static void ModSlot(int slot, uintptr_t a, uintptr_t b)
{
    int32_t n = g_slotCalls[slot];
    if (n > 2000) return;                     /* called every frame: not a mod-start slot */
    g_slotCalls[slot] = n + 1;
    const WStrView* v = (const WStrView*)a;
    if (!Readable(v, sizeof(*v)) || !v->p || !v->n || v->n > 64 || !Readable(v->p, v->n * 2)) return;
    static const wchar_t kMe[] = MOD_NAME;
    if (v->n != sizeof(kMe) / 2 - 1 || memcmp(v->p, kMe, sizeof(kMe) - 2) != 0) return;
    if (!Readable((void*)b, 8)) return;
    Log(L"UE4SS: Lua mod %s started (mod slot %d)", MOD_NAME, slot);
    RegisterLua((void*)b);
}

/* D7's addresses from its signatures; the gate call's target must be gate B. */
static void ResolveLoginEnd(uint8_t* finish, uint8_t* slGate, uint8_t* t7, uint8_t* pa, uint8_t* gateB)
{
    int32_t d;
    if (slGate && gateB) {
        memcpy(&d, slGate + START_LOGIN_GATE_CALL + 1, 4);
        if (slGate + START_LOGIN_GATE_RET + d == gateB) g_slGateRet = slGate + START_LOGIN_GATE_RET;
        else Log(L"StartLogin's gate-B call: its target is not gate B; D7 is off");
    }
    if (t7) { memcpy(&d, t7 + TASK7_CB_DISP, 4); g_task7CbVt = t7 + TASK7_CB_DISP + 4 + d; }
    if (pa) { memcpy(&d, pa + PATH_A_CB_DISP, 4); g_pathACbVt = pa + PATH_A_CB_DISP + 4 + d; }
    g_finishLogin = (FinishLoginFn)(void*)finish;
    Log(L"D7 (boot login end): FinishLogin %s, gate return %s, boot callback vtable exe+%x, path A vtable exe+%x%s",
        finish ? L"found" : L"MISSING", g_slGateRet ? L"found" : L"MISSING",
        g_task7CbVt ? (uint32_t)((uint8_t*)g_task7CbVt - g_exe) : 0, g_pathACbVt ? (uint32_t)((uint8_t*)g_pathACbVt - g_exe) : 0,
        g_cfg.d7 ? L"" : L" (d7=0: off)");
}


/* test 6's game functions, from the call sites its signatures find */
static void ResolveFactions(uint8_t* call, uint8_t* lookup, uint8_t* assigner)
{
    if (call) { g_strihash = (StrihashFn)(void*)CallTarget(call + FAC_CALL_STRIHASH);
                g_facFindOrAdd = (FindOrAddFn)(void*)CallTarget(call + FAC_CALL_FINDORADD); }
    if (lookup) g_fstrAssign = (FStrAssignFn)(void*)CallTarget(lookup + FAC_LOOKUP_FSTR_ASSIGN);
    if (assigner) { g_getWorld = (Ptr1Fn)(void*)CallTarget(assigner + FAC_ASSIGN_GETWORLD);
                    g_worldSub = (Ptr1Fn)(void*)CallTarget(assigner + FAC_ASSIGN_WORLDSUB); }
    Log(L"test 6 (factions): Strihash %s, FindOrAdd %s, FString copy %s, GetWorld %s, world subsystem %s",
        g_strihash ? L"found" : L"MISSING", g_facFindOrAdd ? L"found" : L"MISSING", g_fstrAssign ? L"found" : L"MISSING",
        g_getWorld ? L"found" : L"MISSING", g_worldSub ? L"found" : L"MISSING");
}

/* ---- install (worker thread) -------------------------------------------- */
/* D9's send points (every install); returns how many are hooked (of W_N) */
static int InstallWall(uint8_t* lwaStart, uint8_t* cosmos, uint8_t* curl, uint8_t* lws, uint8_t* strix, uint8_t* messenger)
{
    int n = 0;
    n += HookInline(lwaStart, LENS_LWA_START, (void*)OnLwaStart, &g_origWall[W_LWA], L"D9: LiveWebAPI request start");
    n += HookInline(cosmos, LENS_COSMOS_SEND, (void*)OnCosmosSend, &g_origWall[W_COSMOS], L"D9: Cosmos sender");
    g_curlProcessFn = curl;                            /* (before the hook is live: OnCurlProcess checks the vtable with it) */
    n += HookInline(curl, LENS_CURL_PROCESS, (void*)OnCurlProcess, (void**)&g_origCurlProcess, L"D9: engine HTTP request start");
    n += HookInline(lws, LENS_LWS_CONNECT, (void*)OnLwsConnect, &g_origWall[W_WS], L"D9: WebSocket client connect");
    n += HookInline(strix, LENS_STRIX_INIT, (void*)OnStrixInit, &g_origWall[W_STRIX], L"D9: the game's Strix start");
    n += HookInline(messenger, LENS_MESSENGER_INIT, (void*)OnMessengerInit, &g_origWall[W_MESSENGER], L"D9: the game's Messenger set-up");
    g_wallIn = n;
    return n;
}

/* a gate found through its call site: the call's target, if it starts as the template's head */
static uint8_t* GateAt(uint8_t* call, const uint8_t* head, const wchar_t* what)
{
    if (!call) return NULL;
    uint8_t* t = CallTarget(call);
    if (t && Readable(t, sizeof(kGateAHead)) && memcmp(t, head, sizeof(kGateAHead)) == 0) return t;
    Log(L"%s: the call site's target does not start as expected; not used", what);
    return NULL;
}

/* D9's nine more gates (every install): false, like A and B */
static int InstallMoreGates(uint8_t* const at[GATE_N])
{
    static const wchar_t* const kWhat[GATE_N] = {
        NULL, NULL, L"D9: user-data gate", L"D9: lobbies gate", L"D9: items gate", L"D9: guilds gate",
        L"D9: master-data gate", L"D9: friends gate", L"D9: settings gate", L"D9: blocks gate", L"D9: currencies gate",
    };
    int n = 0;
    for (int i = GATE_USER; i < GATE_N; ++i)
        n += HookInline(at[i], i == GATE_BLOCKS ? LENS_WEB_GATE_BLOCKS : LENS_WEB_GATE_TPL, (void*)kGateDetour[i],
                        (void**)&g_origGate[i], kWhat[i]);
    g_wallGatesIn = n;
    return n;
}

static DWORD WINAPI Worker(void* arg)
{
    (void)arg;
    if (!ReadImage()) { Log(L"game image not found"); return 0; }
    Log(L"game exe: %x bytes mapped, link timestamp %x", (uint32_t)g_exeSize, g_exeStamp);
    enum { P_GATE_A_CALL, P_GATE_B, P_PHASE, P_SET, P_NEXT, P_TRANS, P_MAP, P_SEND, P_ROW, P_PREP, P_FINISH, P_SL_GATE, P_T7_LEA,
           P_PA_LEA, P_FAC_CALL, P_FAC_LOOKUP, P_FAC_ASSIGN,
           P_SET_CONFIRMED, P_MRMM_CONFIRM, P_FILL_SEL, P_REMOTE_SPAWN, P_TARR_COPY, P_NM_RESET,
           P_ENC_ANCHOR, P_DEC_ANCHOR, P_DESER_SP, P_ROUTER, P_PUMP, P_MENU_BASE, P_MAIN_DECIDE, P_TEXT, P_TEXT_HOOKED,
           P_TOTAL_SCORE, P_DC_HANDLER, P_AUTH_APPLY, P_TD_LOCAL, P_SCORE_FN, P_AA_DTOR, P_SU_HANDLER, P_REPORT_CHEAT,
           P_LWA_START, P_LWA_ADD, P_COSMOS, P_CURL, P_LWS, P_STRIX, P_MESSENGER, P_G_USER, P_G_LOBBY, P_G_ITEM, P_G_GUILD,
           P_G_MASTER, P_G_FRIENDS, P_G_SETTINGS, P_G_BLOCKS, P_G_CURRENCIES, P_PHYS_FILL, P_SET_CMD_INDEX, P_MENU_HOVER,
           P_GO_LEVEL, P_GO_MISSION, P_APPLY_GROUP, P_SPEC_CTOR, P_NAME_ENTRY, P_STANDBY_DECIDE, P_TOP_DECIDE, P_MENU_SOUND, P_DG_SET_PLANE, P_DG_SET_SKIN, P_HANGAR_QUIT, P_N };
    static uint8_t textHookedPat[15 + sizeof(kSigTextTail)], textHookedMask[15 + sizeof(kSigTextTail)];
    memset(textHookedMask, 1, sizeof(textHookedMask));
    textHookedPat[0] = 0xFF; textHookedPat[1] = 0x25;            /* jmp [rip+0]; dq ?; nop; then the tail */
    for (int i = 6; i < 14; ++i) textHookedMask[i] = 0;
    textHookedPat[14] = 0x90;
    memcpy(textHookedPat + 15, kSigTextTail, sizeof(kSigTextTail));
    Pattern pats[P_N] = {
        { L"web gate A call site", kSigWebGateACall, kSigWebGateACallMask, sizeof(kSigWebGateACall), NULL, 0 },
        { L"web gate B", kSigWebGateB, NULL, sizeof(kSigWebGateB), NULL, 0 },
        { L"phaseIndex gate", kSigPhaseGate, kSigPhaseGateMask, sizeof(kSigPhaseGate), NULL, 0 },
        { L"SetState", kSigSetState, NULL, sizeof(kSigSetState), NULL, 0 },
        { L"NextState", kSigNextState, kSigNextStateMask, sizeof(kSigNextState), NULL, 0 },
        { L"menu transition", kSigTransition, NULL, sizeof(kSigTransition), NULL, 0 },
        { L"RequestChangeMap", kSigChangeMap, NULL, sizeof(kSigChangeMap), NULL, 0 },
        { L"Send", kSigSend, kSigSendMask, sizeof(kSigSend), NULL, 0 },
        { L"level row lookup", kSigLevelRow, NULL, sizeof(kSigLevelRow), NULL, 0 },
        { L"NetworkManager prepare", kSigNmPrepare, NULL, sizeof(kSigNmPrepare), NULL, 0 },
        { L"FinishLogin", kSigFinishLogin, NULL, sizeof(kSigFinishLogin), NULL, 0 },
        { L"StartLogin's gate-B call", kSigStartLoginGate, kSigStartLoginGateMask, sizeof(kSigStartLoginGate), NULL, 0 },
        { L"boot login callback lea", kSigTask7CbLea, kSigTask7CbLeaMask, sizeof(kSigTask7CbLea), NULL, 0 },
        { L"path A callback lea", kSigPathACbLea, kSigPathACbLeaMask, sizeof(kSigPathACbLea), NULL, 0 },
        { L"faction FindOrAdd call", kSigFactionFindOrAddCall, kSigFactionFindOrAddCallMask, sizeof(kSigFactionFindOrAddCall), NULL, 0 },
        { L"faction lookup", kSigFactionLookup, NULL, sizeof(kSigFactionLookup), NULL, 0 },
        { L"DM faction assigner", kSigDmFactionAssigner, kSigDmFactionAssignerMask, sizeof(kSigDmFactionAssigner), NULL, 0 },
        { L"SetConfirmed", kSigSetConfirmed, kSigSetConfirmedMask, sizeof(kSigSetConfirmed), NULL, 0 },
        { L"MRMM confirm handler", kSigMrmmConfirm, NULL, sizeof(kSigMrmmConfirm), NULL, 0 },
        { L"selector fill", kSigFillFromUdm, NULL, sizeof(kSigFillFromUdm), NULL, 0 },
        { L"remote spawn", kSigRemoteSpawn, kSigRemoteSpawnMask, sizeof(kSigRemoteSpawn), NULL, 0 },
        { L"TArray copy call", kSigTArrCopyCall, kSigTArrCopyCallMask, sizeof(kSigTArrCopyCall), NULL, 0 },
        { L"NM ResetMatchedInfo call", kSigNmResetCall, kSigNmResetCallMask, sizeof(kSigNmResetCall), NULL, 0 },
        { L"message encode anchor", kSigEncAnchor, kSigEncAnchorMask, sizeof(kSigEncAnchor), NULL, 0 },
        { L"message decode anchor", kSigDecAnchor, kSigDecAnchorMask, sizeof(kSigDecAnchor), NULL, 0 },
        { L"DeserSp", kSigDeserSp, NULL, sizeof(kSigDeserSp), NULL, 0 },
        { L"router", kSigRouter, NULL, sizeof(kSigRouter), NULL, 0 },
        { L"slot pump", kSigPump, NULL, sizeof(kSigPump), NULL, 0 },
        { L"menu base", kSigMenuBase, NULL, sizeof(kSigMenuBase), NULL, 0 },
        { L"main menu decide", kSigMainDecide, kSigMainDecideMask, sizeof(kSigMainDecide), NULL, 0 },
        { L"text lookup", kSigText, NULL, sizeof(kSigText), NULL, 0 },
        { L"text lookup (hooked by another mod)", textHookedPat, textHookedMask, sizeof(textHookedPat), NULL, 0 },
        { L"TotalScore", kSigTotalScore, NULL, sizeof(kSigTotalScore), NULL, 0 },
        { L"DamageClient handler", kSigDCHandler, NULL, sizeof(kSigDCHandler), NULL, 0 },
        { L"AuthoritativeApply", kSigAuthApply, NULL, sizeof(kSigAuthApply), NULL, 0 },
        { L"TakeDamage's local AuthoritativeApply call", kSigTdLocalAuthCall, kSigTdLocalAuthCallMask, sizeof(kSigTdLocalAuthCall), NULL, 0 },
        { L"score function", kSigScoreFn, kSigScoreFnMask, sizeof(kSigScoreFn), NULL, 0 },
        { L"AuthoritativeApply's tail (the info destructor)", kSigAaDtorTail, NULL, sizeof(kSigAaDtorTail), NULL, 0 },
        { L"ScoreUpdate handler", kSigScoreUpdateHandler, NULL, sizeof(kSigScoreUpdateHandler), NULL, 0 },
        { L"ReportCheat (D8)", kSigReportCheat, NULL, sizeof(kSigReportCheat), NULL, 0 },
        { L"LiveWebAPI request start (D9)", kSigLwaStart, NULL, sizeof(kSigLwaStart), NULL, 0 },
        { L"LiveWebAPI AddRequest (D9 logger)", kSigLwaAddRequest, NULL, sizeof(kSigLwaAddRequest), NULL, 0 },
        { L"Cosmos sender (D9)", kSigCosmosSend, NULL, sizeof(kSigCosmosSend), NULL, 0 },
        { L"engine HTTP request start (D9)", kSigCurlProcess, NULL, sizeof(kSigCurlProcess), NULL, 0 },
        { L"WebSocket client connect (D9)", kSigLwsConnect, NULL, sizeof(kSigLwsConnect), NULL, 0 },
        { L"Strix start (D9)", kSigStrixInit, kSigStrixInitMask, sizeof(kSigStrixInit), NULL, 0 },
        { L"Messenger set-up (D9)", kSigMessengerInit, NULL, sizeof(kSigMessengerInit), NULL, 0 },
        { L"user-data gate call site (D9)", kSigGateUserCall, kSigGateUserCallMask, sizeof(kSigGateUserCall), NULL, 0 },
        { L"lobbies gate call site (D9)", kSigGateLobbyCall, kSigGateLobbyCallMask, sizeof(kSigGateLobbyCall), NULL, 0 },
        { L"items gate call site (D9)", kSigGateItemCall, kSigGateItemCallMask, sizeof(kSigGateItemCall), NULL, 0 },
        { L"guilds gate call site (D9)", kSigGateGuildCall, kSigGateGuildCallMask, sizeof(kSigGateGuildCall), NULL, 0 },
        { L"master-data gate call site (D9)", kSigGateMasterCall, kSigGateMasterCallMask, sizeof(kSigGateMasterCall), NULL, 0 },
        { L"friends gate (D9)", kSigGateFriends, NULL, sizeof(kSigGateFriends), NULL, 0 },
        { L"settings gate (D9)", kSigGateSettings, NULL, sizeof(kSigGateSettings), NULL, 0 },
        { L"blocks gate (D9)", kSigGateBlocks, kSigGateBlocksMask, sizeof(kSigGateBlocks), NULL, 0 },
        { L"currencies gate (D9)", kSigGateCurrencies, NULL, sizeof(kSigGateCurrencies), NULL, 0 },
        { L"Physics fill (the synced clock)", kSigPhysFill, NULL, sizeof(kSigPhysFill), NULL, 0 },
        { L"menu SetSelectedIndex", kSigSetCmdIndex, kSigSetCmdIndexMask, sizeof(kSigSetCmdIndex), NULL, 0 },
        { L"menu hover sync", kSigMenuHover, kSigMenuHoverMask, sizeof(kSigMenuHover), NULL, 0 },
        { L"GoToLevel (the hangar)", kSigGoToLevel, NULL, sizeof(kSigGoToLevel), NULL, 0 },
        { L"GoToMission (the hangar)", kSigGoToMission, NULL, sizeof(kSigGoToMission), NULL, 0 },
        { L"ApplyGroupDisplay (the hangar)", kSigApplyGroup, kSigApplyGroupMask, sizeof(kSigApplyGroup), NULL, 0 },
        { L"display spec ctor (the hangar)", kSigSpecCtor, NULL, sizeof(kSigSpecCtor), NULL, 0 },
        { L"FName entry resolver (the name pool)", kSigNameEntry, kSigNameEntryMask, sizeof(kSigNameEntry), NULL, 0 },
        { L"STANDBY decide (the hangar)", kSigStandbyDecide, kSigStandbyDecideMask, sizeof(kSigStandbyDecide), NULL, 0 },
        { L"HANGAR MENU decide (the hangar)", kSigTopDecide, NULL, sizeof(kSigTopDecide), NULL, 0 },
        { L"menu PlaySound (the hangar)", kSigMenuSound, kSigMenuSoundMask, sizeof(kSigMenuSound), NULL, 0 },
        { L"display group SetPlane (the hangar)", kSigDgSetPlane, NULL, sizeof(kSigDgSetPlane), NULL, 0 },
        { L"display group SetSkin (the hangar)", kSigDgSetSkin, NULL, sizeof(kSigDgSetSkin), NULL, 0 },
        { L"the hangar's quit", kSigHangarQuit, NULL, sizeof(kSigHangarQuit), NULL, 0 },
    };
    ScanCode(pats, P_N);
    g_setCmdIndex = (SetCmdIndexFn)(void*)pats[P_SET_CMD_INDEX].hit;
    if (pats[P_MENU_HOVER].hit) {
        int32_t h, sel;
        memcpy(&h, pats[P_MENU_HOVER].hit + MENU_HOVER_OFF, 4);
        memcpy(&sel, pats[P_MENU_HOVER].hit + MENU_HOVER_SEL, 4);
        if (h > 0 && h < 0x1000 && sel > 0 && sel < 0x1000) { g_hoverOff = h; g_hoverSelOff = sel; }
    }
    if (pats[P_PHYS_FILL].hit) {                                   /* the game's synced clock, for the two-PC link */
        g_clockObj = (ClockObjFn)(void*)CallTarget(pats[P_PHYS_FILL].hit + PHYS_FILL_CLOCK_OBJ);
        g_clockNow = (ClockNowFn)(void*)CallTarget(pats[P_PHYS_FILL].hit + PHYS_FILL_CLOCK_NOW);
    }

    if (pats[P_ROW].hit) {
        uint8_t* l = pats[P_ROW].hit + LEVEL_ROW_DEFAULT_LEA;
        if (l[0] == 0x48 && l[1] == 0x8D && l[2] == 0x05) {
            int32_t disp; memcpy(&disp, l + 3, 4);
            g_levelRowDefault = l + 7 + disp;
            g_levelRow = (LevelRowFn)(void*)pats[P_ROW].hit;
        } else {
            Log(L"level row lookup: its \"no row\" answer is not where expected; RVNG_TravelDM is off");
        }
    }
    if (pats[P_PREP].hit) g_nmPrepare = (NmPrepareFn)(void*)pats[P_PREP].hit;
    g_fChangeMap = pats[P_MAP].hit;
    ResolveLoginEnd(pats[P_FINISH].hit, pats[P_SL_GATE].hit, pats[P_T7_LEA].hit, pats[P_PA_LEA].hit, pats[P_GATE_B].hit);
    ResolveFactions(pats[P_FAC_CALL].hit, pats[P_FAC_LOOKUP].hit, pats[P_FAC_ASSIGN].hit);
    g_setConfirmed = (SetConfirmedFn)(void*)pats[P_SET_CONFIRMED].hit;
    if (pats[P_MRMM_CONFIRM].hit) {
        g_terminateSel = (MrmmFn)(void*)CallTarget(pats[P_MRMM_CONFIRM].hit + MRMM_CONFIRM_TERMINATE);
        g_buildSel = (MrmmFn)(void*)CallTarget(pats[P_MRMM_CONFIRM].hit + MRMM_CONFIRM_BUILD);
    }
    g_fillSel = (FillSelFn)(void*)pats[P_FILL_SEL].hit;
    if (pats[P_TARR_COPY].hit) g_tarrCopy = (TArrCopyFn)(void*)CallTarget(pats[P_TARR_COPY].hit + TARR_COPY_CALL);
    if (pats[P_NM_RESET].hit) g_nmReset = (NmResetFn)(void*)CallTarget(pats[P_NM_RESET].hit + NM_RESET_CALL);
    if (pats[P_ENC_ANCHOR].hit) {
        g_msCtor = (MsCtorFn)(void*)CallTarget(pats[P_ENC_ANCHOR].hit + ENC_MSCTOR);
        g_encInit = (EncInitFn)(void*)CallTarget(pats[P_ENC_ANCHOR].hit + ENC_INIT);
        g_serialize = (SerializeFn)(void*)CallTarget(pats[P_ENC_ANCHOR].hit + ENC_SERIALIZE);
    }
    if (pats[P_DEC_ANCHOR].hit) g_decCtor = (DecCtorFn)(void*)CallTarget(pats[P_DEC_ANCHOR].hit + DEC_CTOR);
    g_deserSp = (DeserSpFn)(void*)pats[P_DESER_SP].hit;
    g_totalScore = (TotalScoreFn)(void*)pats[P_TOTAL_SCORE].hit;
    if (pats[P_DC_HANDLER].hit) g_dcMeta = (MetaFn)(void*)CallTarget(pats[P_DC_HANDLER].hit + DC_HANDLER_GETTER);
    if (pats[P_SU_HANDLER].hit) {
        uint8_t* h = pats[P_SU_HANDLER].hit;
        g_suMeta = (MetaFn)(void*)CallTarget(h + SU_HANDLER_GETTER);
        if (h[SU_HANDLER_ELEM_LEA] == 0x4C && h[SU_HANDLER_ELEM_LEA + 1] == 0x8D && h[SU_HANDLER_ELEM_LEA + 2] == 0x2D) {
            int32_t d; memcpy(&d, h + SU_HANDLER_ELEM_LEA + 3, 4);
            g_scoreDataVt = h + SU_HANDLER_ELEM_LEA + 7 + d;
        }
    }
    if (pats[P_TD_LOCAL].hit && CallTarget(pats[P_TD_LOCAL].hit + TD_LOCAL_AUTH_CALL) == pats[P_AUTH_APPLY].hit)
        g_tdLocalRet = pats[P_TD_LOCAL].hit + TD_LOCAL_AUTH_RET;
    if (pats[P_AA_DTOR].hit && pats[P_AA_DTOR].hit[AA_DTOR_JMP] == 0xE9) {
        int32_t d; memcpy(&d, pats[P_AA_DTOR].hit + AA_DTOR_JMP + 1, 4);
        g_infoDtor = (InfoDtorFn)(void*)(pats[P_AA_DTOR].hit + AA_DTOR_JMP + 5 + d);
    }
    g_router = (RouterFn)(void*)pats[P_ROUTER].hit;
    Log(L"test 4 (loopback): MsCtor %s, EncInit %s, Serialize %s, DecCtor %s, DeserSp %s, router %s, slot pump %s",
        g_msCtor ? L"found" : L"MISSING", g_encInit ? L"found" : L"MISSING", g_serialize ? L"found" : L"MISSING",
        g_decCtor ? L"found" : L"MISSING", g_deserSp ? L"found" : L"MISSING", g_router ? L"found" : L"MISSING",
        pats[P_PUMP].hit ? L"found" : L"MISSING");
    Log(L"test 3 (opponent): SetConfirmed %s, selector build %s, TerminateAircraftSelector %s, fill %s, TArray copy %s, ResetMatchedInfo %s",
        g_setConfirmed ? L"found" : L"MISSING", g_buildSel ? L"found" : L"MISSING", g_terminateSel ? L"found" : L"MISSING",
        g_fillSel ? L"found" : L"MISSING", g_tarrCopy ? L"found" : L"MISSING", g_nmReset ? L"found" : L"MISSING");

    uint8_t* gateA = NULL;
    if (pats[P_GATE_A_CALL].hit) {
        uint8_t* call = pats[P_GATE_A_CALL].hit;
        int32_t rel; memcpy(&rel, call + 1, 4);
        uint8_t* t = call + 5 + rel;
        if (InGame(t) && Readable(t, sizeof(kGateAHead)) && memcmp(t, kGateAHead, sizeof(kGateAHead)) == 0) gateA = t;
        else Log(L"web gate A: the call site's target does not start as expected; not used");
    }
    if (pats[P_SEND].hit) {
        uint8_t* s = pats[P_SEND].hit;
        int32_t disp; memcpy(&disp, s + SEND_GLOBAL_DISP, 4);
        g_clientGlobal = (uint8_t**)(s + SEND_GLOBAL_DISP + 4 + disp);
        Log(L"Strix client global at exe+%x", (uint32_t)((uint8_t*)g_clientGlobal - g_exe));
    }

    /* D9 in every install (0.3.6), first: the network wall, then the nine more gates */
    int wall = InstallWall(pats[P_LWA_START].hit, pats[P_COSMOS].hit, pats[P_CURL].hit, pats[P_LWS].hit, pats[P_STRIX].hit,
                           pats[P_MESSENGER].hit);
    uint8_t* gates9[GATE_N] = { 0 };
    gates9[GATE_USER] = GateAt(pats[P_G_USER].hit, kGateCHead, L"user-data gate");
    gates9[GATE_LOBBY] = GateAt(pats[P_G_LOBBY].hit, kGateCHead, L"lobbies gate");
    gates9[GATE_ITEM] = GateAt(pats[P_G_ITEM].hit, kGateCHead, L"items gate");
    gates9[GATE_GUILD] = GateAt(pats[P_G_GUILD].hit, kGateAHead, L"guilds gate");
    gates9[GATE_MASTER] = GateAt(pats[P_G_MASTER].hit, kGateAHead, L"master-data gate");
    gates9[GATE_FRIENDS] = pats[P_G_FRIENDS].hit;
    gates9[GATE_SETTINGS] = pats[P_G_SETTINGS].hit;
    gates9[GATE_BLOCKS] = pats[P_G_BLOCKS].hit;
    gates9[GATE_CURRENCIES] = pats[P_G_CURRENCIES].hit;
    int more = InstallMoreGates(gates9);
    if (wall != W_N || more != GATE_N - 2)
        Log(L"WARNING: D9 only partly in (%d of %d send points, %d of %d more gates): what is missing is named above",
            wall, W_N, more, GATE_N - 2);

    /* D5 and D7 in every install (0.2.4): the web gates answer false whether or not the test logger is on */
    int n = 0;
    n += HookInline(gateA, LENS_WEB_GATE_A, (void*)OnGateA, (void**)&g_origGate[0], L"web gate A");
    n += HookInline(pats[P_GATE_B].hit, LENS_WEB_GATE_B, (void*)OnGateB, (void**)&g_origGate[1], L"web gate B");
    if (n != 2) Log(L"WARNING: only %d of the 2 web gates hooked: the game's online code is not fully held back", n);
    /* D8 in every install too: the game's cheat reports are never made */
    int d8 = HookInline(pats[P_REPORT_CHEAT].hit, LENS_REPORT_CHEAT, (void*)OnReportCheat, (void**)&g_origReportCheat,
                        L"ReportCheat (D8: the game's cheat reports off)");
    if (!d8) Log(L"WARNING: D8 not hooked: the game's cheat reports are still made (D1, D5 and the offline flags still keep them in)");
    n += d8;
    InstallMenuRow(pats[P_MENU_BASE].hit, pats[P_MAIN_DECIDE].hit, pats[P_TEXT].hit, pats[P_TEXT_HOOKED].hit);
    /* The match hooks, in every install (2026-11-19, the user's decision): in from the start, so a match never waits on
     * a hook going in mid-session. Until an RVNG match is armed (MatchArm), or without the test logger's settings for
     * one, each passes the game's call straight on: D1's Send and the slot pump on loopback, the phaseIndex gate on d2,
     * SetState / NextState on LIVE(), the score function on loopback (+ guest or hit), AuthoritativeApply on guest */
    int m = 0;
    m += HookInline(pats[P_PHASE].hit, LENS_PHASE_GATE, (void*)OnPhaseGate, (void**)&g_origPhase, L"phaseIndex gate");
    m += HookInline(pats[P_SET].hit, LENS_SET_STATE, (void*)OnSetState, (void**)&g_origSetState, L"SetState");
    m += HookInline(pats[P_NEXT].hit, LENS_NEXT_STATE, (void*)OnNextState, (void**)&g_origNextState, L"NextState");
    m += HookInline(pats[P_MAP].hit, LENS_CHANGE_MAP, (void*)OnChangeMap, (void**)&g_origChangeMap, L"RequestChangeMap");
    m += HookInline(pats[P_SEND].hit, LENS_SEND, (void*)OnSend, (void**)&g_origSend, L"Send (D1: replaced in a match)");
    m += HookInline(pats[P_PUMP].hit, LENS_PUMP, (void*)OnPump, (void**)&g_origPump, L"slot pump");
    int sc = HookInline(pats[P_SCORE_FN].hit, LENS_SCORE_FN, (void*)OnScoreFn, (void**)&g_origScoreFn,
                        L"score function (D4 on the guest; the host's ScoreUpdate in test 7)");
    int d3 = 0;
    if (g_tdLocalRet && g_infoDtor && g_dcMeta)
        d3 = HookInline(pats[P_AUTH_APPLY].hit, LENS_AUTH_APPLY, (void*)OnAuthApply, (void**)&g_origAuthApply, L"AuthoritativeApply (D3)");
    else
        Log(L"D3/D4: a piece is missing (local return %p, info destructor %p, DamageClient metaclass %p): not hooked",
            g_tdLocalRet, (void*)g_infoDtor, (void*)g_dcMeta);
    g_matchCore = m == 6 && sc;
    g_matchGuest = d3 && sc;
    n += m + sc + d3;
    if (!g_matchCore) Log(L"WARNING: only %d of the 7 match hooks in: no RVNG match can start in this session", m + sc);
    /* RVNG's lobby in the hangar (0.4.3, every install; idle until a match opens the hangar; counted apart: RVNG_HgInfo(0)) */
    InstallHangar(pats[P_MENU_BASE].hit, pats[P_GO_LEVEL].hit, pats[P_GO_MISSION].hit, pats[P_APPLY_GROUP].hit,
                  pats[P_SPEC_CTOR].hit, pats[P_REMOTE_SPAWN].hit, pats[P_NAME_ENTRY].hit, pats[P_STANDBY_DECIDE].hit,
                  pats[P_TOP_DECIDE].hit, pats[P_MENU_SOUND].hit, pats[P_DG_SET_PLANE].hit, pats[P_DG_SET_SKIN].hit,
                  pats[P_HANGAR_QUIT].hit);
    if (!g_cfg.probe) {
        g_hooked = n;
        Log(L"ready: %d hooks: the 2 web gates answer false, D8 cheat reports %s, the match hooks %s (they pass the game's calls on until an RVNG match; the guest's D3/D4 %s); D9's network wall (%d of %d send points, %d of %d more gates), boot login end %s; test logger off (rvng_test.ini probe=1 turns it on)",
            n, d8 ? L"off" : L"NOT off", g_matchCore ? L"in" : L"NOT all in", g_matchGuest ? L"in" : L"NOT in", wall, W_N, more,
            GATE_N - 2, g_cfg.d7 && g_finishLogin && g_slGateRet && g_task7CbVt ? L"armed" : L"OFF");
        return 0;
    }
    if (HookInline(pats[P_LWA_ADD].hit, LENS_LWA_ADD, (void*)OnLwaAdd, (void**)&g_origLwaAdd, L"D9 logger: LiveWebAPI AddRequest"))
        g_lwaQueued = 0;                               /* (not in the logger's count: D9's own, RVNG_WallInfo(12)) */
    n += HookInline(pats[P_TRANS].hit, LENS_TRANSITION, (void*)OnTransition, (void**)&g_origTransition, L"menu transition");
    if (g_cfg.opponent)                                /* (log-only pass-through; only in the opponent test) */
        n += HookInline(pats[P_REMOTE_SPAWN].hit, LENS_REMOTE_SPAWN, (void*)OnRemoteSpawn, (void**)&g_origRemoteSpawn, L"remote spawn");
    g_hooked = n;
    Log(L"test logger ready: %d hooks (and D9's wall: %d of %d send points, %d of %d more gates); deathmatch travel %s", n,
        wall, W_N, more, GATE_N - 2,
        g_levelRow && g_nmPrepare && g_fChangeMap ? L"available" : L"NOT available");
    return 0;
}

/* ---- the UE4SS mod object --------------------------------------------- */
static void SetWString(MsvcWString* s, const wchar_t* text)
{
    size_t n = WLen(text);
    if (n <= 7) { memcpy(s->u.buf, text, (n + 1) * 2); s->size = n; s->cap = 7; return; }
    size_t cap = n | 7;
    wchar_t* p = (wchar_t*)malloc((cap + 1) * 2);
    if (!p) return;
    memcpy(p, text, (n + 1) * 2);
    s->u.ptr = p; s->size = n; s->cap = cap;
}

#define MOD_OBJECT_SIZE 0x200
#define VTABLE_SLOTS    40
static int g_instances;

static void* WINAPI Mod_DeletingDtor(void* self, uint32_t flags)
{
    if (g_instances > 0) --g_instances;
    UE4SS_ModBase_Dtor(self);
    if (flags & 1) free(self);
    return self;
}

static void* WINAPI Mod_NoOp(void) { return NULL; }

#define MOD_SLOT(n) static void* WINAPI Mod_Slot##n(void* self, uintptr_t a, uintptr_t b) { (void)self; ModSlot(n, a, b); return NULL; }
MOD_SLOT(1)  MOD_SLOT(2)  MOD_SLOT(3)  MOD_SLOT(4)  MOD_SLOT(5)  MOD_SLOT(6)  MOD_SLOT(7)  MOD_SLOT(8)
MOD_SLOT(9)  MOD_SLOT(10) MOD_SLOT(11) MOD_SLOT(12) MOD_SLOT(13) MOD_SLOT(14) MOD_SLOT(15)
#undef MOD_SLOT

static void* const g_modVtable[1 + VTABLE_SLOTS] = {
    [0]  = NULL,
    [1]  = (void*)Mod_DeletingDtor,
    [2]  = (void*)Mod_Slot1,  [3]  = (void*)Mod_Slot2,  [4]  = (void*)Mod_Slot3,  [5]  = (void*)Mod_Slot4,
    [6]  = (void*)Mod_Slot5,  [7]  = (void*)Mod_Slot6,  [8]  = (void*)Mod_Slot7,  [9]  = (void*)Mod_Slot8,
    [10] = (void*)Mod_Slot9,  [11] = (void*)Mod_Slot10, [12] = (void*)Mod_Slot11, [13] = (void*)Mod_Slot12,
    [14] = (void*)Mod_Slot13, [15] = (void*)Mod_Slot14, [16] = (void*)Mod_Slot15,
    [17 ... VTABLE_SLOTS] = (void*)Mod_NoOp,
};

EXPORT void* start_mod(void)
{
    uint8_t* mod = (uint8_t*)malloc(MOD_OBJECT_SIZE);
    if (!mod) return NULL;
    memset(mod, 0, MOD_OBJECT_SIZE);
    UE4SS_ModBase_Ctor(mod);
    *(void* const**)mod = &g_modVtable[1];
    SetWString((MsvcWString*)(mod + 0x20), MOD_NAME);
    SetWString((MsvcWString*)(mod + 0x40), RT_VERSION);
    SetWString((MsvcWString*)(mod + 0x60), L"Project RVNG: in-game test logger");
    SetWString((MsvcWString*)(mod + 0x80), L"Project RVNG");
    if (g_instances++ == 0) {
        ModPaths();
        OpenLog();
        Log(L"Project RVNG runtime %s", RT_VERSION);
        ReadSettings();
        if (g_cfg.netlog) NlStart();        /* (test only; before anything else, so the boot's first calls are seen) */
        EwStart();                          /* (D9's EOS part, every install; before the EOS SDK loads, about 2 s later) */
        HANDLE th = CreateThread(NULL, 0, Worker, NULL, 0, NULL);
        if (th) CloseHandle(th); else Log(L"could not start the install thread");
    }
    return mod;
}

EXPORT void uninstall_mod(void* mod)
{
    typedef void* (WINAPI *DeletingDtor)(void*, uint32_t);
    if (mod) ((DeletingDtor)(**(void***)mod))(mod, 1);
}

BOOL WINAPI DllMain(HANDLE module, DWORD reason, void* reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) { g_hModule = module; DisableThreadLibraryCalls(module); }
    return 1;
}
