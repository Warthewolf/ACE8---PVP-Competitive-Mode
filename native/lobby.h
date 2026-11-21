/* lobby.h (2026-11-21, runtime 0.4.3): RVNG's lobby in the stock pre-sortie hangar (docs/re/HANGAR.md 3).
 *
 * The user: a match found takes both PCs straight into the hangar; each pilot sets up the plane on STANDBY (the screen
 * with SORTIE); READY UP is there; SORTIE is refused until both pilots are ready, then either pilot's SORTIE launches
 * both (the link's ready flag 2); only the player's plane and the opponent's stand there (Mission014's one wingman spot,
 * the opponent's ids put in whenever the game sets that spot: "delete the other wingman aircraft").
 *
 * Every hook (hangar.h InstallHangar) passes the game's call on unless RVNG's hangar session is up (RVNG_HangarGo ..
 * RVNG_HangarEnd / RVNG_HgLeave):
 *   STANDBY's decide: SORTIE (open only when Lua says both are ready; else the menu's reject sound), SELECT WINGMEN
 *     AIRCRAFT = READY UP, LEAVE THE HANGAR = leave the lobby; the other rows (aircraft, weapons, parts) are the game's.
 *   the HANGAR MENU's decide: BRIEFING (a map travel), SELECT DIFFICULTY and TRAINING refused; QUIT MISSION = leave.
 *   ApplyGroupDisplay: group 1 (the wingman's spot) gets the opponent's aircraft and skin.
 * The loadout: LOADOUT on the link (link.h), sent from the hangar's member 0 and the weapons / parts arrays; the
 * receiver shows a stock aircraft only (kStockPlanes), and FillOpponent puts it in the match's selector for slot 1. */
#define HG_LEVEL_MAINMENU 2
#define HG_FALLBACK_PLANE 24010                      /* F/A-18F: a stock plane for an opponent's unknown aircraft */
enum { HG_SORTIE = 1, HG_READY = 2, HG_LEAVE = 3 };
static volatile int32_t g_sortieOpen;                /* Lua: both pilots ready */
static volatile int32_t g_hgPresses, g_hgKind, g_hgRejects, g_hgSubs, g_oppSelPlane;
static volatile int32_t g_oppPlane, g_oppSkin = -1;  /* the opponent's plane on the wingman's spot (0: the game's own) */
static LinkLoadout g_loLast;
static char g_loNames[48];                           /* this pilot's "plane|sp1|sp2" from its STANDBY (Lua) */
static int32_t g_loSent, g_loChanges;                 /* (LOADOUTs sent; of them with a changed plane) */
static uint64_t g_loSentAt;
static Link* ReadyLink(void);
/* the wingman spot's display group actor: learned from RVNG's own ApplyGroupDisplay for group 1 (the SetPlane call inside
 * it); from then on any page's SetPlane / SetSkin on that actor gets the opponent's ids (lobby run of 11:21) */
static volatile int32_t g_inGroup1, g_dgSubs;        /* (g_group1Dg: hangar.h, reset by each RVNG_HangarGo) */

static int WEqA(const wchar_t* w, const char* a)
{
    size_t i = 0;
    for (; w[i] && a[i]; ++i) if (w[i] != (wchar_t)(uint8_t)a[i]) return 0;
    return w[i] == 0 && a[i] == 0;
}
static void RowMenuId(uint8_t* page, int32_t i, wchar_t* out, size_t cap)
{
    out[0] = 0;
    uint8_t* r = PageRowAt(page, i);
    if (r) FStringText((const FString*)(r + 0xf8), out, cap);
}
/* the plane shown for an opponent's aircraft id: a stock one only (the user's rule), else the fallback */
static int32_t StockOr(int32_t id) { return StockPlane(id) ? id : HG_FALLBACK_PLANE; }
/* a skin that belongs to that plane ((skin / 1e6) % 100 is the plane's number), else -1 (its first stock skin) */
static int32_t SkinFor(int32_t plane, int32_t skin)
{
    if (skin <= 0) return -1;
    int32_t pn = (plane % 1000000) / 1000;
    return ((skin / 1000000) % 100) == pn % 100 ? skin : -1;
}
/* the opponent's loadout from the link (NULL until one came) */
static const LinkLoadout* PeerLoadout(void)
{
    Link* L = g_cfg.wire == 1 ? &g_lpA : &g_link;
    return L->peerLoadoutSeq > 0 ? &L->peerLoadout : NULL;
}

static uint8_t HgTake(uint8_t* page, int kind, const wchar_t* what)
{
    g_hgKind = kind;
    int32_t n = __sync_add_and_fetch(&g_hgPresses, 1);
    static wchar_t c[96];
    Log(L"hangar: press %d on %s: %s (RVNG's lobby)", n, ClassNameOf(page, c, 96), what);
    return 1;
}
static uint8_t HgReject(uint8_t* page, const wchar_t* what)
{
    int32_t n = __sync_add_and_fetch(&g_hgRejects, 1);
    if (g_menuSound) g_menuSound(page, MENU_SOUND_REJECT);
    Log(L"hangar: %s refused (%d), the menu's reject sound", what, n);
    return 0;                                         /* (not handled: no decide sound after the reject) */
}

static uint8_t OnStandbyDecide(uint8_t* page)
{
    if (!g_hangarOn) return g_origStandbyDecide(page);
    int32_t row = SelectedRow(page);
    static wchar_t m[48], m2[48];
    RowMenuId(page, row, m, 48);
    if (WEqA(m, "Sortie")) return g_sortieOpen ? HgTake(page, HG_SORTIE, L"SORTIE") : HgReject(page, L"SORTIE (not both ready)");
    if (WEqA(m, "Top")) return HgTake(page, HG_LEAVE, L"LEAVE THE HANGAR");
    if (WEqA(m, "SelectAircraft")) {                 /* (the second SelectAircraft row is SELECT WINGMEN AIRCRAFT) */
        int32_t first = -1;
        for (int32_t i = 0; i < 16 && first < 0; ++i) { RowMenuId(page, i, m2, 48); if (WEqA(m2, "SelectAircraft")) first = i; }
        if (first >= 0 && row != first) return HgTake(page, HG_READY, L"READY UP");
    }
    return g_origStandbyDecide(page);
}

static uint8_t OnTopDecide(uint8_t* page)
{
    if (!g_hangarOn) return g_origTopDecide(page);
    int32_t row = SelectedRow(page);
    uint8_t* r = PageRowAt(page, row);
    static wchar_t m[48];
    m[0] = 0;
    int32_t lv = r ? R32(r, 0x108) : -1;
    if (r) FStringText((const FString*)(r + 0xf8), m, 48);
    if (lv == HG_LEVEL_MAINMENU) return HgTake(page, HG_LEAVE, L"QUIT MISSION");
    if (lv != -1 || WEqA(m, "SelectDifficulty") || WEqA(m, "SelectTraining")) return HgReject(page, L"a campaign row");
    return g_origTopDecide(page);
}

static void OnApplyGroup(uint8_t* mgr, int32_t slot, uint8_t* spec, uint8_t force)
{
    if (g_hangarOn && slot == WINGMAN_GROUP && g_oppPlane > 0 && spec && Writable(spec, 8)) {
        int32_t was = *(int32_t*)spec;
        *(int32_t*)spec = g_oppPlane;
        *(int32_t*)(spec + 4) = g_oppSkin;
        int32_t n = __sync_add_and_fetch(&g_hgSubs, 1);
        if (n <= 12) Log(L"hangar: the wingman's spot set to the opponent's aircraft %d (skin %d; the game asked for %d)",
                         g_oppPlane, g_oppSkin, was);
    }
    if (slot == WINGMAN_GROUP) g_inGroup1 = 1;
    g_origApplyGroup(mgr, slot, spec, force);
    g_inGroup1 = 0;
}

static void OnDgSetPlane(uint8_t* dg, int32_t plane, void* pattern)
{
    if (g_inGroup1 && g_hangarOn && dg != g_group1Dg) {
        g_group1Dg = dg;
        Log(L"hangar: the wingman spot's display group is %p", dg);
    }
    if (g_hangarOn && dg == g_group1Dg && g_oppPlane > 0 && plane != g_oppPlane) {
        int32_t n = __sync_add_and_fetch(&g_dgSubs, 1);
        if (n <= 12) Log(L"hangar: a page set the wingman's spot to %d: the opponent's %d instead", plane, g_oppPlane);
        plane = g_oppPlane;
    }
    g_origDgSetPlane(dg, plane, pattern);
}
static void OnHangarQuit(uint8_t* page)
{
    if (g_hangarOn) { HgTake(page, HG_LEAVE, L"B on the HANGAR MENU (the game's quit)"); return; }
    g_origHangarQuit(page);
}

static void OnDgSetSkin(uint8_t* dg, int32_t skin)
{
    if (g_hangarOn && dg == g_group1Dg && g_oppPlane > 0) skin = g_oppSkin;
    g_origDgSetSkin(dg, skin);
}

/* FillOpponent (the match's room tables, before the remote spawn): the opponent's own aircraft and skin from the link's
 * LOADOUT into slot 1's selector (+0x78 aircraft, +0xa8 skin: the class the game loads for the copy and its paint). A
 * stock plane only (the user's rule). Without a LOADOUT the selector keeps the game's fill (this PC's plane). */
static void OppLoadoutToSel(uint8_t* sel)
{
    const LinkLoadout* lo = PeerLoadout();
    if (!lo || !Writable(sel + 0x78, 0x34)) { Log(L"test 3: no LOADOUT from the opponent: the copy keeps this PC's plane"); return; }
    int32_t pl = StockOr(lo->aircraft), sk = SkinFor(pl, lo->skin);
    *(int32_t*)(sel + 0x78) = pl;
    *(int32_t*)(sel + 0xa8) = sk;
    g_oppSelPlane = pl;
    Log(L"test 3: the opponent's own plane in slot 1's selector: aircraft %d, skin %d (sent %d / %d)", pl, sk, lo->aircraft, lo->skin);
}

/* the plane the wingman spot's display group holds now (what the hangar shows; -1 unknown) */
static int32_t DgPlaneNow(void)
{
    uint8_t* dg = g_group1Dg;
    return dg && Readable(dg + DG_PLANE_NOW, 4) ? R32(dg, DG_PLANE_NOW) : -1;
}

/* RVNG_HgInfo(k): (0) the lobby's hooks in, (1) the session up, (2) presses taken, (3) the last one's kind (1 SORTIE,
 * 2 READY UP, 3 leave), (4) presses refused, (5) the spot set to the opponent's plane (times), (6) the opponent's plane
 * shown, (7) SORTIE open, (8) the opponent's aircraft in the match's selector (slot 1), (9) loadouts sent, (10) the plane
 * the wingman spot's display group holds now, (11) pages' sets of that spot turned into the opponent's, (12) this pilot's
 * loadout changes sent, (13) the aircraft in this pilot's last LOADOUT (the plane it flies) */
static int L_HgInfo(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    U.luaSetInteger(lua, k == 0 ? g_hangarHooks : k == 1 ? g_hangarOn : k == 2 ? g_hgPresses : k == 3 ? g_hgKind :
                         k == 4 ? g_hgRejects : k == 5 ? g_hgSubs : k == 6 ? g_oppPlane : k == 7 ? g_sortieOpen :
                         k == 8 ? g_oppSelPlane : k == 9 ? g_loSent : k == 10 ? DgPlaneNow() : k == 11 ? g_dgSubs : k == 12 ? g_loChanges :
                         k == 13 ? g_loLast.aircraft : -1);
    return 1;
}
/* RVNG_HgSortie(0/1): SORTIE open (both pilots ready) */
static int L_HgSortie(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    if ((v != 0) != (g_sortieOpen != 0)) Log(L"hangar: SORTIE %s", v != 0 ? L"open (both pilots ready)" : L"closed");
    g_sortieOpen = v != 0;
    return 0;
}
/* RVNG_HgOpp(aircraft, skin) -> the plane the wingman's spot shows from now on (a stock one; 0 = the game's own) */
static int L_HgOpp(void* lua)
{
    double p = 0, s = -1; int stop = 0;
    ArgNextNum(lua, &p, &stop);
    ArgNextNum(lua, &s, &stop);
    int32_t id = (int32_t)p;
    g_oppPlane = id > 0 ? StockOr(id) : 0;
    g_oppSkin = id > 0 ? SkinFor(g_oppPlane, (int32_t)s) : -1;
    Log(L"hangar: the opponent's plane on the wingman's spot: %d (skin %d; asked %d / %d)", g_oppPlane, g_oppSkin, id, (int32_t)s);
    U.luaSetInteger(lua, g_oppPlane);
    return 1;
}
/* RVNG_HgLeave(an active menu page) -> 1: the session over and the page's own travel to the main menu asked for */
static int L_HgLeave(void* lua)
{
    int stop = 0;
    uint8_t* p = ArgPtr(lua, &stop);
    int ok = g_goToLevel && IsMenuPage(p);
    g_hangarOn = 0;
    g_sortieOpen = 0;
    HangarRestoreUdm();
    if (ok) g_goToLevel(p, HG_LEVEL_MAINMENU, 0);
    Log(L"hangar: leaving the hangar for the main menu (%s)", ok ? L"the page's own travel" : L"no menu page: refused");
    U.luaSetInteger(lua, ok);
    return 1;
}
/* RVNG_LoSend() -> 1 when this pilot's loadout went to the opponent (the hangar's member 0 and the weapons and parts
 * arrays; sent when it changed, or every 4 s) */
static int L_LoSend(void* lua)
{
    Link* L = ReadyLink();
    uint8_t* udm = g_gi ? (uint8_t*)RP(g_gi, GI_UDM) : NULL;
    int ok = 0;
    if (L && L->state == LS_UP && udm && Readable(udm + UDM_PARTS, 16)) {
        LinkLoadout lo;
        memset(&lo, 0, sizeof(lo));
        uint8_t* m = udm + UDM_MEMBERS;
        lo.aircraft = R32(m, 0); lo.skin = R32(m, 8); lo.sp1 = R8(m, 4); lo.sp2 = R8(m, 5);
        lo.paint[0] = R8(m, 0x20); lo.paint[1] = R8(m, 0x21); lo.paint[2] = R8(m, 0x22);
        uint8_t* e = (uint8_t*)RP(m, 0x10); int32_t ne = R32(m, 0x18);
        if (e && ne > 0 && ne <= 8 && Readable(e, (size_t)ne * 4)) { memcpy(lo.emblems, e, (size_t)ne * 4); lo.nEmblems = (uint8_t)ne; }
        uint8_t* w = (uint8_t*)RP(udm, UDM_WEAPONS); int32_t nw = R32(udm, UDM_WEAPONS + 8);
        if (w && nw > 0 && nw <= LINK_LO_WEAPONS && Readable(w, (size_t)nw * 4)) { memcpy(lo.weapons, w, (size_t)nw * 4); lo.nWeapons = (uint8_t)nw; }
        uint8_t* pa = (uint8_t*)RP(udm, UDM_PARTS); int32_t np = R32(udm, UDM_PARTS + 8);
        if (pa && np > 0 && np <= LINK_LO_PARTS && Readable(pa, (size_t)np * 4)) { memcpy(lo.parts, pa, (size_t)np * 4); lo.nParts = (uint8_t)np; }
        memcpy(lo.names, g_loNames, sizeof(lo.names));
        uint64_t now = L->io.now(L->io.ctx);
        if (lo.aircraft > 0 && (memcmp(&lo, &g_loLast, sizeof(lo)) || now - g_loSentAt >= 4000000ull)) {
            if (L == &g_link) LinkLock();
            ok = LinkSend(L, LK_LOADOUT, &lo, sizeof(lo), 1);
            if (L == &g_link) LinkUnlock();
            if (ok) {
                if (memcmp(&lo, &g_loLast, sizeof(lo))) {
                    ++g_loChanges;
                    Log(L"hangar: this pilot's loadout to the opponent: aircraft %d, skin %d, specials %d/%d, %d weapons, %d parts",
                        lo.aircraft, lo.skin, (int32_t)lo.sp1, (int32_t)lo.sp2, (int32_t)lo.nWeapons, (int32_t)lo.nParts);
                }
                g_loLast = lo; g_loSentAt = now; ++g_loSent;
            }
        }
    }
    U.luaSetInteger(lua, ok);
    return 1;
}
/* RVNG_LoNames("plane|sp1|sp2"): this pilot's names as its STANDBY shows them, sent with the LOADOUT (the opponent's
 * FLIGHT panel shows them); RVNG_LoPeerName() -> the opponent's ("" until a LOADOUT came) */
static int L_LoNames(void* lua)
{
    char t[48]; int stop = 0;
    int n = ArgNextStr(lua, t, sizeof(t), &stop);
    for (int i = 0; i < n; ++i) if ((uint8_t)t[i] < 0x20 || (uint8_t)t[i] > 0x7e) t[i] = '?';
    memset(g_loNames, 0, sizeof(g_loNames));
    memcpy(g_loNames, t, (size_t)n);
    return 0;
}
static int L_LoPeerNames(void* lua)
{
    const LinkLoadout* lo = PeerLoadout();
    char t[48]; size_t n = 0;
    for (; lo && n < sizeof(t) - 1 && lo->names[n]; ++n) t[n] = (uint8_t)lo->names[n] >= 0x20 && (uint8_t)lo->names[n] <= 0x7e ? lo->names[n] : '?';
    t[n] = 0;
    U.luaSetString(lua, t, n);
    return 1;
}
/* RVNG_LoPeer(k): the opponent's loadout: (0) how many came, (1) the plane to show (a stock one), (2) its skin (or -1),
 * (3) the aircraft id as sent, (4)/(5) the specials */
static int L_LoPeer(void* lua)
{
    double v = 0;
    ArgNumber(lua, &v);
    int k = (int)v;
    Link* L = g_cfg.wire == 1 ? &g_lpA : &g_link;
    const LinkLoadout* lo = PeerLoadout();
    int64_t r = -1;
    if (k == 0) r = L->peerLoadoutSeq;
    else if (lo) {
        int32_t pl = StockOr(lo->aircraft);
        r = k == 1 ? pl : k == 2 ? SkinFor(pl, lo->skin) : k == 3 ? lo->aircraft : k == 4 ? lo->sp1 : k == 5 ? lo->sp2 : -1;
    }
    U.luaSetInteger(lua, r);
    return 1;
}
