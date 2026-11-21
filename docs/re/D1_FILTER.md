# D1 filter: what RVNG relays between the two PCs

Static analysis of the 2026-11-02 exe (2026-11-19). It works out the D1 filter for an RVNG 1v1 deathmatch:
- what RVNG's Send replacement relays to the peer;
- what the receive side injects through the game's router;
- what it drops.

The host PC also plays the server's referee role (DEATHMATCH_NATIVE.md 6.6). Scratch files are in `build/re_scratch/filter/`: `regall.txt` lists every handler registration, `senders_x.txt` the callers of every sender, and `classes.txt` the 165 class names.

Message layout:
- `+0x8` TriggerTime (100 ns); `+0x10` key type; `+0x14` key id; `+0x18` dirty; `+0x19` urgent; `+0x1c` sender, which the router sets.
- The key is `(type << 56) | id`.
- The class name is the metaclass's `+8` std::string; the id is at `+0x48`. The id is not a hash of the name, so D1 matches on names, cached per id.

In the tables, "own" means the key is this PC's plane (`2<<56|me`) and "peer" means the opponent's plane. Unless a row says otherwise, every relayed class is relayed only with an own key, and every injected class is injected only with a peer key.

**In RVNG (runtime 0.2.9):**
- `PolicyOf` / `SendAllowed` / `RecvAllowed` in `native/rvng_rt.c`, with 12 offline checks in `native/tests/rt_test.c`.
- In game (`dm_l3`, 2026-11-19 02:20, 23/23), every class the game sent was classified as the host would:

  | Class | Sent | Decision |
  |---|---|---|
  | Physics | 2,566 | relay |
  | SelectedTarget | 2 | relay |
  | LockedTarget | 5 | relay |
  | GameModeState | 589 | drop |
  | Cheat | 13 | drop |
  | PhaseClear | 1 | drop |
  | MissionClear | 1 | drop |
  | PreparingMissionEnd | 1 | drop |

- The loopback's injected Physics passed the receive rule.
- Still to build with the link: the TriggerTime clock offset, the host's ScoreUpdate, and D3/D4.

## What this changes in DEATHMATCH_NATIVE.md 6.5 / 6.6

1. **Most "game-mode" messages are keyed to the system object (`1<<56|0`), not to the game mode.** This covers GameModeState, PhaseState, GameTime, TimeUp, PauseTime, IGCState, RealTime, EvaluationData/List and ResultState.
   - The system key is the same on both PCs, so a relayed message would land on the receiver's own system object.
   - Only PhaseStart, PhaseClear, MissionClear, MissionEnd, EmergencyMissionClear, TeamScoreAddition, AIActionEventExecute and ExplosiveWeaponHit go to the game mode (`6<<56`); their handlers are in 0x1474a5730.
   - PreparingMissionEnd and MissionRewardUser are keyed to a plane.
2. **"Drop anything stamped with the opponent copy's key" would break damage.**
   - SendDamage 0x1474a9360 stamps the message with the *victim's* key. So the host's results for its hits on the guest carry `2<<56|2`, and the guest's D3 DamageClient carries `2<<56|1`.
   - Damage and DamageClient need per-role rules (below).
   - Copies also emit EscapeInClouds and ElectronicMeasureEffect with their own (the copy's) key.
3. **The guest must never inject DamageClient.** Offline, IsHost 0x1474b38d0 is true on both PCs. The DamageClient handler 0x1474aaae0 would then run AuthoritativeApply on the guest too, applying the damage twice and re-broadcasting it.
4. **Registering the game-mode network object turns on five extra sends** on both PCs: PhaseClear, PhaseStart, MissionClear, MissionEnd and TeamScoreAddition. Their senders check only `GM+0x738`. All their receive handlers are no-ops in this build, so D1 drops them. The PhaseClear and MissionClear sends were seen in game (9.5).
5. **TriggerTime must be moved onto the receiver's clock.**
   - RemoteFire 0x147d617c0 gives a replayed missile a catch-up of (synced now − `msg+0x8`), clamped to 0–3 s (0x14d294ac8 = 3.0).
   - The two PCs' synced clocks are unrelated (each has `c[0x20]` = 0).
   - On receive, add the measured clock offset to `+0x8`. The differences between timestamps stay the same, which the location check needs.
   **The clock (found 2026-11-19, from the Physics fill 0x1474c4380 at 0x1474c43e1):**
   - The synced now is `0x147907660()` + `c[0x18]` − `c[0x8]` + `c[0x20]`, in 100 ns ticks. `0x147907660` is a QueryPerformanceCounter-based tick; `c = 0x147907550()` is a lazily made singleton at the global 0x14e5101b8.
   - `c[0x20]` is the offset the server's RealTime handler 0x1474d00c0 sets online.
   - So RVNG can do what the server does: measure the guest's offset to the host over the link (ping/pong of synced-now values) and write it into the guest's `c[0x20]`.
   - Both PCs then run one synced clock, and TriggerTimes need no per-message shift. RemoteFire's catch-up and the location check then work as they do online.
   - **Confirmed in game** (`dm_l3`, 02:29, 24/24): RVNG's own read of this clock matches every captured Physics TriggerTime to within 25 ms over 283 samples, usually 0 ms. `c[0x20]` is 0 offline.
6. **Never sent offline:**
   - GameTime, PauseTime and IGCState: their wrappers 0x1474b6a60, 0x1474b6ad0 and 0x1474ae770 check `SM+0x1fa`.
   - EvaluationData: its send site 0x1471c96a3 checks `SM+0x1fa`.
   - TimeUp: online, host only.
7. **The `7<<56` key** is ULiveNetworkSimplePlayerResponseObject (made by 0x1472c4270, stored at radio manager `+0x2b0`). It handles SimpleRadio, SimpleRadioAttackInstruction and SimpleRadioReliefRequest.
8. **PreparingMissionEnd: drop it both ways.**
   - Its handler always runs PrepMEndSync 0x1471cb5e0, which sets `+0x80c = 1` during state 14 and makes the receiver send its own PreparingMissionEnd.
   - It force-ends the match when the key id equals the local id, which is 0 offline.
   - RVNG has W1 and its own link-loss path instead.

## Policy

### Flight and physics

| Class | Key | Sent online by | Receiving handler | Send | Recv |
|---|---|---|---|---|---|
| Physics | plane | owner, 80 ms slot | 0x1474aa1c0: location check 0x1474a3f20, copy into N+0x98 (test 4) | relay | inject |
| PhysicsOld | plane | owner, 80 ms slot (not seen offline) | 0x1474a9e70: copy into N+0x88 | relay | inject |
| AirCurrentStates | plane | owner, 80 ms slot (not seen) | 0x1474aa400: copy into N+0xb8 | relay | inject |
| Health | plane | owner, 500 ms slot on change | 0x1474aa800: SetHealth vf+0x918 if > 0 and alive; no role check | relay | inject |
| LandingGear | plane | owner (0x147d61560) | 0x1474c8a90: sets gear, no role check | relay | inject |
| BeginTakeoff | plane | owner (carrier; not in DM) | 0x1474c8c80 | relay | inject |
| EscapeInClouds | plane | owner (0x147f287b3) | 0x1474c7ff0: the copy's +0x1750 counter | relay | inject |
| ObjectAttach | plane | IsHost and N | 0x1474ab1d0: no-op | drop | drop |
| AirCurrentStatesOld, PostStallManeuver, FlightEngineInput, FlightEngineHighGTurn(Old), FlightEnginePhysics | nested in Physics | – | – | drop | drop |

### Weapons and targeting

| Class | Key | Sent online by | Receiving handler | Send | Recv |
|---|---|---|---|---|---|
| SelectedTarget | plane | owner, role 3 | 0x1474c6b30: role-2 copy → 0x1472866b0 | relay | inject |
| SelectedEmlTarget | plane | owner | 0x1474c6e80 | relay | inject |
| LockedTarget | plane | owner, role 3 | 0x1474c6cd0: the victim's lock warning | relay | inject |
| ExplosiveWeaponFire | plane | owner, role 3 (0x147d61216) | 0x1474c7200: RemoteFire 0x147d617c0 (0–3 s catch-up) | relay | inject |
| ExplosiveWeaponHit | **GM 6<<56** | the launcher's PC (0x147f25e10; launcher role 3, GM network object) | 0x1474a73d0: replica by WeaponNetworkId → hit or miss | relay (6<<56) | inject (6<<56) |
| InstantWeaponFire | plane | owner | 0x1474c73f0: weapon checks (a failure goes to ReportCheat → Cheat, dropped), fires on the copy | relay | inject |
| BulletWeaponFire | plane | owner | 0x1474c76c0 | relay | inject |
| ElectronicMeasureFire | plane | owner | 0x1474c79b0 | relay | inject |
| ElectronicMeasureEffect | plane | owner, and copies (no role check) | 0x1474c7df0: faction check, applies 0x147d17650; can hit the receiver's own plane | relay | inject |
| SpecialWeaponArmed | plane | owner | 0x1474c82b0 | relay | inject |
| HoldingMachineGunButton | plane | owner, role 3 | 0x1474c7020: gun replay | relay | inject |
| PushFlare | plane | owner (0x147f46844) | 0x1474c7c80: FireFlares 0x147f504b0 (decoy outcome is decided on the shooter's PC) | relay | inject |
| EscapeByFlare | plane | victim (0x147d50ef5) | 0x1474c8140: the copy's +0x1754/58/5c | relay | inject |
| WeaponData, ElectronicMeasureData | nested | – | – | drop | drop |

### Damage, death and respawn

| Class | Key | Sent online by | Receiving handler | Send | Recv |
|---|---|---|---|---|---|
| Damage | the **victim's** plane | whoever applies it (offline always a result, 0x147d107fb) | 0x1474aa990 → ApplyDamageResult, always. An unroutable one is queued in NM+0x5b8 | host: either plane key. Guest: own key only | host: guest's key only. Guest: own or host's key |
| DamageClient | the victim (host's plane) | online: server. RVNG: D3 on the guest | 0x1474aaae0: IsHost → AuthoritativeApply and re-broadcast | guest: relay (key = host). Host: drop | **host only**, key = host's own plane |
| DestroyedLocation | plane | owner at death (0x147d614dc) | 0x1474c8430: role 2 → SetActorLocation, +0x3c2e = 1 | relay | inject |
| Respawn | plane | owner's RespawnAt (0x147d18cfd) | 0x1474ab4f0: vf+0xbf8, no role check, so an echo respawns twice | relay | inject |
| RespawnTimeEnd | plane | owner | no-op | drop | drop |
| RequestRespawn | plane | server only | 0x1474ab380: RespawnAt(copy), which re-sends Respawn with the copy's key | drop | drop |
| TeleportToRespawnPoint | plane | owner | 0x1474ab830: role 3 → teleports the receiver's **own** plane | drop | drop |
| RequestTeleportToRespawnPoint | plane | server only | 0x1474ab6c0 | drop | drop |
| RespawnRescueTry / RespawnRescueResult | plane | same faction / server | 0x1474c85e0 / 0x1474c8740 (role 3 → ends the receiver's own timer) | drop | drop |
| NoNpcDamage | AI | not in DM | – | drop | drop |

### Score and evaluation

| Class | Key | Sent online by | Receiving handler | Send | Recv |
|---|---|---|---|---|---|
| ScoreAddition | plane | the score function 0x147d111f9 (host offline, once planes have network objects) | 0x1474aba20: AddScore vf+0xc10, no role check (would count twice) | drop | drop |
| ScoreUpdate | plane | online: server. RVNG: built by the host | 0x1474abca0: SetScore vf+0xc18 | the host puts it on the link directly | **guest only** (own or host's key) |
| ScoreData | nested | – | – | drop | drop |
| TeamScoreAddition | GM | 0x1471bf4d2 | 0x1474a70a0: returns when IsHost (always offline) | drop | drop |
| SetObjectInformation | system | server | no-op | drop | drop |
| EvaluationData / List / AccumulateData / UsersList | system | gated on +0x1fa / server / nested | NM+0x90, NM+0xe0 | drop | drop |
| ResultState, ResultEmote | system / ResultObject | the Result screen | NM+0x2b0 | drop | drop |
| MissionRewardUser | plane | server | 0x1474c8f80: rewards + web-API request 0x1479bdc40 | drop | drop |

### Match flow and time

All of these are dropped both ways.

| Class | Key | Sent online by | Receiving handler, and why it is dropped |
|---|---|---|---|
| GameModeState | system | slot, about 2.7 a second offline | 0x1474cefb0: NM+0x210, NM+0x658[sender member id], late counter NM+0x6a8 |
| PhaseState | system | slot, 0x1471dd47d | 0x1474cf250: NM+0x260 |
| GameTime | system | gated on +0x1fa | 0x1474cff60: rewrites Begin/Phase/Finish |
| RealTime | system | server | 0x1474d00c0: sets the clock offset c[0x20] |
| PauseTime | system | gated on +0x1fa | 0x1474d0220: pauses or unpauses the local clock |
| TimeUp | system | online host only | 0x1474d0370: **local time-up** |
| IGCState | system | gated on +0x1fa | 0x1474d0550: the IGC skip table |
| PreparingMissionEnd | the sender's plane | each PC (0x1471cb67c) | see finding 8 |
| PhaseStart, PhaseClear, MissionClear, MissionEnd, EmergencyMissionClear | GM | the GM network object (finding 4) | no-ops |
| AircraftSelect(Test), AircraftSelectStart, EventHash, LatencyCheck, LatencyResponse | selector / system | room, server, NM tick | – |

### Anti-cheat, admin and other

All of these are dropped both ways.
- **Anti-cheat and admin:** Cheat (handler 0x1474d0d80 → cheat vote 0x1474b8de0), KickPlayer, EasyAntiCheatPeerData (not analysed) and Error (NM 0x1474b9080: error code and session-error path).
- **Since runtime 0.3.5, D8 stops the game making Cheat messages at all** (ReportCheat returns; DEATHMATCH_NATIVE.md 9.9). D1's drop of Cheat stays as a second wall, and Cheat and KickPlayer are still never injected from the peer.
- **Bots and non-messages:** ChangeBot, OperateBot, LogOutput and Base.
- **Radio:** SimpleRadio\* (key 7<<56; the radio plays only when the factions match).
- **Other modes and objects:** all 21 AI\* classes, the boss and PvE classes (AlicornDive, RailgunShot, SystemObjectHelios, Stauros/ALCM lotteries, AceBattleNpc\*, NpcRandomLottery\*, PVPVE\*), Entity\*, TransactionRecord and Guild.
- **Debug and lobby:** game.FLiveDebugMessage\* and lobby.\*.

## The special cases

- **Game mode.** Only ExplosiveWeaponHit is needed. It requires the game-mode network object on both PCs, which RVNG registers (9.5).
  Never inject:
  - TimeUp: it forces a local time-up.
  - GameTime, PauseTime and RealTime: they change the clock.
  - PreparingMissionEnd.
  - GameModeState, PhaseState, IGCState, ResultState and EvaluationData: they overwrite NM's member tables keyed by member id, which is 0 offline, the local entry. IGCState could also skip the local cutscene.
  - Error: it arms the abort and session-error paths.
- **Damage, guest → host:** DamageClient from D3 (the guest's hits on the host), and Damage keyed to the guest (the guest's own crashes).
- **Damage, host → guest:** Damage for both keys.
- **Open risk (inferred), crash damage on a role-2 copy:** crash damage types 7/8/9 might be applied to a role-2 copy. On the guest, D3 would forward it as DamageClient; on the host, it would author a kill the guest never had. D3 should forward only hits whose attacker is the guest's own plane. Test 7 should check this.
- **Score.** The host's ScoreAddition is dropped. The host sends ScoreUpdate for both plane keys on the link itself.
- **Respawn.** Only DestroyedLocation and Respawn travel.
- **What can make the PCs diverge:**
  - an echo (a plane-keyed message coming back to its owner);
  - the copy-key rule;
  - plane id 0 (the offline default from vf+0xc58);
  - TriggerTime (finding 5);
  - Damage for keys that aren't registered (it queues in NM+0x5b8).

## C-ready summary

```c
/* Match only the top-level class: the metaclass+8 name with the "...message.game.FLiveMessage" prefix removed.
   Everything else is denied by default. */
static const char *SEND_RELAY[] = {   /* only if key == 2<<56|me */
 "Physics","PhysicsOld","AirCurrentStates","Health","LandingGear","BeginTakeoff",
 "EscapeInClouds","EscapeByFlare","SelectedTarget","SelectedEmlTarget","LockedTarget",
 "ExplosiveWeaponFire","InstantWeaponFire","BulletWeaponFire","ElectronicMeasureFire",
 "ElectronicMeasureEffect","SpecialWeaponArmed","HoldingMachineGunButton","PushFlare",
 "DestroyedLocation","Respawn" };
/* Special SEND cases:
   ExplosiveWeaponHit: key == 6<<56.
   Damage: host, any plane key; guest, key == own plane only.
   DamageClient: guest only, key == the host's plane.
   ScoreUpdate: the host builds it and puts it on the link directly. */
static const char *RECV_INJECT[] = { /* the same 21 names */ };   /* only if key == 2<<56|peer */
/* + ExplosiveWeaponHit (key == 6<<56)
   + Damage (key == the peer's plane; on the guest also key == its own plane) */
static const char *HOST_ONLY_RECV[]  = { "DamageClient" };   /* key == the host's own plane */
static const char *GUEST_ONLY_RECV[] = { "ScoreUpdate" };    /* key == own or the host's plane */
/* For every injected message:
   - drop type-2 keys with id 0, and keys not registered in SM+0x2e0;
   - set +0x18/+0x19 to 0;
   - add the peer's clock offset to +0x8;
   - set uid+8 to the peer's player number (never 0). */
```

Borderline calls:
- **Health is relayed**, as online. A Health message sent just before a hit can briefly put the copy's old health back on the host.
- **PhysicsOld, AirCurrentStates and BeginTakeoff are kept.** They weren't seen in a DM, and they are harmless copies of what the game sends anyway.
- **Dropped:**
  - RespawnTimeEnd: its handler is a no-op.
  - TeleportToRespawnPoint: dangerous if it ever names the receiver's own plane.
  - GameModeState: offline the member barriers pass anyway, and RVNG has its own heartbeat.
  - SimpleRadio\*: the radio filters by faction.
- **Never call 0x147490260.** Aircraft selectors use type-2 keys, and the first entry for a key wins, so a selector would take a plane's key.
