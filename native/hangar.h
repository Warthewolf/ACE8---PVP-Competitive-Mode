/* hangar.h (2026-11-21, runtime 0.4.2): the stock pre-sortie hangar for RVNG's lobby. The user: players pick and edit
 * their aircraft in the hangar before the match, "launch straight into the hangar", the opponent's plane where the
 * wingman's stands, and SORTIE blocked until both players are ready (docs/re/hangar/, DEATHMATCH_NATIVE 9.14).
 *
 * This first step is the in-game probe (rvng_test.ini hangar=1, the kit's `hangar` suite); nothing here runs without
 * hangar=1:
 *   - the travel from the main menu into the hangar (PL_Hangar002, level 13) with a free-mission context (Mission006,
 *     mode 2), the way the stock free mission's difficulty page goes there (GoToLevel, the page's own request);
 *   - the menu base's confirm input (slot 0xDF) hooked: the active page is the one whose tick asks it, and a press the
 *     self-test asks for runs that page's own decide inside its own tick (posted keys don't reach an unfocused game);
 *     B / Esc through the page's own pending-cancel byte, as RVNG_MenuBack does on the main menu;
 *   - GoToMission hooked as a safety net: while RVNG's hangar session is up no campaign or free mission starts;
 *   - the opponent's plane on the wingman's spot (display group 1) through LiveHangarManager::ApplyGroupDisplay, only
 *     for a stock aircraft id (kStockPlanes: the 32 base aircraft, the ADF-X02, the F-14A DLC; the user's rule);
 *   - the loadout fields read (the UDM's four member loadouts, the mission context, the weapons and parts arrays). */

#define UDM_MEMBERS     0xd28     /* 4 x 0x28: k = 0 the player, 1..3 the wingmen: +0 aircraft, +4/+5 specials, +8 skin,
                                   * +0x10 TArray emblems, +0x20..+0x22 paint bytes, +0x24 the aircraft-set number */
#define UDM_MEMBER_SIZE 0x28
#define UDM_WEAPONS     0xdd8     /* TArray<int32> (not per member; the main menu empties it when it builds) */
#define UDM_PARTS       0xde8
#define UDM_MISSION     0xf38     /* the mission context */
#define UDM_LEVEL       0xf3c     /* the travel's LevelId */
#define UDM_MODE        0xf60     /* u8: 1 campaign, 2 free mission */
/* Mission014 (MissionID 14): free choice of aircraft, not carrier-only, and ONE wingman slot (HangarSelectWingman1st only;
 * 2nd and 3rd WingmanType None), so the hangar builds the player's plane and one wingman's: that spot is the opponent's,
 * no other wingmen (the user, 2026-11-21: "delete the other wingman aircraft"). Its hangar: TravelHangarMap 4 = PL_Hangar003,
 * level 14. (Runs 1-4 used Mission006: three wingmen, PL_Hangar002, level 13; Mission013 has one wingman too but is
 * carrier-only.) */
#define HANGAR_MISSION  14
#define HANGAR_LEVEL    14        /* ELiveLevelID: PL_Hangar003 */
#define HANGAR_MODE     2
#define VF_ROW_AT       0xF2      /* (page, int16) -> the command row (the base 0x147a7a230) */
#define HMGR_IFACE_OBJ  0x78      /* LiveHangarManager: the hangar game mode's interface (object, interface) */
#define HMGR_IFACE      0x80
#define WINGMAN_GROUP   1         /* the display group next to the player's (all five hangar maps have one) */

typedef uint8_t  (*PageFn)(void* page);
typedef void     (*GoToLevelFn)(void* page, int32_t level, uint8_t flag);
typedef void     (*GoToMissionFn)(void* page, int32_t mission, uint8_t flag);
typedef void*    (*SpecCtorFn)(void* spec);
typedef void     (*ApplyGroupFn)(void* mgr, int32_t slot, void* spec, uint8_t force);
typedef void     (*GFreeFn)(void* p);
typedef uint8_t* (*RowAtFn)(void* page, int16_t i);

static uint8_t*      g_menuBaseFn;            /* the confirm input (slot 0xDF of every menu page) */
static PageFn        g_origConfirm;
static GoToLevelFn   g_goToLevel;
static GoToMissionFn g_origGoMission;
static SpecCtorFn    g_specCtor;
static ApplyGroupFn  g_applyGroup;
static GFreeFn       g_gfree;
static int32_t       g_rowsOff = -1, g_rowCountOff = -1, g_rowStride = -1;   /* from the base row getter's code */
static volatile int32_t g_hangarOn;           /* RVNG's hangar session: RVNG_HangarGo .. RVNG_HangarEnd */
static uint8_t* volatile g_group1Dg;          /* the wingman spot's display group actor this session (lobby.h) */
static uint8_t*      g_hgUdm;                  /* (the session's UDM, its mission context and mode before it) */
static int32_t       g_hgOldMission;
static uint8_t       g_hgOldMode;
static uint8_t* volatile g_pressPage;
static volatile int32_t g_presses, g_pressResult = -1, g_missionRefused;
static uint8_t* volatile g_activePage;
static uint8_t*      g_activeLogged;
static volatile int32_t g_activeChanges;

/* the base aircraft (1010..32010), the ADF-X02 (38010) and the F-14A DLC (10034010): the aircraft tree's nodes = the
 * rows of DT_HangarAircraft / DT_WingmanAircraft in the stock game (docs/re/hangar/allowlist.txt). Compiled in, never
 * read from the game's tables at run time (a mod can AddRow into them) */
static const int32_t kStockPlanes[] = {
    1010, 2010, 3010, 4010, 5010, 6010, 7010, 8010, 9010, 10010, 11010, 12010, 13010, 14010, 15010, 16010,
    17010, 18010, 19010, 20010, 21010, 22010, 23010, 24010, 25010, 26010, 27010, 28010, 29010, 30010, 31010, 32010,
    38010, 10034010,
};
static int StockPlane(int32_t id)
{
    for (size_t i = 0; i < sizeof(kStockPlanes) / sizeof(kStockPlanes[0]); ++i) if (kStockPlanes[i] == id) return 1;
    return 0;
}

/* an FName read from game data (not from a UObject's own name): its id checked against the game's name pool first. The
 * game's resolver checks nothing, and a field that isn't an FName (a command row's MenuID is an FString) crashed the
 * game in the first hangar run (10:17, sigs.h kSigNameEntry). "" when the id isn't a name the pool holds */
static uint8_t* g_namePool;
static const wchar_t* SafeNameText(const void* fname, wchar_t* out, size_t cap)
{
    out[0] = 0;
    if (!g_namePool || !Readable(fname, 8)) return out;
    uint32_t id = (uint32_t)R32(fname, 0);
    uint32_t block = id >> 16, off = (id & 0xffff) * 2;
    if (block >= 8192 || !Readable(g_namePool + NAME_POOL_BLOCKS + (size_t)block * 8, 8)) return out;
    uint8_t* b = (uint8_t*)RP(g_namePool, NAME_POOL_BLOCKS + (size_t)block * 8);
    if (!b || !Readable(b + off, 2)) return out;
    uint16_t hdr = *(uint16_t*)(b + off);                 /* (the entry's header: its length above bit 6, bit 0 wide) */
    size_t len = (size_t)(hdr >> 6), bytes = (hdr & 1) ? len * 2 : len;
    if (!len || len > 1024 || !Readable(b + off + 2, bytes)) return out;
    return NameText((const FNameRaw*)fname, out, cap);
}

static const wchar_t* ClassNameOf(const void* obj, wchar_t* out, size_t cap)
{
    out[0] = 0;
    const uint8_t* cls = obj && Readable(obj, 0x20) ? (const uint8_t*)RP(obj, 0x10) : NULL;   /* UObject ClassPrivate */
    if (cls && Readable(cls, 0x20)) SafeNameText(cls + 0x18, out, cap);   /* (checked too: a page pointer can go stale) */
    return out;
}
/* a menu page: its vtable's confirm input is the menu base */
static int IsMenuPage(const void* p)
{
    if (!p || !g_menuBaseFn || !Readable(p, 8)) return 0;
    void** vt = *(void***)p;
    return Readable(vt + VT_BASE_SLOT, 8) && (uint8_t*)vt[VT_BASE_SLOT] == g_menuBaseFn;
}

static uint8_t OnConfirmInput(uint8_t* page)
{
    g_activePage = page;
    if (page != g_activeLogged) {
        g_activeLogged = page;
        ++g_activeChanges;
        static wchar_t n[96];
        Log(L"hangar test: the active menu page is now %s (%p)", ClassNameOf(page, n, 96), page);
    }
    if (page && page == g_pressPage) {
        g_pressPage = NULL;
        uint8_t r = ((PageFn)(*(void***)page)[VT_DECIDE_SLOT])(page);   /* its own decide, in its own tick */
        g_pressResult = r;
        ++g_presses;
        static wchar_t n[96];
        Log(L"hangar test: press %d on %s (row %d): the page's decide answered %d", g_presses, ClassNameOf(page, n, 96),
            SelectedRow(page), (int32_t)r);
        return r;
    }
    return g_origConfirm(page);
}

static void OnGoToMission(uint8_t* page, int32_t mission, uint8_t flag)
{
    if (g_hangarOn) {
        ++g_missionRefused;
        Log(L"hangar test: the travel to mission %d refused (RVNG's hangar session: no campaign or free mission starts from it)",
            mission);
        return;
    }
    g_origGoMission(page, mission, flag);
}

/* RVNG's lobby in the hangar (0.4.3, below): STANDBY's and the HANGAR MENU's decides, the wingman spot's detour */
typedef void (*MenuSoundFn)(void* page, uint8_t id);
static PageFn       g_origStandbyDecide, g_origTopDecide;
static ApplyGroupFn g_origApplyGroup;
static MenuSoundFn  g_menuSound;
static int32_t      g_hangarHooks;                /* (counted apart from RVNG_Hooks: RVNG_HgInfo(0)) */
static uint8_t OnStandbyDecide(uint8_t* page);
static uint8_t OnTopDecide(uint8_t* page);
static void    OnApplyGroup(uint8_t* mgr, int32_t slot, uint8_t* spec, uint8_t force);
typedef void (*DgSetPlaneFn)(void* dg, int32_t plane, void* pattern);
typedef void (*DgSetSkinFn)(void* dg, int32_t skin);
static DgSetPlaneFn g_origDgSetPlane;
static DgSetSkinFn  g_origDgSetSkin;
static void OnDgSetPlane(uint8_t* dg, int32_t plane, void* pattern);
static void OnDgSetSkin(uint8_t* dg, int32_t skin);
typedef void (*HangarQuitFn)(void* page);
static HangarQuitFn g_origHangarQuit;
static void OnHangarQuit(uint8_t* page);

/* the hooks and functions, in every install since 0.4.3 (each passes the game's call on unless RVNG's hangar session is
 * up); the count goes to g_hangarHooks */
static void InstallHangar(uint8_t* menuBase, uint8_t* goLevel, uint8_t* goMission, uint8_t* applyGroup, uint8_t* specCtor,
                          uint8_t* remoteSpawn, uint8_t* nameEntry, uint8_t* standbyDecide, uint8_t* topDecide,
                          uint8_t* menuSound, uint8_t* dgSetPlane, uint8_t* dgSetSkin, uint8_t* hangarQuit)
{
    g_menuSound = (MenuSoundFn)(void*)menuSound;
    if (nameEntry && nameEntry[NAME_ENTRY_POOL_DISP - 3] == 0x48 && nameEntry[NAME_ENTRY_POOL_DISP - 2] == 0x8D) {
        int32_t d; memcpy(&d, nameEntry + NAME_ENTRY_POOL_DISP, 4);
        g_namePool = nameEntry + NAME_ENTRY_POOL_DISP + 4 + d;
    }
    g_menuBaseFn = menuBase;
    g_goToLevel = (GoToLevelFn)(void*)goLevel;
    g_applyGroup = (ApplyGroupFn)(void*)applyGroup;
    g_specCtor = (SpecCtorFn)(void*)specCtor;
    uint8_t* fr = remoteSpawn ? CallTarget(remoteSpawn + REMOTE_SPAWN_FREE_CALL) : NULL;
    if (fr && InGame(fr) && Readable(fr, 4) && !memcmp(fr, kFreeHead, sizeof(kFreeHead))) g_gfree = (GFreeFn)(void*)fr;
    /* the row getter's offsets (the main menu's vtable: every page shares the base getter):
     * cmp [rcx+count], eax at +3 | imul rax, rax, stride at +0x14 | add rax, [rcx+rows] at +0x1b */
    uint8_t* ra = g_vtMain && Readable(g_vtMain + VF_ROW_AT, 8) ? (uint8_t*)g_vtMain[VF_ROW_AT] : NULL;
    if (ra && InGame(ra) && Readable(ra, 0x22) && ra[3] == 0x39 && ra[4] == 0x81 && ra[0x14] == 0x48 && ra[0x15] == 0x69 &&
        ra[0x16] == 0xC0 && ra[0x1b] == 0x48 && ra[0x1c] == 0x03 && ra[0x1d] == 0x81) {
        memcpy(&g_rowCountOff, ra + 5, 4); memcpy(&g_rowStride, ra + 0x17, 4); memcpy(&g_rowsOff, ra + 0x1e, 4);
    }
    int n = 0;
    if (menuBase) n += HookInline(menuBase, LENS_CONFIRM_INPUT, (void*)OnConfirmInput, (void**)&g_origConfirm,
                                  L"menu confirm input (hangar test: the active page, the self-test's presses)");
    n += HookInline(goMission, LENS_GO_MISSION, (void*)OnGoToMission, (void**)&g_origGoMission,
                    L"GoToMission (refused while RVNG's hangar session is up)");
    n += HookInline(standbyDecide, LENS_STANDBY_DECIDE, (void*)OnStandbyDecide, (void**)&g_origStandbyDecide,
                    L"STANDBY decide (RVNG's lobby: SORTIE, READY UP, leave)");
    n += HookInline(topDecide, LENS_TOP_DECIDE, (void*)OnTopDecide, (void**)&g_origTopDecide,
                    L"HANGAR MENU decide (RVNG's lobby: no briefing, difficulty or training; QUIT leaves)");
    if (applyGroup) n += HookInline(applyGroup, LENS_APPLY_GROUP, (void*)OnApplyGroup, (void**)&g_origApplyGroup,
                                    L"ApplyGroupDisplay (RVNG's lobby: the opponent's plane on the wingman's spot)");
    n += HookInline(dgSetPlane, LENS_DG_SET_PLANE, (void*)OnDgSetPlane, (void**)&g_origDgSetPlane,
                    L"display group SetPlane (RVNG's lobby: the opponent's plane whichever page sets the wingman's spot)");
    n += HookInline(dgSetSkin, LENS_DG_SET_SKIN, (void*)OnDgSetSkin, (void**)&g_origDgSetSkin,
                    L"display group SetSkin (RVNG's lobby: the opponent's paint)");
    n += HookInline(hangarQuit, LENS_HANGAR_QUIT, (void*)OnHangarQuit, (void**)&g_origHangarQuit,
                    L"the hangar's quit (RVNG's lobby: B on the HANGAR MENU leaves the lobby)");
    g_hangarHooks = n;
    Log(L"hangar: GoToLevel %s, ApplyGroupDisplay %s, spec ctor %s, FMemory::Free %s, the name pool %s, the menu sound %s, rows at +%x (count +%x, stride %x); %d of 8 hooks",
        g_goToLevel ? L"found" : L"MISSING", g_applyGroup ? L"found" : L"MISSING", g_specCtor ? L"found" : L"MISSING",
        g_gfree ? L"found" : L"MISSING", g_namePool ? L"found" : L"MISSING", g_menuSound ? L"found" : L"MISSING",
        (uint32_t)g_rowsOff, (uint32_t)g_rowCountOff, (uint32_t)g_rowStride, n);
}

static int SetStr(void* lua, const wchar_t* w)
{
    static char a[256];
    size_t k = 0;
    for (; w && w[k] && k < sizeof(a) - 1; ++k) a[k] = w[k] >= 0x20 && w[k] < 0x7F ? (char)w[k] : '?';
    a[k] = 0;
    U.luaSetString(lua, a, k);
    return 1;
}
static uint8_t* ArgPtr(void* lua, int* stop)
{
    double a = 0;
    ArgNextNum(lua, &a, stop);
    return (uint8_t*)(uintptr_t)(uint64_t)a;
}

/* RVNG_UdmDump(tag): the loadout fields into the log */
static void UdmDump(const char* tag)
{
    static wchar_t t[48];
    size_t k = 0;
    for (; tag && tag[k] && k < 47; ++k) t[k] = (wchar_t)(uint8_t)tag[k];
    t[k] = 0;
    uint8_t* udm = g_gi ? (uint8_t*)RP(g_gi, GI_UDM) : NULL;
    if (!udm || !Readable(udm, UDM_MODE + 8)) { Log(L"hangar test: UDM (%s): no UDM yet", t); return; }
    Log(L"hangar test: UDM (%s): mission %d, level %d, mode %d, squad slot edited %d", t, R32(udm, UDM_MISSION),
        R32(udm, UDM_LEVEL), (int32_t)R8(udm, UDM_MODE), (int32_t)R8(udm, 0xe0e));
    for (int m = 0; m < 4; ++m) {
        uint8_t* e = udm + UDM_MEMBERS + m * UDM_MEMBER_SIZE;
        uint8_t* em = (uint8_t*)RP(e, 0x10);
        int32_t ne = R32(e, 0x18);
        static wchar_t es[160];
        int o = 0;
        es[0] = 0;
        for (int i = 0; em && ne > 0 && ne <= 16 && i < ne && Readable(em, (size_t)ne * 4) && o < 140; ++i) {
            int32_t v = R32(em, (size_t)i * 4);
            /* (a small decimal writer: vfmt.h has no widths; the ids go out one by one) */
            char d[16]; int dn = 0; uint32_t u = v < 0 ? (uint32_t)(-(int64_t)v) : (uint32_t)v;
            do { d[dn++] = (char)('0' + u % 10); u /= 10; } while (u && dn < 15);
            if (v < 0) es[o++] = '-';
            while (dn) es[o++] = (wchar_t)d[--dn];
            es[o++] = ' ';
        }
        es[o] = 0;
        Log(L"  member %d: aircraft %d, specials %d/%d, skin %d, emblems %d [%s], paint %d/%d/%d, set %d", m, R32(e, 0),
            (int32_t)R8(e, 4), (int32_t)R8(e, 5), R32(e, 8), ne, es, (int32_t)R8(e, 0x20), (int32_t)R8(e, 0x21),
            (int32_t)R8(e, 0x22), R32(e, 0x24));
    }
    for (int a = 0; a < 2; ++a) {
        size_t off = a ? UDM_PARTS : UDM_WEAPONS;
        uint8_t* p = (uint8_t*)RP(udm, off);
        int32_t n = R32(udm, off + 8);
        static wchar_t es[200];
        int o = 0;
        es[0] = 0;
        for (int i = 0; p && n > 0 && n <= 32 && i < n && Readable(p, (size_t)n * 4) && o < 180; ++i) {
            int32_t v = R32(p, (size_t)i * 4);
            char d[16]; int dn = 0; uint32_t u = v < 0 ? (uint32_t)(-(int64_t)v) : (uint32_t)v;
            do { d[dn++] = (char)('0' + u % 10); u /= 10; } while (u && dn < 15);
            if (v < 0) es[o++] = '-';
            while (dn) es[o++] = (wchar_t)d[--dn];
            es[o++] = ' ';
        }
        es[o] = 0;
        Log(L"  %s +%x: %d element(s) [%s]", a ? L"parts" : L"weapons", (uint32_t)off, n, es);
    }
}
static int L_UdmDump(void* lua)
{
    char tag[48]; int stop = 0;
    ArgNextStr(lua, tag, sizeof(tag), &stop);
    UdmDump(tag);
    return 0;
}

/* RVNG_HangarGo(address of the main menu widget) -> 1: the travel into the hangar asked for (the menu's own request; the
 * travel itself runs on the menu's next tick); 0 refused */
static int L_HangarGo(void* lua)
{
    int stop = 0;
    uint8_t* w = ArgPtr(lua, &stop);
    uint8_t* udm = g_gi ? (uint8_t*)RP(g_gi, GI_UDM) : NULL;
    int ok = g_goToLevel && IsMenuPage(w) && udm && Writable(udm + UDM_MISSION, 4) && Writable(udm + UDM_MODE, 1);
    if (ok) {
        Log(L"hangar test: to the hangar (level %d) from the main menu %p: mission %d -> %d, mode %d -> %d", HANGAR_LEVEL, w,
            R32(udm, UDM_MISSION), HANGAR_MISSION, (int32_t)R8(udm, UDM_MODE), HANGAR_MODE);
        UdmDump("before the hangar");
        g_hgOldMission = R32(udm, UDM_MISSION); g_hgOldMode = udm[UDM_MODE]; g_hgUdm = udm;
        *(int32_t*)(udm + UDM_MISSION) = HANGAR_MISSION;
        udm[UDM_MODE] = HANGAR_MODE;
        g_hangarOn = 1;
        g_group1Dg = NULL;
        g_goToLevel(w, HANGAR_LEVEL, 0);
    } else {
        Log(L"hangar test: RVNG_HangarGo refused (hangar=%d, GoToLevel %p, page %p a menu page %d, UDM %p)", g_cfg.hangar,
            (void*)g_goToLevel, w, IsMenuPage(w), udm);
    }
    U.luaSetInteger(lua, ok);
    return 1;
}
/* the mission context and mode from before RVNG_HangarGo, back (the session's end) */
static void HangarRestoreUdm(void)
{
    if (g_hgUdm && Writable(g_hgUdm + UDM_MISSION, 4) && Writable(g_hgUdm + UDM_MODE, 1)) {
        *(int32_t*)(g_hgUdm + UDM_MISSION) = g_hgOldMission;
        g_hgUdm[UDM_MODE] = g_hgOldMode;
        Log(L"hangar: the mission context back to %d, mode %d", g_hgOldMission, (int32_t)g_hgOldMode);
    }
    g_hgUdm = NULL;
}
/* RVNG_HangarEnd(): RVNG's hangar session over (the game's own travels to missions pass again) */
static int L_HangarEnd(void* lua)
{
    (void)lua;
    HangarRestoreUdm();
    if (g_hangarOn) Log(L"hangar test: the hangar session ended (%d mission travel(s) refused during it)", g_missionRefused);
    g_hangarOn = 0;
    return 0;
}
/* RVNG_PageNow() -> the active menu page's address (0 none yet); RVNG_PageName(address) -> its class name */
static int L_PageNow(void* lua) { U.luaSetInteger(lua, (int64_t)(uintptr_t)g_activePage); return 1; }
static int L_PageName(void* lua)
{
    int stop = 0;
    uint8_t* p = ArgPtr(lua, &stop);
    static wchar_t n[96];
    return SetStr(lua, IsMenuPage(p) ? ClassNameOf(p, n, 96) : L"");
}
/* RVNG_PagePress(page, row) -> 1: the cursor to row (row < 0: where it is) and a confirm press on that page's next tick;
 * RVNG_PageInfo(k): (0) presses run, (1) the last one's answer, (2) mission travels refused, (3) active-page changes,
 * (4) the hangar session on */
static int L_PagePress(void* lua)
{
    int stop = 0;
    uint8_t* p = ArgPtr(lua, &stop);
    double r = -1;
    ArgNextNum(lua, &r, &stop);
    int ok = g_origConfirm && IsMenuPage(p);
    if (ok && r >= 0 && r < 64 && g_setCmdIndex) {
        if (g_hoverOff && (g_selIdxOff <= 0 || g_hoverSelOff == g_selIdxOff) && Writable(p + g_hoverOff, 2))
            *(int16_t*)(p + g_hoverOff) = (int16_t)r;
        g_setCmdIndex(p, (int16_t)r);
    }
    if (ok) g_pressPage = p;
    else Log(L"hangar test: RVNG_PagePress refused (page %p, a menu page %d)", p, IsMenuPage(p));
    U.luaSetInteger(lua, ok);
    return 1;
}
static int L_PageInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k == 0 ? g_presses : k == 1 ? g_pressResult : k == 2 ? g_missionRefused : k == 3 ? g_activeChanges :
                         k == 4 ? g_hangarOn : -1);
    return 1;
}
/* RVNG_PageBack(page) -> 1: the page's own pending-cancel byte set (its next tick runs B / Esc's path) */
static int L_PageBack(void* lua)
{
    int stop = 0;
    uint8_t* p = ArgPtr(lua, &stop);
    void** vt = IsMenuPage(p) ? *(void***)p : NULL;
    int ok = vt && g_vtMain && g_cancelPendOff && Readable(vt + VT_CANCEL_INPUT_SLOT, 8) &&
             vt[VT_CANCEL_INPUT_SLOT] == g_vtMain[VT_CANCEL_INPUT_SLOT] && Writable(p + g_cancelPendOff, 1);
    if (ok) p[g_cancelPendOff] = 1;
    else Log(L"hangar test: RVNG_PageBack refused (page %p)", p);
    U.luaSetInteger(lua, ok);
    return 1;
}
/* RVNG_PageRow(page, i) -> "CommandID|MenuID|LevelId|invalid|appearance" ("" past the last row); RVNG_PageRows(page) ->
 * the row count (-1 not a menu page) */
static uint8_t* PageRowAt(uint8_t* p, int32_t i)
{
    if (!IsMenuPage(p) || g_rowsOff <= 0 || g_rowStride <= 0 || g_rowCountOff <= 0) return NULL;
    int32_t n = R32(p, (size_t)g_rowCountOff);
    uint8_t* rows = (uint8_t*)RP(p, (size_t)g_rowsOff);
    if (i < 0 || i >= n || n > 64 || !rows || !Readable(rows + (size_t)i * (size_t)g_rowStride, (size_t)g_rowStride)) return NULL;
    return rows + (size_t)i * (size_t)g_rowStride;
}
static int L_PageRows(void* lua)
{
    int stop = 0;
    uint8_t* p = ArgPtr(lua, &stop);
    U.luaSetInteger(lua, IsMenuPage(p) && g_rowCountOff > 0 ? R32(p, (size_t)g_rowCountOff) : -1);
    return 1;
}
static int L_PageRow(void* lua)
{
    int stop = 0;
    uint8_t* p = ArgPtr(lua, &stop);
    double i = -1;
    ArgNextNum(lua, &i, &stop);
    uint8_t* row = PageRowAt(p, (int32_t)i);
    if (!row) return SetStr(lua, L"");
    /* LiveMenuCommandsDataTable (the game's usmap): +0x8 CommandID FName, +0x18 TitleTextID FString, +0xf8 MenuID FString,
     * +0x108 LevelId uint32, +0x130 StringArgs FString, +0x140 bIsInvalid, +0x142 InvalidAppearance */
    static wchar_t cmd[64], menu[64], out[200];
    SafeNameText(row + 0x8, cmd, 64);
    FStringText((const FString*)(row + 0xf8), menu, 64);
    /* (by hand: vfmt.h is the log's; here a plain join) */
    int o = 0;
    for (int k = 0; cmd[k] && o < 60; ++k) out[o++] = cmd[k];
    out[o++] = '|';
    for (int k = 0; menu[k] && o < 124; ++k) out[o++] = menu[k];
    out[o++] = '|';
    int32_t lv = R32(row, 0x108);
    char d[16]; int dn = 0; uint32_t u = lv < 0 ? (uint32_t)(-(int64_t)lv) : (uint32_t)lv;
    do { d[dn++] = (char)('0' + u % 10); u /= 10; } while (u && dn < 15);
    if (lv < 0) out[o++] = '-';
    while (dn) out[o++] = (wchar_t)d[--dn];
    out[o++] = '|'; out[o++] = (wchar_t)('0' + (R8(row, 0x140) ? 1 : 0));
    out[o++] = '|'; out[o++] = (wchar_t)('0' + (R8(row, 0x142) % 10));
    out[o] = 0;
    return SetStr(lua, out);
}
/* RVNG_HangarShow(LiveHangarManager address, aircraft id, skin id) -> 1: that aircraft on the wingman's spot (display group
 * 1) through the game's ApplyGroupDisplay; 0 refused (not a stock aircraft, no hangar interface, a function missing) */
static int L_HangarShow(void* lua)
{
    int stop = 0;
    uint8_t* mgr = ArgPtr(lua, &stop);
    double plane = -1, skin = -1;
    ArgNextNum(lua, &plane, &stop);
    ArgNextNum(lua, &skin, &stop);
    int32_t id = (int32_t)plane;
    int ok = g_applyGroup && g_specCtor && g_gfree && mgr && Readable(mgr, HMGR_IFACE + 8) &&
             RP(mgr, HMGR_IFACE_OBJ) && RP(mgr, HMGR_IFACE) && Readable(RP(mgr, HMGR_IFACE), 8) && StockPlane(id);
    if (ok) {
        uint8_t spec[0x80] __attribute__((aligned(16)));
        memset(spec, 0, sizeof(spec));
        g_specCtor(spec);
        *(int32_t*)(spec + 0) = id;
        *(int32_t*)(spec + 4) = (int32_t)skin;
        g_applyGroup(mgr, WINGMAN_GROUP, spec, 1);
        void* em = *(void**)(spec + 8);
        if (em) g_gfree(em);
        Log(L"hangar test: aircraft %d (skin %d) asked for on display group %d (LiveHangarManager %p)", id, (int32_t)skin,
            WINGMAN_GROUP, mgr);
    } else {
        Log(L"hangar test: RVNG_HangarShow refused (aircraft %d stock %d, manager %p, its interface %p, functions %p %p %p)", id,
            StockPlane(id), mgr, mgr && Readable(mgr, HMGR_IFACE + 8) ? RP(mgr, HMGR_IFACE) : NULL, (void*)g_applyGroup,
            (void*)g_specCtor, (void*)g_gfree);
    }
    U.luaSetInteger(lua, ok);
    return 1;
}
