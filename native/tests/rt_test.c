/* rt_test.c : offline checks of rvng_rt.c's risky parts, without the game or UE4SS: the inline hook's trampoline (also
 * with a relocated E8 call), the signature scanner's masks, rvng_test.ini parsing, the watch's "stay offline" verdict,
 * F6's writes, W1, the gate detours and the transition's +0xf3c fix. Built and run by tests/run.sh. */
#define IMPORT
#include "../rvng_rt.c"

IMPORT HANDLE WINAPI GetStdHandle(DWORD n);
IMPORT void   WINAPI ExitProcess(uint32_t code);

/* UE4SS's CppUserModBase constructor and destructor (the DLL imports them from UE4SS.dll) */
void* UE4SS_ModBase_Ctor(void* self) { return self; }
void  UE4SS_ModBase_Dtor(void* self) { (void)self; }

static int g_fail, g_pass;
static void T(const wchar_t* fmt, ...)
{
    static wchar_t w[512]; static char u[1600];
    va_list ap; va_start(ap, fmt); VFmt(w, 512, fmt, ap); va_end(ap);
    int n = WideCharToMultiByte(CP_UTF8, 0, w, (int)WLen(w), u, (int)sizeof(u) - 2, NULL, NULL);
    u[n++] = '\n';
    DWORD put; WriteFile(GetStdHandle((DWORD)-11), u, (DWORD)n, &put, NULL);
}
#define CHECK(cond, what) do { if (cond) ++g_pass; else { ++g_fail; T(L"FAIL: %s (line %d)", what, (int32_t)__LINE__); } } while (0)

/* ---- 1. trampoline with a relocated call ---------------------------------- */
typedef uintptr_t (*F0)(void);
static F0 g_origF;
static uintptr_t DetourF(void) { return g_origF() + 100; }

static void TestCallRelocation(void)
{
    uint8_t* m = (uint8_t*)VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    uint8_t* h = m + 0x200;                                     /* H: mov eax, 42; ret */
    static const uint8_t hb[] = { 0xB8, 0x2A, 0x00, 0x00, 0x00, 0xC3 };
    memcpy(h, hb, sizeof(hb));
    uint8_t* f = m;                                             /* F: push rbx; sub rsp,0x50; call H; mov rcx,rax; ... */
    static const uint8_t fb[] = { 0x40, 0x53, 0x48, 0x83, 0xEC, 0x50, 0xE8, 0, 0, 0, 0, 0x48, 0x8B, 0xC8,
                                  0x48, 0x8D, 0x41, 0x01, 0x48, 0x83, 0xC4, 0x50, 0x5B, 0xC3 };
    memcpy(f, fb, sizeof(fb));
    int32_t rel = (int32_t)(h - (f + 11));
    memcpy(f + 7, &rel, 4);
    CHECK(((F0)(void*)f)() == 43, L"unhooked F returns 43");
    CHECK(HookInline(f, "2,4,c5,3", (void*)DetourF, (void**)&g_origF, L"test F"), L"F hooked");
    CHECK(f[0] == 0xFF && f[1] == 0x25, L"F starts with the jump");
    CHECK(g_origF && g_origF() == 43, L"trampoline (relocated call) returns 43");
    CHECK(((F0)(void*)f)() == 143, L"hooked F returns 143");
    CHECK(!HookInline(f, "2,4,c5,3", (void*)DetourF, (void**)&g_origF, L"test F again"), L"a hooked function is refused");
}

/* ---- 2. a SetState-like prologue ------------------------------------------ */
typedef uintptr_t (*F2)(uintptr_t, uintptr_t);
static F2 g_origG;
static uintptr_t DetourG(uintptr_t a, uintptr_t b) { return g_origG(a, b) + 1000; }

static void TestPlainPrologue(void)
{
    uint8_t* m = (uint8_t*)VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    static const uint8_t gb[] = { 0x33, 0xC0, 0x88, 0x91, 0x58, 0x07, 0x00, 0x00, 0x48, 0x89, 0x81, 0x7C, 0x05, 0x00, 0x00,
                                  0x0F, 0xB6, 0x81, 0x58, 0x07, 0x00, 0x00, 0xC3 };
    memcpy(m, gb, sizeof(gb));
    static uint8_t obj[0x800];
    memset(obj + 0x57c, 0xAA, 8);
    CHECK(HookInline(m, "2,6,7", (void*)DetourG, (void**)&g_origG, L"test G"), L"G hooked");
    uintptr_t r = ((F2)(void*)m)((uintptr_t)obj, 7);
    CHECK(r == 1007, L"hooked G returns state + 1000");
    CHECK(obj[0x758] == 7 && R64(obj, 0x57c) == 0, L"G's moved instructions ran");
    uint8_t* bad = m + 0x100;
    memcpy(bad, gb, sizeof(gb));
    void* o;
    CHECK(!HookInline(bad, "2,6", (void*)DetourG, &o, L"short"), L"a prologue under 14 bytes is refused");
    CHECK(!HookInline(bad, "2,c6,7", (void*)DetourG, &o, L"not a call"), L"a 'c' on a non-call is refused");
    CHECK(!HookInline(NULL, "2,6,7", (void*)DetourG, &o, L"missing"), L"a missing function is refused");
}

/* ---- 3. scanner masks ------------------------------------------------------ */
static void TestScan(void)
{
    static uint8_t buf[512];
    memset(buf, 0xCC, sizeof(buf));
    memcpy(buf + 100, kSigWebGateACall, sizeof(kSigWebGateACall));
    buf[101] = 0x11; buf[102] = 0x22;                   /* a different rel32: masked */
    Pattern p = { L"gate A call", kSigWebGateACall, kSigWebGateACallMask, sizeof(kSigWebGateACall), NULL, 0 };
    static ScanCtx c;
    ScanIndex(&c, &p, 1);
    ScanRegion(buf, sizeof(buf), &c);
    CHECK(p.count == 1 && p.hit == buf + 100, L"masked pattern found once, at its place");
    memcpy(buf + 300, kSigWebGateACall, sizeof(kSigWebGateACall));
    p.hit = NULL; p.count = 0;
    ScanRegion(buf, sizeof(buf), &c);
    CHECK(p.count == 2, L"two copies count 2");
    buf[300 + 6] ^= 0xFF;                                /* a fixed byte differs */
    p.hit = NULL; p.count = 0;
    ScanRegion(buf, sizeof(buf), &c);
    CHECK(p.count == 1, L"a changed fixed byte does not match");

    /* the first-byte buckets: patterns sharing a first byte, one with its own, one that starts with a wildcard */
    memset(buf, 0xCC, sizeof(buf));
    memcpy(buf + 10, kSigGateFriends, sizeof(kSigGateFriends));
    memcpy(buf + 60, kSigGateSettings, sizeof(kSigGateSettings));
    memcpy(buf + 110, kSigGateBlocks, sizeof(kSigGateBlocks));
    memcpy(buf + 160, kSigGateUserCall, sizeof(kSigGateUserCall));
    static const uint8_t wild[3] = { 0x00, 0xCC, 0xCC }, wildMask[3] = { 0, 1, 1 };
    Pattern ps[5] = {
        { L"friends", kSigGateFriends, NULL, sizeof(kSigGateFriends), NULL, 0 },
        { L"settings", kSigGateSettings, NULL, sizeof(kSigGateSettings), NULL, 0 },
        { L"blocks", kSigGateBlocks, kSigGateBlocksMask, sizeof(kSigGateBlocks), NULL, 0 },
        { L"user call", kSigGateUserCall, kSigGateUserCallMask, sizeof(kSigGateUserCall), NULL, 0 },
        { L"wildcard first", wild, wildMask, sizeof(wild), NULL, 0 },
    };
    ScanIndex(&c, ps, 5);
    CHECK(c.head[0x48] == 0 && c.next[0] == 1 && c.next[1] == -1 && c.head[0x40] == 2 && c.head[0xE8] == 3,
          L"scan: patterns bucketed by first byte, the lowest index first");
    ScanRegion(buf, sizeof(buf), &c);
    CHECK(ps[0].count == 1 && ps[0].hit == buf + 10 && ps[1].count == 1 && ps[1].hit == buf + 60, L"scan: two patterns of one bucket each found");
    CHECK(ps[2].count == 1 && ps[2].hit == buf + 110 && ps[3].count == 1 && ps[3].hit == buf + 160, L"scan: the other buckets found");
    CHECK(ps[4].count == 0, L"scan: a pattern starting with a wildcard is never looked for");
}

/* ---- 4. rvng_test.ini ------------------------------------------------------ */
static void TestSettings(void)
{
    static wchar_t path[PATH_CAP];
    PathJoin(path, g_modRoot, L"rvng_test.ini");
    static const char ini[] = "# test\r\nprobe = 1\r\nGATES=observe   # comment\r\nD2=1\nw1=0\nmission=160020\nf3c=-5\nfull_every=0\nd7=1\nbogus=7\n";
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    DWORD put; WriteFile(h, ini, sizeof(ini) - 1, &put, NULL); CloseHandle(h);
    ReadSettings();
    CHECK(g_cfg.probe == 1 && g_cfg.gates == GATES_BLOCK && g_cfg.gatesAsked && g_cfg.d2 == 1 && g_cfg.w1 == 0,
          L"switches read; gates=observe is ignored (always block)");
    CHECK(g_cfg.mission == 160020 && g_cfg.f3c == -5 && g_cfg.fullEvery == 1, L"numbers read (full_every at least 1)");
    CHECK(g_cfg.d7 == 1, L"d7 read");
    g_cfg.d7 = 0;
}

/* ---- 5. watch, F6, W1, gates, transition ----------------------------------- */
static uint8_t gi[0x1000], sm[0x300], p2p[0x40], udm[0x1400], nm[0x800], gm[0x900];
static void* g_fakeVt[4];
static void* g_fakeClient;
static uintptr_t StubTrue(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ (void)a; (void)b; (void)c; (void)d; (void)e; (void)f; (void)g; (void)h; return 1; }
static uintptr_t StubFalse(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ (void)a; (void)b; (void)c; (void)d; (void)e; (void)f; (void)g; (void)h; return 0; }
static uintptr_t StubSeen;
static uintptr_t StubRecord(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ (void)b; (void)c; (void)d; (void)e; (void)f; (void)g; (void)h; StubSeen = a; return 0x77; }

static void TestGameLogic(void)
{
    *(void**)(gi + GI_STRIX) = sm; *(void**)(gi + GI_P2P) = p2p; *(void**)(gi + GI_UDM) = udm; *(void**)(gi + GI_NM) = nm;
    g_cfg.probe = 1; g_cfg.mission = 160010; g_cfg.f3c = LEVEL_ONLINE_STARTUP;
    g_clientGlobal = (uint8_t**)&g_fakeClient;
    CHECK(Watch(gi) == 0, L"all zero: offline");
    CHECK(g_gi == gi, L"watch keeps the GameInstance");
    sm[0x1fa] = 1;
    CHECK(Watch(NULL) == 1, L"StrixManager+0x1fa set: not offline");
    sm[0x1fa] = 0; *(uint64_t*)(p2p + 0x28) = 5;
    CHECK(Watch(NULL) == 1, L"P2P+0x28 set: not offline");
    *(uint64_t*)(p2p + 0x28) = 0; g_fakeClient = (void*)gi;
    CHECK(Watch(NULL) == 1, L"client global set: not offline");
    g_fakeClient = NULL;
    g_cfg.probe = 0;
    CHECK(Watch(gi) == -1 && ArmDM() == 0, L"probe off: watch and F6 do nothing");
    g_cfg.probe = 1;

    *(int32_t*)(udm + 0xf38) = 5; *(int32_t*)(udm + 0xf3c) = 25; *(int32_t*)(nm + 0x538) = 7;
    CHECK(ArmDM() == 1 && g_armed, L"F6 arms");
    CHECK(R32(udm, 0xf38) == 160010 && R32(nm, 0x538) == 0, L"F6 writes the MissionID and clears NM+0x538");

    g_origTransition = StubRecord;
    CHECK(OnTransition(0x1234, 0, 0, 0, 0, 0, 0, 0) == 0x77 && StubSeen == 0x1234, L"transition calls the game's with its arguments");
    CHECK(R32(udm, 0xf3c) == LEVEL_ONLINE_STARTUP && !g_armed, L"campaign +0xf3c replaced, armed once");
    *(int32_t*)(udm + 0xf3c) = 30;
    OnTransition(0, 0, 0, 0, 0, 0, 0, 0);
    CHECK(R32(udm, 0xf3c) == 30, L"not armed: +0xf3c untouched");

    *(void**)gm = g_fakeVt; g_gm = gm; g_gmVt = g_fakeVt;
    gm[GM_STATE] = 15; *(int32_t*)(gm + 0x80c) = 0;
    g_cfg.w1 = 0; AfterState(gm, L"test", 14);
    CHECK(R32(gm, 0x80c) == 0, L"w1=0: +0x80c untouched");
    g_cfg.w1 = 1; AfterState(gm, L"test", 14);
    CHECK(R32(gm, 0x80c) == 2, L"w1=1: +0x80c = 2 on state 15");
    gm[GM_STATE] = 14; *(int32_t*)(gm + 0x80c) = 0; AfterState(gm, L"test", 13);
    CHECK(R32(gm, 0x80c) == 0, L"W1 only on state 15");
    CHECK(LiveGM() == gm, L"game mode alive while its vtable is unchanged");
    *(void**)gm = NULL;
    CHECK(LiveGM() == NULL, L"game mode dropped once its vtable changes");

    g_origGate[0] = StubTrue;
    g_cfg.gates = GATES_BLOCK;
    CHECK(OnGateA(0, 0, 0, 0, 0, 0, 0, 0) == 0 && g_gateTrue[0] == 1, L"block: RVNG answers 0, the game's true is counted");
    g_cfg.gates = GATES_OBSERVE;                        /* (no longer reachable through the ini; still 0) */
    CHECK(OnGateA(0, 0, 0, 0, 0, 0, 0, 0) == 0, L"the gate answers 0 whatever g_cfg.gates says");
    g_cfg.gates = GATES_BLOCK;

    g_origPhase = NULL; g_cfg.d2 = 1;
    CHECK(OnPhaseGate(0, 0, 0, 0, 0, 0, 0, 0) == 1, L"d2=1: released without the game's gate");
    g_origPhase = StubFalse; g_cfg.d2 = 0;
    CHECK(OnPhaseGate(0, 0, 0, 0, 0, 0, 0, 0) == 0, L"d2=0: the game's gate decides");
}

/* ---- 5b. D7: the refused boot login ended through FinishLogin -------------- */
static uint8_t gac[0x200], cbInst[0x40], loginData[0x100];
static void* g_t7Vt[16];
static void* g_paVt[16];
static uint8_t g_fakeRet[4];
static int g_finishCalls;
static int32_t g_finishCode;
static void* g_finishGac;
static void StubFinish(void* g, int32_t code)
{
    ++g_finishCalls; g_finishCode = code; g_finishGac = g;
    *(int32_t*)((uint8_t*)g + 0x194) = code; *(int32_t*)((uint8_t*)g + 0xe0) = 0;
}
static uintptr_t GateB(void* ret) { return Gate(1, (uintptr_t)gac, 0, 0, 0, 0, 0, 0, 0, ret); }
/* L_Tick's body without the Lua stack */
static int32_t TickEnd(uint8_t* g)
{
    return AlwaysTick(g);
}
static void Pending(int32_t mode, void* vt) { *(int32_t*)(gac + 0x194) = -1; *(int32_t*)(gac + 0x138) = mode; *(int32_t*)(gac + 0xe0) = 1; *(void**)cbInst = vt; }

static void TestLoginEnd(void)
{
    *(void**)(udm + UDM_GAC) = gac; *(void**)(udm + UDM_LOGIN_DATA) = loginData; *(void**)(gac + 0xd8) = cbInst;
    g_finishLogin = StubFinish; g_task7CbVt = g_t7Vt; g_pathACbVt = g_paVt; g_slGateRet = g_fakeRet;
    g_origGate[1] = StubTrue; g_cfg.gates = GATES_BLOCK; g_cfg.probe = 1;
    Pending(0, g_t7Vt);
    g_cfg.d7 = 0;
    CHECK(GateB(g_fakeRet) == 0 && !g_slPend && g_slRefused == 1, L"d7=0: StartLogin's refusal is counted, nothing marked");
    Watch(gi);
    CHECK(g_finishCalls == 0, L"d7=0: nothing ended");
    g_cfg.d7 = 1;
    CHECK(GateB(g_fakeRet + 1) == 0 && !g_slPend, L"another gate-B caller is not marked");
    CHECK(GateB(g_fakeRet) == 0 && g_slPend && g_slGac == gac, L"StartLogin's refusal marked; the gate still answers 0");
    CHECK(g_finishCalls == 0, L"nothing is fired inside the gate's detour");
    Watch(gi);
    CHECK(g_finishCalls == 1 && g_finishCode == 1 && g_finishGac == gac && !g_slPend, L"the watch ends it with code 1 (failed)");
    Watch(gi);
    CHECK(g_finishCalls == 1, L"one end per refusal");
    Pending(1, g_paVt); GateB(g_fakeRet); Watch(gi);
    CHECK(g_finishCalls == 1 && !g_slPend, L"path A's callback (mode 1) left alone, not retried");
    Pending(0, g_paVt); GateB(g_fakeRet); Watch(gi);
    CHECK(g_finishCalls == 1, L"a callback with another vtable left alone");
    Pending(0, g_t7Vt); *(int32_t*)(gac + 0x194) = 0; GateB(g_fakeRet); Watch(gi);
    CHECK(g_finishCalls == 1, L"a login whose result is already set left alone");
    Pending(0, g_t7Vt); g_cfg.probe = 0;
    CHECK(GateB(g_fakeRet) == 0 && g_slPend, L"probe off: the refusal is still marked");
    CHECK(Watch(gi) == -1 && g_slPend && g_finishCalls == 1, L"probe off: the watch does nothing");
    CHECK(TickEnd(gi) == 2 && !g_slPend, L"probe off: RVNG_Tick's path ends it (the always-on tick)");
    g_cfg.probe = 1;
    CHECK(g_finishCalls == 2, L"a second boot login is ended too");
    Pending(0, g_t7Vt); GateB(g_fakeRet); Watch(gi);
    CHECK(g_finishCalls == 2 && !g_slPend, L"at most two per process");
    g_cfg.d7 = 0; g_slGateRet = NULL;
}

/* ---- 5c. test 6: the local user's faction written through the game's map functions ---- */
static uint8_t facElem[0x38];
static FString g_facKeySeen;
static uint32_t g_facHashSeen;
static int g_facAssigns;
static wchar_t g_facName[32];
static uint32_t StubHash(int32_t n, const wchar_t* str) { (void)str; return 0x1000u + (uint32_t)n; }
static uint8_t* StubFindOrAdd(void* map, uint32_t h, const FString* k) { (void)map; g_facHashSeen = h; g_facKeySeen = *k; return facElem + 0x10; }
static FString* StubAssign(FString* d, const FString* src)
{
    memcpy(g_facName, src->data, (size_t)src->num * 2); d->data = g_facName; d->num = src->num; d->max = src->num;
    ++g_facAssigns; return d;
}
static void TestFactions(void)
{
    static wchar_t uidText[] = L"user42";
    static FString uidStr;
    static uint8_t user[0x20];
    uidStr.data = uidText; uidStr.num = 7; uidStr.max = 7;
    memcpy(user, &uidStr, sizeof(uidStr));
    *(void**)(udm + UDM_USER) = user;
    g_gi = gi;
    g_strihash = StubHash; g_facFindOrAdd = StubFindOrAdd; g_fstrAssign = StubAssign;
    g_cfg.faction = 0;
    ApplyFaction(nm, L"test");
    CHECK(g_facAssigns == 0 && g_facWritten == 0, L"faction=0: nothing written");
    g_cfg.faction = 2;
    ApplyFaction(nm, L"test");
    CHECK(g_facWritten == 1 && facElem[0x10] == 2 && R32(facElem, 0x28) == 1, L"faction 2 and number 1 written");
    CHECK(g_facName[0] == L'B' && WEq(g_facName, L"BRAVO1") && ((FString*)(facElem + 0x18))->num == 7, L"name BRAVO1 through the game's copy");
    CHECK(g_facKeySeen.data == uidText && g_facHashSeen == 0x1006u, L"keyed by the local user id, hashed over its length");
    g_strihash = NULL;
    ApplyFaction(nm, L"test");
    CHECK(g_facWritten == 1, L"a missing signature: nothing written");
    g_cfg.faction = 0; g_strihash = NULL; g_facFindOrAdd = NULL; g_fstrAssign = NULL;
}

/* ---- 5d. test 3: the room tables filled for a fake second member ---- */
static uint8_t mrmm[0x200], selA[0x200], selB[0x200], selSet[0x40];
static uint8_t* g_cmSeen;
static int g_built, g_fills, g_copies, g_terminated, g_resetKind = -1;
static void StubSetConfirmed(void* n, const void* c) { (void)n; g_cmSeen = (uint8_t*)c; *(int32_t*)(nm + 0x3d8) = *(const int32_t*)((const uint8_t*)c + 0x10); }
static uint8_t StubBuild(void* m)
{
    (void)m; ++g_built;
    *(void**)(selSet + 0x10) = selA; *(void**)(selSet + 0x30) = selB;     /* elements: stride 0x20, value at +0x10 */
    *(void**)(mrmm + 0x40) = selSet; *(int32_t*)(mrmm + 0x48) = 2; *(int32_t*)(mrmm + 0x50) = 3;   /* Num 2, bits 0 and 1 */
    *(int32_t*)(selA + 0x30) = 0; *(int32_t*)(selB + 0x30) = 1;
    *(int32_t*)(selA + 0x2c) = -1; *(int32_t*)(selB + 0x2c) = -1;
    return 1;
}
static void StubFill(void* m, const FString* u, uint8_t c) { (void)m; (void)u; (void)c; ++g_fills; }
static void* StubTArrCopy(void* d, const void* s) { (void)s; ++g_copies; return d; }
static uint8_t StubTerminate(void* m) { (void)m; ++g_terminated; *(int32_t*)(mrmm + 0x48) = 0; return 0; }
static void StubReset(void* n, uint8_t k) { (void)n; g_resetKind = k; *(int32_t*)(nm + 0x3d8) = 0; }
static void TestOpponent(void)
{
    *(void**)(gi + GI_MRMM) = mrmm;
    g_gi = gi;
    g_setConfirmed = StubSetConfirmed; g_buildSel = StubBuild; g_fillSel = StubFill; g_tarrCopy = StubTArrCopy;
    g_terminateSel = StubTerminate; g_nmReset = StubReset;
    g_strihash = StubHash; g_facFindOrAdd = StubFindOrAdd; g_fstrAssign = StubAssign;
    nm[0x3a8] = 0xff; *(int32_t*)(nm + 0x3c0) = 77;
    *(int32_t*)(nm + 0x3d8) = 2;
    g_oppArmed = 1; FillOpponent();
    CHECK(!g_oppFilled && !g_built && !g_oppArmed, L"room tables not empty: no fill, disarmed");
    *(int32_t*)(nm + 0x3d8) = 0;
    g_oppArmed = 1; FillOpponent();
    CHECK(g_oppFilled == 1 && g_built == 1 && g_fills == 2, L"filled: the selectors built, both filled from the UDM");
    CHECK(R32(g_cmSeen, 0x10) == 2 && R32(g_cmSeen, 0x28) == 2 && R32(g_cmSeen, 0x30) == 77, L"SetConfirmed: 2 players, 2 members, the mission program kept");
    uint8_t* m1 = *(uint8_t**)(g_cmSeen + 0x20) + 0xc0;
    CHECK(((FString*)m1)->data == kOppUserText && R32(m1, 0x20) == 1, L"member 2 is RVNG_TEST_2 on team 1");
    CHECK(R32(selA, 0x2c) == 1 && R32(selB, 0x2c) == 2 && selA[0x28] == 1 && selB[0x28] == 1, L"netIds 1 (local) and 2 (opponent), both joined");
    CHECK(g_copies == 2, L"only the opponent's weapons and parts copied");
    CHECK(g_facWritten >= 1 && facElem[0x10] == 2, L"faction entries written (the opponent Bravo last)");
    CleanupOpponent(L"test");
    CHECK(g_oppCleaned && g_terminated == 1 && g_resetKind == 0xff, L"cleanup: selectors terminated, ResetMatchedInfo with the saved kind");
    CleanupOpponent(L"test");
    CHECK(g_terminated == 1, L"cleanup once");
    g_strihash = NULL; g_facFindOrAdd = NULL; g_fstrAssign = NULL; g_oppFilled = 0; g_oppCleaned = 0;
    *(void**)(gi + GI_MRMM) = NULL;
}

/* ---- 5e. test 4: the loopback path (Send capture, encode/decode, re-key, offset, router) with stub game code ---- */
static int g_destroyed, g_deleted;
static void StubDestroy(void* c) { (void)c; ++g_destroyed; }
static void StubDelete(void* c) { (void)c; ++g_deleted; }
static void* g_ctlVt[2] = { (void*)StubDestroy, (void*)StubDelete };
static uint8_t g_mc[0x60];
static void* StubGetMc(void* o) { (void)o; return g_mc; }
static void* g_msgVt[1] = { (void*)StubGetMc };
static uint8_t g_msBuf[0x100];
static uint32_t g_msLen;
static uint32_t MsLen(void) { return g_msLen; }
static void* StubMsDtor(void* ms, uint64_t f) { (void)ms; (void)f; return NULL; }
static void* StubMsWrite(void* ms, const void* p, uint64_t n) { memcpy(g_msBuf, p, (size_t)n); g_msLen = (uint32_t)n; (void)ms; return NULL; }
static void* g_msVt[3] = { (void*)StubMsDtor, NULL, (void*)StubMsWrite };
static void* StubMsCtor(void* ms, uint64_t cap) { (void)cap; *(void**)ms = g_msVt; return ms; }
static void* StubEncInit(void* enc) { *(void**)enc = NULL; return enc; }
static uint8_t StubSerialize(void* err, void* enc, void* mc, void* obj)
{   /* "bytes" = the message itself */
    (void)err; (void)mc;
    uint8_t* ms = *(uint8_t**)((uint8_t*)enc + 8);
    memcpy(g_msBuf, obj, 0x80);
    *(uint8_t**)(ms + 8) = g_msBuf; *(uint8_t**)(ms + 0x10) = g_msBuf + 0x80;
    return 1;
}
static void* g_decVt[1] = { (void*)StubMsDtor };
static void* StubDecCtor(void* dec) { *(void**)dec = g_decVt; return dec; }
static uint8_t g_obj2[0x80], g_ctl2[0x18];
static void StubDeserSp(void* u, void* dec, uintptr_t* sp)
{
    (void)u; (void)dec;
    memcpy(g_obj2, g_msBuf, 0x80);
    *(void**)g_ctl2 = g_ctlVt; *(int32_t*)(g_ctl2 + 8) = 1; *(int32_t*)(g_ctl2 + 0xc) = 1;
    sp[0] = (uintptr_t)g_obj2; sp[1] = (uintptr_t)g_ctl2;
}
static uint8_t g_copyPhys[0x80], g_copyN[0x100], g_copyPlane[0x1000];
static int g_routed; static int32_t g_routedFrom;
static void StubRouter(void* sm, uintptr_t* sender, uintptr_t* sp)
{
    (void)sm; ++g_routed;
    g_routedFrom = *(int32_t*)((uint8_t*)sender[0] + 8);
    memcpy(g_copyPhys, (void*)sp[0], 0x80);
    *(int32_t*)(g_copyPhys + 0x1c) = g_routedFrom;
}
static void TestLoopback(void)
{
    /* release: one use and one weak -> destroy and delete; two uses -> nothing */
    uint8_t ctl[0x18]; *(void**)ctl = g_ctlVt;
    *(int32_t*)(ctl + 8) = 2; *(int32_t*)(ctl + 0xc) = 1; SpRelease(ctl);
    CHECK(g_destroyed == 0 && R32(ctl, 8) == 1, L"release: a shared message only loses a use");
    SpRelease(ctl);
    CHECK(g_destroyed == 1 && g_deleted == 1, L"release: the last use destroys and frees it");
    g_msCtor = StubMsCtor; g_encInit = StubEncInit; g_serialize = StubSerialize; g_decCtor = StubDecCtor;
    g_deserSp = StubDeserSp; g_router = StubRouter;
    g_cfg.loopback = 1;                                    /* (an RVNG match: Send is D1's) */
    uintptr_t bogus[2] = { 0x10, 0 };
    int32_t sends = g_lbSends;
    OnSend(0, (uintptr_t)bogus, 0, 0, 0, 0, 0, 0);
    CHECK(g_lbSends == sends, L"Send: the {0x10, NULL} form is left alone");
    /* a Physics message keyed 2<<56|1 */
    static uint8_t msg[0x80];
    *(void**)msg = g_msgVt; msg[0x10] = 2; *(int32_t*)(msg + 0x14) = 1; msg[0x18] = 1;
    float dir[3] = { 2.0f, 0.0f, 0.0f }; memcpy(msg + 0x20, dir, 12);
    *(int32_t*)(msg + 0x2c) = 1000; *(int32_t*)(msg + 0x30) = 2000; *(int32_t*)(msg + 0x34) = 3000;
    static char clsName[] = "jp.co.soft_gear.strix.server.ext.message.game.FLiveMessagePhysics";   /* (> 15: on the heap) */
    *(int32_t*)(g_mc + 0x48) = 0x1234; *(char**)(g_mc + 8) = clsName;
    *(uint64_t*)(g_mc + 0x18) = sizeof(clsName) - 1; *(uint64_t*)(g_mc + 0x20) = sizeof(clsName) + 8;
    g_lbPhysVt = g_msgVt; g_lbReady = 1; g_gameThread = GetCurrentThreadId();
    uint8_t c1[0x18]; *(void**)c1 = g_ctlVt; *(int32_t*)(c1 + 8) = 1; *(int32_t*)(c1 + 0xc) = 1;
    uintptr_t sp1[2] = { (uintptr_t)msg, (uintptr_t)c1 };
    g_destroyed = g_deleted = 0;
    OnSend(0, (uintptr_t)sp1, 0, 0, 0, 0, 0, 0);
    CHECK(g_lbCaptured == 1 && g_lbCount == 1 && g_destroyed == 1, L"Send: the local Physics captured, the message released");
    CHECK(g_lbNCls == 1 && g_lbCls[0].id == 0x1234 && WEq(g_lbCls[0].name, L"FLiveMessagePhysics") && g_lbCls[0].loop &&
          g_lbCls[0].pol == POL_PLANE, L"Send: counted by class (the name's end), looped, D1 policy plane");
    msg[0x14] = 2;                                         /* keyed to the copy: not captured */
    uint8_t c2[0x18]; *(void**)c2 = g_ctlVt; *(int32_t*)(c2 + 8) = 1; *(int32_t*)(c2 + 0xc) = 1;
    uintptr_t sp2[2] = { (uintptr_t)msg, (uintptr_t)c2 };
    OnSend(0, (uintptr_t)sp2, 0, 0, 0, 0, 0, 0);
    CHECK(g_lbCaptured == 1 && g_destroyed == 2, L"Send: anything else is only released");
    /* drain: decoded, re-keyed, moved 150 m ahead, routed as player 2, applied */
    g_lbCopy = g_copyPlane; g_lbCopyN = g_copyN; *(void**)(g_copyN + 0x98) = g_copyPhys; g_cfg.lbOff = 15000;
    g_destroyed = 0;
    LbDrain((uint8_t*)gi);
    CHECK(g_routed == 1 && g_routedFrom == 2 && g_lbInjected == 1 && g_lbApplied == 1, L"drain: routed as player 2 and applied to the copy");
    CHECK(R32(g_copyPhys, 0x14) == 2 && g_copyPhys[0x18] == 0 && g_copyPhys[0x19] == 0, L"drain: re-keyed to 2<<56|2, not dirty");
    CHECK(R32(g_copyPhys, 0x2c) == 16000 && R32(g_copyPhys, 0x30) == 2000 && R32(g_copyPhys, 0x34) == 3000, L"drain: 150 m ahead along the direction");
    CHECK(g_copyPlane[0x8b1] == 1 && g_destroyed == 1 && g_lbCount == 0, L"drain: the one-shot skip set, our reference released");
    (void)MsLen();
    g_lbReady = 0; g_lbPhysVt = NULL; g_lbCopy = NULL; g_lbCopyN = NULL; g_cfg.loopback = 0;
}

/* ---- 5f. the main-menu row: RVNG texts answered, its press taken, other rows and keys passed on ---- */
static int g_textPassed, g_decidePassed;
static uintptr_t StubText(void* t, uintptr_t f, void* k, void* found) { (void)t; (void)f; (void)k; (void)found; ++g_textPassed; return 0x55; }
static uintptr_t StubDecide(void* w) { (void)w; ++g_decidePassed; return 7; }
static uint8_t g_cmdRow[0x200];
static void* StubSelected(void* w) { (void)w; return g_cmdRow; }
static void* g_widgetVt[0x100];
static void TestMenuRow(void)
{
    InitTexts();
    g_nextText = StubText; g_nextMainDecide = (Fn1)StubDecide;
    static wchar_t k1[] = L"RVNG_Menu_Title", k2[] = L"Campaign_Main_Title", k3[] = L"RVNG_Nope";
    FString f1 = { k1, 16, 16 }, f2 = { k2, 20, 20 }, f3 = { k3, 10, 10 };
    uint8_t found = 0;
    const FString* r = (const FString*)OnText(NULL, 0, &f1, &found);
    CHECK(found == 1 && r && WEq(r->data, L"MULTIPLAYER") && r->num == 12, L"text: RVNG_Menu_Title answered (MULTIPLAYER)");
    CHECK(OnText(NULL, 0, &f2, &found) == 0x55 && OnText(NULL, 0, &f3, &found) == 0x55 && g_textPassed == 2,
          L"text: other keys (and unknown RVNG_ keys) go to the game");
    g_widgetVt[VF_SELECTED_CMD] = (void*)StubSelected;
    void* widget[1] = { g_widgetVt };
    static wchar_t mine[] = L"RVNG_1v1", other[] = L"CampaignArgs";
    FString a1 = { mine, 9, 9 }, a2 = { other, 13, 13 };
    memcpy(g_cmdRow + CMD_STRING_ARGS, &a1, sizeof(a1));
    CHECK(OnMainDecide(widget) == 1 && g_menuPicks == 1 && g_decidePassed == 0, L"decide: COMPETITIVE 1V1 taken, not passed on");
    memcpy(g_cmdRow + CMD_STRING_ARGS, &a2, sizeof(a2));
    CHECK(OnMainDecide(widget) == 7 && g_menuPicks == 1 && g_decidePassed == 1, L"decide: other rows go down the chain");
    /* B / Esc: RVNG's BACK while a page is up (handled: no quit prompt); the game's own otherwise */
    g_nextMainCancel = (Fn1)StubDecide;
    g_menuPage = 1;
    CHECK(OnMainCancel(widget) == 1 && g_menuCancels == 1 && g_decidePassed == 1, L"cancel: B/Esc on RVNG's page taken (BACK), not passed on");
    g_menuPage = 0;
    CHECK(OnMainCancel(widget) == 7 && g_menuCancels == 1 && g_decidePassed == 2, L"cancel: on the stock main menu the game's own (its quit prompt)");
    g_nextMainCanCancel = (Fn1)StubDecide;
    g_menuPage = 1;
    CHECK(OnMainCanCancel(widget) == 1 && g_decidePassed == 2, L"can cancel: yes on RVNG's page (the menu's tick then runs its cancel path)");
    g_menuPage = 0;
    CHECK(OnMainCanCancel(widget) == 7 && g_decidePassed == 3, L"can cancel: the game's own answer on the stock main menu");
    g_nextText = NULL; g_nextMainDecide = NULL; g_nextMainCancel = NULL; g_nextMainCanCancel = NULL;
}

/* ---- 5g. D1's filter (docs/re/D1_FILTER.md) ---- */
static void TestFilter(void)
{
    int phys = PolicyOf(L"FLiveMessagePhysics"), dmg = PolicyOf(L"FLiveMessageDamage"), dc = PolicyOf(L"FLiveMessageDamageClient");
    int hit = PolicyOf(L"FLiveMessageExplosiveWeaponHit"), su = PolicyOf(L"FLiveMessageScoreUpdate");
    CHECK(phys == POL_PLANE && dmg == POL_DAMAGE && dc == POL_DAMAGE_CLIENT && hit == POL_GM_HIT && su == POL_SCORE_UPDATE,
          L"filter: classes found by name");
    CHECK(PolicyOf(L"FLiveMessagePreparingMissionEnd") == POL_DROP && PolicyOf(L"FLiveMessageTimeUp") == POL_DROP &&
          PolicyOf(L"FLiveMessageGameModeState") == POL_DROP && PolicyOf(L"FLiveMessageCheat") == POL_DROP &&
          PolicyOf(L"FLiveMessageScoreAddition") == POL_DROP && PolicyOf(L"FLiveMessagePhysicsX") == POL_DROP &&
          PolicyOf(L"Physics") == POL_DROP && PolicyOf(NULL) == POL_DROP, L"filter: everything else denied (exact names only)");
    /* send: own plane only; the game mode's hit; damage per role */
    CHECK(SendAllowed(phys, 2, 1, 1) && !SendAllowed(phys, 2, 2, 1) && SendAllowed(phys, 2, 2, 2) && !SendAllowed(phys, 1, 0, 1),
          L"filter send: plane messages only with the sender's own key");
    CHECK(SendAllowed(hit, 6, 0, 1) && SendAllowed(hit, 6, 0, 2) && !SendAllowed(hit, 2, 1, 1), L"filter send: ExplosiveWeaponHit on 6<<56");
    CHECK(SendAllowed(dmg, 2, 1, 1) && SendAllowed(dmg, 2, 2, 1) && SendAllowed(dmg, 2, 2, 2) && !SendAllowed(dmg, 2, 1, 2),
          L"filter send: Damage: the host either plane, the guest its own");
    CHECK(SendAllowed(dc, 2, 1, 2) && !SendAllowed(dc, 2, 1, 1) && !SendAllowed(dc, 2, 2, 2), L"filter send: DamageClient: guest, the host's key");
    CHECK(!SendAllowed(su, 2, 2, 1) && !SendAllowed(POL_DROP, 2, 1, 1), L"filter send: ScoreUpdate and denied classes never through Send");
    /* receive: the peer's plane; damage and score per role */
    CHECK(RecvAllowed(phys, 2, 2, 1) && !RecvAllowed(phys, 2, 1, 1) && RecvAllowed(phys, 2, 1, 2) && !RecvAllowed(phys, 2, 0, 1),
          L"filter recv: plane messages only with the peer's key (never id 0)");
    CHECK(RecvAllowed(dmg, 2, 2, 1) && !RecvAllowed(dmg, 2, 1, 1) && RecvAllowed(dmg, 2, 2, 2) && RecvAllowed(dmg, 2, 1, 2),
          L"filter recv: Damage: the host the guest's key, the guest either");
    CHECK(RecvAllowed(dc, 2, 1, 1) && !RecvAllowed(dc, 2, 1, 2) && !RecvAllowed(dc, 2, 2, 1), L"filter recv: DamageClient only on the host, its own key");
    CHECK(RecvAllowed(su, 2, 2, 2) && RecvAllowed(su, 2, 1, 2) && !RecvAllowed(su, 2, 2, 1), L"filter recv: ScoreUpdate only on the guest");
    CHECK(RecvAllowed(hit, 6, 0, 1) && !RecvAllowed(POL_DROP, 1, 0, 1), L"filter recv: the hit on 6<<56; denied classes dropped");
}

/* ---- 5h. D3 / D4 (the guest's half) ---- */
static int g_scoreCalls; static float g_scoreDmg;
static void StubScore(void* v, float dmg, void* a, uint8_t w, uint8_t ind) { (void)v; (void)a; (void)w; (void)ind; ++g_scoreCalls; g_scoreDmg = dmg; }
static int g_authCalls;
static void StubAuth(void* v, void* i) { (void)v; (void)i; ++g_authCalls; }
static int g_dtorCalls;
static void StubInfoDtor(void* i) { (void)i; ++g_dtorCalls; }
static void TestGuest(void)
{
    g_origScoreFn = StubScore; g_origAuthApply = StubAuth; g_infoDtor = StubInfoDtor;
    g_cfg.guest = 1; g_cfg.loopback = 0; g_matchGuest = 1;
    OnScoreFn(NULL, 4.0f, NULL, 0, 0);
    CHECK(g_scoreCalls == 1 && g_scoreDmg == 4.0f && g_d4Blocked == 0, L"D4: no RVNG match (loopback 0): the game's own score function");
    g_scoreCalls = 0;
    g_cfg.loopback = 1;
    g_cfg.guest = 0;
    OnScoreFn(NULL, 12.5f, NULL, 0, 0);
    CHECK(g_scoreCalls == 1 && g_scoreDmg == 12.5f, L"D4: the host's score function runs, its float damage intact");
    g_cfg.guest = 1;
    OnScoreFn(NULL, 3.0f, NULL, 0, 0);
    CHECK(g_scoreCalls == 1 && g_d4Blocked == 1, L"D4: the guest's score function never runs");
    g_matchGuest = 0;
    OnScoreFn(NULL, 3.0f, NULL, 0, 0);
    CHECK(g_scoreCalls == 2 && g_d4Blocked == 1, L"D4: not without D3 in (the guest's score function runs)");
    g_matchGuest = 1;
    CHECK(Me() == 2 && Peer() == 1, L"guest: this PC is player 2, the peer (the host) player 1");
    static uint8_t victim[0x1000], info[0x48];
    g_tdLocalRet = (uint8_t*)1;                          /* (no call here returns there: always passed on) */
    OnAuthApply(victim, info);
    CHECK(g_authCalls == 1 && g_dtorCalls == 0, L"D3: any other caller of AuthoritativeApply goes to the game's");
    g_cfg.guest = 0;
    CHECK(Me() == 1 && Peer() == 2, L"host: this PC is player 1");
    OnAuthApply(victim, info);
    CHECK(g_authCalls == 2, L"D3: off on the host");
    g_origScoreFn = NULL; g_origAuthApply = NULL; g_infoDtor = NULL; g_tdLocalRet = NULL;
    g_cfg.loopback = 0; g_matchGuest = 0;
}

/* ---- 5i. D8: the game's cheat reports switched off ---- */
static int g_rcCalls; static int32_t g_rcId; static uint8_t g_rcType; static void* g_rcArg;
static void StubReport(void* nm, int32_t id, uint8_t type, void* arg) { (void)nm; ++g_rcCalls; g_rcId = id; g_rcType = type; g_rcArg = arg; }
typedef int32_t (*FakeReportFn)(void* nm, int32_t id, uint8_t type, void* arg);
static void TestCheatOff(void)
{
    g_origReportCheat = StubReport;
    for (uint8_t t = 2; t <= 9; ++t) OnReportCheat(NULL, 5, t, (void*)0x77);
    CHECK(g_rcCalls == 0 && g_cheatOff == 8, L"D8: report types 2-9 never reach the game's ReportCheat");
    CHECK(g_cheatByType[9] == 1 && g_cheatByType[2] == 1 && g_cheatByType[1] == 0, L"D8: counted by type");
    OnReportCheat((void*)0x10, 6, 1, (void*)0x88);
    CHECK(g_rcCalls == 1 && g_rcId == 6 && g_rcType == 1 && g_rcArg == (void*)0x88 && g_cheatPassed == 1 && g_cheatOff == 8,
          L"D8: type 1 (client_eac_kick) is handed to the game untouched");

    /* the game's real first 16 bytes (from the signature) moved by LENS_REPORT_CHEAT, then a body that undoes them and
     * returns the type: the hook and its trampoline run as they will in the game */
    uint8_t* m = (uint8_t*)VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    static const uint8_t body[] = { 0x41, 0x5E, 0x41, 0x5C, 0x5F, 0x5E, 0x48, 0x8B, 0x5C, 0x24, 0x10, 0x48, 0x8B, 0x6C, 0x24, 0x18,
                                    0x41, 0x0F, 0xB6, 0xC0, 0xC3 };
    memcpy(m, kSigReportCheat, 16);
    memcpy(m + 16, body, sizeof(body));
    g_origReportCheat = NULL;
    CHECK(((FakeReportFn)(void*)m)(NULL, 0, 9, NULL) == 9, L"D8: the stand-in runs unhooked (the prologue and its undo)");
    CHECK(HookInline(m, LENS_REPORT_CHEAT, (void*)OnReportCheat, (void**)&g_origReportCheat, L"test ReportCheat"),
          L"D8: the real prologue hooks with LENS_REPORT_CHEAT (16 bytes)");
    ((FakeReportFn)(void*)m)(NULL, 3, 9, NULL);
    CHECK(g_cheatOff == 9, L"D8: a call to the hooked function is switched off");
    CHECK(((FakeReportFn)(void*)g_origReportCheat)(NULL, 0, 7, NULL) == 7, L"D8: the trampoline runs the moved prologue and the rest");
    ((FakeReportFn)(void*)m)(NULL, 4, 1, NULL);
    CHECK(g_cheatPassed == 2, L"D8: type 1 goes through the hook and the trampoline");
    g_origReportCheat = NULL;
}

/* ---- D9: the network wall ------------------------------------------------- */
typedef uint32_t (*FakeStartFn)(void* elem, double now);
typedef uint8_t (*FakeBoolFn)(void* a, void* b, void* c);
typedef void* (*FakePtrFn)(void* a);
typedef void (*FakeVoidFn)(void* a);
typedef uintptr_t (*FakeGateFn)(void* ctrl);
static int g_curlRan;
static uint8_t StubCurl(uint8_t* req) { ++g_curlRan; return (uint8_t)((FString*)(req + CURL_URL))->num; }
static uintptr_t StubGateTrue(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ (void)a; (void)b; (void)c; (void)d; (void)e; (void)f; (void)g; (void)h; return 1; }

/* the game's real prologue (from the signature: the bytes the lens moves), then a body that undoes it and returns */
static uint8_t* StandIn(uint8_t* m, const uint8_t* sig, size_t moved, const uint8_t* body, size_t n)
{
    memcpy(m, sig, moved);
    memcpy(m + moved, body, n);
    return m;
}

static void TestWall(void)
{
    uint8_t* m = (uint8_t*)VirtualAlloc(NULL, 8192, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    static uint8_t elem[0x48];
    static wchar_t name[] = L"NotificationsGet";
    FString* nm = (FString*)(elem + LWA_ELEM_NAME);
    nm->data = name; nm->num = (int32_t)WLen(name) + 1; nm->max = nm->num;
    *(int32_t*)(elem + LWA_ELEM_TYPE) = 0;

    /* the LiveWebAPI start: 4 (no request), the element marked as the game's own exit marks it */
    CHECK(OnLwaStart(elem) == LWA_NO_REQUEST && elem[LWA_ELEM_STARTED] == 1 && elem[LWA_ELEM_DONE] == 0 &&
          g_wallRefused[W_LWA] == 1, L"D9: a LiveWebAPI request start answers 4 and marks the element started, not done");
    /* the real prologue (5,1,4,2,5 = 17 bytes), then: add rsp,30h | pop rdi | mov rsi,[rsp+20h] | mov eax,7 | ret */
    static const uint8_t startBody[] = { 0x48, 0x83, 0xC4, 0x30, 0x5F, 0x48, 0x8B, 0x74, 0x24, 0x20, 0xB8, 0x07, 0, 0, 0, 0xC3 };
    uint8_t* start = StandIn(m, kSigLwaStart, 17, startBody, sizeof(startBody));
    CHECK(((FakeStartFn)(void*)start)(elem, 2.5) == 7 && *(double*)(elem + 0x40) == 2.5, L"D9: the start stand-in runs unhooked");
    CHECK(HookInline(start, LENS_LWA_START, (void*)OnLwaStart, &g_origWall[W_LWA], L"test LiveWebAPI start"),
          L"D9: the real start prologue hooks with LENS_LWA_START");
    CHECK(((FakeStartFn)(void*)start)(elem, 3.5) == LWA_NO_REQUEST && g_wallRefused[W_LWA] == 2, L"D9: the hooked start drops the request");
    CHECK(((FakeStartFn)(void*)g_origWall[W_LWA])(elem, 4.5) == 7 && *(double*)(elem + 0x40) == 4.5,
          L"D9: the start's trampoline runs the moved prologue (xmm1 kept) and the rest");

    /* Cosmos: 0 (not sent). Real prologue 5,5,5, then: mov eax,1 | ret */
    static const uint8_t oneBody[] = { 0xB8, 0x01, 0, 0, 0, 0xC3 };
    static wchar_t curl[] = L"https://neo.cosmos.example/client/sys/get_env?token=SECRET";
    FString url = { curl, (int32_t)WLen(curl) + 1, (int32_t)WLen(curl) + 1 };
    uint8_t* cosmos = StandIn(m + 0x100, kSigCosmosSend, 15, oneBody, sizeof(oneBody));
    CHECK(((FakeBoolFn)(void*)cosmos)(NULL, &url, NULL) == 1, L"D9: the Cosmos stand-in sends unhooked");
    CHECK(HookInline(cosmos, LENS_COSMOS_SEND, (void*)OnCosmosSend, &g_origWall[W_COSMOS], L"test Cosmos sender"),
          L"D9: the real Cosmos prologue hooks with LENS_COSMOS_SEND");
    CHECK(((FakeBoolFn)(void*)cosmos)(NULL, &url, NULL) == 0 && g_wallRefused[W_COSMOS] == 1, L"D9: the hooked Cosmos sender answers 0");
    CHECK(((FakeBoolFn)(void*)g_origWall[W_COSMOS])(NULL, &url, NULL) == 1, L"D9: the Cosmos trampoline runs");
    wchar_t u[64];
    CHECK(WEq(FUrlText(&url, u, 64), L"https://neo.cosmos.example/client/sys/get_env"), L"D9: a URL is logged without its query");
    CHECK(WEq(UrlText(L"https://a.example/x", u, 10), L"https://a"), L"D9: a long URL is cut to the buffer");

    /* engine HTTP: a request whose vtable's slot 26 is the hooked function has its URL emptied, then the engine runs */
    static uint8_t req[0x300];
    static void* vt[32];
    *(void***)req = vt;
    FString* ru = (FString*)(req + CURL_URL);
    ru->data = curl; ru->num = (int32_t)WLen(curl) + 1; ru->max = ru->num;
    g_curlProcessFn = (uint8_t*)(void*)StubCurl;
    vt[CURL_VT_PROCESS] = (void*)g_curlProcessFn;
    g_origCurlProcess = (CurlProcessFn)(void*)StubCurl;
    CHECK(OnCurlProcess(req) == 0 && ru->num == 0 && g_curlRan == 1 && g_wallRefused[W_HTTP] == 1,
          L"D9: an engine HTTP request goes on to the engine with an empty URL (its own failure path)");
    ru->num = 5;
    vt[CURL_VT_PROCESS] = (void*)TestWall;                 /* not the curl class */
    CHECK(OnCurlProcess(req) == 0 && ru->num == 5 && g_curlRan == 1, L"D9: an object not known as a curl request is refused unsent");
    /* the real prologue (5,1,1,2,4,7 = 20), then: add rsp,40h | pop r14 | pop rdi | pop rsi | mov eax,[rcx+270h] | ret */
    static const uint8_t curlBody[] = { 0x48, 0x83, 0xC4, 0x40, 0x41, 0x5E, 0x5F, 0x5E, 0x8B, 0x81, 0x70, 0x02, 0x00, 0x00, 0xC3 };
    uint8_t* proc = StandIn(m + 0x200, kSigCurlProcess, 20, curlBody, sizeof(curlBody));
    ru->num = 9;
    CHECK(((FakePtrFn)(void*)proc)(req) == (void*)(uintptr_t)9, L"D9: the HTTP stand-in runs unhooked");
    g_curlProcessFn = proc; vt[CURL_VT_PROCESS] = proc;
    CHECK(HookInline(proc, LENS_CURL_PROCESS, (void*)OnCurlProcess, (void**)&g_origCurlProcess, L"test HTTP start"),
          L"D9: the real HTTP prologue hooks with LENS_CURL_PROCESS");
    CHECK(((uint32_t)(uintptr_t)((FakePtrFn)(void*)proc)(req) & 0xFF) == 0 && ru->num == 0 && g_wallRefused[W_HTTP] == 3,
          L"D9: the hooked HTTP start reaches the engine's code with the URL emptied");

    /* WebSocket: NULL. Real prologue 5,1,4,4, then: add rsp,20h | pop rdi | mov rax,rsi | mov rsi,[rsp+10h] | ret */
    static uint8_t info[0x40];
    static char host[] = "matchmaker.example", path[] = "/matchmaking";
    *(const char**)(info + LWS_INFO_ADDRESS) = host; *(int32_t*)(info + LWS_INFO_PORT) = 443;
    *(const char**)(info + LWS_INFO_PATH) = path; *(void**)(info + 0x30) = (void*)0x1234;
    static const uint8_t lwsBody[] = { 0x48, 0x83, 0xC4, 0x20, 0x5F, 0x48, 0x8B, 0xC6, 0x48, 0x8B, 0x74, 0x24, 0x10, 0xC3 };
    uint8_t* lws = StandIn(m + 0x300, kSigLwsConnect, 14, lwsBody, sizeof(lwsBody));
    CHECK(((FakePtrFn)(void*)lws)(info) == (void*)0x1234, L"D9: the WebSocket stand-in connects unhooked");
    CHECK(HookInline(lws, LENS_LWS_CONNECT, (void*)OnLwsConnect, &g_origWall[W_WS], L"test WebSocket connect"),
          L"D9: the real WebSocket prologue hooks with LENS_LWS_CONNECT");
    CHECK(((FakePtrFn)(void*)lws)(info) == NULL && g_wallRefused[W_WS] == 1, L"D9: the hooked WebSocket connect answers NULL");
    CHECK(((FakePtrFn)(void*)g_origWall[W_WS])(info) == (void*)0x1234, L"D9: the WebSocket trampoline runs");
    wchar_t a[8];
    CHECK(WEq(CText(host, a, 8), L"matchma"), L"D9: a C string is read up to the buffer");

    /* Strix start: real prologue 2,1,8,7, then: add rsp,2C8h | pop rsi | pop rbp | ret */
    static const uint8_t strixBody[] = { 0x48, 0x81, 0xC4, 0xC8, 0x02, 0x00, 0x00, 0x5E, 0x5D, 0xC3 };
    uint8_t* strix = StandIn(m + 0x400, kSigStrixInit, 18, strixBody, sizeof(strixBody));
    ((FakeVoidFn)(void*)strix)(NULL);
    CHECK(HookInline(strix, LENS_STRIX_INIT, (void*)OnStrixInit, &g_origWall[W_STRIX], L"test Strix start"),
          L"D9: the real Strix prologue hooks with LENS_STRIX_INIT");
    ((FakeVoidFn)(void*)strix)(NULL);
    CHECK(g_wallRefused[W_STRIX] == 1, L"D9: the hooked Strix start is refused");
    ((FakeVoidFn)(void*)g_origWall[W_STRIX])(NULL);
    /* Messenger set-up: real prologue 2,1,3,4,8, then: add rsp,38h | pop rbx | pop rbp | ret */
    static const uint8_t msgBody[] = { 0x48, 0x83, 0xC4, 0x38, 0x5B, 0x5D, 0xC3 };
    static uint8_t mgr[0x100];
    uint8_t* msg = StandIn(m + 0x500, kSigMessengerInit, 18, msgBody, sizeof(msgBody));
    ((FakeVoidFn)(void*)msg)(mgr);
    CHECK(HookInline(msg, LENS_MESSENGER_INIT, (void*)OnMessengerInit, &g_origWall[W_MESSENGER], L"test Messenger set-up"),
          L"D9: the real Messenger prologue hooks with LENS_MESSENGER_INIT");
    ((FakeVoidFn)(void*)msg)(mgr);
    CHECK(g_wallRefused[W_MESSENGER] == 1, L"D9: the hooked Messenger set-up is refused");
    ((FakeVoidFn)(void*)g_origWall[W_MESSENGER])(mgr);

    /* the nine more gates: the game's answer logged, 0 returned */
    g_origGate[GATE_FRIENDS] = StubGateTrue;
    CHECK(kGateDetour[GATE_FRIENDS](1, 2, 3, 4, 5, 6, 7, 8) == 0 && g_gateCalls[GATE_FRIENDS] == 1 && g_gateTrue[GATE_FRIENDS] == 1,
          L"D9: a gate the game answers true answers false");
    /* the template (5,1,4,5), then: add rsp,20h | pop rdi | mov eax,1 | ret; and the blocks gate's (2,4,5,3) */
    static const uint8_t gateBody[] = { 0x48, 0x83, 0xC4, 0x20, 0x5F, 0xB8, 0x01, 0, 0, 0, 0xC3 };
    static uint8_t ctrl[0x80];
    uint8_t* gs = StandIn(m + 0x600, kSigGateSettings, 15, gateBody, sizeof(gateBody));
    uint8_t* gbk = StandIn(m + 0x700, kSigGateBlocks, 14, gateBody, sizeof(gateBody));
    CHECK(((FakeGateFn)(void*)gs)(ctrl) == 1 && ((FakeGateFn)(void*)gbk)(ctrl) == 1, L"D9: the gate stand-ins answer true unhooked");
    uint8_t* at[GATE_N] = { 0 };
    at[GATE_SETTINGS] = gs; at[GATE_BLOCKS] = gbk;
    CHECK(InstallMoreGates(at) == 2 && g_wallGatesIn == 2, L"D9: the gates found are hooked, the missing ones skipped");
    CHECK(((FakeGateFn)(void*)gs)(ctrl) == 0 && ((FakeGateFn)(void*)gbk)(ctrl) == 0 && g_gateTrue[GATE_SETTINGS] == 1 &&
          g_gateTrue[GATE_BLOCKS] == 1, L"D9: the hooked gates answer false, the game's true counted");

    /* a gate found through its call site: the target's head must be the template's */
    uint8_t* site = m + 0x800;
    uint8_t* tgt = m + 0x900;
    site[0] = 0xE8; { int32_t rel = (int32_t)(tgt - (site + 5)); memcpy(site + 1, &rel, 4); }
    memcpy(tgt, kGateCHead, sizeof(kGateCHead));
    uint8_t* exe0 = g_exe; size_t size0 = g_exeSize;
    g_exe = m; g_exeSize = 8192;
    CHECK(GateAt(site, kGateCHead, L"test gate") == tgt, L"D9: a call site's target with the template's head is the gate");
    CHECK(GateAt(site, kGateAHead, L"test gate") == NULL, L"D9: a target with another head is not used");
    g_exe = exe0; g_exeSize = size0;
}

/* ---- 6. the self-test's deathmatch travel (TravelDM) ----------------------- */
static uint8_t info[0x200], mcm[0x200], fakeRow[0x100], defaultRow[0x100];
static uint32_t g_rowAsked;
static uintptr_t g_mapArgs[8];
static int g_prepared;
static uint8_t* StubRow(void* im, uint32_t id) { (void)im; g_rowAsked = id; return id == 160010 ? fakeRow : defaultRow; }
static uintptr_t StubMap(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ g_mapArgs[0] = a; g_mapArgs[1] = b; g_mapArgs[2] = c; g_mapArgs[3] = d; g_mapArgs[6] = g; (void)e; (void)f; (void)h; return 0; }
static uintptr_t StubPrep(void* nm) { (void)nm; ++g_prepared; return 0; }

static void TestTravel(void)
{
    *(void**)(gi + GI_INFO_MGR) = info; *(void**)(gi + GI_MAP_CHANGE) = mcm;
    g_gi = gi; g_cfg.probe = 1; g_cfg.mission = 160010;
    g_levelRow = NULL;
    CHECK(TravelDM() == 0, L"not ready without the game's functions");
    g_levelRow = StubRow; g_levelRowDefault = defaultRow; g_fChangeMap = (uint8_t*)(void*)StubMap; g_nmPrepare = StubPrep;
    *(int32_t*)(udm + 0xf38) = 7; *(int32_t*)(nm + 0x538) = 6;
    CHECK(TravelDM() == 1, L"travel requested");
    CHECK(g_rowAsked == 160010 && g_mapArgs[0] == (uintptr_t)mcm && g_mapArgs[1] == (uintptr_t)(fakeRow + 0x48),
          L"RequestChangeMap(MapChangeManager, &row+0x48, ...)");
    CHECK(g_mapArgs[2] && R64((void*)g_mapArgs[2], 0) == 0 && g_mapArgs[3] && g_mapArgs[6], L"empty options, scratch and 7th argument");
    CHECK(g_prepared == 1, L"the NetworkManager prepare step ran");
    CHECK(R32(udm, 0xf38) == 160010 && R32(nm, 0x538) == 0, L"MissionID written, NM+0x538 cleared");
    g_cfg.mission = 999;
    CHECK(TravelDM() == 0 && g_prepared == 1, L"no level row: no travel");
    g_cfg.mission = 160010;
}

/* ---- 7. D6: the Result map's travel goes to the main menu ------------------ */
static const wchar_t* const kNames[] = { L"", L"/Game/Maps/Menu/PL_MainMenu", L"PL_MainMenu",
                                         L"/Game/OnlineMode/Maps/Menu/Result", L"Result", L"/Game/OnlineMode/Maps/DM/PL_DM_001" };
static void* StubNameToString(const FNameRaw* n, MsvcWString* out)
{
    const wchar_t* s = (n->index >= 0 && n->index < 6) ? kNames[n->index] : L"";
    size_t len = WLen(s), cap = len | 7;
    wchar_t* p = (wchar_t*)malloc((cap + 1) * 2);
    memcpy(p, s, (len + 1) * 2);
    out->u.ptr = p; out->size = len; out->cap = cap;
    return out;
}
static uintptr_t g_mapPathSeen;
static uintptr_t StubMapPath(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ (void)a; (void)c; (void)d; (void)e; (void)f; (void)g; (void)h; g_mapPathSeen = b; return 0x55; }

static void TestResultRedirect(void)
{
    U.nameToString = StubNameToString;
    g_origChangeMap = StubMapPath;
    static FNameRaw menu[4] = { { 1, 0 }, { 2, 0 }, { 0, 0 }, { 0, 0 } }, result[4] = { { 3, 0 }, { 4, 0 }, { 0, 0 }, { 0, 0 } };
    FString none; memset(&none, 0, sizeof(none));
    g_cfg.d6 = 1;
    OnChangeMap(0, (uintptr_t)result, (uintptr_t)&none, 0, 0, 0, 0, 0);
    CHECK(g_mapPathSeen == (uintptr_t)result, L"d6 without a kept main menu path: the Result map goes ahead");
    OnChangeMap(0, (uintptr_t)menu, (uintptr_t)&none, 0, 0, 0, 0, 0);
    CHECK(g_haveMenuPath && g_mapPathSeen == (uintptr_t)menu, L"the main menu's own request passes and its path is kept");
    CHECK(OnChangeMap(0, (uintptr_t)result, (uintptr_t)&none, 0, 0, 0, 0, 0) == 0x55 && g_mapPathSeen == (uintptr_t)g_menuPath,
          L"d6: the Result map's travel goes to the kept main menu path");
    CHECK(R64(g_menuPath, 0) == R64(menu, 0) && R64(g_menuPath, 8) == R64(menu, 8) && R64(g_menuPath, 16) == 0,
          L"the kept path: both FNames, an empty SubPath");
    CHECK(WEq(g_lastMap, L"/Game/Maps/Menu/PL_MainMenu"), L"the last map reads as the main menu");
    g_cfg.d6 = 0;
    OnChangeMap(0, (uintptr_t)result, (uintptr_t)&none, 0, 0, 0, 0, 0);
    CHECK(g_mapPathSeen == (uintptr_t)result, L"d6=0: the Result map goes ahead");
    U.nameToString = NULL;
}

/* ---- 7b. a normal install's match (probe=0): the match hooks pass the game's calls on until the launch arms one ---- */
static int g_sendPassed, g_pumpPassed, g_setPassed;
static uintptr_t StubSendPass(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ (void)a; (void)b; (void)c; (void)d; (void)e; (void)f; (void)g; (void)h; ++g_sendPassed; return 0x77; }
static uintptr_t StubPumpPass(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ (void)a; (void)b; (void)c; (void)d; (void)e; (void)f; (void)g; (void)h; ++g_pumpPassed; return 0x78; }
static uintptr_t StubSetPass(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d, uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h)
{ (void)a; (void)b; (void)c; (void)d; (void)e; (void)f; (void)g; (void)h; ++g_setPassed; return 0x79; }
static void TestMatchMode(void)
{
    static __typeof__(g_cfg) keepCfg; keepCfg = g_cfg;
    static Link keepLink; keepLink = g_link;             /* (static: a Link is large) */
    void* slots[] = { &g_setConfirmed, &g_buildSel, &g_fillSel, &g_tarrCopy, &g_fstrAssign, &g_msCtor, &g_encInit, &g_serialize,
                      &g_decCtor, &g_deserSp, &g_router };
    enum { NS = sizeof(slots) / sizeof(slots[0]) };
    uintptr_t keep[NS], one = 1, none0 = 0;
    for (int i = 0; i < NS; ++i) { memcpy(&keep[i], slots[i], 8); memcpy(slots[i], &none0, 8); }
    Fn8 s0 = g_origSend, p0 = g_origPump, t0 = g_origSetState, m0 = g_origChangeMap;
    g_origSend = StubSendPass; g_origPump = StubPumpPass; g_origSetState = StubSetPass; g_origChangeMap = StubMapPath;
    U.nameToString = StubNameToString;
    g_cfg.probe = 0; g_cfg.d2 = 0; g_cfg.w1 = 0; g_cfg.d6 = 0; g_cfg.opponent = 0; g_cfg.loopback = 0; g_cfg.wire = 0; g_cfg.guest = 0;
    g_cfg.mission = 160010;

    /* idle: every match hook is the game's own */
    uintptr_t bogus[2] = { 0x10, 0 };
    CHECK(OnSend(0, (uintptr_t)bogus, 0, 0, 0, 0, 0, 0) == 0x77 && g_sendPassed == 1, L"idle: Send is the game's own (D1 only in a match)");
    CHECK(OnPump(0, 0, 0, 0, 0, 0, 0, 0) == 0x78 && g_pumpPassed == 1, L"idle: the slot pump is the game's own");
    static uint8_t gmb[0x1000];
    g_lastHookState = -7;
    CHECK(OnSetState((uintptr_t)gmb, 5, 0, 0, 0, 0, 0, 0) == 0x79 && g_setPassed == 1 && g_lastHookState == -7 && g_gm == gmb,
          L"idle: SetState passed on, nothing of RVNG's run (the game mode still kept)");
    g_gm = NULL;

    /* the launch arms the match only with the link up, every match hook in and every piece found */
    int32_t prep = g_prepared;
    g_link.state = LS_OFF; g_link.player = 2;
    CHECK(TravelDM() == 0 && !g_matchOn && g_prepared == prep, L"match: no travel without the link to the other PC up");
    g_link.state = LS_UP; g_matchCore = 0; g_matchGuest = 1;
    CHECK(TravelDM() == 0 && !g_matchOn, L"match: no travel with a match hook missing");
    g_matchCore = 1; g_matchGuest = 0;
    CHECK(TravelDM() == 0 && !g_matchOn, L"match: the guest needs D3/D4 in");
    g_matchGuest = 1;
    CHECK(TravelDM() == 0 && !g_matchOn && g_cfg.loopback == 0, L"match: no travel with a piece of the copy or the message layer missing");
    for (int i = 0; i < NS; ++i) memcpy(slots[i], &one, 8);
    *(int32_t*)(fakeRow + 0x48) = 5;                       /* (the row's map: PL_DM_001) */
    g_wireReleased = 1; g_llFired = 1; g_clockApplied = 1; g_oppFilled = 0;
    CHECK(TravelDM() == 1 && g_matchOn && g_prepared == prep + 1, L"match: armed and travelled");
    CHECK(g_cfg.d2 && g_cfg.w1 && g_cfg.d6 && g_cfg.opponent && g_cfg.loopback && g_cfg.wire == 2 && g_cfg.guest && g_cfg.linkPlayer == 2 &&
          !g_cfg.hit && !g_cfg.probe && g_oppArmed, L"match: D2, W1, D6, the copy and the Steam wire on, as the guest (player 2)");
    CHECK(!g_wireReleased && !g_llFired && !g_clockApplied && WEq(g_matchMap, L"/Game/OnlineMode/Maps/DM/PL_DM_001"),
          L"match: the last match's once-only steps reset; the deathmatch map kept");
    CHECK(OnSend(0, (uintptr_t)bogus, 0, 0, 0, 0, 0, 0) == 0 && g_sendPassed == 1, L"match: Send is D1's now (nothing passed on)");

    /* the travel away from the deathmatch disarms it 8.5 s later; the settings come back */
    static FNameRaw dm[4] = { { 5, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 } }, result[4] = { { 3, 0 }, { 4, 0 }, { 0, 0 }, { 0, 0 } };
    FString nostr; memset(&nostr, 0, sizeof(nostr));
    OnChangeMap(0, (uintptr_t)dm, (uintptr_t)&nostr, 0, 0, 0, 0, 0);
    CHECK(g_matchEndAt == 0, L"match: its own map's travel does not end it");
    CHECK(OnChangeMap(0, (uintptr_t)result, (uintptr_t)&nostr, 0, 0, 0, 0, 0) == 0x55 && g_mapPathSeen == (uintptr_t)g_menuPath &&
          g_matchEndAt > GetTickCount64() + 8000, L"match: the Result map goes to the main menu (D6) and the disarm is due in 8.5 s");
    TickEnd(NULL);
    CHECK(g_matchOn, L"match: still armed before then");
    g_matchEndAt = GetTickCount64() - 1;
    TickEnd(NULL);
    CHECK(!g_matchOn && !g_cfg.loopback && !g_cfg.d6 && !g_cfg.d2 && !g_cfg.wire && !g_cfg.guest && !g_oppArmed && !g_matchMap[0],
          L"match: disarmed by the tick: the settings as before");
    CHECK(OnSend(0, (uintptr_t)bogus, 0, 0, 0, 0, 0, 0) == 0x77 && g_sendPassed == 2, L"match: after it Send is the game's own again");

    /* the one-PC rehearsal (the kit's dm_p): the same arming on the in-process pair's link A, wire 1, as the host */
    static Link keepA; keepA = g_lpA;
    g_cfg.rehearse = 1; g_cfg.wire = 1;
    g_link.state = LS_OFF; g_lpA.state = LS_UP; g_lpA.player = 1;
    CHECK(TravelDM() == 1 && g_matchOn && g_cfg.wire == 1 && !g_cfg.guest && g_cfg.loopback,
          L"rehearsal: armed from the pair's link (wire 1, the host), not Steam's");
    MatchDisarm(L"the rehearsal test");
    CHECK(!g_matchOn && g_cfg.wire == 1 && g_cfg.rehearse && !g_cfg.loopback, L"rehearsal: disarmed back to the idle pair (wire 1, loopback 0)");
    g_lpA = keepA;

    *(int32_t*)(fakeRow + 0x48) = 0;
    for (int i = 0; i < NS; ++i) memcpy(slots[i], &keep[i], 8);
    g_origSend = s0; g_origPump = p0; g_origSetState = t0; g_origChangeMap = m0;
    U.nameToString = NULL; g_matchCore = 0; g_matchGuest = 0;
    g_link = keepLink; g_cfg = keepCfg;
}

/* ---- D9's test-only network log (netlog.h): import slots in a fake module image, the wrappers, the address text ---- */
static uintptr_t g_fkSock; static int g_fkLen; static const void* g_fkSa;
static int FakeConnect(uintptr_t s, const void* sa, int len) { g_fkSock = s; g_fkSa = sa; g_fkLen = len; return 77; }
static int FakeGai(const void* n, const void* s, const void* h, void** r) { (void)n; (void)s; (void)h; (void)r; return 11001; }
static int FakeSendTo(uintptr_t s, const char* b, int n, int f, const void* to, int tl) { (void)s; (void)b; (void)f; (void)to; (void)tl; return n; }
static BOOL FakeConnectEx(uintptr_t s, const void* sa, int l, void* b, DWORD n, DWORD* sent, void* ov)
{ (void)b; (void)n; (void)sent; (void)ov; g_fkSock = s; g_fkSa = sa; g_fkLen = l; return 1; }
static void* g_fkSendMsgOut;
static int FakeIoctl(uintptr_t s, DWORD c, void* in, DWORD il, void* out, DWORD ol, DWORD* got, void* ov, void* cr)
{ (void)s; (void)c; (void)in; (void)il; (void)ol; (void)ov; (void)cr; *(void**)out = g_fkSendMsgOut ? g_fkSendMsgOut : (void*)FakeConnectEx; if (got) *got = 8; return 0; }
static void* FakeGpa(HANDLE m, const char* name) { (void)m; return name && name[0] == 'c' ? (void*)FakeConnect : (void*)FakeGai; }
static int FakeSendMsg(uintptr_t s, void* m, DWORD f, DWORD* n, void* ov, void* cr) { (void)s; (void)m; (void)f; (void)n; (void)ov; (void)cr; return 99; }

static void TestNetLog(void)
{
    NlInitTargets();
    g_nl[NL_CONNECT].real = (void*)FakeConnect;
    g_nl[NL_GAI].real = (void*)FakeGai;
    g_nl[NL_SENDTO].real = (void*)FakeSendTo;
    g_nl[NL_IOCTL].real = (void*)FakeIoctl;
    g_nl[NL_GPA].real = (void*)FakeGpa;
    uint8_t* b = (uint8_t*)VirtualAlloc(NULL, 0x3000, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    *(uint32_t*)(b + 0x3C) = 0x80;
    *(uint32_t*)(b + 0x80) = 0x4550;                                   /* PE\0\0 */
    uint8_t* opt = b + 0x80 + 24;
    *(uint16_t*)opt = 0x20B;
    *(uint32_t*)(opt + 56) = 0x3000;                                    /* SizeOfImage */
    *(uint32_t*)(opt + 108) = 16;                                       /* NumberOfRvaAndSizes */
    *(uint32_t*)(opt + 120) = 0x1000;                                   /* import directory */
    *(uint32_t*)(opt + 112 + 13 * 8) = 0x1400;                          /* delay-import directory */
    *(uint32_t*)(b + 0x1000 + 12) = 0x1100; *(uint32_t*)(b + 0x1000 + 16) = 0x1200;    /* one descriptor, then zeros */
    uint64_t* iat = (uint64_t*)(b + 0x1200);
    iat[0] = (uint64_t)(uintptr_t)FakeConnect; iat[1] = 0x1234; iat[2] = (uint64_t)(uintptr_t)FakeGai; iat[3] = 0;
    *(uint32_t*)(b + 0x1400) = 1; *(uint32_t*)(b + 0x1400 + 4) = 0x1100; *(uint32_t*)(b + 0x1400 + 12) = 0x1500;
    uint64_t* diat = (uint64_t*)(b + 0x1500);
    diat[0] = (uint64_t)(uintptr_t)FakeSendTo; diat[1] = 0;
    CHECK(NlPatchModule(b) == 3, L"netlog: 3 watched slots patched (2 imports, 1 delay import)");
    CHECK(iat[0] == (uint64_t)(uintptr_t)NlConnect && iat[2] == (uint64_t)(uintptr_t)NlGai, L"netlog: the import slots point at the wrappers");
    CHECK(iat[1] == 0x1234, L"netlog: an unwatched slot is left alone");
    CHECK(diat[0] == (uint64_t)(uintptr_t)NlSendTo, L"netlog: the delay-import slot points at its wrapper");
    CHECK(NlPatchModule(b) == 0, L"netlog: a second pass patches nothing more");

    uint8_t out4[16] = { 2, 0, 0x01, 0xBB, 8, 8, 4, 4 }, lo4[16] = { 2, 0, 0, 80, 127, 0, 0, 1 };
    int32_t o0 = g_nlOutside, l0 = g_nlLoopback;
    CHECK(((NlConnectFn)(uintptr_t)iat[0])(42, out4, 16) == 77 && g_fkSock == 42 && g_fkSa == out4 && g_fkLen == 16,
          L"netlog: connect's wrapper calls the real one with the same arguments and returns its answer");
    CHECK(g_nlOutside == o0 + 1, L"netlog: an outside connect is counted");
    ((NlConnectFn)(uintptr_t)iat[0])(42, out4, 16);
    CHECK(g_nlOutside == o0 + 2, L"netlog: a repeat (the fast path) is still counted");
    ((NlConnectFn)(uintptr_t)iat[0])(43, lo4, 16);
    CHECK(g_nlLoopback == l0 + 1 && g_nlOutside == o0 + 2, L"netlog: a loopback connect is counted as loopback only");
    CHECK(((NlSendToFn)(uintptr_t)diat[0])(1, "ab", 2, 0, out4, 16) == 2, L"netlog: sendto's wrapper passes the answer back");
    CHECK(((NlGaiFn)(uintptr_t)iat[2])("api.example.test", "443", NULL, NULL) == 11001 && g_nlLookups >= 1,
          L"netlog: getaddrinfo's wrapper passes the answer back and counts the lookup");
    int32_t lk = g_nlLookups;
    ((NlGaiFn)(uintptr_t)iat[2])("localhost", NULL, NULL, NULL);
    CHECK(g_nlLookups == lk, L"netlog: a localhost lookup is not counted as outside");

    wchar_t d[64]; int loop;
    NlAddr(out4, 16, d, 64, &loop);
    CHECK(WEq(d, L"8.8.4.4:443") && !loop, L"netlog: IPv4 text");
    uint8_t six[28] = { 23, 0, 0x01, 0xBB, 0, 0, 0, 0, 0x20, 0x01, 0x0D, 0xB8 };
    six[23] = 1;
    NlAddr(six, 28, d, 64, &loop);
    CHECK(WEq(d, L"[2001:db8:0:0:0:0:0:1]:443") && !loop, L"netlog: IPv6 text");
    uint8_t six1[28] = { 23, 0, 0, 80 }; six1[23] = 1;
    NlAddr(six1, 28, d, 64, &loop);
    CHECK(loop, L"netlog: ::1 is loopback");
    uint8_t map4[28] = { 23, 0, 0, 80 }; map4[18] = 0xFF; map4[19] = 0xFF; map4[20] = 127; map4[23] = 1;
    NlAddr(map4, 28, d, 64, &loop);
    CHECK(loop, L"netlog: ::ffff:127.0.0.1 is loopback");

    CHECK(NlGpa(NULL, "connect") == (void*)NlConnect, L"netlog: GetProcAddress of a watched function gives the wrapper");
    CHECK(NlGpa(NULL, "other") == (void*)NlGai, L"netlog: (the fake's other answer is watched too)");
    g_nl[NL_GAI].real = NULL;
    CHECK(NlGpa(NULL, "other") == (void*)FakeGai, L"netlog: GetProcAddress of an unwatched function is passed back as is");

    void* ce = NULL; DWORD got = 0;
    CHECK(NlIoctl(7, 0xC8000006u, (void*)kWsaIdConnectEx, 16, &ce, 8, &got, NULL, NULL) == 0 && ce == (void*)NlConnectEx,
          L"netlog: ConnectEx handed out through WSAIoctl is wrapped");
    CHECK(NlConnectEx(9, out4, 16, NULL, 0, NULL, NULL) == 1 && g_fkSock == 9, L"netlog: the ConnectEx wrapper calls the real one");
    g_nl[NL_BIND].real = (void*)FakeConnect;
    int32_t b0 = g_nlBinds;
    CHECK(NlBind(5, lo4, 16) == 77 && NlBind(6, lo4, 16) == 77 && g_nlBinds == b0 + 2 && g_fkSock == 6,
          L"netlog: bind is passed through and counted");
    void* sm = NULL;
    static uint8_t sendMsgId[16];
    memcpy(sendMsgId, kWsaIdSendMsg, 16);
    g_fkSendMsgOut = (void*)FakeSendMsg;
    CHECK(NlIoctl(7, 0xC8000006u, sendMsgId, 16, &sm, 8, &got, NULL, NULL) == 0 && sm == (void*)NlSendMsgX,
          L"netlog: WSASendMsg handed out through WSAIoctl is wrapped");
    void* msg[2] = { out4, (void*)(uintptr_t)16 };
    int32_t o1 = g_nlOutside;
    CHECK(NlSendMsgX(3, msg, 0, NULL, NULL, NULL) == 99 && g_nlOutside == o1 + 1, L"netlog: a WSASendMsg datagram's outside destination is counted");
    g_fkSendMsgOut = NULL;
    (void)b;                                                    /* (the fake image is left; the test ends soon) */
}

/* ---- the EOS block (eoswall.h, eosblock=1): the EOS SDK's import slots, the refusing wrappers, the load notification ---- */
static int g_ewErr, g_ewGaiRan, g_ewConnRan;
static void FakeSetErr(int e) { g_ewErr = e; }
static int EwFakeConnect(uintptr_t s, const void* sa, int len) { (void)s; (void)sa; (void)len; ++g_ewConnRan; return 0; }
static int EwFakeGai(const void* n, const void* s, const void* h, void** r) { (void)n; (void)s; (void)h; (void)r; ++g_ewGaiRan; return 0; }
static int EwFakeSendTo(uintptr_t s, const char* b, int n, int f, const void* to, int tl) { (void)s; (void)b; (void)f; (void)to; (void)tl; return n; }
static void* EwFakeGpa(HANDLE m, const char* name) { (void)m; return name && name[0] == 'c' ? (void*)EwFakeConnect : (void*)EwFakeGai; }

static uint8_t* FakeImage(uint64_t a, uint64_t b2, uint64_t c, uint64_t d)
{
    uint8_t* b = (uint8_t*)VirtualAlloc(NULL, 0x3000, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    *(uint32_t*)(b + 0x3C) = 0x80;
    *(uint32_t*)(b + 0x80) = 0x4550;
    uint8_t* opt = b + 0x80 + 24;
    *(uint16_t*)opt = 0x20B;
    *(uint32_t*)(opt + 56) = 0x3000;
    *(uint32_t*)(opt + 108) = 16;
    *(uint32_t*)(opt + 120) = 0x1000;
    *(uint32_t*)(opt + 112 + 13 * 8) = 0x1400;
    *(uint32_t*)(b + 0x1000 + 12) = 0x1100; *(uint32_t*)(b + 0x1000 + 16) = 0x1200;
    uint64_t* iat = (uint64_t*)(b + 0x1200);
    iat[0] = a; iat[1] = b2; iat[2] = c; iat[3] = 0;
    *(uint32_t*)(b + 0x1400) = 1; *(uint32_t*)(b + 0x1400 + 4) = 0x1100; *(uint32_t*)(b + 0x1400 + 12) = 0x1500;
    uint64_t* diat = (uint64_t*)(b + 0x1500);
    diat[0] = d; diat[1] = 0;
    return b;
}

static void TestEosWall(void)
{
    EwInitTargets();
    g_ew[EW_CONNECT].real = (void*)EwFakeConnect;
    g_ew[EW_GAI].real = (void*)EwFakeGai;
    g_ew[EW_SENDTO].real = (void*)EwFakeSendTo;
    g_ew[EW_IOCTL].real = (void*)FakeIoctl;
    g_ew[EW_GPA].real = (void*)EwFakeGpa;
    g_ewSetErr = FakeSetErr;
    /* connect (the real one), something else, getaddrinfo, and netlog's sendto wrapper in the delay imports */
    uint8_t* b = FakeImage((uint64_t)(uintptr_t)EwFakeConnect, 0x1234, (uint64_t)(uintptr_t)EwFakeGai, (uint64_t)(uintptr_t)NlSendTo);
    uint64_t* iat = (uint64_t*)(b + 0x1200);
    uint64_t* diat = (uint64_t*)(b + 0x1500);
    EwPatch(b, 0x3000, L"test");
    CHECK(g_ewSlots == 3 && g_ewLoaded == 1 && g_ewBase == b, L"eosblock: 3 reaching-out slots of the EOS SDK patched");
    CHECK(iat[0] == (uint64_t)(uintptr_t)EwConnect && iat[2] == (uint64_t)(uintptr_t)EwGai && iat[1] == 0x1234,
          L"eosblock: connect and getaddrinfo point at the refusing wrappers, other slots untouched");
    CHECK(diat[0] == (uint64_t)(uintptr_t)EwSendTo, L"eosblock: a slot netlog had wrapped is taken over too");
    CHECK(EwUnwrapped() == 0, L"eosblock: no reaching-out slot left unwrapped");
    iat[0] = (uint64_t)(uintptr_t)EwFakeConnect;
    CHECK(EwUnwrapped() == 1, L"eosblock: a slot put back is seen");
    EwWalk(b, 0);
    CHECK(EwUnwrapped() == 0 && iat[0] == (uint64_t)(uintptr_t)EwConnect, L"eosblock: and patched again");

    uint8_t out4[16] = { 2, 0, 0x01, 0xBB, 104, 18, 125, 108 }, lo4[16] = { 2, 0, 0, 80, 127, 0, 0, 1 };
    g_ewErr = 0;
    CHECK(((NlConnectFn)(uintptr_t)iat[0])(5, out4, 16) == -1 && g_ewConnRan == 0 && g_ewErr == EW_ENETUNREACH &&
          g_ewRefused[EW_CONNECT] == 1, L"eosblock: an outside connect fails as an unreachable network, never reaching Winsock");
    CHECK(((NlConnectFn)(uintptr_t)iat[0])(5, lo4, 16) == 0 && g_ewConnRan == 1 && g_ewLoopback == 1,
          L"eosblock: a loopback connect goes through");
    void* res = (void*)1;
    CHECK(((NlGaiFn)(uintptr_t)iat[2])("api.epicgames.dev", "443", NULL, &res) == EW_HOST_NOT_FOUND && res == NULL &&
          g_ewGaiRan == 0 && g_ewErr == EW_HOST_NOT_FOUND, L"eosblock: an outside name is answered as unknown without a lookup");
    CHECK(((NlGaiFn)(uintptr_t)iat[2])("localhost", NULL, NULL, &res) == 0 && g_ewGaiRan == 1, L"eosblock: localhost is looked up");
    CHECK(((NlSendToFn)(uintptr_t)diat[0])(1, "ab", 2, 0, out4, 16) == -1 && g_ewRefused[EW_SENDTO] == 1,
          L"eosblock: an outside UDP send is refused");
    CHECK(((NlSendToFn)(uintptr_t)diat[0])(1, "ab", 2, 0, NULL, 0) == 2, L"eosblock: a send on a connected socket goes through");
    void* ce = NULL; DWORD got = 0;
    CHECK(EwIoctl(7, 0xC8000006u, (void*)kWsaIdConnectEx, 16, &ce, 8, &got, NULL, NULL) == 0 && ce == (void*)EwConnectEx,
          L"eosblock: ConnectEx handed out through WSAIoctl is the refusing one");
    g_fkSock = 0;
    CHECK(EwConnectEx(9, out4, 16, NULL, 0, NULL, NULL) == 0 && g_fkSock == 0 && g_ewRefused[EW_CONNECTEX] == 1,
          L"eosblock: ConnectEx to an outside address fails");
    CHECK(EwConnectEx(9, lo4, 16, NULL, 0, NULL, NULL) == 1 && g_fkSock == 9, L"eosblock: ConnectEx to loopback goes through");
    CHECK(EwGpa(NULL, "connect") == (void*)EwConnect && EwGpa(NULL, "other") == (void*)EwGai,
          L"eosblock: GetProcAddress from the SDK hands out the refusing wrappers");

    /* the load notification: the EOS SDK by name (any case) is patched, another EOS module only noted */
    static const wchar_t sdk[] = L"eossdk-win64-shipping.dll", ovh[] = L"EOSOVH-Win64-Shipping.dll";
    uint8_t* b2 = FakeImage((uint64_t)(uintptr_t)EwFakeConnect, 0, 0, 0);
    EwUStr u1 = { (uint16_t)(WLen(sdk) * 2), 0, 0, sdk }, u2 = { (uint16_t)(WLen(ovh) * 2), 0, 0, ovh };
    EwLoaded l1 = { 0, &u1, &u1, b2, 0x3000 }, l2 = { 0, &u2, &u2, b2, 0x3000 };
    EwNotify(1, &l2, NULL);
    CHECK(g_ewOtherEos == 1 && *(uint64_t*)(b2 + 0x1200) == (uint64_t)(uintptr_t)EwFakeConnect, L"eosblock: another EOS module is noted, not changed");
    EwNotify(1, &l1, NULL);
    CHECK(*(uint64_t*)(b2 + 0x1200) == (uint64_t)(uintptr_t)EwConnect && g_ewBase == b2, L"eosblock: the SDK is patched when it loads");

    /* netlog's EOS lookup log: each name once; anti-cheat interface names counted, never named */
    NlEosLookup("EOS_Platform_Create", (void*)TestEosWall);
    NlEosLookup("EOS_Platform_Create", (void*)TestEosWall);
    NlEosLookup("EOS_AntiCheatThing_Example", (void*)TestEosWall);
    CHECK(g_nlEosFns == 1 && g_nlEosAc == 1, L"netlog: an EOS lookup is logged once; an anti-cheat one only counted");
    g_ewSetErr = NULL;
}

/* ---- the link (link.h): two Links over a fake transport (delays, clocks apart, drops), no Steam ------------------ */
#define FQ 256
typedef struct { uint8_t data[FQ][LINK_MAX_MSG]; int len[FQ], ch[FQ]; uint64_t at[FQ], from[FQ]; uint32_t head, tail; } FakeQ;
typedef struct { FakeQ* out; FakeQ* in; int64_t skew; uint64_t self, delay; int drop; } FakeEnd;
static uint64_t g_fakeUs;                                  /* the world's time */
static FakeQ g_qAB, g_qBA;
static uint64_t FkNow(void* c) { return (uint64_t)((int64_t)g_fakeUs + ((FakeEnd*)c)->skew); }
static void FkPut(FakeQ* q, int ch, const void* p, uint32_t n, uint64_t at, uint64_t from)
{
    uint32_t i = q->head % FQ;
    memcpy(q->data[i], p, n); q->len[i] = (int)n; q->ch[i] = ch; q->at[i] = at; q->from[i] = from;
    q->head++;
}
static int FkSend(void* c, int ch, const void* p, uint32_t n, int rel)
{
    FakeEnd* e = (FakeEnd*)c;
    (void)rel;
    if (e->drop || e->out->head - e->out->tail >= FQ) return 1;   /* (lost on the way: still "sent") */
    FkPut(e->out, ch, p, n, g_fakeUs + e->delay, e->self);
    return 1;
}
static int FkRecv(void* c, int ch, uint8_t* buf, int cap, uint64_t* from)
{
    FakeQ* q = ((FakeEnd*)c)->in;
    if (q->tail == q->head) return 0;
    uint32_t i = q->tail % FQ;
    if (q->at[i] > g_fakeUs || q->ch[i] != ch) return 0;
    int n = q->len[i] < cap ? q->len[i] : cap;
    memcpy(buf, q->data[i], (size_t)n); *from = q->from[i];
    q->tail++;
    return n;
}
static Link g_lA, g_lB;
static FakeEnd g_eA, g_eB;
static void LinkPair(int64_t skewB, uint64_t dAB, uint64_t dBA, uint32_t tagB)
{
    memset(&g_qAB, 0, sizeof(g_qAB)); memset(&g_qBA, 0, sizeof(g_qBA));
    g_eA = (FakeEnd){ &g_qAB, &g_qBA, 0, 111, dAB, 0 };
    g_eB = (FakeEnd){ &g_qBA, &g_qAB, skewB, 222, dBA, 0 };
    g_lA.io = (LinkIo){ FkSend, FkRecv, FkNow, &g_eA };
    g_lB.io = (LinkIo){ FkSend, FkRecv, FkNow, &g_eB };
    LinkBegin(&g_lA, 111, 222, 1, 77, 5, 0, "Host");
    LinkBegin(&g_lB, 222, 111, 2, tagB, 5, 0, "Guest");
}
static void LinkRun(uint64_t us, uint64_t step)
{
    for (uint64_t t = 0; t < us; t += step) { g_fakeUs += step; LinkTick(&g_lA); LinkTick(&g_lB); }
}

static void TestLink(void)
{
    CHECK(LinkTagOf("match-42", 8) == LinkTagOf("match-42", 8) && LinkTagOf("match-42", 8) != LinkTagOf("match-43", 8) &&
          LinkTagOf("", 0) != 0, L"link: the match tag is stable, differs per match, never 0");
    CHECK(sizeof(LinkHdr) == 16 && sizeof(LinkHello) == 44 && sizeof(LinkPong) == 24, L"link: the wire structs are packed");

    /* the guest's clock 5 s ahead; 30 ms one way, 50 ms the other */
    g_fakeUs = 1000000000ull;
    LinkPair(5000000, 30000, 50000, 77);
    CHECK(g_lA.state == LS_WAITING && g_lB.state == LS_WAITING, L"link: both start waiting, a hello sent");
    LinkRun(300000, 5000);
    CHECK(g_lA.state == LS_UP && g_lB.state == LS_UP, L"link: up on both PCs after the hellos (300 ms)");
    CHECK(WEq(L"Host", L"Host") && g_lB.theirs.player == 1 && g_lA.theirs.player == 2 && g_lB.theirs.name[0] == 'H' &&
          g_lA.theirs.name[0] == 'G', L"link: each has the other's hello (player, name)");
    CHECK(!LinkGoStart(&g_lA, 1500000, 0) || g_lA.peerSynced, L"link: no GO before the guest's clock is synced");
    LinkRun(2500000, 5000);
    int64_t err = g_lB.offsetUs - (-5000000);
    CHECK(g_lB.synced && g_lA.peerSynced && g_lB.nSamples >= LINK_SYNC_MIN, L"link: the guest's clock synced, and the host knows");
    CHECK(err > -15000 && err < 15000, L"link: the guest's offset within 15 ms of the true -5 s (delays 30 / 50 ms)");
    CHECK(g_lB.rttUs > 70000 && g_lB.rttUs < 100000, L"link: the round trip measured about 80 ms");

    /* GO: both PCs reach the start within 15 ms of each other in world time */
    CHECK(LinkGoStart(&g_lA, 1500000, 123456789), L"link: the host's GO is sent once the guest is synced");
    uint64_t dueA = 0, dueB = 0;
    for (int i = 0; i < 3000 && (!dueA || !dueB); ++i) {
        g_fakeUs += 1000; LinkTick(&g_lA); LinkTick(&g_lB);
        if (!dueA && LinkGoDue(&g_lA)) dueA = g_fakeUs;
        if (!dueB && LinkGoDue(&g_lB)) dueB = g_fakeUs;
    }
    int64_t skew = (int64_t)dueA - (int64_t)dueB;
    CHECK(g_lA.goState == LG_ACKED && g_lB.goState == LG_SET, L"link: the guest acknowledged the GO");
    CHECK(g_lB.peerClockK == 123456789, L"link: the host's clock relation arrives with the GO");
    /* host game clock = host link clock x10 + kh, guest's = guest link clock x10 + kg, host link - guest link = o:
     * the guest's game clock + delta = the host's */
    {   int64_t o = -5000000, kh = 7000000000ll, kg = -3000000000ll, tg = 1000000000ll;
        int64_t gh = (tg + o) * 10 + kh, gg = tg * 10 + kg;
        CHECK(gg + LinkClockDelta(o, kh, kg) == gh, L"link: the guest's clock delta makes its game clock the host's"); }
    CHECK(dueA && dueB && skew > -15000 && skew < 15000, L"link: both PCs start within 15 ms of each other");

    /* the ready-up screen: no LAUNCH until both are ready; then both launch within 15 ms of each other */
    CHECK(!LinkLaunchStart(&g_lA, 2000000) && g_lA.lnState == LG_NONE, L"ready-up: no LAUNCH while neither pilot is ready");
    g_lA.localReady = 1;
    LinkRun(600000, 5000);
    CHECK(!LinkLaunchStart(&g_lA, 2000000) && g_lB.peerReady == 1, L"ready-up: the guest sees the host ready; no LAUNCH while the guest isn't");
    g_lB.localReady = 1;
    LinkRun(600000, 5000);
    CHECK(g_lA.peerReady == 1 && LinkLaunchStart(&g_lA, 2000000), L"ready-up: both ready: the host's LAUNCH is sent");
    uint64_t lA = 0, lB = 0;
    int64_t leftB = -2;
    for (int i = 0; i < 4000 && (!lA || !lB); ++i) {
        g_fakeUs += 1000; LinkTick(&g_lA); LinkTick(&g_lB);
        if (leftB == -2 && LinkLaunchSet(&g_lB)) leftB = LinkLaunchLeftMs(&g_lB);
        if (!lA && LinkLaunchDue(&g_lA)) lA = g_fakeUs;
        if (!lB && LinkLaunchDue(&g_lB)) lB = g_fakeUs;
    }
    int64_t lskew = (int64_t)lA - (int64_t)lB;
    CHECK(g_lA.lnState == LG_ACKED && g_lB.lnState == LG_SET && leftB > 1800 && leftB <= 2000,
          L"ready-up: the guest has the launch time (a countdown of about 2 s) and acknowledged it");
    CHECK(lA && lB && lskew > -15000 && lskew < 15000, L"ready-up: both PCs launch within 15 ms of each other");
    CHECK(!LinkLaunchStart(&g_lA, 2000000), L"ready-up: one LAUNCH per match");

    /* the hangar lobby (0.4.3): ready 2 (SORTIE pressed) rides on the pings; LOADOUT both ways; the receiver's rules */
    g_lA.localReady = 2;
    LinkRun(600000, 5000);
    CHECK(g_lB.peerReady == 2, L"hangar: the host's SORTIE (ready 2) reaches the guest on the pings");
    {   LinkLoadout lo; memset(&lo, 0, sizeof(lo));
        lo.aircraft = 10034010; lo.skin = 34002001; lo.sp1 = 3; lo.nWeapons = 2; lo.weapons[0] = 2011802; lo.weapons[1] = 2012802;
        int32_t seq0 = g_lA.peerLoadoutSeq;
        CHECK(LinkSend(&g_lB, LK_LOADOUT, &lo, sizeof(lo), 1), L"hangar: the guest's LOADOUT sent");
        LinkRun(100000, 5000);
        CHECK(g_lA.peerLoadoutSeq == seq0 + 1 && g_lA.peerLoadout.aircraft == 10034010 && g_lA.peerLoadout.skin == 34002001 &&
              g_lA.peerLoadout.nWeapons == 2 && g_lA.peerLoadout.weapons[1] == 2012802, L"hangar: the host has the guest's LOADOUT");
        lo.nWeapons = 200;                            /* (a count past the array is cut to it) */
        LinkSend(&g_lB, LK_LOADOUT, &lo, sizeof(lo), 1);
        LinkRun(100000, 5000);
        CHECK(g_lA.peerLoadout.nWeapons == LINK_LO_WEAPONS, L"hangar: a LOADOUT's counts are cut to its arrays"); }
    CHECK(StockOr(21010) == 21010 && StockOr(10034010) == 10034010 && StockOr(38010) == 38010 && StockOr(99999) == 24010 &&
          StockOr(10013010) == 24010 && StockOr(-1) == 24010, L"hangar: only the 34 stock aircraft are shown; anything else the F/A-18F");
    CHECK(SkinFor(21010, 21002001) == 21002001 && SkinFor(10034010, 34002001) == 34002001 && SkinFor(38010, 138301001) == 138301001 &&
          SkinFor(21010, 34002001) == -1 && SkinFor(21010, -1) == -1 && SkinFor(21010, 0) == -1,
          L"hangar: a skin only with its own plane (else the plane's first stock skin)");

    /* DATA both ways, in order */
    uint8_t got[64];
    LinkSendData(&g_lA, "abc", 3, 0); LinkSendData(&g_lA, "defg", 4, 1); LinkSendData(&g_lB, "xy", 2, 0);
    LinkRun(100000, 5000);
    CHECK(LinkRecvData(&g_lB, got, 64) == 3 && memcmp(got, "abc", 3) == 0 && LinkRecvData(&g_lB, got, 64) == 4 &&
          memcmp(got, "defg", 4) == 0 && LinkRecvData(&g_lB, got, 64) == 0, L"link: DATA host to guest, in order, then none");
    CHECK(LinkRecvData(&g_lA, got, 64) == 2 && memcmp(got, "xy", 2) == 0, L"link: DATA guest to host");

    /* another sender, another match's tag, a broken header: dropped */
    int32_t bp = g_lB.badPeer, bt = g_lB.badTag, bh = g_lB.badHeader;
    LinkHdr h = { LINK_MAGIC, LINK_PROTO, LK_DATA, 1, 9, 77 };
    uint8_t m[17]; memcpy(m, &h, 16); m[16] = 'z';
    FkPut(&g_qAB, 1, m, 17, g_fakeUs, 999);
    h.tag = 78; memcpy(m, &h, 16);
    FkPut(&g_qAB, 1, m, 17, g_fakeUs, 111);
    h.tag = 77; h.magic = 0x12345678; memcpy(m, &h, 16);
    FkPut(&g_qAB, 1, m, 17, g_fakeUs, 111);
    LinkRun(20000, 5000);
    CHECK(g_lB.badPeer == bp + 1 && g_lB.badTag == bt + 1 && g_lB.badHeader == bh + 1 && LinkRecvData(&g_lB, got, 64) == 0,
          L"link: a stranger's, another match's and a broken message are all dropped");

    /* the host goes silent: the guest calls the link lost after 6 s, not before */
    g_eA.drop = 1;
    LinkRun(5000000, 5000);
    CHECK(g_lB.state == LS_UP, L"link: 5 s of silence is not yet a lost link");
    LinkRun(1500000, 5000);
    CHECK(g_lB.state == LS_LOST && g_lB.reason == LB_LOST, L"link: after 6 s of silence the link is lost");

    /* a clean stop: BYE closes the other side with the reason */
    g_fakeUs += 1000000;
    LinkPair(0, 20000, 20000, 77);
    LinkRun(200000, 5000);
    LinkEnd(&g_lA, LB_MATCH_OVER);
    LinkRun(100000, 5000);
    CHECK(g_lA.state == LS_CLOSED && g_lB.state == LS_CLOSED && g_lB.reason == LB_MATCH_OVER, L"link: BYE closes both with its reason");

    /* another match's tag never comes up; a peer that never answers waits, then is lost after 2 minutes */
    LinkPair(0, 20000, 20000, 78);
    LinkRun(2000000, 5000);
    CHECK(g_lA.state == LS_WAITING && g_lB.state == LS_WAITING && g_lB.badTag > 0, L"link: two PCs with different match tags never link");
    LinkRun(119000000, 50000);
    CHECK(g_lA.state == LS_LOST, L"link: a peer that never answers is given up after 2 minutes");
    CHECK(g_lA.sent[LK_HELLO] > 200, L"link: hellos are repeated while waiting");
}

static size_t FlLen(const char* s) { size_t n = 0; while (s[n]) ++n; return n; }
static int FlEq(const char* a, const char* b) { while (*a && *a == *b) { ++a; ++b; } return *a == *b; }
/* a Lua stack that behaves like UE4SS 3.0.1's: get_number and get_string take the value off the stack */
static struct { int n; int isNum[8]; double num[8]; const char* str[8]; } g_fl;
static int32_t FlSize(void* l) { (void)l; return g_fl.n; }
static uint8_t FlIsNum(void* l, int32_t i) { (void)l; return i >= 1 && i <= g_fl.n && g_fl.isNum[i - 1]; }
static uint8_t FlIsStr(void* l, int32_t i) { (void)l; return i >= 1 && i <= g_fl.n; }   /* (numbers are strings to Lua too) */
static void FlRemove(int32_t i)
{
    for (int k = i - 1; k + 1 < g_fl.n; ++k) { g_fl.isNum[k] = g_fl.isNum[k + 1]; g_fl.num[k] = g_fl.num[k + 1]; g_fl.str[k] = g_fl.str[k + 1]; }
    --g_fl.n;
}
static double FlGetNum(void* l, int32_t i)
{
    (void)l;
    if (i < 1 || i > g_fl.n) return 0;
    double v = g_fl.isNum[i - 1] ? g_fl.num[i - 1] : 0;
    FlRemove(i);
    return v;
}
static StrView* FlGetStr(void* l, StrView* out, int32_t i)
{
    (void)l;
    out->p = NULL; out->n = 0;
    if (i < 1 || i > g_fl.n) return out;
    static char numText[32];
    if (g_fl.isNum[i - 1]) { int k = 0; int64_t v = (int64_t)g_fl.num[i - 1]; char t[24]; int m = 0;
        if (v == 0) t[m++] = '0'; while (v > 0) { t[m++] = (char)('0' + v % 10); v /= 10; } while (m) numText[k++] = t[--m]; numText[k] = 0;
        out->p = numText; out->n = (size_t)k; }
    else { out->p = g_fl.str[i - 1]; out->n = FlLen(g_fl.str[i - 1]); }
    FlRemove(i);
    return out;
}
static void FlPush(int isNum, double v, const char* s) { g_fl.isNum[g_fl.n] = isNum; g_fl.num[g_fl.n] = v; g_fl.str[g_fl.n] = s; ++g_fl.n; }

/* the arguments of RVNG's Lua functions read in order, each from index 1 (UE4SS's getters pop) */
static void TestLuaArgs(void)
{
    int32_t (*s0)(void*) = U.luaStackSize; uint8_t (*n0)(void*, int32_t) = U.luaIsNumber; uint8_t (*t0)(void*, int32_t) = U.luaIsString;
    double (*g0)(void*, int32_t) = U.luaGetNumber; StrView* (*gs0)(void*, StrView*, int32_t) = U.luaGetString;
    U.luaStackSize = FlSize; U.luaIsNumber = FlIsNum; U.luaIsString = FlIsStr; U.luaGetNumber = FlGetNum; U.luaGetString = FlGetStr;

    /* RVNG_MenuSelect(address, row) */
    g_fl.n = 0; FlPush(1, 12038263136.0, NULL); FlPush(1, 3, NULL);
    double a = 0, r = -1; int stop = 0;
    ArgNextNum(NULL, &a, &stop); ArgNextNum(NULL, &r, &stop);
    CHECK(a == 12038263136.0 && r == 3 && !stop, L"Lua args: (address, row) both read (the second one is not lost to the first read's pop)");

    /* RVNG_LinkStart(peer, player, match id, name) */
    g_fl.n = 0; FlPush(0, 0, "76561198000000001"); FlPush(1, 2, NULL); FlPush(0, 0, "m42"); FlPush(0, 0, "Pixy");
    char peer[32], tag[96], name[32]; double pl = 0; stop = 0;
    ArgNextStr(NULL, peer, sizeof(peer), &stop); ArgNextNum(NULL, &pl, &stop);
    int nt = ArgNextStr(NULL, tag, sizeof(tag), &stop); ArgNextStr(NULL, name, sizeof(name), &stop);
    CHECK(FlEq(peer, "76561198000000001") && pl == 2 && nt == 3 && FlEq(tag, "m42") && FlEq(name, "Pixy"),
          L"Lua args: (peer, player, match id, name) all four read in order");

    /* a missing or wrong-typed argument: the rest keep their defaults, nothing read past it */
    g_fl.n = 0; FlPush(0, 0, "76561198000000001"); FlPush(0, 0, "two"); FlPush(0, 0, "m42");
    pl = 0; stop = 0;
    ArgNextStr(NULL, peer, sizeof(peer), &stop); ArgNextNum(NULL, &pl, &stop);
    nt = ArgNextStr(NULL, tag, sizeof(tag), &stop);
    CHECK(pl == 0 && stop && nt == 0 && tag[0] == 0 && g_fl.n == 2, L"Lua args: a wrong-typed argument stops the reading (no shifted read)");
    g_fl.n = 0; FlPush(1, 5, NULL);
    a = 0; r = -1; stop = 0;
    ArgNextNum(NULL, &a, &stop); ArgNextNum(NULL, &r, &stop);
    CHECK(a == 5 && r == -1 && stop, L"Lua args: a missing argument keeps its default");

    U.luaStackSize = s0; U.luaIsNumber = n0; U.luaIsString = t0; U.luaGetNumber = g0; U.luaGetString = gs0;
}

/* the opponent's shown name: UTF-8 from Lua to the FString the fill writes; the user id stays the key */
/* the match's deaths for the leaderboard (matchstats.h): counted from the DestroyedLocation messages sent and received */
static void TestMatchStats(void)
{
    int32_t keepN = g_lbNCls;
    g_lbNCls = 1;
    memset(&g_lbCls[0], 0, sizeof(g_lbCls[0]));
    memcpy(g_lbCls[0].name, L"FLiveMessageDestroyedLocation", 30 * 2);
    g_lbCls[0].n = 3; g_lbCls[0].looped = 2;                      /* (an earlier match's) */
    g_llFired = 0;
    MatchStatsReset();
    g_s14At = 0;
    MatchStatsTick();
    CHECK(g_msOn == 0, L"match stats: nothing counted before GamePlaying");
    g_s14At = GetTickCount64() - 30000;
    MatchStatsTick();
    CHECK(g_msOn && g_msDeaths[0] == 0 && g_msDeaths[1] == 0, L"match stats: GamePlaying starts this match's counts at zero");
    g_lbCls[0].n += 1; g_lbCls[0].looped += 2;
    MatchStatsTick();
    CHECK(g_msDeaths[0] == 1 && g_msDeaths[1] == 2 && g_msN == 3 && g_msWho[0] == 0 && g_msWho[1] == 1 && g_msT[0] >= 300,
          L"match stats: one death sent, two received: this pilot 1, the opponent 2, each with its time");
    int32_t m0 = g_msMatches;
    g_lbCls[0].looped += 1;
    MatchStatsEnd();
    CHECK(g_msMatches == m0 + 1 && g_msDeaths[1] == 3 && g_msSecs >= 30 && g_msEnd == 0 && g_msOn == 2,
          L"match stats: the end counts the last second too, the length, time-up");
    g_lbCls[0].looped += 5; MatchStatsTick();
    CHECK(g_msDeaths[1] == 3 && g_msOn == 2, L"match stats: kept after the end until the next match (the run of 14:05 started over)");
    g_llFired = 1; MatchStatsReset(); MatchStatsTick(); MatchStatsEnd();
    CHECK(g_msEnd == 1, L"match stats: a forced end after a lost link is told apart");
    g_llFired = 0; g_s14At = 0; MatchStatsReset();
    g_lbNCls = keepN;
}

static void TestOppName(void)
{
    SetOppName("Pixy", 4);
    CHECK(g_oppName.data == g_oppNameText && g_oppName.num == 5 && g_oppNameText[0] == L'P' && g_oppNameText[4] == 0 &&
          g_oppUser.data == kOppUserText && g_oppUser.num == 12, L"opponent name: Pixy shown, the user id RVNG_TEST_2 kept");
    SetOppName("Mih\xC3\xA1ly \xF0\x9F\x9B\xA9", 12);                /* Mihály + an airplane emoji (a surrogate pair) */
    CHECK(g_oppName.num == 10 && g_oppNameText[3] == 0xE1 && g_oppNameText[7] == 0xD83D && g_oppNameText[8] == 0xDEE9,
          L"opponent name: UTF-8 to UTF-16 (2-byte and 4-byte sequences)");
    SetOppName("A\xFF\x80" "B", 4);
    CHECK(g_oppName.num == 5 && g_oppNameText[1] == L'?' && g_oppNameText[2] == L'?' && g_oppNameText[3] == L'B',
          L"opponent name: bad bytes become ?");
    char longName[80]; for (int i = 0; i < 79; ++i) longName[i] = 'x'; longName[79] = 0;
    SetOppName(longName, 79);
    CHECK(g_oppName.num == OPP_NAME_MAX && g_oppNameText[OPP_NAME_MAX - 1] == 0, L"opponent name: cut at 31 characters");
    SetOppName("\xF0\x9F", 2);
    SetOppName("", 0);
    CHECK(g_oppName.data == kOppUserText && g_oppName.num == 12, L"opponent name: empty = the user id again");
}

/* the main menu's selected row, through the game's own getter's bytes (vtable slot 0xF3) */
static void TestSelectedRow(void)
{
    uint8_t* m = (uint8_t*)VirtualAlloc(NULL, 8192, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    static const uint8_t getter[8] = { 0x0F, 0xB7, 0x81, 0x88, 0x06, 0x00, 0x00, 0xC3 };
    memcpy(m + 0x100, getter, 8);
    void** vt = (void**)(m + 0x400);
    vt[VF_SELECTED_IDX] = m + 0x100;
    uint8_t* widget = m + 0x1000;
    *(void***)widget = vt;
    *(int16_t*)(widget + 0x688) = 2;
    uint8_t* exe0 = g_exe; size_t size0 = g_exeSize;
    g_exe = m; g_exeSize = 8192; g_selIdxOff = -1;
    CHECK(SelectedRow(widget) == 2 && g_selIdxOff == 0x688, L"menu: the selected row read through the getter's offset (+0x688)");
    *(int16_t*)(widget + 0x688) = -1;
    CHECK(SelectedRow(widget) == -1, L"menu: no selection reads -1");
    g_selIdxOff = -1;
    ((uint8_t*)(m + 0x100))[0] = 0x90;                          /* a getter of another shape */
    CHECK(SelectedRow(widget) == -1 && g_selIdxOff == 0, L"menu: a getter not as expected: rows unknown, never a guess");
    g_exe = exe0; g_exeSize = size0; g_selIdxOff = -1;
}

/* the wire's start gate (wire 1, real time): the in-process pair comes up, syncs, and opens D2 at the agreed time */
static void TestWireGate(void)
{
    int32_t wire0 = g_cfg.wire, guest0 = g_cfg.guest;
    g_cfg.wire = 1; g_cfg.guest = 0;
    int opened = 0, calls = 0;
    uint64_t t0 = GetTickCount64(), openAt = 0;
    while (GetTickCount64() - t0 < 6000 && !opened) { opened = WireGate(); ++calls; Sleep(10); }
    openAt = GetTickCount64() - t0;
    CHECK(g_wireOn && g_lpA.state == LS_UP && g_lpB.state == LS_UP, L"wire 1: the pair came up at the start gate");
    CHECK(g_lpB.synced && g_lpA.peerSynced && g_lpA.goState == LG_ACKED && g_lpB.goState == LG_SET, L"wire 1: the stand-in's clock synced, GO sent and acknowledged");
    CHECK(opened && g_wireReleased && openAt >= 1500 && openAt < 4500, L"wire 1: the start gate opened at the agreed time (1.5 s after GO)");
    CHECK(g_lpB.offsetUs >= -(g_lpB.rttUs / 2 + 2000) && g_lpB.offsetUs <= g_lpB.rttUs / 2 + 2000,
          L"wire 1: one clock in one process: the offset within half the round trip (the polling order's asymmetry)");
    g_wireCut = 1;
    t0 = GetTickCount64();
    while (GetTickCount64() - t0 < 7000 && g_lpA.state == LS_UP) { WireTickPair(); Sleep(20); }
    uint64_t lostAt = GetTickCount64() - t0;
    T(L"wire 1: after the cut: state A %d B %d after %d ms", g_lpA.state, g_lpB.state, (int32_t)lostAt);
    CHECK(g_lpA.state == LS_LOST && lostAt >= 5700, L"wire 1: a cut wire is a lost link 6 s after its last message (pings every 0.25 s)");
    T(L"wire 1: opened %d ms after the first gate call (%d calls), offset %d us, round trip %d us", (int32_t)openAt, calls,
      (int32_t)g_lpB.offsetUs, (int32_t)g_lpB.rttUs);
    g_cfg.wire = wire0; g_cfg.guest = guest0; g_wireOn = 0; g_wireCut = 0; g_wireReleased = 0;
}

void TestMain(void)
{
    g_hModule = NULL;
    GetModuleFileNameW(NULL, g_modRoot, PATH_CAP);            /* ...\tests\rt_test.exe -> ...\tests */
    { wchar_t* s = g_modRoot + WLen(g_modRoot); while (s > g_modRoot && *s != L'\\' && *s != L'/') --s; *s = 0; }
    TestCallRelocation();
    TestPlainPrologue();
    TestScan();
    TestSettings();
    TestGameLogic();
    TestLoginEnd();
    TestFactions();
    TestOpponent();
    TestLoopback();
    TestMenuRow();
    TestFilter();
    TestGuest();
    TestCheatOff();
    TestTravel();
    TestResultRedirect();
    TestMatchMode();
    TestNetLog();
    TestWall();
    TestEosWall();
    TestLink();
    TestWireGate();
    TestSelectedRow();
    TestLuaArgs();
    TestOppName();
    TestMatchStats();
    T(L"rt_test: %d passed, %d failed", g_pass, g_fail);
    ExitProcess(g_fail ? 1u : 0u);
}
