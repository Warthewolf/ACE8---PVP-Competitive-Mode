/* eoswall.h (2026-11-19): the EOS SDK's own network calls refused, in every install (part of D9). Tested first as a
 * switch (net_eos 8/8, net_dm_eos 17/17 twice: no outside connection at all, no visible change); the user then made it
 * the default.
 *
 * Why: with D9 in, the only outside contact an RVNG session makes is the EOS SDK's (EOSSDK-Win64-Shipping.dll, Epic's
 * library): about 12 s after boot it looks up api.epicgames.dev and keeps a TLS connection to it, reconnecting later
 * (netlog.h and tools/autotest/netwatch.py, 2026-11-19). The library also hosts EOS's anti-cheat client interface;
 * RVNG doesn't touch, call or look into that.
 *
 * How: when the DLL is mapped (ntdll's DLL-load notification comes after its imports are bound and before any of its
 * code runs), its import slots for the Winsock calls that reach out (connect, WSAConnect, sendto, WSASendTo,
 * getaddrinfo, GetAddrInfoW/ExW/ExA, gethostbyname, WSAConnectByNameW/A, and WSAIoctl, through which ConnectEx is
 * handed out) and for GetProcAddress (so a run-time lookup gets the same) are pointed at wrappers. A wrapper lets
 * loopback through and answers everything else as an unreachable network or an unknown host, without resolving or
 * sending anything: the EOS SDK sees a PC with no internet. No game code, and no EOS code, is patched. */
#ifndef RVNG_EOSWALL_H
#define RVNG_EOSWALL_H

#define EW_MODULE L"EOSSDK-Win64-Shipping.dll"
#define EW_ENETUNREACH 10051
#define EW_HOST_NOT_FOUND 11001

enum { EW_CONNECT, EW_WSACONNECT, EW_CONNECTEX, EW_SENDTO, EW_WSASENDTO, EW_GAI, EW_GAIW, EW_GAIEXW, EW_GAIEXA, EW_GHBN,
       EW_CBNW, EW_CBNA, EW_IOCTL, EW_GPA, EW_N };
typedef struct { const wchar_t* dll; const char* name; void* wrap; void* nlwrap; void* real; } EwTarget;
static EwTarget g_ew[EW_N];
static volatile int32_t g_ewOn, g_ewLoaded, g_ewSlots, g_ewRefused[EW_N], g_ewLoopback, g_ewOtherEos;
static uint8_t* volatile g_ewBase;
static uint32_t g_ewSize;
static void* volatile g_ewConnectExReal;
typedef void (*EwSetErrFn)(int);
static EwSetErrFn g_ewSetErr;

static const wchar_t* const kEwNames[EW_N] = {
    L"connect", L"WSAConnect", L"ConnectEx", L"sendto", L"WSASendTo", L"getaddrinfo", L"GetAddrInfoW", L"GetAddrInfoExW",
    L"GetAddrInfoExA", L"gethostbyname", L"WSAConnectByNameW", L"WSAConnectByNameA", L"WSAIoctl", L"GetProcAddress",
};

/* a refusal: counted, logged (the first 10, then at powers of 2), the thread's Winsock error set; returns err */
static int EwRefuse(int k, const void* ret, const wchar_t* dest, int err)
{
    int32_t n = __sync_add_and_fetch(&g_ewRefused[k], 1);
    if (n <= 10 || (n & (n - 1)) == 0) {
        uint8_t* b = g_ewBase;
        uint32_t off = b && (const uint8_t*)ret >= b && (const uint8_t*)ret < b + g_ewSize ? (uint32_t)((const uint8_t*)ret - b)
                                                                                          : (uint32_t)(uintptr_t)ret;
        Log(L"eosblock: %s %d by EOSSDK+%x -> %s refused (answered as %s)", kEwNames[k], n, off, dest,
            err == EW_HOST_NOT_FOUND ? L"an unknown host" : L"an unreachable network");
    }
    if (g_ewSetErr) g_ewSetErr(err);
    return err;
}

/* a sockaddr: 1 if it may go (loopback / unspecified), else the refusal is logged with its text */
static int EwAddrOk(int k, const void* ret, const void* sa, int len)
{
    wchar_t d[64];
    int loop = 0;
    NlAddr((const uint8_t*)sa, len, d, 64, &loop);
    if (loop) { __sync_add_and_fetch(&g_ewLoopback, 1); return 1; }
    EwRefuse(k, ret, d, EW_ENETUNREACH);
    return 0;
}
/* a host name: 1 if it may be resolved (NULL, empty, localhost, a loopback literal) */
static int EwNameOk(int k, const void* ret, const void* name, int wide)
{
    wchar_t d[160];
    size_t n = 0;
    if (!name) { __sync_add_and_fetch(&g_ewLoopback, 1); return 1; }
    if (wide) { const wchar_t* s = (const wchar_t*)name; for (; n < 150 && Readable(s + n, 2) && s[n]; ++n) d[n] = s[n]; }
    else { const char* s = (const char*)name; for (; n < 150 && Readable(s + n, 1) && s[n]; ++n) d[n] = (wchar_t)(uint8_t)s[n]; }
    d[n] = 0;
    if (NlNameIsLocal(d)) { __sync_add_and_fetch(&g_ewLoopback, 1); return 1; }
    EwRefuse(k, ret, d, EW_HOST_NOT_FOUND);
    return 0;
}

#define EWREAL(k, T) ((T)g_ew[k].real)
#define EW_SOCKET_ERROR (-1)
static int EwConnect(uintptr_t s, const void* sa, int len)
{ return EwAddrOk(EW_CONNECT, __builtin_return_address(0), sa, len) ? EWREAL(EW_CONNECT, NlConnectFn)(s, sa, len) : EW_SOCKET_ERROR; }
static int EwWsaConnect(uintptr_t s, const void* sa, int len, void* a, void* b, void* c, void* d)
{ return EwAddrOk(EW_WSACONNECT, __builtin_return_address(0), sa, len) ? EWREAL(EW_WSACONNECT, NlWsaConnectFn)(s, sa, len, a, b, c, d) : EW_SOCKET_ERROR; }
static BOOL EwConnectEx(uintptr_t s, const void* sa, int len, void* buf, DWORD n, DWORD* sent, void* ov)
{ return EwAddrOk(EW_CONNECTEX, __builtin_return_address(0), sa, len) ? ((NlConnectExFn)g_ewConnectExReal)(s, sa, len, buf, n, sent, ov) : 0; }
static int EwSendTo(uintptr_t s, const char* buf, int n, int fl, const void* to, int tolen)
{
    if (to && !EwAddrOk(EW_SENDTO, __builtin_return_address(0), to, tolen)) return EW_SOCKET_ERROR;
    return EWREAL(EW_SENDTO, NlSendToFn)(s, buf, n, fl, to, tolen);      /* (no address: a connected socket, so loopback) */
}
static int EwWsaSendTo(uintptr_t s, void* b, DWORD c, DWORD* sent, DWORD fl, const void* to, int tolen, void* ov, void* cr)
{
    if (to && !EwAddrOk(EW_WSASENDTO, __builtin_return_address(0), to, tolen)) return EW_SOCKET_ERROR;
    return EWREAL(EW_WSASENDTO, NlWsaSendToFn)(s, b, c, sent, fl, to, tolen, ov, cr);
}
static int EwGai(const void* node, const void* svc, const void* hints, void** res)
{
    if (EwNameOk(EW_GAI, __builtin_return_address(0), node, 0)) return EWREAL(EW_GAI, NlGaiFn)(node, svc, hints, res);
    if (res) *res = NULL;
    return EW_HOST_NOT_FOUND;
}
static int EwGaiW(const void* node, const void* svc, const void* hints, void** res)
{
    if (EwNameOk(EW_GAIW, __builtin_return_address(0), node, 1)) return EWREAL(EW_GAIW, NlGaiFn)(node, svc, hints, res);
    if (res) *res = NULL;
    return EW_HOST_NOT_FOUND;
}
static int EwGaiExW(const void* n, const void* s, DWORD ns, void* id, const void* h, void** r, void* t, void* ov, void* cr, void* hd)
{
    if (EwNameOk(EW_GAIEXW, __builtin_return_address(0), n, 1)) return EWREAL(EW_GAIEXW, NlGaiExFn)(n, s, ns, id, h, r, t, ov, cr, hd);
    if (r) *r = NULL;
    return EW_HOST_NOT_FOUND;                           /* (an error return: no completion is queued) */
}
static int EwGaiExA(const void* n, const void* s, DWORD ns, void* id, const void* h, void** r, void* t, void* ov, void* cr, void* hd)
{
    if (EwNameOk(EW_GAIEXA, __builtin_return_address(0), n, 0)) return EWREAL(EW_GAIEXA, NlGaiExFn)(n, s, ns, id, h, r, t, ov, cr, hd);
    if (r) *r = NULL;
    return EW_HOST_NOT_FOUND;
}
static void* EwGhbn(const char* name)
{ return EwNameOk(EW_GHBN, __builtin_return_address(0), name, 0) ? EWREAL(EW_GHBN, NlGhbnFn)(name) : NULL; }
static BOOL EwCbnW(uintptr_t s, const void* node, const void* svc, DWORD* a, void* b, DWORD* c, void* d, const void* t, void* r)
{ return EwNameOk(EW_CBNW, __builtin_return_address(0), node, 1) ? EWREAL(EW_CBNW, NlCbnFn)(s, node, svc, a, b, c, d, t, r) : 0; }
static BOOL EwCbnA(uintptr_t s, const void* node, const void* svc, DWORD* a, void* b, DWORD* c, void* d, const void* t, void* r)
{ return EwNameOk(EW_CBNA, __builtin_return_address(0), node, 0) ? EWREAL(EW_CBNA, NlCbnFn)(s, node, svc, a, b, c, d, t, r) : 0; }
/* WSAIoctl: when ConnectEx is asked for, the refusing wrapper is handed out */
static int EwIoctl(uintptr_t s, DWORD code, void* in, DWORD inLen, void* out, DWORD outLen, DWORD* got, void* ov, void* cr)
{
    int r = EWREAL(EW_IOCTL, NlIoctlFn)(s, code, in, inLen, out, outLen, got, ov, cr);
    if (r == 0 && code == 0xC8000006u && inLen >= 16 && outLen >= 8 && in && out && Readable(in, 16) &&
        memcmp(in, kWsaIdConnectEx, 16) == 0 && Writable(out, 8)) {
        void* real = *(void**)out;
        if (real == (void*)NlConnectEx) real = g_nlConnectExReal;          /* (netlog's wrapper: its real one) */
        void* prev = __sync_val_compare_and_swap(&g_ewConnectExReal, NULL, real);
        if (real && (prev == NULL || prev == real)) *(void**)out = (void*)EwConnectEx;
        else Log(L"eosblock: a second ConnectEx provider handed to EOS: NOT wrapped");
    }
    return r;
}
/* GetProcAddress from the EOS SDK: a reaching-out function comes back as its refusing wrapper */
static void* EwGpa(HANDLE mod, const char* name)
{
    void* r = EWREAL(EW_GPA, NlGpaFn)(mod, name);
    if (r) for (int k = 0; k < EW_GPA; ++k) if (g_ew[k].real == r && g_ew[k].wrap) return g_ew[k].wrap;
    return r;
}

static void EwInitTargets(void)
{
    static const struct { const wchar_t* dll; const char* name; void* wrap; void* nlwrap; } k[EW_N] = {
        { L"ws2_32.dll", "connect", (void*)EwConnect, (void*)NlConnect },
        { L"ws2_32.dll", "WSAConnect", (void*)EwWsaConnect, (void*)NlWsaConnect },
        { NULL, NULL, NULL, NULL /* ConnectEx: through WSAIoctl */ },
        { L"ws2_32.dll", "sendto", (void*)EwSendTo, (void*)NlSendTo },
        { L"ws2_32.dll", "WSASendTo", (void*)EwWsaSendTo, (void*)NlWsaSendTo },
        { L"ws2_32.dll", "getaddrinfo", (void*)EwGai, (void*)NlGai },
        { L"ws2_32.dll", "GetAddrInfoW", (void*)EwGaiW, (void*)NlGaiW },
        { L"ws2_32.dll", "GetAddrInfoExW", (void*)EwGaiExW, (void*)NlGaiExW },
        { L"ws2_32.dll", "GetAddrInfoExA", (void*)EwGaiExA, (void*)NlGaiExA },
        { L"ws2_32.dll", "gethostbyname", (void*)EwGhbn, (void*)NlGhbn },
        { L"ws2_32.dll", "WSAConnectByNameW", (void*)EwCbnW, (void*)NlCbnW },
        { L"ws2_32.dll", "WSAConnectByNameA", (void*)EwCbnA, (void*)NlCbnA },
        { L"ws2_32.dll", "WSAIoctl", (void*)EwIoctl, (void*)NlIoctl },
        { L"kernel32.dll", "GetProcAddress", (void*)EwGpa, (void*)NlGpa },
    };
    for (int i = 0; i < EW_N; ++i) { g_ew[i].dll = k[i].dll; g_ew[i].name = k[i].name; g_ew[i].wrap = k[i].wrap; g_ew[i].nlwrap = k[i].nlwrap; }
}

/* the real functions (ws2_32 is loaded before the EOS SDK, which imports it); returns how many are known */
static int EwResolve(void)
{
    int known = 0;
    for (int i = 0; i < EW_N; ++i) {
        if (!g_ew[i].dll) continue;
        if (!g_ew[i].real) {
            HANDLE h = GetModuleHandleW(g_ew[i].dll);
            if (h) g_ew[i].real = GetProcAddress(h, g_ew[i].name);
        }
        if (g_ew[i].real) ++known;
    }
    if (!g_ewSetErr) { HANDLE w = GetModuleHandleW(L"ws2_32.dll"); if (w) g_ewSetErr = (EwSetErrFn)GetProcAddress(w, "WSASetLastError"); }
    return known;
}

/* one import slot: pointed at the wrapper if it holds the real function (or netlog's wrapper of it) */
static int EwPatchSlot(uint64_t* slot, int count)
{
    if (!Readable(slot, 8)) return 0;
    uint64_t v = *slot;
    if (!v) return 0;
    for (int k = 0; k < EW_N; ++k) {
        if (!g_ew[k].wrap) continue;
        if (v != (uint64_t)(uintptr_t)g_ew[k].real && v != (uint64_t)(uintptr_t)g_ew[k].nlwrap) continue;
        if (!g_ew[k].real) continue;
        if (count) return 1;                            /* (EwUnwrapped: a reaching-out slot not pointed at its wrapper) */
        DWORD old = 0, ign = 0;
        if (!VirtualProtect(slot, 8, PAGE_READWRITE, &old)) return 0;
        __atomic_store_n(slot, (uint64_t)(uintptr_t)g_ew[k].wrap, __ATOMIC_SEQ_CST);
        VirtualProtect(slot, 8, old, &ign);
        return 1;
    }
    return 0;
}

/* every import and delay-import slot of the module; count = 1 only counts the slots still unwrapped */
static int EwWalk(uint8_t* base, int count)
{
    if (!Readable(base, 0x40)) return 0;
    uint32_t pe = *(uint32_t*)(base + 0x3C);
    if (pe > 0x1000 || !Readable(base + pe, 24 + 240) || *(uint32_t*)(base + pe) != 0x4550u) return 0;
    uint8_t* opt = base + pe + 24;
    if (*(uint16_t*)opt != 0x20B) return 0;
    uint32_t ndir = *(uint32_t*)(opt + 108), size = *(uint32_t*)(opt + 56);
    int put = 0;
    for (int which = 0; which < 2; ++which) {
        uint32_t idx = which ? 13 : 1, step = which ? 32 : 20, ftAt = which ? 12 : 16, nameAt = which ? 4 : 12;
        if (ndir <= idx) continue;
        uint32_t rva = *(uint32_t*)(opt + 112 + idx * 8);
        for (uint32_t i = 0; rva && rva < size && i < 4096; ++i) {
            uint8_t* d = base + rva + i * step;
            if (!Readable(d, step)) break;
            uint32_t nameRva = *(uint32_t*)(d + nameAt), ft = *(uint32_t*)(d + ftAt);
            if (!nameRva && !ft) break;
            if (!ft || ft >= size) continue;
            for (uint32_t j = 0; j < 65536; ++j) {
                uint64_t* slot = (uint64_t*)(base + ft) + j;
                if (!Readable(slot, 8) || !*slot) break;
                put += EwPatchSlot(slot, count);
            }
        }
    }
    return put;
}

/* the EOS SDK's import slots that reach out and are NOT pointed at a wrapper now (0 = the wall holds) */
static int EwUnwrapped(void) { return g_ewBase ? EwWalk(g_ewBase, 1) : -1; }

static void EwPatch(uint8_t* base, uint32_t size, const wchar_t* when)
{
    g_ewSize = size;
    g_ewBase = base;
    int known = EwResolve();
    int put = EwWalk(base, 0);
    __sync_add_and_fetch(&g_ewSlots, put);
    g_ewLoaded = 1;
    Log(L"eosblock: %s %s: %d import slot(s) pointed at refusing wrappers (%d functions known); its outside calls now fail",
        EW_MODULE, when, put, known);
}

static int EwSameName(const wchar_t* a, size_t n, const wchar_t* b)
{
    size_t i = 0;
    for (; i < n && b[i]; ++i) if ((a[i] | 32) != (b[i] | 32)) return 0;
    return i == n && !b[i];
}

/* ntdll's DLL-load notification (the loader lock is held: no loading here) */
typedef struct { uint16_t len, max; uint32_t pad; const wchar_t* buf; } EwUStr;
typedef struct { uint32_t flags; const EwUStr* full; const EwUStr* base; void* dllBase; uint32_t size; } EwLoaded;
typedef void (*EwNotifyFn)(uint32_t reason, const EwLoaded* data, void* ctx);
typedef int32_t (*EwRegisterFn)(uint32_t flags, EwNotifyFn fn, void* ctx, void** cookie);

static void EwNotify(uint32_t reason, const EwLoaded* data, void* ctx)
{
    (void)ctx;
    if (reason != 1 || !data || !data->base || !data->base->buf) return;
    size_t n = data->base->len / 2;
    if (EwSameName(data->base->buf, n, EW_MODULE)) { EwPatch((uint8_t*)data->dllBase, data->size, L"loaded"); return; }
    if (n >= 3 && (data->base->buf[0] | 32) == L'e' && (data->base->buf[1] | 32) == L'o' && (data->base->buf[2] | 32) == L's') {
        __sync_add_and_fetch(&g_ewOtherEos, 1);
        wchar_t w[64]; size_t k = 0;
        for (; k < n && k < 63; ++k) w[k] = data->base->buf[k];
        w[k] = 0;
        Log(L"eosblock: another EOS module loaded: %s (not changed; netlog=1 shows its calls)", w);
    }
}

static void EwStart(void)
{
    EwInitTargets();
    g_ewOn = 1;
    HANDLE nt = GetModuleHandleW(L"ntdll.dll");
    EwRegisterFn reg = nt ? (EwRegisterFn)GetProcAddress(nt, "LdrRegisterDllNotification") : NULL;
    static void* cookie;
    int32_t st = reg ? reg(0, EwNotify, NULL, &cookie) : -1;
    HANDLE h = GetModuleHandleW(EW_MODULE);
    if (h && !g_ewBase) {
        uint8_t* b = (uint8_t*)h;
        uint32_t pe = *(uint32_t*)(b + 0x3C);
        EwPatch(b, *(uint32_t*)(b + pe + 24 + 56), L"already loaded (calls made before now were not covered)");
    }
    Log(L"eosblock (D9, every install): the EOS SDK's outside calls will be refused; load notification %s, the SDK %s",
        st == 0 ? L"registered" : L"NOT registered", g_ewBase ? L"patched" : L"not loaded yet");
}

#endif /* RVNG_EOSWALL_H */
