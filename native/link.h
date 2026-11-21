/* link.h (2026-11-19): RVNG's link between the two PCs of a match, over Steam's ISteamNetworkingMessages (Steamworks
 * 1.57 flat API, from the game's own steam_api64.dll), RELAY-ONLY: P2P_Transport_ICE_Enable = 0 for the process, so
 * every packet goes through Valve's relays (SDR) and neither player learns the other's IP address. The user chose this
 * over ISteamNetworking v006 (direct first, exposes addresses).
 *
 * Who talks to whom: each PC knows the other's SteamID from RVNG's matchmaker (the bridge). Each sends first, which
 * accepts the session with that one peer only (Steam's implicit accept); a message from anyone else is never accepted,
 * and one that still arrives is dropped (its sender is checked). No Steam callback is registered.
 *
 * The protocol (docs/re/DEATHMATCH_NATIVE.md 9.7 step 2): every message has a 16-byte header (magic "RVNG", protocol,
 * type, length, sequence, the match tag both PCs got from the matchmaker, so a message from an earlier match is
 * dropped). Channel 0 carries the link's own messages, channel 1 the game's (DATA).
 *   HELLO  every 0.5 s until both sides have the other's (each says whether it has the peer's): player number, the
 *          runtime version, the mod-scan hash, the pilot's name, and (later) the airset. The link is UP once both
 *          sides have both hellos.
 *   PING / PONG every 0.25 s both ways, the heartbeat: no message for LINK_LOST_US (6 s) = the link is lost.
 *          The guest's pings also measure the clock: offset = host clock - guest clock, from the sample with the
 *          lowest round trip of the last 16 (NTP's estimate), so one synced clock runs on both PCs.
 *   GO     the host's start: "at host time T". The guest turns T into its own clock and answers GOACK. The host sends
 *          GO only once the guest says its clock is synced (its pings carry the flag).
 *   READY  each side's ready flag rides on its pings (the ready-up screen); once both are ready and the guest's clock
 *          is synced, the host sends LAUNCH "at host time T" (as GO), the guest answers LAUNCHACK, and both PCs launch
 *          into the match at T (the start gate's GO then lines up the match itself, whatever the loading times).
 *   BYE    a clean stop, with a reason.
 *   DATA   the game's messages, queued for the game thread (LinkRecvData).
 * The link's thread (LinkThread) runs every 5 ms; the game thread only sends DATA and reads the queue. */
#ifndef RVNG_LINK_H
#define RVNG_LINK_H

#define LINK_MAGIC       0x474E5652u          /* "RVNG" */
#define LINK_PROTO       2                    /* 2 (2026-11-21): LOADOUT; the ready flag 0..2 (2 = ready, SORTIE pressed) */
#define LINK_HELLO_US    500000ull
#define LINK_PING_US     250000ull
#define LINK_GO_RESEND   250000ull
#define LINK_LOST_US     6000000ull
#define LINK_CONNECT_US  120000000ull        /* waiting for the peer to appear at all */
#define LINK_SYNC_MIN    6                    /* clock samples before the guest says it is synced */
#define LINK_MAX_MSG     1200                 /* one message, header included (Steam's unreliable MTU) */
#define LINK_RING        128                  /* DATA messages waiting for the game thread */
#define LINK_NAME        32

enum { LK_HELLO = 1, LK_PING, LK_PONG, LK_GO, LK_GOACK, LK_BYE, LK_DATA, LK_LAUNCH, LK_LAUNCHACK, LK_LOADOUT, LK_NTYPES };
enum { LS_OFF, LS_WAITING, LS_UP, LS_LOST, LS_CLOSED };
enum { LB_STOPPED = 1, LB_LOST, LB_MATCH_OVER, LB_BAD_PEER };
enum { LG_NONE, LG_SENT, LG_ACKED, LG_SET };  /* host: sent, acked; guest: set */

#pragma pack(push, 1)
typedef struct { uint32_t magic; uint8_t proto; uint8_t type; uint16_t len; uint32_t seq; uint32_t tag; } LinkHdr;
typedef struct { uint8_t player; uint8_t gotYours; uint16_t rsv; uint32_t rtVersion; uint32_t modHash; char name[LINK_NAME]; } LinkHello;
typedef struct { uint64_t t0; uint8_t synced; uint8_t stage; uint8_t ready; } LinkPing;   /* stage: the game's point (12 = at the start gate) */
typedef struct { uint64_t t0, t1, t2; } LinkPong;
typedef struct { uint64_t atHostUs; uint32_t goId; int64_t hostClockK; } LinkGo;   /* hostClockK: the host's game clock
                                                                                       * minus its link clock x 10 (100 ns) */
typedef struct { uint32_t goId; int64_t offsetUs; } LinkGoAck;
typedef struct { uint8_t reason; } LinkBye;
/* LOADOUT (reliable, whenever it changes): the pilot's plane as the game's own ids (the hangar's member 0 and the weapons
 * and parts arrays). The receiver shows only a stock aircraft (hangar.h kStockPlanes; the user's rule) */
#define LINK_LO_WEAPONS 24
#define LINK_LO_PARTS   32
typedef struct { int32_t aircraft, skin; uint8_t sp1, sp2, paint[3], nEmblems, nWeapons, nParts; int32_t emblems[8];
                 int32_t weapons[LINK_LO_WEAPONS]; int32_t parts[LINK_LO_PARTS];
                 char names[48]; } LinkLoadout;          /* names: "plane|sp1|sp2" as the sender's own STANDBY shows them */
#pragma pack(pop)

/* the transport: Steam in the game, a fake pair in the tests */
typedef struct {
    int      (*send)(void* ctx, int channel, const void* p, uint32_t n, int reliable);  /* 1 sent */
    int      (*recv)(void* ctx, int channel, uint8_t* buf, int cap, uint64_t* from);   /* bytes; 0 none */
    uint64_t (*now)(void* ctx);                                                         /* microseconds */
    void*    ctx;
} LinkIo;

typedef struct {
    LinkIo   io;
    volatile int32_t state, reason;
    int32_t  player;                  /* 1 host, 2 guest */
    uint64_t self, peer;
    uint32_t tag, seq;
    uint64_t startUs, lastRecvUs, lastHelloUs, lastPingUs, upUs;
    int32_t  gotPeerHello, peerGotMine;
    LinkHello mine, theirs;
    /* the clock (offset = host - local; 0 on the host) */
    uint64_t sampleRtt[16]; int64_t sampleOff[16]; int32_t nSamples;
    volatile int64_t offsetUs, rttUs;
    volatile int32_t synced, peerSynced;
    volatile int32_t localStage, peerStage;    /* where each game is (the GM state; 12 = held at the start gate) */
    volatile int32_t localReady, peerReady;    /* the ready-up screen's flags (0 no, 1 ready, 2 ready and SORTIE pressed) */
    LinkLoadout peerLoadout; volatile int32_t peerLoadoutSeq;   /* the opponent's plane (LOADOUT) */
    /* LAUNCH (the same as GO, for the launch into the match) */
    volatile int32_t lnState; uint32_t lnId; uint64_t lnAtHostUs, lnLastSentUs; volatile uint64_t lnAtLocalUs;
    /* GO */
    volatile int32_t goState; uint32_t goId; uint64_t goAtHostUs, goLastSentUs; volatile uint64_t goAtLocalUs;
    int64_t  goClockK; volatile int64_t peerClockK;  /* the host's clock relation, sent in GO (the guest aligns to it) */
    /* counts */
    volatile int32_t sent[LK_NTYPES], got[LK_NTYPES], badPeer, badHeader, badTag, sendFail, ringFull;
    /* DATA for the game thread: single producer (the link thread), single consumer (the game thread) */
    uint8_t  ring[LINK_RING][LINK_MAX_MSG]; uint16_t ringLen[LINK_RING];
    volatile uint32_t ringHead, ringTail;
} Link;

static uint32_t LinkTagOf(const char* s, size_t n)          /* the match tag: FNV-1a of the matchmaker's match id */
{
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < n; ++i) { h ^= (uint8_t)s[i]; h *= 16777619u; }
    return h ? h : 1;
}

static int LinkSend(Link* L, int type, const void* body, uint32_t n, int reliable)
{
    uint8_t buf[LINK_MAX_MSG];
    if (n > LINK_MAX_MSG - sizeof(LinkHdr)) return 0;
    LinkHdr h = { LINK_MAGIC, LINK_PROTO, (uint8_t)type, (uint16_t)n, __sync_add_and_fetch(&L->seq, 1), L->tag };
    memcpy(buf, &h, sizeof(h));
    if (n) memcpy(buf + sizeof(h), body, n);
    int ok = L->io.send(L->io.ctx, type == LK_DATA ? 1 : 0, buf, (uint32_t)(sizeof(h) + n), reliable);
    if (ok) __sync_add_and_fetch(&L->sent[type], 1); else __sync_add_and_fetch(&L->sendFail, 1);
    return ok;
}

static void LinkSendHello(Link* L, uint64_t now)
{
    L->mine.gotYours = (uint8_t)L->gotPeerHello;
    LinkSend(L, LK_HELLO, &L->mine, sizeof(L->mine), 0);
    L->lastHelloUs = now;
}

/* start a link to the peer; player 1 = host, 2 = guest */
static void LinkBegin(Link* L, uint64_t self, uint64_t peer, int player, uint32_t tag, uint32_t rtVersion, uint32_t modHash,
                      const char* name)
{
    LinkIo io = L->io;
    memset(L, 0, sizeof(*L));
    L->io = io;
    L->self = self; L->peer = peer; L->player = player; L->tag = tag;
    L->mine.player = (uint8_t)player; L->mine.rtVersion = rtVersion; L->mine.modHash = modHash;
    for (int i = 0; name && name[i] && i < LINK_NAME - 1; ++i) L->mine.name[i] = name[i];
    L->startUs = L->lastRecvUs = io.now(io.ctx);
    L->synced = player == 1;                                          /* the host's clock is the match clock */
    L->state = LS_WAITING;
    LinkSendHello(L, L->startUs);
}

static void LinkEnd(Link* L, int reason)
{
    if (L->state == LS_WAITING || L->state == LS_UP) {
        LinkBye b = { (uint8_t)reason };
        LinkSend(L, LK_BYE, &b, sizeof(b), 1);
    }
    L->reason = reason;
    L->state = LS_CLOSED;
}

/* the guest's clock: the sample with the lowest round trip of the last 16 */
static void LinkClockSample(Link* L, uint64_t t0, uint64_t t1, uint64_t t2, uint64_t t3)
{
    if (t3 < t0) return;
    int64_t rtt = (int64_t)(t3 - t0) - (int64_t)(t2 - t1);
    if (rtt < 0) rtt = 0;
    int64_t off = (((int64_t)t1 - (int64_t)t0) + ((int64_t)t2 - (int64_t)t3)) / 2;
    int i = L->nSamples % 16;
    L->sampleRtt[i] = (uint64_t)rtt; L->sampleOff[i] = off;
    ++L->nSamples;
    int n = L->nSamples < 16 ? L->nSamples : 16, best = 0;
    for (int k = 1; k < n; ++k) if (L->sampleRtt[k] < L->sampleRtt[best]) best = k;
    if (L->player == 2) { L->offsetUs = L->sampleOff[best]; if (L->nSamples >= LINK_SYNC_MIN) L->synced = 1; }
    L->rttUs = (int64_t)L->sampleRtt[best];
}

static void LinkPushData(Link* L, const uint8_t* p, uint32_t n)
{
    uint32_t h = L->ringHead;
    if (h - L->ringTail >= LINK_RING) { __sync_add_and_fetch(&L->ringFull, 1); return; }
    memcpy(L->ring[h % LINK_RING], p, n);
    L->ringLen[h % LINK_RING] = (uint16_t)n;
    __atomic_store_n(&L->ringHead, h + 1, __ATOMIC_RELEASE);
}

/* the game thread: the next DATA message (its payload, without the link header), or 0 */
static int LinkRecvData(Link* L, uint8_t* out, int cap)
{
    uint32_t t = L->ringTail;
    if (t == __atomic_load_n(&L->ringHead, __ATOMIC_ACQUIRE)) return 0;
    int n = L->ringLen[t % LINK_RING];
    if (n > cap) n = cap;
    memcpy(out, L->ring[t % LINK_RING], (size_t)n);
    __atomic_store_n(&L->ringTail, t + 1, __ATOMIC_RELEASE);
    return n;
}

static int LinkSendData(Link* L, const void* p, uint32_t n, int reliable)
{
    return L->state == LS_UP ? LinkSend(L, LK_DATA, p, n, reliable) : 0;
}

/* one received message; returns 1 if it was taken */
static int LinkHandle(Link* L, const uint8_t* buf, int n, uint64_t from, uint64_t now)
{
    if (from != L->peer) { __sync_add_and_fetch(&L->badPeer, 1); return 0; }
    if (n < (int)sizeof(LinkHdr)) { __sync_add_and_fetch(&L->badHeader, 1); return 0; }
    LinkHdr h; memcpy(&h, buf, sizeof(h));
    if (h.magic != LINK_MAGIC || h.proto != LINK_PROTO || h.type == 0 || h.type >= LK_NTYPES || h.len != n - (int)sizeof(h)) {
        __sync_add_and_fetch(&L->badHeader, 1); return 0;
    }
    if (h.tag != L->tag) { __sync_add_and_fetch(&L->badTag, 1); return 0; }
    const uint8_t* b = buf + sizeof(h);
    L->lastRecvUs = now;
    __sync_add_and_fetch(&L->got[h.type], 1);
    switch (h.type) {
    case LK_HELLO:
        if (h.len < sizeof(LinkHello)) return 0;
        memcpy(&L->theirs, b, sizeof(LinkHello));
        L->theirs.name[LINK_NAME - 1] = 0;
        if (!L->gotPeerHello) { L->gotPeerHello = 1; LinkSendHello(L, now); }   /* tell the peer at once */
        if (L->theirs.gotYours) L->peerGotMine = 1;
        break;
    case LK_PING: {
        if (h.len < sizeof(LinkPing)) return 0;
        LinkPing p; memcpy(&p, b, sizeof(p));
        L->peerSynced = p.synced;
        L->peerStage = p.stage;
        L->peerReady = p.ready;
        LinkPong r = { p.t0, now, L->io.now(L->io.ctx) };
        LinkSend(L, LK_PONG, &r, sizeof(r), 0);
        break;
    }
    case LK_PONG: {
        if (h.len < sizeof(LinkPong)) return 0;
        LinkPong r; memcpy(&r, b, sizeof(r));
        LinkClockSample(L, r.t0, r.t1, r.t2, now);
        break;
    }
    case LK_GO: {                                     /* (guest) */
        if (h.len < sizeof(LinkGo) || L->player != 2) return 0;
        LinkGo g; memcpy(&g, b, sizeof(g));
        if (L->goState != LG_SET || L->goId != g.goId) {
            L->goId = g.goId; L->goAtHostUs = g.atHostUs; L->peerClockK = g.hostClockK;
            L->goAtLocalUs = (uint64_t)((int64_t)g.atHostUs - L->offsetUs);
            L->goState = LG_SET;
        }
        LinkGoAck a = { g.goId, L->offsetUs };
        LinkSend(L, LK_GOACK, &a, sizeof(a), 1);
        break;
    }
    case LK_GOACK: {                                  /* (host) */
        if (h.len < sizeof(LinkGoAck) || L->player != 1) return 0;
        LinkGoAck a; memcpy(&a, b, sizeof(a));
        if (a.goId == L->goId && L->goState == LG_SENT) L->goState = LG_ACKED;
        break;
    }
    case LK_LAUNCH: {                                 /* (guest) */
        if (h.len < sizeof(LinkGo) || L->player != 2) return 0;
        LinkGo g; memcpy(&g, b, sizeof(g));
        if (L->lnState != LG_SET || L->lnId != g.goId) {
            L->lnId = g.goId; L->lnAtHostUs = g.atHostUs;
            L->lnAtLocalUs = (uint64_t)((int64_t)g.atHostUs - L->offsetUs);
            L->lnState = LG_SET;
        }
        LinkGoAck a = { g.goId, L->offsetUs };
        LinkSend(L, LK_LAUNCHACK, &a, sizeof(a), 1);
        break;
    }
    case LK_LAUNCHACK: {                              /* (host) */
        if (h.len < sizeof(LinkGoAck) || L->player != 1) return 0;
        LinkGoAck a; memcpy(&a, b, sizeof(a));
        if (a.goId == L->lnId && L->lnState == LG_SENT) L->lnState = LG_ACKED;
        break;
    }
    case LK_BYE: {
        LinkBye y = { 0 };
        if (h.len >= sizeof(y)) memcpy(&y, b, sizeof(y));
        L->reason = y.reason;
        L->state = LS_CLOSED;
        break;
    }
    case LK_DATA:
        if (L->state == LS_UP) LinkPushData(L, b, h.len);
        break;
    case LK_LOADOUT:
        if (h.len < sizeof(LinkLoadout)) return 0;
        memcpy(&L->peerLoadout, b, sizeof(LinkLoadout));
        if (L->peerLoadout.nEmblems > 8) L->peerLoadout.nEmblems = 8;
        if (L->peerLoadout.nWeapons > LINK_LO_WEAPONS) L->peerLoadout.nWeapons = LINK_LO_WEAPONS;
        if (L->peerLoadout.nParts > LINK_LO_PARTS) L->peerLoadout.nParts = LINK_LO_PARTS;
        L->peerLoadout.names[sizeof(L->peerLoadout.names) - 1] = 0;
        __sync_add_and_fetch(&L->peerLoadoutSeq, 1);
        break;
    }
    if (L->state == LS_WAITING && L->gotPeerHello && L->peerGotMine) { L->state = LS_UP; L->upUs = now; }
    return 1;
}

/* the host's GO: the match starts delayUs from now (host clock), once the guest's clock is synced; 1 if sent.
 * clockK: the host's game clock minus its link clock (x 10), so the guest can run the host's game clock */
static int LinkGoStart(Link* L, uint64_t delayUs, int64_t clockK)
{
    if (L->player != 1 || L->state != LS_UP || !L->peerSynced) return 0;
    uint64_t now = L->io.now(L->io.ctx);
    L->goId += 1;
    L->goAtHostUs = now + delayUs;
    L->goAtLocalUs = L->goAtHostUs;
    L->goState = LG_SENT;
    L->goClockK = clockK;
    LinkGo g = { L->goAtHostUs, L->goId, clockK };
    L->goLastSentUs = now;
    return LinkSend(L, LK_GO, &g, sizeof(g), 1);
}

/* the host's LAUNCH: both PCs launch into the match delayUs from now, once both are ready and the guest's clock is
 * synced; committed once sent (a pilot who leaves after it ends the link instead). 1 if sent */
static int LinkLaunchStart(Link* L, uint64_t delayUs)
{
    if (L->player != 1 || L->state != LS_UP || !L->peerSynced || !L->localReady || !L->peerReady || L->lnState != LG_NONE)
        return 0;
    uint64_t now = L->io.now(L->io.ctx);
    L->lnId += 1;
    L->lnAtHostUs = now + delayUs;
    L->lnAtLocalUs = L->lnAtHostUs;
    L->lnState = LG_SENT;
    L->lnLastSentUs = now;
    LinkGo g = { L->lnAtHostUs, L->lnId, 0 };
    return LinkSend(L, LK_LAUNCH, &g, sizeof(g), 1);
}
/* the launch: scheduled on this PC (the guest as soon as LAUNCH came, the host once the guest acknowledged it) */
static int LinkLaunchSet(Link* L) { return L->lnState == LG_SET || L->lnState == LG_ACKED; }
static int LinkLaunchDue(Link* L) { return LinkLaunchSet(L) && L->io.now(L->io.ctx) >= L->lnAtLocalUs; }
static int64_t LinkLaunchLeftMs(Link* L)
{
    return LinkLaunchSet(L) ? ((int64_t)L->lnAtLocalUs - (int64_t)L->io.now(L->io.ctx)) / 1000 : -1;
}

/* what the guest adds to its game clock's offset (c[0x20], 100 ns) to run the host's: the two game clocks differ by
 * the link clocks' offset (x 10) plus the two PCs' own game-minus-link relations */
static int64_t LinkClockDelta(int64_t offsetUs, int64_t hostClockK, int64_t myClockK)
{
    return offsetUs * 10 + hostClockK - myClockK;
}

/* 1 once the agreed start time has come on this PC */
static int LinkGoDue(Link* L)
{
    if (L->goState != LG_SET && L->goState != LG_ACKED) return 0;
    return L->io.now(L->io.ctx) >= L->goAtLocalUs;
}

/* receive everything waiting, then the timers; the link thread calls it every few ms */
static void LinkTick(Link* L)
{
    if (L->state != LS_WAITING && L->state != LS_UP) return;
    uint8_t buf[LINK_MAX_MSG];
    uint64_t from = 0;
    for (int ch = 0; ch < 2; ++ch) {
        for (int k = 0; k < 256; ++k) {
            int n = L->io.recv(L->io.ctx, ch, buf, (int)sizeof(buf), &from);
            if (n == 0) break;
            if (n < 0) { __sync_add_and_fetch(&L->badHeader, 1); continue; }   /* (one dropped by the transport) */
            LinkHandle(L, buf, n, from, L->io.now(L->io.ctx));
            if (L->state == LS_CLOSED) return;
        }
    }
    uint64_t now = L->io.now(L->io.ctx);
    if (L->state == LS_WAITING && now - L->lastHelloUs >= LINK_HELLO_US) LinkSendHello(L, now);
    if (now - L->lastPingUs >= LINK_PING_US && (L->state == LS_UP || L->gotPeerHello)) {
        LinkPing p = { now, (uint8_t)L->synced, (uint8_t)L->localStage, (uint8_t)L->localReady };
        LinkSend(L, LK_PING, &p, sizeof(p), 0);
        L->lastPingUs = now;
    }
    if (L->player == 1 && L->goState == LG_SENT && now - L->goLastSentUs >= LINK_GO_RESEND) {
        LinkGo g = { L->goAtHostUs, L->goId, L->goClockK };
        LinkSend(L, LK_GO, &g, sizeof(g), 1);
        L->goLastSentUs = now;
    }
    if (L->player == 1 && L->lnState == LG_SENT && now - L->lnLastSentUs >= LINK_GO_RESEND) {
        LinkGo g = { L->lnAtHostUs, L->lnId, 0 };
        LinkSend(L, LK_LAUNCH, &g, sizeof(g), 1);
        L->lnLastSentUs = now;
    }
    if (now - L->lastRecvUs > (L->state == LS_UP ? LINK_LOST_US : LINK_CONNECT_US)) { L->reason = LB_LOST; L->state = LS_LOST; }
}

/* ---- the Steam transport (steam_api64.dll's flat API, resolved by name) ------------------------------------------ */
#define ST_ID_SIZE       136               /* sizeof(SteamNetworkingIdentity) */
#define ST_ID_STEAMID    16                /* k_ESteamNetworkingIdentityType_SteamID */
#define ST_SEND_RELIABLE 8
#define ST_SEND_NONAGLE  1
#define ST_SEND_RESTART  32                /* AutoRestartBrokenSession */
#define ST_CFG_ICE_ENABLE 104              /* k_ESteamNetworkingConfig_P2P_Transport_ICE_Enable (checked by name) */
#define ST_SCOPE_GLOBAL  1
#define ST_MSG_DATA      0                 /* SteamNetworkingMessage_t: m_pData, m_cbSize, m_identityPeer */
#define ST_MSG_SIZE      8
#define ST_MSG_PEER      16

static struct {
    int      bound;                        /* 1 found, -1 missing, 0 not tried */
    void*    msgs; void* utils; void* user;
    int      (*send)(void* self, const void* id, const void* data, uint32_t n, int flags, int ch);
    int      (*recv)(void* self, int ch, void** out, int max);
    uint8_t  (*close)(void* self, const void* id);
    int      (*session)(void* self, const void* id, void* info, void* status);
    void     (*release)(void* msg);
    void     (*setId)(void* id, uint64_t sid);
    uint64_t (*steamId)(void* user);
    uint8_t  (*setGlobalI32)(void* utils, int key, int32_t v);
    int      (*getConfig)(void* utils, int key, int scope, intptr_t obj, int* type, void* out, size_t* cb);
    const char* (*cfgInfo)(void* utils, int key, int* type, int* scope);
    void     (*initRelay)(void* utils);
    int      (*relayStatus)(void* utils, void* details);
    uint8_t  peerId[ST_ID_SIZE + 8];
    volatile int32_t iceSet, iceRead, relayAsked, lastSendResult, lastSessionState;
} S;

static int SteamBind(void)
{
    if (S.bound) return S.bound > 0;
    HANDLE h = GetModuleHandleW(L"steam_api64.dll");
    if (!h) return 0;                                              /* (not loaded yet: try again later) */
    typedef void* (*IfaceFn)(void);
    IfaceFn fMsgs = (IfaceFn)GetProcAddress(h, "SteamAPI_SteamNetworkingMessages_SteamAPI_v002");
    IfaceFn fUtils = (IfaceFn)GetProcAddress(h, "SteamAPI_SteamNetworkingUtils_SteamAPI_v004");
    IfaceFn fUser = (IfaceFn)GetProcAddress(h, "SteamAPI_SteamUser_v021");
#define SB(f, n) *(void**)&S.f = GetProcAddress(h, n)
    SB(send, "SteamAPI_ISteamNetworkingMessages_SendMessageToUser");
    SB(recv, "SteamAPI_ISteamNetworkingMessages_ReceiveMessagesOnChannel");
    SB(close, "SteamAPI_ISteamNetworkingMessages_CloseSessionWithUser");
    SB(session, "SteamAPI_ISteamNetworkingMessages_GetSessionConnectionInfo");
    SB(release, "SteamAPI_SteamNetworkingMessage_t_Release");
    SB(setId, "SteamAPI_SteamNetworkingIdentity_SetSteamID64");
    SB(steamId, "SteamAPI_ISteamUser_GetSteamID");
    SB(setGlobalI32, "SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32");
    SB(getConfig, "SteamAPI_ISteamNetworkingUtils_GetConfigValue");
    SB(cfgInfo, "SteamAPI_ISteamNetworkingUtils_GetConfigValueInfo");
    SB(initRelay, "SteamAPI_ISteamNetworkingUtils_InitRelayNetworkAccess");
    SB(relayStatus, "SteamAPI_ISteamNetworkingUtils_GetRelayNetworkStatus");
#undef SB
    if (!fMsgs || !fUtils || !fUser || !S.send || !S.recv || !S.close || !S.session || !S.release || !S.setId ||
        !S.steamId || !S.setGlobalI32 || !S.getConfig || !S.cfgInfo || !S.initRelay || !S.relayStatus) {
        S.bound = -1;
        Log(L"link: steam_api64.dll lacks a function RVNG needs (Steamworks 1.57 flat API); no link");
        return 0;
    }
    S.msgs = fMsgs(); S.utils = fUtils(); S.user = fUser();
    if (!S.msgs || !S.utils || !S.user) { Log(L"link: Steam's interfaces are not available yet (Steam not started?)"); return 0; }
    S.bound = 1;
    /* relay-only: ICE off for the whole process, after checking the setting's number by its name */
    int type = 0, scope = 0;
    const char* nm = S.cfgInfo(S.utils, ST_CFG_ICE_ENABLE, &type, &scope);
    static const char kIce[] = "P2P_Transport_ICE_Enable";
    int named = nm && Readable(nm, sizeof(kIce)) && memcmp(nm, kIce, sizeof(kIce)) == 0;
    if (named) S.iceSet = S.setGlobalI32(S.utils, ST_CFG_ICE_ENABLE, 0) ? 1 : -1;
    else S.iceSet = -2;
    int32_t v = -99; size_t cb = sizeof(v); int dt = 0;
    int r = S.getConfig(S.utils, ST_CFG_ICE_ENABLE, ST_SCOPE_GLOBAL, 0, &dt, &v, &cb);
    S.iceRead = (r == 1 || r == 2) ? v : -99;
    Log(L"link: Steam networking found (ISteamNetworkingMessages v002); relay-only %s (P2P_Transport_ICE_Enable reads %d)",
        S.iceSet == 1 && S.iceRead == 0 ? L"ON" : named ? L"NOT confirmed" : L"NOT set: the setting's number has another name",
        S.iceRead);
    return 1;
}

/* Valve's relay network: asked for once (it pings the relays), then its status (100 = current) */
static int SteamRelay(void)
{
    if (!SteamBind()) return -1000;
    if (!S.relayAsked) { S.relayAsked = 1; S.initRelay(S.utils); }
    return S.relayStatus(S.utils, NULL);
}

static uint64_t SteamSelf(void) { return SteamBind() ? S.steamId(S.user) : 0; }

static int StSend(void* ctx, int channel, const void* p, uint32_t n, int reliable)
{
    (void)ctx;
    int flags = (reliable ? ST_SEND_RELIABLE : ST_SEND_NONAGLE) | ST_SEND_RESTART;
    int r = S.send(S.msgs, S.peerId, p, n, flags, channel);
    S.lastSendResult = r;
    return r == 1;                                   /* k_EResultOK */
}
static int StRecv(void* ctx, int channel, uint8_t* buf, int cap, uint64_t* from)
{
    (void)ctx;
    void* m = NULL;
    if (S.recv(S.msgs, channel, &m, 1) != 1 || !m) return 0;
    uint8_t* mb = (uint8_t*)m;
    const uint8_t* data = *(const uint8_t**)(mb + ST_MSG_DATA);
    int n = *(const int*)(mb + ST_MSG_SIZE);
    int32_t idType = *(const int32_t*)(mb + ST_MSG_PEER);
    *from = idType == ST_ID_STEAMID ? *(const uint64_t*)(mb + ST_MSG_PEER + 8) : 0;
    int ok = n > 0 && n <= cap && data;
    if (ok) memcpy(buf, data, (size_t)n);
    S.release(m);
    return ok ? n : -1;                              /* (-1: empty or too long for RVNG, dropped) */
}
static uint64_t StNow(void* ctx)
{
    (void)ctx;
    static int64_t freq;
    int64_t c = 0;
    if (!freq) QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&c);
    return (uint64_t)((c / freq) * 1000000 + (c % freq) * 1000000 / freq);
}

/* ---- the game's link: one at a time, its thread ------------------------------------------------------------------- */
static Link g_link;
static volatile int32_t g_linkLock, g_linkThread, g_linkRelay = -1000, g_linkLogged;

static void LinkLock(void) { while (__sync_lock_test_and_set(&g_linkLock, 1)) Sleep(0); }
static void LinkUnlock(void) { __sync_lock_release(&g_linkLock); }

static DWORD WINAPI LinkThread(void* arg)
{
    (void)arg;
    int32_t lastState = -1;
    for (;;) {
        LinkLock();
        if (g_link.state == LS_WAITING || g_link.state == LS_UP) LinkTick(&g_link);
        int32_t st = g_link.state;
        LinkUnlock();
        if (st != lastState) {
            static const wchar_t* const kSt[] = { L"off", L"waiting for the peer", L"UP", L"LOST", L"closed" };
            Log(L"link: %s (player %d; clock offset %d ms, round trip %d ms; reason %d)", kSt[st], g_link.player,
                (int32_t)(g_link.offsetUs / 1000), (int32_t)(g_link.rttUs / 1000), g_link.reason);
            lastState = st;
        }
        Sleep(st == LS_WAITING || st == LS_UP ? 5 : 50);
    }
    return 0;
}

/* start the link to peer (SteamID64) as player 1 (host) or 2 (guest); the tag names the match. 1 = started */
static int LinkStartSteam(uint64_t peer, int player, uint32_t tag, const char* name)
{
    if (!peer || (player != 1 && player != 2) || !SteamBind()) return 0;
    uint64_t self = S.steamId(S.user);
    if (!self || self == peer) { Log(L"link: the peer is this PC's own Steam account; no link"); return 0; }
    if (!S.relayAsked) SteamRelay();
    LinkLock();
    if (g_link.state == LS_WAITING || g_link.state == LS_UP) LinkEnd(&g_link, LB_STOPPED);
    memset(S.peerId, 0, sizeof(S.peerId));
    S.setId(S.peerId, peer);
    g_link.io.send = StSend; g_link.io.recv = StRecv; g_link.io.now = StNow; g_link.io.ctx = NULL;
    uint32_t ver = 0;
    for (const char* v = RT_VERSION_A; *v; ++v) ver = ver * 31u + (uint8_t)*v;
    LinkBegin(&g_link, self, peer, player, tag, ver, 0, name);
    LinkUnlock();
    if (!__sync_lock_test_and_set(&g_linkThread, 1)) {
        HANDLE th = CreateThread(NULL, 0, LinkThread, NULL, 0, NULL);
        if (th) CloseHandle(th); else Log(L"link: could not start its thread");
    }
    Log(L"link: started as player %d (%s), relay status %d", player, player == 1 ? L"host" : L"guest", SteamRelay());
    return 1;
}

static void LinkStopSteam(int reason)
{
    LinkLock();
    LinkEnd(&g_link, reason);
    LinkUnlock();
    if (S.bound > 0 && S.peerId[0]) S.close(S.msgs, S.peerId);
}

#endif /* RVNG_LINK_H */
