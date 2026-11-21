/* netlog.h (D9, 2026-11-19): a TEST-ONLY observer of the process's network calls, on with rvng_test.ini netlog=1.
 * It never blocks, changes or delays a call. It logs who asked for what, so a gated run can say which module opened a
 * connection that tools/autotest/netwatch.py saw from outside (2026-11-19 12:09: one outside HTTPS connection to a
 * Cloudflare address, which the local DNS cache could not name).
 *
 * How: every loaded module's import table (and delay-import table) slots that point at a watched function are pointed at
 * a wrapper that logs and calls the real function. GetProcAddress is wrapped the same way, so code that looks a watched
 * function up at run time gets the wrapper too. A thread re-scans the module list (new modules, newly loaded DLLs) once a
 * second for 5 minutes, then every 10 s. ConnectEx, which programs get through WSAIoctl, is wrapped when asked for.
 *
 * What it cannot see: code that finds exports by hand (a protector's import resolver, for example), raw syscalls, and
 * other processes. netwatch.py's outside view covers the first two.
 *
 * Logged once per distinct (call, calling module, destination): the module and the return address's offset in it, so
 * an exe caller can be found in the disassembly. Loopback destinations are only counted.                             */
#ifndef RVNG_NETLOG_H
#define RVNG_NETLOG_H

enum { NL_CONNECT, NL_WSACONNECT, NL_CONNECTEX, NL_SENDTO, NL_WSASENDTO, NL_GAI, NL_GAIW, NL_GAIEXW, NL_GAIEXA, NL_GHBN,
       NL_CBNW, NL_CBNA, NL_IOCTL, NL_BIND, NL_SENDMSG, NL_WHCONNECT, NL_WHOPEN, NL_ICONNW, NL_ICONNA, NL_IOPENURLW,
       NL_IOPENURLA, NL_GPA, NL_N };

typedef struct { const wchar_t* dll; const char* name; void* wrap; void* real; } NlTarget;

static NlTarget g_nl[NL_N];
static volatile int32_t g_nlLock, g_nlOn, g_nlSlots, g_nlModules, g_nlOutside, g_nlLoopback, g_nlLookups,
                        g_nlHttp, g_nlNewLines, g_nlGen;
static void* volatile g_nlConnectExReal;
static void* volatile g_nlSendMsgReal;                /* WSASendMsg handed out through WSAIoctl */
static volatile int32_t g_nlBinds;
static volatile int32_t g_nlFirstPassDone;            /* modules seen after the start's pass are logged by name */                    /* bind calls (each module's first per family and kind logged) */
static volatile int32_t g_nlEosFns, g_nlEosAc;     /* EOS functions looked up (anti-cheat interface ones: counted only) */
static void* volatile g_nlEosMod;

/* ---- what the log says ----------------------------------------------------------------------------------------- */
/* The modules the scan has seen (base, size, file name), so a wrapper names its caller without the loader lock. */
typedef struct { uint8_t* base; uint32_t size; wchar_t name[48]; } NlMod;
static NlMod            g_nlMod[1024];
static volatile int32_t g_nlNMod;

static void NlBaseName(HANDLE h, wchar_t* out, size_t cap)
{
    wchar_t path[PATH_CAP];
    DWORD n = GetModuleFileNameW(h, path, PATH_CAP);
    if (!n || n >= PATH_CAP) { out[0] = L'?'; out[1] = 0; return; }
    const wchar_t* b = path + n;
    while (b > path && b[-1] != L'\\' && b[-1] != L'/') --b;
    size_t k = 0;
    for (; b[k] && k + 1 < cap; ++k) out[k] = b[k];
    out[k] = 0;
}

static void NlModOf(const void* ret, wchar_t* out, size_t cap, uint32_t* off)
{
    const uint8_t* a = (const uint8_t*)ret;
    int32_t n = g_nlNMod;
    for (int32_t i = 0; i < n; ++i) {
        if (a >= g_nlMod[i].base && a < g_nlMod[i].base + g_nlMod[i].size) {
            *off = (uint32_t)(a - g_nlMod[i].base);
            size_t k = 0;
            for (; g_nlMod[i].name[k] && k + 1 < cap; ++k) out[k] = g_nlMod[i].name[k];
            out[k] = 0;
            return;
        }
    }
    *off = (uint32_t)(uintptr_t)a;                                  /* not a module the scan saw: the address itself */
    out[0] = L'?'; out[1] = 0;
}

static uint32_t NlHash(uint32_t h, const void* p, size_t n)
{
    const uint8_t* b = (const uint8_t*)p;
    for (size_t i = 0; i < n; ++i) { h ^= b[i]; h *= 16777619u; }
    return h;
}

/* 1 the first time this (call, module, destination) is seen; counts every time */
static int NlFirst(int kind, const wchar_t* mod, const wchar_t* dest)
{
    static uint32_t seen[1024];
    static int32_t nseen;
    uint32_t h = NlHash(2166136261u, &kind, sizeof(kind));
    h = NlHash(h, mod, WLen(mod) * 2);
    h = NlHash(h, dest, WLen(dest) * 2);
    if (!h) h = 1;
    int first = 1;
    while (__sync_lock_test_and_set(&g_nlLock, 1)) Sleep(0);
    for (int32_t i = 0; i < nseen; ++i) if (seen[i] == h) { first = 0; break; }
    if (first && nseen < 1024) seen[nseen++] = h;
    __sync_lock_release(&g_nlLock);
    return first;
}

static const wchar_t* const kNlNames[NL_N] = {
    L"connect", L"WSAConnect", L"ConnectEx", L"sendto", L"WSASendTo", L"getaddrinfo", L"GetAddrInfoW", L"GetAddrInfoExW",
    L"GetAddrInfoExA", L"gethostbyname", L"WSAConnectByNameW", L"WSAConnectByNameA", L"WSAIoctl(ConnectEx)",
    L"bind", L"WSASendMsg", L"WinHttpConnect", L"WinHttpOpenRequest", L"InternetConnectW", L"InternetConnectA", L"InternetOpenUrlW",
    L"InternetOpenUrlA", L"GetProcAddress",
};

static void NlNote(int kind, const void* ret, const wchar_t* dest, int loop)
{
    wchar_t mod[64];
    uint32_t off;
    if (loop) { __sync_add_and_fetch(&g_nlLoopback, 1); return; }
    NlModOf(ret, mod, 64, &off);
    if (!NlFirst(kind, mod, dest)) return;
    __sync_add_and_fetch(&g_nlNewLines, 1);
    Log(L"netlog: %s by %s+%x -> %s", kNlNames[kind], mod, off, dest);
}

/* a sockaddr as text ("1.2.3.4:443", "[2001:db8::1]:443"); *loop = 1 for loopback / unspecified */
static void NlAddr(const uint8_t* sa, int len, wchar_t* out, size_t cap, int* loop)
{
    wchar_t* p = out; wchar_t* end = out + cap - 1;
#define NLPUT(c) do { if (p < end) *p++ = (wchar_t)(c); } while (0)
    *loop = 0;
    if (!sa || len < 4 || !Readable(sa, (size_t)len)) { NLPUT(L'?'); *p = 0; return; }
    uint16_t fam = *(const uint16_t*)sa;
    uint16_t port = (uint16_t)((sa[2] << 8) | sa[3]);
    wchar_t num[8];
    if (fam == 2 && len >= 8) {
        for (int i = 0; i < 4; ++i) {
            if (i) NLPUT(L'.');
            int v = sa[4 + i], n = 0;
            do { num[n++] = (wchar_t)(L'0' + v % 10); v /= 10; } while (v);
            while (n) NLPUT(num[--n]);
        }
        *loop = sa[4] == 127 || (sa[4] | sa[5] | sa[6] | sa[7]) == 0;
    } else if (fam == 23 && len >= 24) {
        const uint8_t* a = sa + 8;
        int zero = 1, mapped = 1;
        for (int i = 0; i < 16; ++i) if (a[i] && !(i == 15 && a[i] == 1)) zero = 0;
        for (int i = 0; i < 10; ++i) if (a[i]) mapped = 0;
        mapped = mapped && a[10] == 0xFF && a[11] == 0xFF;
        *loop = zero || (mapped && (a[12] == 127 || (a[12] | a[13] | a[14] | a[15]) == 0));
        NLPUT(L'[');
        for (int i = 0; i < 16; i += 2) {
            if (i) NLPUT(L':');
            int v = (a[i] << 8) | a[i + 1];
            wchar_t t[4]; int n = 0;
            do { t[n++] = L"0123456789abcdef"[v & 15]; v >>= 4; } while (v);
            while (n) NLPUT(t[--n]);
        }
        NLPUT(L']');
    } else {
        NLPUT(L'f'); NLPUT(L'a'); NLPUT(L'm'); NLPUT(L'=');
        int v = fam, n = 0;
        do { num[n++] = (wchar_t)(L'0' + v % 10); v /= 10; } while (v);
        while (n) NLPUT(num[--n]);
        *p = 0;
        return;
    }
    NLPUT(L':');
    { int v = port, n = 0; do { num[n++] = (wchar_t)(L'0' + v % 10); v /= 10; } while (v); while (n) NLPUT(num[--n]); }
    *p = 0;
#undef NLPUT
}

static void NlAddrNote(int kind, const void* ret, const void* sa, int len)
{
    /* fast path (sendto runs per packet): a (caller, destination) pair already seen is only counted */
    static volatile uint32_t quick[1024];                 /* hash with bit 0 = loopback; 0 = empty */
    uint32_t q = 0;
    if (sa && len >= 8 && len <= 128 && Readable(sa, (size_t)len)) {
        q = NlHash(2166136261u, &ret, sizeof(ret));
        q = NlHash(q, &kind, sizeof(kind));
        q = NlHash(q, sa, (size_t)(len < 28 ? len : 28));
        q = (q & ~1u) | 2u;
        uint32_t e = quick[(q >> 2) & 1023];
        if ((e & ~1u) == q) {
            if (e & 1u) __sync_add_and_fetch(&g_nlLoopback, 1); else __sync_add_and_fetch(&g_nlOutside, 1);
            return;
        }
    }
    wchar_t d[64];
    int loop;
    NlAddr((const uint8_t*)sa, len, d, 64, &loop);
    if (q) quick[(q >> 2) & 1023] = q | (loop ? 1u : 0u);
    if (!loop) __sync_add_and_fetch(&g_nlOutside, 1);
    NlNote(kind, ret, d, loop);
}

static int NlNameIsLocal(const wchar_t* s)
{
    static const wchar_t* const kLocal[] = { L"localhost", L"127.0.0.1", L"::1", L"" };
    for (size_t i = 0; i < sizeof(kLocal) / sizeof(kLocal[0]); ++i) {
        const wchar_t* a = s; const wchar_t* b = kLocal[i];
        while (*a && *b && (*a | 32) == (*b | 32)) { ++a; ++b; }
        if (!*a && !*b) return 1;
    }
    return 0;
}

static void NlNameNote(int kind, const void* ret, const void* name, int wide, const void* service, int port)
{
    wchar_t d[200];
    size_t n = 0;
    if (!name) { d[n++] = L'<'; d[n++] = L'n'; d[n++] = L'u'; d[n++] = L'l'; d[n++] = L'l'; d[n++] = L'>'; }
    else if (wide) { const wchar_t* s = (const wchar_t*)name; for (; n < 150 && Readable(s + n, 2) && s[n]; ++n) d[n] = s[n]; }
    else { const char* s = (const char*)name; for (; n < 150 && Readable(s + n, 1) && s[n]; ++n) d[n] = (wchar_t)(uint8_t)s[n]; }
    d[n] = 0;
    int local = name && NlNameIsLocal(d);
    if (service) {
        d[n++] = L' '; d[n++] = L'(';
        if (wide) { const wchar_t* s = (const wchar_t*)service; for (size_t i = 0; i < 20 && Readable(s + i, 2) && s[i]; ++i) d[n++] = s[i]; }
        else { const char* s = (const char*)service; for (size_t i = 0; i < 20 && Readable(s + i, 1) && s[i]; ++i) d[n++] = (wchar_t)(uint8_t)s[i]; }
        d[n++] = L')';
    } else if (port >= 0) {
        wchar_t t[8]; int k = 0, v = port;
        d[n++] = L':';
        do { t[k++] = (wchar_t)(L'0' + v % 10); v /= 10; } while (v);
        while (k) d[n++] = t[--k];
    }
    d[n] = 0;
    if (!local) {
        if (kind >= NL_WHCONNECT) __sync_add_and_fetch(&g_nlHttp, 1);
        else __sync_add_and_fetch(&g_nlLookups, 1);
    }
    NlNote(kind, ret, d, local);
}

/* ---- the wrappers (each calls the real function with the same arguments) --------------------------------------- */
#define NLREAL(k, T) ((T)g_nl[k].real)
typedef int (*NlConnectFn)(uintptr_t, const void*, int);
typedef int (*NlWsaConnectFn)(uintptr_t, const void*, int, void*, void*, void*, void*);
typedef BOOL (*NlConnectExFn)(uintptr_t, const void*, int, void*, DWORD, DWORD*, void*);
typedef int (*NlSendToFn)(uintptr_t, const char*, int, int, const void*, int);
typedef int (*NlWsaSendToFn)(uintptr_t, void*, DWORD, DWORD*, DWORD, const void*, int, void*, void*);
typedef int (*NlGaiFn)(const void*, const void*, const void*, void**);
typedef int (*NlGaiExFn)(const void*, const void*, DWORD, void*, const void*, void**, void*, void*, void*, void*);
typedef void* (*NlGhbnFn)(const char*);
typedef BOOL (*NlCbnFn)(uintptr_t, const void*, const void*, DWORD*, void*, DWORD*, void*, const void*, void*);
typedef int (*NlIoctlFn)(uintptr_t, DWORD, void*, DWORD, void*, DWORD, DWORD*, void*, void*);
typedef int (*NlBindFn)(uintptr_t, const void*, int);
typedef int (*NlSendMsgFn)(uintptr_t, void*, DWORD, DWORD*, void*, void*);
typedef void* (*NlWhConnectFn)(void*, const wchar_t*, uint16_t, DWORD);
typedef void* (*NlWhOpenFn)(void*, const wchar_t*, const wchar_t*, const wchar_t*, const wchar_t*, const wchar_t**, DWORD);
typedef void* (*NlIConnFn)(void*, const void*, uint16_t, const void*, const void*, DWORD, DWORD, uintptr_t);
typedef void* (*NlIOpenUrlFn)(void*, const void*, const void*, DWORD, DWORD, uintptr_t);
typedef void* (*NlGpaFn)(HANDLE, const char*);

static int NlConnect(uintptr_t s, const void* sa, int len)
{ NlAddrNote(NL_CONNECT, __builtin_return_address(0), sa, len); return NLREAL(NL_CONNECT, NlConnectFn)(s, sa, len); }
static int NlWsaConnect(uintptr_t s, const void* sa, int len, void* a, void* b, void* c, void* d)
{ NlAddrNote(NL_WSACONNECT, __builtin_return_address(0), sa, len); return NLREAL(NL_WSACONNECT, NlWsaConnectFn)(s, sa, len, a, b, c, d); }
static BOOL NlConnectEx(uintptr_t s, const void* sa, int len, void* buf, DWORD n, DWORD* sent, void* ov)
{ NlAddrNote(NL_CONNECTEX, __builtin_return_address(0), sa, len); return ((NlConnectExFn)g_nlConnectExReal)(s, sa, len, buf, n, sent, ov); }
static int NlSendTo(uintptr_t s, const char* buf, int n, int fl, const void* to, int tolen)
{ if (to) NlAddrNote(NL_SENDTO, __builtin_return_address(0), to, tolen); return NLREAL(NL_SENDTO, NlSendToFn)(s, buf, n, fl, to, tolen); }
static int NlWsaSendTo(uintptr_t s, void* b, DWORD c, DWORD* sent, DWORD fl, const void* to, int tolen, void* ov, void* cr)
{ if (to) NlAddrNote(NL_WSASENDTO, __builtin_return_address(0), to, tolen); return NLREAL(NL_WSASENDTO, NlWsaSendToFn)(s, b, c, sent, fl, to, tolen, ov, cr); }
static int NlGai(const void* node, const void* svc, const void* hints, void** res)
{ NlNameNote(NL_GAI, __builtin_return_address(0), node, 0, svc, -1); return NLREAL(NL_GAI, NlGaiFn)(node, svc, hints, res); }
static int NlGaiW(const void* node, const void* svc, const void* hints, void** res)
{ NlNameNote(NL_GAIW, __builtin_return_address(0), node, 1, svc, -1); return NLREAL(NL_GAIW, NlGaiFn)(node, svc, hints, res); }
static int NlGaiExW(const void* n, const void* s, DWORD ns, void* id, const void* h, void** r, void* t, void* ov, void* cr, void* hd)
{ NlNameNote(NL_GAIEXW, __builtin_return_address(0), n, 1, s, -1); return NLREAL(NL_GAIEXW, NlGaiExFn)(n, s, ns, id, h, r, t, ov, cr, hd); }
static int NlGaiExA(const void* n, const void* s, DWORD ns, void* id, const void* h, void** r, void* t, void* ov, void* cr, void* hd)
{ NlNameNote(NL_GAIEXA, __builtin_return_address(0), n, 0, s, -1); return NLREAL(NL_GAIEXA, NlGaiExFn)(n, s, ns, id, h, r, t, ov, cr, hd); }
static void* NlGhbn(const char* name)
{ NlNameNote(NL_GHBN, __builtin_return_address(0), name, 0, NULL, -1); return NLREAL(NL_GHBN, NlGhbnFn)(name); }
static BOOL NlCbnW(uintptr_t s, const void* node, const void* svc, DWORD* a, void* b, DWORD* c, void* d, const void* t, void* r)
{ NlNameNote(NL_CBNW, __builtin_return_address(0), node, 1, svc, -1); return NLREAL(NL_CBNW, NlCbnFn)(s, node, svc, a, b, c, d, t, r); }
static BOOL NlCbnA(uintptr_t s, const void* node, const void* svc, DWORD* a, void* b, DWORD* c, void* d, const void* t, void* r)
{ NlNameNote(NL_CBNA, __builtin_return_address(0), node, 0, svc, -1); return NLREAL(NL_CBNA, NlCbnFn)(s, node, svc, a, b, c, d, t, r); }

static const uint8_t kWsaIdConnectEx[16] = { 0xB9, 0x07, 0xA2, 0x25, 0xF3, 0xDD, 0x60, 0x46,
                                             0x8E, 0xE9, 0x76, 0xE5, 0x8C, 0x74, 0x06, 0x3E };
static const uint8_t kWsaIdSendMsg[16] = { 0x12, 0xE7, 0x41, 0xA4, 0x4F, 0x75, 0xCA, 0x43,
                                           0x84, 0xA7, 0x0D, 0xEE, 0x44, 0xCF, 0x60, 0x6D };

/* bind: who opens local sockets (2026-11-19: ~30 UDP binds on 0.0.0.0 in some runs, owner unknown). Logged once per
 * (module, address family, loopback or not), with the first port; every call counted. Never refused. */
static int NlBind(uintptr_t s, const void* sa, int len)
{
    __sync_add_and_fetch(&g_nlBinds, 1);
    wchar_t mod[64], d[80];
    uint32_t off;
    int loop = 0;
    NlAddr((const uint8_t*)sa, len, d, 64, &loop);
    NlModOf(__builtin_return_address(0), mod, 64, &off);
    wchar_t key[16] = L"family ";
    key[7] = (wchar_t)(L'0' + (sa && len >= 2 && Readable(sa, 2) ? (*(const uint16_t*)sa) % 10 : 0));
    key[8] = loop ? L'L' : L'A';
    key[9] = 0;
    if (NlFirst(NL_BIND, mod, key)) {
        __sync_add_and_fetch(&g_nlNewLines, 1);
        Log(L"netlog: bind by %s+%x -> %s (the first of this module's binds of this kind; all are counted)", mod, off, d);
    }
    return NLREAL(NL_BIND, NlBindFn)(s, sa, len);
}
/* WSASendMsg: a datagram's destination is the message's name (+0, length +8) */
static int NlSendMsgTo(void* fn, uintptr_t s, void* msg, DWORD fl, DWORD* sent, void* ov, void* cr, const void* ret)
{
    if (msg && Readable(msg, 16)) {
        const void* to = *(void* const*)msg;
        int tolen = *(const int*)((const uint8_t*)msg + 8);
        if (to) NlAddrNote(NL_SENDMSG, ret, to, tolen);
    }
    return ((NlSendMsgFn)fn)(s, msg, fl, sent, ov, cr);
}
static int NlSendMsg(uintptr_t s, void* msg, DWORD fl, DWORD* sent, void* ov, void* cr)
{ return NlSendMsgTo(g_nl[NL_SENDMSG].real, s, msg, fl, sent, ov, cr, __builtin_return_address(0)); }
static int NlSendMsgX(uintptr_t s, void* msg, DWORD fl, DWORD* sent, void* ov, void* cr)
{ return NlSendMsgTo(g_nlSendMsgReal, s, msg, fl, sent, ov, cr, __builtin_return_address(0)); }
static int NlIoctl(uintptr_t s, DWORD code, void* in, DWORD inLen, void* out, DWORD outLen, DWORD* got, void* ov, void* cr)
{
    int r = NLREAL(NL_IOCTL, NlIoctlFn)(s, code, in, inLen, out, outLen, got, ov, cr);
    if (r == 0 && code == 0xC8000006u && inLen >= 16 && outLen >= 8 && in && out && Readable(in, 16) &&
        memcmp(in, kWsaIdConnectEx, 16) == 0 && Writable(out, 8)) {
        void* real = *(void**)out;
        void* prev = __sync_val_compare_and_swap(&g_nlConnectExReal, NULL, real);
        if (real && (prev == NULL || prev == real)) {
            *(void**)out = (void*)NlConnectEx;
            NlNote(NL_IOCTL, __builtin_return_address(0), L"ConnectEx handed out (wrapped)", 0);
        } else {
            NlNote(NL_IOCTL, __builtin_return_address(0), L"ConnectEx handed out (a second provider: NOT wrapped)", 0);
        }
    }
    if (r == 0 && code == 0xC8000006u && inLen >= 16 && outLen >= 8 && in && out && Readable(in, 16) &&
        memcmp(in, kWsaIdSendMsg, 16) == 0 && Writable(out, 8)) {
        void* real = *(void**)out;
        void* prev = __sync_val_compare_and_swap(&g_nlSendMsgReal, NULL, real);
        if (real && (prev == NULL || prev == real)) {
            *(void**)out = (void*)NlSendMsgX;
            NlNote(NL_IOCTL, __builtin_return_address(0), L"WSASendMsg handed out (wrapped)", 0);
        }
    }
    return r;
}
static void* NlWhConnect(void* sess, const wchar_t* server, uint16_t port, DWORD rsv)
{ NlNameNote(NL_WHCONNECT, __builtin_return_address(0), server, 1, NULL, port); return NLREAL(NL_WHCONNECT, NlWhConnectFn)(sess, server, port, rsv); }
static void* NlWhOpen(void* c, const wchar_t* verb, const wchar_t* obj, const wchar_t* ver, const wchar_t* ref, const wchar_t** acc, DWORD fl)
{ NlNameNote(NL_WHOPEN, __builtin_return_address(0), obj, 1, verb, -1); return NLREAL(NL_WHOPEN, NlWhOpenFn)(c, verb, obj, ver, ref, acc, fl); }
static void* NlIConnW(void* h, const void* server, uint16_t port, const void* u, const void* pw, DWORD svc, DWORD fl, uintptr_t ctx)
{ NlNameNote(NL_ICONNW, __builtin_return_address(0), server, 1, NULL, port); return NLREAL(NL_ICONNW, NlIConnFn)(h, server, port, u, pw, svc, fl, ctx); }
static void* NlIConnA(void* h, const void* server, uint16_t port, const void* u, const void* pw, DWORD svc, DWORD fl, uintptr_t ctx)
{ NlNameNote(NL_ICONNA, __builtin_return_address(0), server, 0, NULL, port); return NLREAL(NL_ICONNA, NlIConnFn)(h, server, port, u, pw, svc, fl, ctx); }
static void* NlIOpenUrlW(void* h, const void* url, const void* hd, DWORD hl, DWORD fl, uintptr_t ctx)
{ NlNameNote(NL_IOPENURLW, __builtin_return_address(0), url, 1, NULL, -1); return NLREAL(NL_IOPENURLW, NlIOpenUrlFn)(h, url, hd, hl, fl, ctx); }
static void* NlIOpenUrlA(void* h, const void* url, const void* hd, DWORD hl, DWORD fl, uintptr_t ctx)
{ NlNameNote(NL_IOPENURLA, __builtin_return_address(0), url, 0, NULL, -1); return NLREAL(NL_IOPENURLA, NlIOpenUrlFn)(h, url, hd, hl, fl, ctx); }

/* an EOS function looked up from the EOS SDK (the exe delay-loads 296; the lookup is the first call's): logged once
 * each with its caller, except EOS's anti-cheat interface functions, which are only counted (RVNG stays out of them) */
static void NlEosLookup(const char* name, const void* ret)
{
    wchar_t d[96];
    size_t n = 0;
    int ac = 0;
    for (; n < 95 && Readable(name + n, 1) && name[n]; ++n) d[n] = (wchar_t)(uint8_t)name[n];
    d[n] = 0;
    for (size_t i = 0; i + 9 <= n && !ac; ++i) {
        static const char kAc[] = "anticheat";
        size_t j = 0;
        while (j < 9 && (char)(d[i + j] | 32) == kAc[j]) ++j;
        ac = j == 9;
    }
    if (ac) { __sync_add_and_fetch(&g_nlEosAc, 1); return; }
    wchar_t mod[64];
    uint32_t off;
    NlModOf(ret, mod, 64, &off);
    if (!NlFirst(NL_GPA, L"EOSSDK", d)) return;
    int32_t k = __sync_add_and_fetch(&g_nlEosFns, 1);
    Log(L"netlog: EOS function %d looked up by %s+%x: %s", k, mod, off, d);
}

/* GetProcAddress: a watched function looked up at run time comes back as its wrapper */
static void* NlGpa(HANDLE mod, const char* name)
{
    void* r = NLREAL(NL_GPA, NlGpaFn)(mod, name);
    if (r && mod && ((uintptr_t)name >> 16)) {
        void* eos = g_nlEosMod;
        if (!eos && (eos = (void*)GetModuleHandleW(L"EOSSDK-Win64-Shipping.dll")) != NULL) g_nlEosMod = eos;
        if (eos && (void*)mod == eos) NlEosLookup(name, __builtin_return_address(0));
    }
    if (r) for (int k = 0; k < NL_GPA; ++k) if (g_nl[k].real == r && g_nl[k].wrap) {
        wchar_t d[64]; size_t n = 0;
        if ((uintptr_t)name >> 16) { for (; n < 60 && Readable(name + n, 1) && name[n]; ++n) d[n] = (wchar_t)(uint8_t)name[n]; }
        else { d[n++] = L'#'; d[n++] = (wchar_t)(L'0' + ((uintptr_t)name / 100) % 10); d[n++] = (wchar_t)(L'0' + ((uintptr_t)name / 10) % 10);
               d[n++] = (wchar_t)(L'0' + (uintptr_t)name % 10); }
        d[n] = 0;
        NlNote(NL_GPA, __builtin_return_address(0), d, 0);
        return g_nl[k].wrap;
    }
    return r;
}

static void NlInitTargets(void)
{
    static const struct { const wchar_t* dll; const char* name; void* wrap; } k[NL_N] = {
        { L"ws2_32.dll", "connect", (void*)NlConnect }, { L"ws2_32.dll", "WSAConnect", (void*)NlWsaConnect },
        { NULL, NULL, NULL /* ConnectEx: through WSAIoctl */ },
        { L"ws2_32.dll", "sendto", (void*)NlSendTo }, { L"ws2_32.dll", "WSASendTo", (void*)NlWsaSendTo },
        { L"ws2_32.dll", "getaddrinfo", (void*)NlGai }, { L"ws2_32.dll", "GetAddrInfoW", (void*)NlGaiW },
        { L"ws2_32.dll", "GetAddrInfoExW", (void*)NlGaiExW }, { L"ws2_32.dll", "GetAddrInfoExA", (void*)NlGaiExA },
        { L"ws2_32.dll", "gethostbyname", (void*)NlGhbn }, { L"ws2_32.dll", "WSAConnectByNameW", (void*)NlCbnW },
        { L"ws2_32.dll", "WSAConnectByNameA", (void*)NlCbnA }, { L"ws2_32.dll", "WSAIoctl", (void*)NlIoctl },
        { L"ws2_32.dll", "bind", (void*)NlBind }, { L"ws2_32.dll", "WSASendMsg", (void*)NlSendMsg },
        { L"winhttp.dll", "WinHttpConnect", (void*)NlWhConnect }, { L"winhttp.dll", "WinHttpOpenRequest", (void*)NlWhOpen },
        { L"wininet.dll", "InternetConnectW", (void*)NlIConnW }, { L"wininet.dll", "InternetConnectA", (void*)NlIConnA },
        { L"wininet.dll", "InternetOpenUrlW", (void*)NlIOpenUrlW }, { L"wininet.dll", "InternetOpenUrlA", (void*)NlIOpenUrlA },
        { L"kernel32.dll", "GetProcAddress", (void*)NlGpa },
    };
    for (int i = 0; i < NL_N; ++i) { g_nl[i].dll = k[i].dll; g_nl[i].name = k[i].name; g_nl[i].wrap = k[i].wrap; }
}

/* the real functions of DLLs that are loaded now; returns how many are known */
static int NlResolve(void)
{
    int known = 0;
    for (int i = 0; i < NL_N; ++i) {
        if (!g_nl[i].dll) continue;
        if (!g_nl[i].real) {
            HANDLE h = GetModuleHandleW(g_nl[i].dll);
            if (h) g_nl[i].real = GetProcAddress(h, g_nl[i].name);
        }
        if (g_nl[i].real) ++known;
    }
    return known;
}

static int NlPatchSlot(uint64_t* slot)
{
    if (!Readable(slot, 8)) return 0;
    uint64_t v = *slot;
    if (!v) return 0;
    for (int k = 0; k < NL_N; ++k) {
        if (!g_nl[k].real || !g_nl[k].wrap || v != (uint64_t)(uintptr_t)g_nl[k].real) continue;
        DWORD old = 0, ign = 0;
        if (!VirtualProtect(slot, 8, PAGE_READWRITE, &old)) return 0;
        __atomic_store_n(slot, (uint64_t)(uintptr_t)g_nl[k].wrap, __ATOMIC_SEQ_CST);
        VirtualProtect(slot, 8, old, &ign);
        return 1;
    }
    return 0;
}

/* every import and delay-import slot of one module that points at a watched function; returns slots patched */
static int NlPatchModule(uint8_t* base)
{
    if (!Readable(base, 0x40)) return 0;
    uint32_t pe = *(uint32_t*)(base + 0x3C);
    if (pe > 0x1000 || !Readable(base + pe, 24 + 240) || *(uint32_t*)(base + pe) != 0x4550u) return 0;
    uint8_t* opt = base + pe + 24;
    if (*(uint16_t*)opt != 0x20B) return 0;                                   /* PE32+ only */
    uint32_t ndir = *(uint32_t*)(opt + 108);
    uint32_t size = *(uint32_t*)(opt + 56);
    int put = 0;
    if (ndir > 1) {
        uint32_t rva = *(uint32_t*)(opt + 120);
        for (uint32_t i = 0; rva && rva < size && i < 4096; ++i) {
            uint8_t* d = base + rva + i * 20;
            if (!Readable(d, 20)) break;
            uint32_t nameRva = *(uint32_t*)(d + 12), ft = *(uint32_t*)(d + 16);
            if (!nameRva && !ft) break;
            if (!ft || ft >= size) continue;
            for (uint32_t j = 0; j < 65536; ++j) {
                uint64_t* slot = (uint64_t*)(base + ft) + j;
                if (!Readable(slot, 8) || !*slot) break;
                put += NlPatchSlot(slot);
            }
        }
    }
    if (ndir > 13) {
        uint32_t rva = *(uint32_t*)(opt + 112 + 13 * 8);
        for (uint32_t i = 0; rva && rva < size && i < 1024; ++i) {
            uint8_t* d = base + rva + i * 32;
            if (!Readable(d, 32)) break;
            uint32_t nameRva = *(uint32_t*)(d + 4), iat = *(uint32_t*)(d + 12);
            if (!nameRva && !iat) break;
            if (!iat || iat >= size) continue;
            for (uint32_t j = 0; j < 65536; ++j) {
                uint64_t* slot = (uint64_t*)(base + iat) + j;
                if (!Readable(slot, 8) || !*slot) break;
                put += NlPatchSlot(slot);
            }
        }
    }
    return put;
}

/* one pass over the loaded modules: new ones, or all again when a watched DLL was loaded since the last pass */
static void NlScan(void)
{
    static HANDLE mods[1024];
    static uint8_t* done[1024];
    static int32_t ndone;
    int known = NlResolve();
    if (known != g_nlGen) { g_nlGen = known; ndone = 0; }
    DWORD need = 0;
    if (!K32EnumProcessModules(GetCurrentProcess(), mods, sizeof(mods), &need)) return;
    int n = (int)(need / sizeof(HANDLE));
    if (n > 1024) n = 1024;
    for (int i = 0; i < n; ++i) {
        uint8_t* b = (uint8_t*)mods[i];
        if (!b || b == (uint8_t*)g_hModule) continue;
        int seen = 0;
        for (int32_t j = 0; j < ndone; ++j) if (done[j] == b) { seen = 1; break; }
        if (seen) continue;
        int known_mod = 0;
        for (int32_t j = 0; j < g_nlNMod; ++j) if (g_nlMod[j].base == b) { known_mod = 1; break; }
        if (!known_mod && g_nlNMod < 1024 && Readable(b, 0x40)) {
            NlMod* m = &g_nlMod[g_nlNMod];
            uint32_t pe = *(uint32_t*)(b + 0x3C);
            m->base = b;
            m->size = pe <= 0x1000 && Readable(b + pe + 24 + 56, 4) ? *(uint32_t*)(b + pe + 24 + 56) : 0x1000;
            NlBaseName((HANDLE)b, m->name, 48);
            __sync_add_and_fetch(&g_nlNMod, 1);
            __sync_add_and_fetch(&g_nlModules, 1);
            if (g_nlFirstPassDone) Log(L"netlog: module loaded: %s", m->name);
        }
        int put = NlPatchModule(b);
        if (ndone < 1024) done[ndone++] = b;
        if (put) {
            __sync_add_and_fetch(&g_nlSlots, put);
            wchar_t mod[64]; uint32_t off;
            NlModOf(b, mod, 64, &off);
            Log(L"netlog: %d import slot(s) of %s now observed", put, mod);
        }
    }
}

static DWORD WINAPI NlThread(void* arg)
{
    (void)arg;
    for (int i = 0; ; ++i) {
        NlScan();
        g_nlFirstPassDone = 1;
        Sleep(i < 300 ? 1000 : 10000);
    }
    return 0;
}

static void NlStart(void)
{
    NlInitTargets();
    g_nlOn = 1;
    NlScan();
    Log(L"netlog (test only, observe only): %d watched functions resolved, %d import slots in %d modules observed; re-scanning",
        g_nlGen, g_nlSlots, g_nlModules);
    HANDLE th = CreateThread(NULL, 0, NlThread, NULL, 0, NULL);
    if (th) CloseHandle(th); else Log(L"netlog: could not start its scan thread");
}

#endif /* RVNG_NETLOG_H */
