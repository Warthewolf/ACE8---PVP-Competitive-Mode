# The native deathmatch, reverse-engineered, and how RVNG reproduces it

**Status:** this is static reverse engineering only. Nothing here has been confirmed in-game yet; section 9 lists the tests.
**Build:** `AceCombat8.exe` of 2026-11-02 (551,201,904 bytes, image base `0x140000000`).

Every address is specific to this build. RVNG's DLL must find each one by signature at load time, never by hard-coding it.

**Sources:** two research passes, each checked by its own verifier.
- `re/deathmatch/first_pass.json` covers modes, authority, flow, seam and targeting.
- `re/deathmatch/deep_pass.json` covers outside contacts, boot and spawn, the state machine, the wire format and the server's role.
- Where a verifier corrected a report, this document uses the correction.

**Hard boundaries.** They apply to everything below.
- A modded client never contacts Bandai's online services: Strix, the Chronicle matchmaker, the Strix Messenger, the LiveWebAPI web services, EOS and EAC.
- Never touch, analyse or work around EasyAntiCheat. Where the game has its own call sites into anti-cheat reporting, they are listed only so RVNG can keep them unreached. D8 (9.9) switches off the game's own cheat reports in ReportCheat and hands type 1, the one the anti-cheat manager makes, to the game untouched.
- RVNG's link is its own P2P link, copied from Survival's co-op networking and built into RVNG's own DLL.
- Private use only.

---

## 1. What the online deathmatch is

**Class chain:** `BP_ChronicleDeathMatchGameMode` → `ALiveDeathMatchGameMode` (vtable `0x14c693718`) → `ALiveSoloPVPGameMode` → `ALiveOnlineGameMode` (vtable `0x14c980e98`) → `ALiveGameMode`.

**Maps:** `PL_DM_001`, `002`, `003`, `004` and `006`. The MissionIDs are 160010, 160020, 160030, 160040 and 160060.

**Rules** come from three data assets:
- `MC_DM` sets VictoryScore 500000 and MissionLimitTime 210 s. The clock reads MissionLimitTime: `vf+0xaa8` copies config `+0x30` into `GM+0x498` (at `0x15bde9633`) and keeps the config pointer in `GM+0x530`. The constructor's 480 s is only a default.
- `WD_DM` defines 8 factions, each with `Start_<F>0` and 5 respawn points.
- `DT_MissionContents`, row DM: BaseRespawnTime 10, ConnectionsLeftNum 1, MissionSuccessSeconds 105.

**Overrides.** The DM class overrides these slots; everything else is ALiveOnlineGameMode's:
- GamePlaying tick `+0xd40`
- OnGameFinish `+0xab8`
- start hook `+0xb28`
- faction assigner `+0xa30`
- MissionConfig CDO fallback `+0xb40`
- `+0xc40`, `+0xc48` and `+0xdd8`

The vtables live in a read-only section and are shared between classes. **Use inline detours, never vtable patches.**

**Score.** The calculator is `0x147d11450`. DM turns on only these score switches:

| Switch | Meaning |
|---|---|
| 2 | player damage |
| 3 | player kill |
| 13 | indirect kill |
| 16 | rank correction |

- Every rate is 1.0, and the 2-player rank correction is 1.0.
- BaseScore runs from 1400 at cost 0 to 4000 at cost 4800.
- A kill from full health pays the killer about 2 × BaseScore(victim's cost).
- VictoryScore is unreachable in practice, so **a match ends at time-up**.

**Score authority.** In DM the server is the only score authority:
- `ALiveOnlineGameMode` clears `NM+0x739` at start (`0x1471c5242`).
- The score function `0x147d10f70` runs only when `!(StrixManager+0x1fa) || (NM+0x739 && IsHost)`.
- So no online DM client scores. Scores arrive only as server-made `ScoreUpdate` messages, which carry absolute `{type, value}` lists applied with `SetScore vf+0xc18`.
- SetScore shows a popup only when a value changes, so re-sending an equal value is harmless.

**Victory check.** `0x1471df5f0` runs on every PC with no host gate. Mirrored scores therefore end the match locally on both PCs.

**Respawn** runs entirely on each pilot's own PC:
- Death (`0x147d56780`) sets the plane's `+0x3c2c` and `+0x3c2e` and sends `DestroyedLocation`.
- The plane tick counts RespawnTime, which is BaseRespawnTime 10 × RespawnRate(cost) × the respawn-time parts values.
- When the timer ends the plane sends a header-only `RespawnTimeEnd`. The receiving handler does nothing.
- The pilot then picks a point in the pause menu. The respawn function `vf+0xbf0` sends `Respawn`, and peers apply it with `vf+0xbf8`.

**Spawn protection.**
- Every respawn sets `+0xdfc` for 5 s, and only DamageType 7 gets through while it is set. Firing clears it.
- The expiry list is at `ALiveOnlineGameMode+0x818`, keyed by the plane's network-object id. **Planes need distinct network ids, or expiry clears the wrong plane** (section 6.4).

**Kill credit.**
- Native `Killed` flag plus the score function.
- A crash credits an indirect kill to the last damager inside `NM+0x740`, which is INDIRECT_KILL_VALID_TIME_SEC, default 30 s, × 1e7.
- `NM+0x740` is set only on the online join path (`0x1474ad130`), so **offline it is probably 0, and RVNG must write it**.

**Factions.**
- The DM assigner `0x1471e0230` runs at the end of TimeSync and hands out Alpha, Bravo and so on.
- An `NM+0x4d0` entry keyed by `plane+0x2200` (the userId) overrides the assignment.
- Offline, the transition tail `0x1474ae080 → 0x1474b5b10` **seeds NM+0x4d0 with the local user as faction 1**. So on each PC the pilot is Alpha and starts at `Start_Alpha0`. Section 6.3 has the fix.

---

## 2. The online match flow (ELiveOnlineGameModeState, `GM+0x758`)

- The online tick is `0x1471c54e0`, SetState is `0x1471c6020` and NextState is `0x1471c6150`.
- NextState also writes the local state into `NM+0x210`, a `TMap<memberId, state>`. Its key is 0 offline.
- Every "wait for the other members" barrier compares `CountAtLeast(NM+0x210, N)` (`0x1474cc700`) with MemberCount (`0x1474b39e0`). MemberCount is the live Strix room list and is 0 offline, so **offline every member barrier passes on its first tick**.

| # | State | What it waits for online | Offline |
|---|---|---|---|
| 1 | WaitingNetworkInitialize | Starts the synced clock and runs the MRMM web request `0x147491990` (gated on `+0x1fa`) | Passes |
| 2 | PostNetworkInitialize | — | Passes. **RVNG fills the room tables here** (6.3). |
| 3 | LoadPlayerPlane | Async load of every member's aircraft class. `GM+0x5f1` is 1 until the load is done. | Passes (Survival's campaign runs prove the clear) |
| 4 | SpawnPlayerPlane | Local spawn `0x1471b66a0`, then the remote loop `0x1471b7430` → `0x1471b84f0` | With the room tables filled, the native code spawns the opponent |
| 5 | TimeSync | Member barrier. Then the DM faction assigner. | Passes |
| 6–7 | SpawnAIs / WaitingSpawnedAIs | Member barrier | Passes |
| 8 | TeleportPlayers | Places each plane at its faction start | Passes |
| 9–11 | IGC opening | Member barriers and the skip barrier | Passes. The skip barrier compares with `max(count,1)`. |
| 12 | **SyncStartMatch** | **Room property `phaseIndex` ≥ 1 (gate `0x1471c1050`)**, which only the server sets | **Stalls. RVNG detour D2 makes this the synchronized start.** |
| 13 | CallStartMatch | Builds ScoreRankList, then StartMatch | Passes |
| 14 | GamePlaying | Clock runs. It is unpaused in the base hook `0x1471ba2a0` at `0x1471ba748`. | Time-up is local on each PC |
| 15 | **GameTerminating** | **`GM+0x80c` ≥ 2**, written by the callback chain of server message `MissionRewardUser` | **Stalls. RVNG writes 2** (W1) |
| 16–17 | IGC ending | Member barrier with a 30 s timeout | Passes |
| 18 | SyncEvaluation | Member barrier. Then it copies `NM+0xe0` (EvaluationList) into UserData. | Passes |
| 19 | Ended | If `+0x804==1`, AbortPath `0x1471c5f70`. Otherwise `+0xb18` `0x1471c5d20` travels to the Result map. | **AbortPath goes to level 99995 = OnlineLobby, so RVNG must redirect it** (D6) |

**End of the match:**
- Time-up (`+0x538 = 2`) or VictoryScore (`= 3`) calls OnGameFinish.
- OnGameFinish starts a 3 s `ULiveOnlineMissionEndSequence` and then enters GameTerminating.
- That sequence ticks only in state 14 and only while the game is not paused.

**Forced end.** The server sends `PreparingMissionEnd` addressed to the receiving PC's own member id. The handler `RecvPreparingMissionEnd vf+0xdd0` (`0x1471cb7e0`) then:
- sets `+0x804` to 2 (Finished) if CoopResult or MatchResult is set, otherwise to 1 (Aborted);
- sets `+0x538` to 4;
- calls OnGameFinish.

It only leaves state 14. A Finished forced end still needs `+0x80c = 2`.

**Stale-error hazard.** If `NM+0x538` holds a non-zero error code from an earlier online error in the same process, SyncStartMatch's tick arms an abort timer offline. RVNG zeroes `NM+0x538` before an RVNG match.

**Clock.**
- The synced "now" is `0x147907660() + c[0x18] − c[0x8] + c[0x20]`, where `c = 0x147907550()`, in 100 ns ticks.
- Each PC has exactly `GM+0x498` seconds left at its own unpause, so **releasing gate 12 on both PCs at the same moment synchronizes the match clocks**. Nothing has to be mirrored.
- To change the length, write `+0x498` after `0x1471b5920` returns (a post-hook on slot `+0x390`) and before `0x1471b5160` runs. A write any earlier is overwritten.
- `0x1474b3930` resets `c[0x20]`. Re-apply any offset after a reset.

---

## 3. What Bandai's server does in a deathmatch

These are worked out from what the client's handlers expect back; the server's code is not in the exe.

1. **Damage routing ("room owner").**
   - Every client, the owner included, only *reports* hits: TakeDamage `0x147d1037d` sends a report through BroadcastDamage, with return address `0x147d103c3`.
   - The server routes a `DamageClient` to the room owner. The owner runs AuthoritativeApply `0x147d104a0`.
   - The owner broadcasts the *result* `Damage` (BroadcastDamage, return address `0x147d107fb`). Everyone applies it with ApplyDamageResult `0x147d1b070`.
   - A plain `Damage` is always applied, so results must never echo back to their sender.
   - Bandai's exact pairing logic is stateful and can't be recovered from the client.
2. **Score.** It is the only score authority and sends absolute `ScoreUpdate` (section 1).
3. **Start.** It sets the room property `phaseIndex`, which releases SyncStartMatch.
4. **Clock.** `RealTime` sets the synced-clock offset (`c[0x20]`) through handler `0x1474d00c0`.
5. **End of match.**
   - `MissionRewardUser` roots the only callback chain that writes `GM+0x80c = 2`.
   - On a disconnect it sends `PreparingMissionEnd` to each remaining member, with Finished if at least 105 s were played and Aborted otherwise.
   - The rule's numbers are client data; who evaluates them is inferred to be the server.
6. **Relay.** It relays everything else, which the clients build themselves: Physics, Health, weapon fire, locks, flares, Respawn, DestroyedLocation, GameTime, EvaluationData, ResultState and so on.

**RVNG never synthesizes these server messages:** `MissionRewardUser`, `EvaluationList`, `EventHash`, `RealTime` and `ResultState`. MissionRewardUser in particular starts the UserData and web-API async chain.

---

## 4. The message layer (Strix FLiveMessage)

**Objects.** Messages are Strix C++ objects held in MSVC `std::shared_ptr` `{obj, ctl}`. The control block keeps the strong count at `+8` and the weak count at `+0xC`.

**Header:**

| Offset | Field |
|---|---|
| `+0x8` | TriggerTime: synced-clock ticks |
| `+0x10` | NetworkTypeId (u8) |
| `+0x14` | NetworkId (u32) |
| `+0x18` | dirty flag (not serialized) |
| `+0x19` | urgent flag (not serialized) |
| `+0x1c` | sender (not serialized; written by the router) |
| `+0x20` | payload starts |

**Network object N.**
- A UObject whose Outer is the plane, the NetworkManager or the GameMode.
- Its key `N+0x28` is `(ELiveNetworkType << 56) | id`. Types: 1 System, 2 Player, 6 GameMode.
- Registering it (slot 87, `0x1474a1b90`) adds it to `StrixManager+0x2e0`. Registration has no online check, and the first entry for a key wins.
- The system object (key `1<<56`) exists offline from GI init.
- Plane and GameMode objects are created only online, but RVNG can create them (6.4).

**Send `0x1474a2190(unused, shared_ptr byValue)`.**
- It reaches Strix only through the client global `0x14e4c5818`. It drops the message when that global is null, which it always is offline.
- When an allocation fails, callers pass a bogus `{ptr=0x10, ctl=null}`.

**Stamp `0x1474a1c90`** writes the header from `N`.

**Router `0x1474ef630(SM, &sender, &msg)`.**
- It borrows both pointers and sets `msg+0x1c` from `*(u32*)(sender+8)`.
- It looks the target up by key and dispatches by class id. A key that is registered but stale drops the message silently.

**Serializer.** The game's own MessagePack serializer is used for wire bytes:
- Encode: `MemoryStream` (`0x14a402db0`), then `MessagePackEncoder` (`0x14a403250`), then `0x14a3b13f0`.
- Decode: `MessagePackDecoder` (`0x14a404570`), then `0x1453bb4d0`, which returns a `shared_ptr`.
- Class ids are SuperFastHash(class name), so they match on both PCs.
- The full recipe is in `deep_pass.json` (area `wire`).

**Pump.**
- The GI ticker runs `0x1478cccd0 → 0x1474efd50 → 0x1474a2770 → 0x14748d530` every frame, with no online test.
- It sends a state slot when it is dirty or urgent and its interval has passed. Own-plane Physics is dirtied every tick, so **once the own plane's N is registered, Physics leaves at about 12.5 Hz with no RVNG timer**.
- Slot sets: a player plane gets PhysicsOld, Physics and AirCurrentStates at 80 ms, plus Health at 500 ms. Any other object gets the AI set at 160 ms, plus Health.
- Offline, GameModeState is never filled.

**Plane event senders** (lock, fire, flare, gear and others) fire when:
- `plane+0xed0` is a `ULiveNetworkPlayerPlane`, and
- the role is 3.

Exception: the ElectronicMeasureEffect wrapper has no role check, so a role-2 copy can emit it.

---

## 5. Outside contacts and the game's own cheat call sites

**StrixManager flags (GI+0x910).**
- `+0x1fa` (in room) is set only by three Strix SDK success callbacks.
- `+0x1f9` (room-server connection) is set by a fourth callback. With no Strix client, `+0x1f9 = 1` causes an immediate "Disconnected from the room server" kick.
- `+0x1f8` (master server) is set by a fifth callback.
- **All three stay 0 for RVNG.**

**Other outside channels.** All stay unreached:
- Chronicle matchmaker (GI+0x918)
- Strix Messenger (GI+0x920)
- LiveWebAPI (GI+0x970) and the UserData API controllers. Their two gates are `0x147926ce0` and `0x147959480`.
- EOS. `ULiveNetworkP2P` (GI+0x930) is an EOS P2P party-invite transport, socket `INVITE_PAETY`. **It is not a gameplay channel. Don't reuse it.**
- **Since runtime 0.3.6, D9 (9.10) refuses at every send point** in every install: the LiveWebAPI queue's Start, Cosmos's sender, the engine's HTTP request start, the WebSocket connect, and the game's Strix and Messenger set-up. All 11 gates answer false. Measured: the only outside contact in a session is the EOS SDK's own connection to `api.epicgames.dev`.

**The game's own cheat checks:**
- Location, damage, weapon id, ammo, cooldown and combat zone all report into ReportCheat `0x1474b8bb0`.
- ReportCheat builds a `FLiveMessageCheat` and passes it to Send **even offline**. The stock Send drops it at the null client. **RVNG's Send replacement must drop it too, and must never forward it.**
- Offline, the vote record `NetworkCheatManager+0x88` is not written, because its path is gated on `+0x1fa`/`NM+0x4c9`. So the match-end cheat-report web call has nothing to send. Its web gate is false anyway.
- The KickPlayer send is gated on `+0x1fa`.
- **Since runtime 0.3.5, D8 makes ReportCheat do nothing** (every install; 9.9). No Cheat message, vote or record is made; D1's drop and the false web gate stay as further walls.
- On receive, RVNG also filters `Cheat`, `KickPlayer` and `EasyAntiCheatPeerData`, so a peer can never route one into the local game.

**Checks that can fire on RVNG traffic:**
- **Teleport check.** A respawn or teleport position jump on a copy trips the Physics location check `0x1474a3f20` (type 3). The resulting Cheat message is dropped at Send. A copy's `plane+0x8b1 = 1` skips one check; the game's own setter for it is unknown.
- **Combat zone.** The check `0x147d5af30` may be armed in DM, depending on `GM+0x520`. If armed, it reports type 9 after 5 s outside, cumulative. That report is also dropped at Send.

---

## 6. RVNG design: both PCs stay offline, and RVNG plays the server

### 6.1 Model

**Chosen: offline flags, native message layer.**
- Both PCs keep `StrixManager+0x1fa/+0x1f9/+0x1f8 = 0`.
- RVNG gives the planes and the game mode the network objects they would have online.
- RVNG replaces Send with its own P2P transport and injects received messages through the game's own router.

The result is that **the game's own message builders, state slots, pump, router and handlers all run**, which is the online deathmatch's own data path. The RVNG host plays the four server roles from section 3.

**Rejected: a local Strix stand-in (`+0x1fa = 1`).** It arms at least 12 online-only behaviours that would each need a detour:
- timeouts
- member queries
- the MRMM web request
- KickPlayer sends
- the room-member cheat record

None of these behaviours gives the game anything it lacks offline.

**Native vs RVNG**

| Concern | Native (unchanged game code) | RVNG supplies |
|---|---|---|
| Mode, rules, HUD, radio, maps | DM game mode by MissionID | MissionID + travel |
| Opponent plane | native remote spawn `0x1471b84f0`, a role-2 copy with a dummy controller | room-table entries from the P2P "hello" |
| Flight, weapons, locks, flares | own-plane builders + pump + copy handlers | transport (Send replacement + router inject) |
| Damage | AuthoritativeApply / ApplyDamageResult / DamageClient handler on the host | guest-side detour D3 (routes the guest's hits to the host) |
| Score | score function on the host, SetScore on the guest | guest detour D4 + host sends ScoreUpdate |
| Respawn, protection | timers, picker, Respawn / DestroyedLocation messages | distinct network ids |
| Start | SyncStartMatch | phaseIndex gate D2 = synchronized "go" |
| Clock | local FinishTime per PC | the simultaneous release (optionally an offset) |
| End | time-up, MissionEndSequence, IGC, evaluation | `GM+0x80c = 2` (W1), exit redirect D6 |
| Link loss | `RecvPreparingMissionEnd` | heartbeat timeout → `vf+0xdd0` |

### 6.2 Invariants while RVNG mode is on (checked every tick)

1. `*(0x14e4c5818) == 0`, `StrixManager+0x1f8/+0x1f9/+0x1fa == 0` and `ULiveNetworkP2P+0x28 == 0`. If any is non-zero, abort to the main menu.
2. The LiveWebAPI gates `0x147926ce0` and `0x147959480` return false (detour D5, a local stub).
3. `NM+0x610` and `NM+0x614` stay 0, because these two timers have no `+0x1fa` test. Log any arming.
4. Never call Strix init (`0x1474ec7e0`, `0x1452390d0`, the InitializeStrixNetwork thunks), EOS P2P or the OnlineLobby travel `0x147ec9fc0`.
5. At OnGameFinish, assert `NetworkCheatManager+0x88` is empty.

### 6.3 Before the match: travel and room tables

1. **Lobby.** RVNG's P2P "hello" exchanges each player's:
   - userId (`*(UDM+0xfd0)+0`), gamer tag and player number (host 1, guest 2);
   - the full airset: aircraft id, weapons, parts, skin, specials, emblems, level and cost fields;
   - the mod-scan result.
2. **Travel.**
   - Zero `NM+0x538`, then write `UDM+0xf38` = the DM MissionID.
   - If the game's transition `0x147570da0` is used, `UDM+0xf3c` must not be a campaign level (19..49). Otherwise transition type 9 goes to the campaign route.
   - Or call RequestChangeMap `0x147901bf0(GI+0x888, &row+0x48, emptyOptions)` directly, then `0x1474ae080` yourself.
3. **In the DM world at the state 2 → 3 transition** (a NextState pre-hook), never before travel:
   - Fill the room tables:
     - `NM+0x3d8 = 2` and `NM+0x410` through `0x1474b2310(NM, &localConfirmedResult)`;
     - the MRMM selectors through the reset steps of `0x14748e610`, then `0x147490bc0`/`0x147491460`.
   - Write **both** selectors' `+0x2c` netId (1 and 2).
   - Write the opponent selector's airset fields (`+0x78` … `+0x108`). Use the game's TArray copy, never raw pointers.
   - The local member's userId must equal `*(UDM+0xfd0)+0`, so the remote loop skips the local slot.
4. **Factions.** On both PCs, overwrite `NM+0x4d0`: host userId → 1 (Alpha), guest userId → 2 (Bravo), with matching callsigns. The native assigner then places the host at `Start_Alpha0` and the guest at `Start_Bravo0` on both PCs.
5. **Indirect kills.** If `NM+0x740 == 0`, write 300,000,000 (30 s).

### 6.4 Identity: network objects offline

Both PCs use the same numbers: host plane `2<<56 | 1`, guest plane `2<<56 | 2`, game mode `6<<56`.

- **Own plane** (after the native local spawn):
  1. Call `vf+0xc60`.
  2. Set `N+0x28 = 2<<56 | myNum` and `+0x53b8 = myNum`.
  3. Set role `+0xed8 = 3`.
  4. Call `vf+0xc68` exactly once.

  Role 3 is required: CanBeDamagedBy only lets a role-3 attacker damage a role-2 copy.
- **Opponent copy.** The native remote spawn already sets role 2, `N+0x28` and `+0x53b8` from the selector netId.
- **Game mode:** `vf+0xc48`, then `+0x738→+0x28 = 6<<56`, then `vf+0xc50`. This enables ExplosiveWeaponHit and the game-mode handlers.
- **Don't re-create the system object.** It exists already and has the same key on both PCs.
- **Unregister** destroyed objects (`0x1474a1ab0`). A stale key blackholes all traffic for its id.

### 6.5 Transport

> **Updated 2026-11-19:** the per-class policy, with handler evidence, is in `D1_FILTER.md`. It supersedes the drop list below in four places:
> - most "game-mode" messages are keyed to the *system* object;
> - Damage is stamped with the victim's key, so the copy-key rule must not apply to it;
> - the guest must never inject DamageClient;
> - PreparingMissionEnd is dropped both ways.
>
> The receive side must also move TriggerTime onto the receiver's clock.

**Detour D1: replace Send `0x1474a2190`.** Do not chain to the original. In the replacement:
1. Return at once on the bogus `{0x10, null}` form.
2. Classify the message by IsA or vtable.
3. **Drop** these types:
   - Cheat, KickPlayer, EasyAntiCheatPeerData, LatencyCheck and Error;
   - ScoreAddition (the host turns score changes into ScoreUpdate instead; 6.6);
   - Avatar\*, PlayerStatusUpdate, Guild\* and Centurion\*;
   - anything stamped with the opponent copy's key.
4. Serialize everything else with the game's serializer and queue the bytes on RVNG's link.
5. Release the by-value reference exactly as the original does at `0x1474a22b1`.

**Receive.** On the game thread:
1. Deserialize.
2. Filter the same block list, plus every server-only type the peer has no business sending. The exception is the host's ScoreUpdate.
3. Inject with `Router(GI+0x910, {&uid, null}, &sp)`. Set `uid+8` to the **peer's non-zero player number**, because offline the local member id is 0.
4. Keep `+0x18/+0x19` at 0.
5. Don't restamp `+0x8`: the location check divides by TriggerTime deltas.

### 6.6 The host's server role

**Damage (host-authoritative, as online).**
- **Detour D3, guest only.** In AuthoritativeApply `0x147d104a0`, when the victim is the host's copy (role 2) and the caller is TakeDamage's local branch:
  - don't apply the damage;
  - build a `DamageClient` (factory-only: metaclass Create, then fill `+0x20..+0x31`) and send it.
- **On the host** this needs no RVNG damage code. The native DamageClient handler `0x1474aaae0` sees IsHost and runs AuthoritativeApply on the host's own plane, with the guest copy as attacker. The native result broadcast then sends `Damage` back. The guest applies it to the host copy with ApplyDamageResult.
- Host hits on the guest copy, and either pilot's crash, go through the native offline path: apply, then broadcast the result.

**Score.**
- **Detour D4, guest only.** The score function `0x147d10f70` returns at once, which is the online non-host gate.
- **The host runs the score function natively.** A post-hook on the host's score function reads the scorer's map at `+0xe08`; its elements are `{u8 type, float}`. It then sends a `ScoreUpdate` with the absolute `{u8 type; pad[3]; i32 value}` list to that plane's key. The guest's native ScoreUpdate handler applies it with `vf+0xc18`.

**Start: detour D2, the phaseIndex gate `0x1471c1050`.**
- Return false until both PCs report state 12.
- The host then sends "go at synced time T". Both return true at T.
- CallStartMatch and GamePlaying then unpause both clocks together.

**End of match.**
- Time-up runs locally on each PC.
- **W1:** when SetState enters 15, write `GM+0x80c = 2`. This replaces the MissionRewardUser chain.
- **Detour D6:** redirect AbortPath (`0x1471c5f70`/`0x147ec9fc0`, which leads to OnlineLobby) to RVNG's main-menu travel.
- If the Result map stalls without EvaluationList or reward data, also redirect `+0xb18` `0x1471c5d20` to RVNG's own result screen.

**Link loss (heartbeat timeout).**
- **In state 14:** call `vf+0xdd0(gm, 0, false, elapsed ≥ 105 s)`, which is exactly a server-made PreparingMissionEnd. If that gives Finished, also apply W1 when state 15 starts.
- **Before state 14:** the forced end can't leave states 1–13, so use RVNG's own exit to the menu.

**Never inject with sender id 0.** Offline the local member id is 0, and a `PreparingMissionEnd` addressed to the local id force-ends the match. With the peer's non-zero number in `uid+8` (6.5), the native `PreparingMissionEnd` each PC sends at match end is harmless to relay: on the peer it only starts stage 1, if that hasn't started yet.

### 6.7 After the match

- Set `NM+0x3d8 = 0`.
- Clear `NM+0x410`, the `MRMM+0x40` selectors and their objects, and the `NM+0x4d0` entries.
- Unregister the RVNG network objects.

Leftovers would leak into later campaign and Survival sorties, which run the same remote loop.

### 6.8 Change list

| ID | Kind | Where | Machine |
|---|---|---|---|
| D1 | replace | Send `0x1474a2190` | both |
| D2 | detour | phaseIndex gate `0x1471c1050` | both |
| D3 | detour | AuthoritativeApply `0x147d104a0` (guest's hits on the host copy) | guest |
| D4 | detour | score function `0x147d10f70` → return | guest |
| D5 | detour | web gates `0x147926ce0`, `0x147959480` → false | both |
| D6 | detour | AbortPath / OnlineLobby travel (+ optional Result travel) → RVNG menu | both |
| D8 | detour | ReportCheat `0x1474b8bb0` → return (type 1 passed to the game untouched) | both |
| L | link | `native/link.h`: Steam ISteamNetworkingMessages relay-only; the wire (`wire=1/2`) carries D1's messages, D3's DamageClients and the host's ScoreUpdates; D2 opens at the link's GO; a lost link is the forced end; the guest's `c[0x20]` set to the host's clock; LAUNCH for the ready-up screen (9.11, 9.12) | both |
| D9 | detour | LiveWebAPI Start `0x148088980` → 4; Cosmos sender `0x145449cc0` → 0; curl ProcessRequest `0x141ef0c50` → URL emptied (the engine's failure path); lws connect `0x14a38cba0` → NULL; Strix start `0x1474ec7e0` and Messenger set-up `0x1474f0200` → return; 9 more web gates → false | both |
| W1 | write | `GM+0x80c = 2` on entering state 15 | both |
| H | observe | SetState/NextState (table fill, W1, cleanup); the host's score post-hook; BroadcastDamage (log) | both |
| C | calls | `0x1474b2310`, MRMM selector build, `NM+0x4d0` entries, `vf+0xc60/0xc68`, GM `vf+0xc48/0xc50`, serializer, router, `vf+0xdd0`, metaclass Create | both |

D8 (runtime 0.3.5) switches `ReportCheat` off at the source; D1 still drops any Cheat message as a second wall. D9 (runtime 0.3.6) is the network wall under D5: every place the game's code sends to Bandai's services refuses (9.10, ONLINE_UI.md 5).

---

## 7. Corrections to earlier notes

- `NM+0x538` is the last FLiveMessageError code (6, 7, 10 or 11), **not a member count**.
- `GM+0x498` = MissionLimitTime (proven at `0x15bde9633`). It is not left at 480 s.
- The state-slot pump **does** run offline, so RVNG doesn't need its own Physics timer.
- Offline, `0x1474ae080` **seeds** `NM+0x4d0` with the local user as Alpha. Giving the local plane a network object does not fix factions; overwriting `NM+0x4d0` does.
- AbortPath's destination is level 99995 (OnlineLobby).
- `MissionRewardUser` is the only native route to stage 2, which is why RVNG writes `+0x80c` itself instead.
- The combat-zone threshold is 5 s, not 30 s, and whether the check is armed in DM depends on `GM+0x520`.
- `GAME_INTEGRATION.md` and `mod/ProjectRVNG/Scripts/main.lua` use placeholder `/Script/TODO.*` hooks that don't exist in the game. Their crash-kill crediting differs from the native rule in section 1.
  - UE4SS Lua can't reach this machinery anyway, because none of it is reflected.
  - The match logic belongs in RVNG's native DLL; Lua keeps only UI glue.
- From the online-screens audit (2026-11-19, `ONLINE_UI.md`):
  - `0x1474af800` **starts** matchmaking; it is not CancelMatch. The cancel is `0x1474b1180`.
  - `UDM+0x12a0` is PenaltyAPIController; the LiveWebAPI is `GI+0x970`.
  - GM EndPlay's LeaveRoom runs offline, and its Strix calls return at the null client.
  - The Result screen's own exit travels to the OnlineLobby, which D6 does not redirect yet.
  - D5 covers 2 of at least 11 web gates (`ONLINE_UI.md` section 5).

---

## 8. Main menu, mods and the rest of the plan (unchanged decisions)

- A real main-menu row, Survival's approach: a row added to `DT_LiveMenuMainTopCommands`, with the press caught by RVNG's DLL.

  **Done, runtime 0.2.8 (2026-11-19):** COMPETITIVE 1V1 sits where ACE COMBAT ONLINE was.
  - **The row.** `Scripts/rvng_menu.lua` rewrites the ONLINE row in place: CommandID `Main_Top_RVNG1v1`, TitleTextID `RVNG_Menu_Title`, HelpTextID `RVNG_Menu_Help`, StringArgs `RVNG_1v1`. STORE is taken off.
  - **The texts.** The DLL hooks the game's text lookup 0x14739dfc0 (prologue "3,4,4,4") and answers only RVNG_ keys. If another mod (Survival) hooked it first, RVNG chains on top of that jump ("14,1").
  - **The press.** The DLL swaps the main menu widget's decide slot 0xEE. Its vtable is found by base 0x147a79a30 at slot 0xDF and decide 0x147b3fa10, or behind another mod's handler.
    - A press on `RVNG_1v1` is taken.
    - Every other press goes down the chain.
    - Lua sees the count rise and calls `requestQueue` (as F8) on the game thread.
  - **Without both hooks** the ONLINE row is taken off, as before.
  - **In game** (`menu`, 7/7): the row shows with RVNG's label (5 text lookups answered).
  - **Not yet confirmed:** the press. Keys posted to an unfocused window never reach the menu ("presses passed on 0"), and the job deliberately takes no focus, so the press needs one check by hand.
- A real `ALivePlayerPlane` opponent. Section 6 delivers this through the native remote spawn.
- Ranked play allows only UE4SS, RVNG and admin-approved cosmetic mods.
- No LandWalkSim code or design, and no AC8ModSettings code.

---

## 9. In-game test plan (in order; offline, network unplugged where noted)

Tests 1 and 2 run with RVNG's native test logger (`native/rvng_rt.c`). `docs/IN_GAME_TESTS.md` says how to install it and run them.

1. **Flag watch.** Once a second through boot, the menu, a Survival sortie and the result screen, log:
   - `*(0x14e4c5818)`, `SM+0x1f8/0x1f9/0x1fa/+0x30`
   - `ULiveNetworkP2P+0x28`, `GI+0x970`, `UDM+0x12a0/+0xfb0`
   - the two web gates' return values. Run the gates in block mode.

   Expect every value to be zero or false.
2. **Solo DM travel.** Do this on one PC with the network unplugged.
   - Set MissionID 160010 and travel.
   - Log `+0x758`, `+0x5f1`, `+0x498`, `+0x80c`, `+0x804` and `+0x521`.
   - Expect a stall at 12. With D2, expect a stall at 15. With W1, expect 16 → 19 and the Result map. Note what the Result map does.
3. **Native opponent spawn on one PC.**
   - Fill the room tables at 2 → 3 with a fake second member.
   - Confirm that `0x1471b84f0` runs once, the copy shows its skin, emblems, tag and ObjName, and `NM+0x3d8` doesn't stall anything.
4. **Network objects and the serializer on one PC.**
   - Register the own plane, then dump `SM+0x2e0`.
   - Count pump sends over 10 s: expect about 125 Physics.
   - Serialize, deserialize and compare ToString.
   - Run a router loopback onto a copy.
5. **Role-3 audit.** Look for gameplay differences between an offline plane with role 1 and with role 3.
6. **Factions.** Check `+0x3b2`, the callsigns and the start positions after writing `NM+0x4d0`.
7. **Damage, score and respawn on loopback.**
   - Check BroadcastDamage return addresses, SetScore on the copy and the respawn timer.
   - Check spawn-protection expiry with distinct ids.
   - Read `NM+0x740`.
8. **Two-PC test.**
   - Measure the gate-release skew and the time-up skew.
   - Check damage round trips, score parity and respawn relays.
   - Pull the link at 60 s and at 150 s and check the end that follows.

### 9.1 Results (in-game, unattended through `tools/autotest`)

**Test 1, the flag watch: PASS.** Run of 2026-11-18 18:19, runtime 0.2.0, with only SkipIntro beside RVNG.
- All 10 signatures were found and all 7 hooks installed.
- **Every "stay offline" value was 0 in all 93 samples, from boot through 90 s at the main menu:**
  - the Strix client global `0x14e4c5818`;
  - `StrixManager +0x1f8/+0x1f9/+0x1fa` and `+0x30`;
  - `ULiveNetworkP2P+0x28`;
  - `NM+0x538/+0x610/+0x614`.
- **A correction to section 5: the LiveWebAPI is live offline.**
  - `GI+0x970`, `UDM+0x12a0` and `UDM+0xfb0` are all set at boot.
  - Web gate B (`0x147959480`) **answered true** at boot and at the main menu. Its callers were in `0x1479559e0` and `0x147958d80`, in the GeneralAPIController's range.
  - So without D5 the game goes ahead with web-API calls in a modded offline session, and **D5 is required, not optional**.
  - Web gate A was not called before the main menu.
- `UDM+0xf38` is -1 at the main menu.
- The main menu is `RequestChangeMap` to `/Game/Maps/Menu/PL_MainMenu`, called from `0x147ec9e40`.

**Test 2 run A, solo deathmatch travel without D2: PASS 10/10.** Run of 2026-11-18 18:21.
- **Travel.** From the main menu, the game's own mission-by-ID travel (`RVNG_TravelDM`: LevelRow(GI+0x878, 160010), then `RequestChangeMap(GI+0x888, &row+0x48, "")`, then `0x1474ae080(NM)`) loaded `/Game/OnlineMode/Maps/DM/PL_DM_001`. No hangar and no input were needed.
- **Game mode.** It is the deathmatch class: vtable `0x14c693718`, ALiveDeathMatchGameMode.
- **States, all offline:**
  - 1 → 2 → 3 at once;
  - LoadPlayerPlane (3) took 42 s, with `GM+0x5f1` going 1 → 0, so **it clears offline**;
  - states 4 → 12 took 9 s, with every member barrier passing at once;
  - **it then held at SyncStartMatch (12) for the full 60 s**, as predicted without D2.
- **Fields:**
  - `GM+0x498` = 210000 ms, MissionLimitTime as predicted;
  - `NM+0x740` = 0 offline, so **RVNG must write it** (6.3, step 5);
  - `NM+0x3d8` = 0 and `NM+0x538` = 0.
- **Offline:** 169 watch samples through the match, none not offline.
- **A correction:** NextState does call SetState after its increment (the log shows SetState(n) inside each NextState). So hooking SetState alone sees every state change.

**Test 2 run B, with D2 (phaseIndex gate answered true): PASS 11/11.** Run of 2026-11-18 18:25.
- **Start.** D2's first gate call released SyncStartMatch: 12 → 13 (CallStartMatch) → 14 (GamePlaying) within 0.1 s.
- **Match length.** Time-up came **214.4 s** after 14: the 210 s MissionLimitTime plus the 3 s MissionEndSequence, then 14 → 15 (GameTerminating).
- **Fields at 15:**
  - `GM+0x538` = 2 (time-up);
  - `+0x80c` = 1, so stage 1 started and stage 2 is still missing;
  - `+0x521` = 1;
  - `+0x804` = 0.
- **It held at 15 for 30 s**, as predicted without W1.
- **Offline:** 294 watch samples, none not offline.
- **Load time.** The second load of PL_DM_001 took 12 s to state 12 (42 s the first time).

**Test 2 run C, with D2 and W1: W1 works; the Result map CRASHES offline.** Run of 2026-11-18 18:30.
- **W1 works.** It wrote `GM+0x80c` 1 → 2 on entering 15. Then 15 → 16 → 17 took 3 s, and 17 → 18 → 19 another 9.5 s.
- **Ended chose the Result path.** `+0x804` was not 1, so Ended's `+0xb18` (`0x1471c5d20`) called `RequestChangeMap(/Game/OnlineMode/Maps/Menu/Result)` from `0x1471c5f13`.
- **Then the crash.** 3 s later the game died with EXCEPTION_INT_DIVIDE_BY_ZERO at `0x147725a84`:
  - the function is `0x147725a06`, reached through ProcessEvent;
  - it runs `idiv` of 5590 by `+0x34` of a struct that `0x14771a280` fills;
  - that function builds date and season data from `UDM+0xfb0` (GeneralAPIController) `+0x108 → +0x1b0` (else the local time) and a table at `+0x1468`, and offline it gives 0.
- **What it means.** The online Result map needs web-API season data. RVNG blocks that and never contacts the service, so **the Result map can't be used**.
- **The fix, D6's Result half (runtime 0.2.1, `d6=1`).** When `RequestChangeMap` asks for `/Game/OnlineMode/Maps/Menu/Result`, the same call goes to the main menu instead. It uses the main menu's own FSoftObjectPath, kept from the game's request at boot. RVNG's own result screen comes later.
- **The fix in game (run of 18:40, runtime 0.2.1).** D6 fired on Ended's travel, and the game ran on for 3 minutes with no crash until the job closed it. The self-test marked "Ended (19) reached" as failed for its own reason: 18 → 19 and the travel happen in one frame, so its 1 s tick never saw 19 (fixed in 0.2.2 with `RVNG_LastState`).
- **The 0.2.2 run that would confirm it** was stopped mid-match from outside: low memory on the PC, not a game fault. The user's install was restored by hand.
- **Confirmed (run of 19:03, runtime 0.2.2): PASS 13/13, with window pictures** in `build/autotest/runs/20261118_190310_rvng/shots`:
  - the opening card "Deathmatch, Fort Grays Island";
  - the deathmatch HUD at the start, with the clock counting down from 3:30 and SCORE 0;
  - in flight at 1:54;
  - "DRAW" at 0:00:00;
  - the ending cutscene;
  - then, after D6, **the full main menu 10 s after the match**.
- **The scoreboard** shows two "ALPHA 1" rows, the faction issue of 6.3, step 4.
- **The main menu at boot** still showed only its background and a loading icon 40 s after its RequestChangeMap. After the match it had all its rows within 10 s. Why the first one is slow is still open.

**The other four deathmatch maps: PASS 10/10 each** (run A, runs of 19:48–19:58, runtime 0.2.2). The game's own mission-by-ID travel loads every one:

| MissionID | Map | Opening card |
|---|---|---|
| 160010 | `PL_DM_001` | Fort Grays Island |
| 160020 | `PL_DM_002` | Anchorhead Bay |
| 160030 | `PL_DM_003` | Waiapolo Mountains |
| 160040 | `PL_DM_004` | Yinshi Valley |
| 160060 | `PL_DM_006` | Roca Roja |

On every map, the second load reached SyncStartMatch (12) about 11 s after the travel.

**The 20:00 reruns, runtime 0.2.2:** flags 5/5, dm_b 11/11, dm_c 13/13. Gate B was called the same 3 times at boot in every run.

**The boot main menu never shows its rows while the web gates are blocked** (`menu` suite, 19:37). Pictures at 20, 40, 30+30, 60, 90 and 120 s all show only the menu's background and a loading icon, while after a match the same map shows CAMPAIGN / SYSTEM / QUIT GAME within 10 s. The likely cause is a one-time boot step, perhaps login or server data through the GeneralAPIController, waiting on a request gate B refused. This is under static investigation. It blocks a real main-menu row for RVNG, but not the tests: the travel works from the boot menu. **Fixed by D7 (runtime 0.2.3); see 9.2.**

### 9.2 D7: the boot login gate B refuses (fixed, 2026-11-18 21:22)

**Cause** (static analysis, workflow of 2026-11-18, with two independent checks):
- The boot main menu's Authenticate page starts in SigninCheck (Enter 0x147af99b0, auth+0x98 = 0).
- SigninCheck runs OnlineAuthenticator step 1 (RunStep 0x14791d150 → 0x14791d48f): it shows the loading icon and calls ULivePlatformManager::OnlineLightLogin 0x14791e330 (seq 0).
- That starts strategy task 7 (0x147921810), which calls GeneralAPIController StartLogin 0x1479559e0 (GAC = UDM+0xfb0, callback vtable 0x14cbb7968, mode 0).
- StartLogin stores the callback at GAC+0xd8, sets GAC+0x194 = -1 and GAC+0x138 = mode, then asks gate B (call at 0x147955ab3, returning to 0x147955ab8). On RVNG's false it just returns.
- The callback never runs, so step 6 (0x14791d22a: OnFinished broadcast, icon hidden) never comes. SigninCheck never finishes, and the Authenticate tick (0x147afe540) polls it forever: no Top page, no rows.
- After a match the boot chain is skipped (Boot widget once-byte 0x14e510470), which is why that menu works.

**Fix (D7, `d7=1`, only with `gates=block`):**
- The gate-B detour only *marks* a refusal whose return address is StartLogin's 0x147955ab8; nothing runs inside the detour.
- On the next game-thread watch, RVNG calls the game's own FinishLogin 0x1479638e0(GAC, 1), code 1 = Failed. It does so only when all of these hold: the same GAC, result -1, mode 0, a bound callback, and callback vtable 0x14cbb7968. Path A's callback (vtable 0x14cb68558, mode 1) is never ended: its false branch travels to the title. Each refusal gets one try; at most 2 per process.
- That is the shipped game's own network-down ending, minus the dialog. No gate is opened, no LiveWebAPI function is called and no login is faked: the login status UDM+0xfb8→+0x88 stays 0.
- The fallback F2 (answer OnlineLightLogin's own "online unavailable" {1,0}) is not built. If it ever is, it must also require seq == 0: Top's Online command and the invite path call the same step-1 site with seq 1, and would reach Steam/online-subsystem code.
- Signatures are in `native/sigs.h` (kSigFinishLogin, kSigStartLoginGate checked against gate B, kSigTask7CbLea, kSigPathACbLea). There are 14 offline checks in `native/tests/rt_test.c` (64 in all, all pass).

**In game** (`menu` suite with d7=1, run 20261118_212219_rvng, 6/6):
- Gate B was called 3 times, as before. The third, from exe+0x7955ab8, was marked.
- 0.4 s later: `login stall: result -1 mode 0 bound 3 vtable exe+CBB7968; login status 0`, then `FinishLogin returned: result 1 bound 0; login status 0`.
- No further gate A or B call in the remaining 3 minutes; 0 "not offline" watch samples.
- Every picture (20 s to 120 s) shows MAIN MENU with CAMPAIGN, CAMPAIGN TRAINING, SYSTEM and QUIT GAME. There is no spinner and no dialog, and ONLINE and STORE are still removed.

**Side effect:** the Authenticate states after SigninCheck now run at boot, as in the shipped game, including FirstSave. That writes the user save (the gate put back Campaign.sav after the run).

**Since then (runtime 0.2.4, 2026-11-19):**
- D5 and D7 run in every install, with or without the test logger. Before 0.2.4, `probe=0` (the shipped setting) hooked nothing, so a normal RVNG install neither shut the web gates nor ended the login.
- `gates=observe/off` lines are ignored and logged: the gates always answer false.
- The always-on game-thread tick is `Scripts/rvng_native.lua` → `RVNG_Tick`. d7 defaults to 1 and is on in every suite.
- `dm_c` with d7=1 passed 13/13 (00:05): travel, match, W1 and D6 all work from the fully built boot menu.
- The `prod` suite (probe=0) passed 5/5 (00:18): only the 2 gate hooks, the login ended 9 s after the menu step began, Online and Store off, no gate asked again, and the menu's rows in the pictures.

**Earlier note (superseded):** d7 is on only in the `menu` suite. Before it becomes the default, a dm suite should run with d7=1, since a deathmatch travel during the boot save has not been tried. States 2 and 5 and the step-1 result handler are VM-protected; they behaved silently in this run.

### 9.3 Test 6, factions (passed in game, 2026-11-19 00:29; runtime 0.2.5, suite `dm_f`, 16/16)

**Layout** [static, confirmed in game]:
- `NM+0x4d0` is a `TMap<FString userId, {u8 faction; FString name; i32 number}>`, a TSet with element stride 0x38: key +0x00, faction +0x10, name +0x18 (e.g. "BRAVO1"), number +0x28.
- The hash is `FCrc::Strihash` 0x1416e0640, case-insensitive.
- ELiveFaction: 1 Alpha, 2 Bravo, 3 Charlie, 4 Delta, 5 Lima, 6 Oscar, 7 Romeo, 8 Zulu.

**Writers:** only the offline seeder 0x1474b5b10 (run by the travel's prepare step), the online builder 0x1474b5d90 and the NM destructor. Nothing in the DM world re-seeds it.

**Readers:** the DM faction assigner 0x1471e0230 (state 5, through GM `vf+0xa30`) writes `plane+0x3b2`.
- The start-point picker 0x147391240 then wants a point with `+0x2d8 != 0`, `+0x2d9 == faction` and `+0x2da == 0`.
- The callsign is `plane+0x6e8`, and the HUD text key is `Online_Hud_OnlineMissionCallsign_<Faction>_<n>_Name`.

**RVNG:**
- `faction=N` writes the local user's entry right after RVNG_TravelDM's prepare step, and again before state 3.
- It goes through the game's own FindOrAdd 0x1474bc580 (found through the call site 0x1474b60c1) and FString `operator=` 0x1416e0b60, so the map never holds RVNG memory.

**In game:**
- Offline the local user id is the empty string, and the game keys its entry the same way.
- The plane got faction 2 and callsign BRAVO1. It started on Bravo start point 1, 0 m away; the map has 48 start points.
- The player list at time-up reads BRAVO 1. Before, two ALPHA 1 rows were shown.
- `AfterState` never sees state 9: TeleportPlayers increments `GM+0x758` itself.

### 9.4 Test 3, the opponent's copy through the native remote spawn (passed in game, 2026-11-19 00:49; runtime 0.2.6, suite `dm_s`, 18/18)

**Where the copy comes from** [static]: SpawnPlayerPlane's Enter (state 4, 0x1471c6460) runs the local spawn 0x1471b66a0, then the remote loop 0x1471b7430.
- The loop calls the per-slot wrapper 0x1471b9330 → remote spawn 0x1471b84f0(GM, slot, class) for every slot `i < NM+0x3d8` whose selector netId (`sel+0x2c`) differs from the local user's.
- The class comes from the selector's aircraft (`sel+0x78`) through the InformationManager.

**RVNG** (`opponent=1`, before state 3 of an RVNG-travelled DM):
1. `SetConfirmed` 0x1474b2310(NM, &result). The result is an FChronicleMatchmakerConfirmedResult with Players 2 and members {local "", "RVNG_TEST_2" team 1} (0xc0-byte members). This sets `NM+0x3d8 = 2` and fills NM+0x410.
2. The MRMM's selector build 0x147490bc0 and `FillFromUdm` 0x147491460 for both: the opponent clones the local airset.
3. RVNG writes netIds (local 1, opponent 2), the joined byte `+0x28` and the names. It copies the opponent's weapons and parts TArrays with the game's TArray copy 0x1416d9f10.
4. RVNG writes the faction entries: local ALPHA1, opponent BRAVO1.
5. **Not called:** `0x14748e610` as a whole (it binds StrixManager delegates) and `0x147490260` (it would register network keys).

**Cleanup** runs 8 s after the travel back to the menu, once the DM world is gone:
- TerminateAircraftSelector 0x14748d870;
- ResetMatchedInfo 0x1474b1af0(NM, NM+0x3a8, which is 0xff offline). Its prologue differs in memory from the file (0 matches in game), so it is found through the session teardown's call at 0x147eca7ea.

All counts are 0 afterwards. Leftovers would block the next sortie's pre-travel check and leak into campaign and Survival.

**In game:**
- The remote spawn ran once, for slot 1, with class `BP_PlayerPlane_PP0024_f18f_C`, returning to exe+0x71b965b.
- The copy: role (`+0xed8`) 2, `+0x53b8` 2, `N+0x28` 0x0200000000000002, `+0x3c00` 2, user and name "RVNG_TEST_2", faction Bravo, callsign BRAVO1.
- The local plane: role 1, `+0x53b8` -1, `N+0x28` 0 (no key offline).
- The copy was placed on its Bravo start point by TeleportPlayers and then **stayed exactly still all match**. It was not pulled to the map origin as Survival's older test suggested.
- The HUD lists both pilots: ALPHA 1 (own) and RVNG_TEST_2 / BRAVO 1 in red as the enemy, with the A/B team marker.
- No crash. The run stayed offline throughout.

**Next:** test 4 on one PC, a loopback mirror: the local plane's own messages re-keyed to the copy and injected through the router, so the copy flies.

### 9.5 Test 4, the one-PC loopback mirror (passed in game, 2026-11-19 01:22; runtime 0.2.7, suite `dm_l`, 23/23)

This is the transport RVNG will use between two PCs, run end to end on one PC: capture at Send, serialize, bytes, deserialize, router inject, the copy's handlers.

**Correction to 6.4:** the remote spawn calls the copy's `vf+0xc60` but never `vf+0xc68`. The game's register step 0x147d13dc0 runs c60/c58/c68 only when `SM+0x1fa` is set. So offline **neither plane is in `StrixManager+0x2e0`**, and RVNG must register both.

**RVNG** (`loopback=1`, which needs `opponent=1`):

1. **At state 14 (AfterState):**
   - local plane: `vf+0xc60` (makes `N = plane+0xed0`), then `N+0x28 = 2<<56|1` and `+0x53b8 = 1`, then `vf+0xc68` (registers it);
   - the copy: `vf+0xc68`;
   - the slot bytes are checked first. The ALivePlayerPlane vtable is 0x14cbef168, with c60 0x147d5e650 and c68 0x147d5e740.
   - `SM+0x2e0` went from 2 keys (1<<56, 7<<56) to 4.
2. **Each frame, the local plane stays role 1.** In the slot pump's pre-hook (0x1474efd50, the GameInstance ticker), RVNG calls the Physics fill 0x1474c4380(N, plane+0x2268), reached by the jmp at `vf+0xc68 + 0x45`. The pump then sends Physics every 80 ms with no offline gate.
3. **Send is replaced (D1, 0x1474a2190):**
   - nothing reaches the original;
   - the `{0x10, NULL}` form is ignored;
   - a message whose vtable is the local Physics vtable (0x14bfd7d90) and whose key is `+0x10 = 2`, `+0x14 = 1` is serialized into RVNG's ring. The serializer is the game's channel code: MsCtor 0x14a402db0, EncInit 0x14a403250, `Serialize 0x14a3b13f0(&err, &enc, metaclass, obj)`;
   - every message is then released the way the original releases it.
4. **After each pump**, each ring entry is:
   - decoded by `DecCtor 0x14a404570` + `DeserSp 0x1453bb4d0` into a new shared_ptr;
   - re-keyed (`+0x14 = 2`, `+0x18/+0x19 = 0`; `+0x8` kept);
   - moved 150 m ahead along its Direction (`+0x20`; Location int cm at `+0x2c`);
   - delivered by `Router 0x1474ef630(SM, {uid with +8 = 2, NULL}, &sp)`.
   - `copyPlane+0x8b1 = 1` is set once, before the first message, to skip the location check that one time.
5. **Disarmed** at time-up or on any map change. The game's teardown unregisters both planes.

**In game:**
- In about 3.5 minutes of match: 3,178 sends. 2,567 were Physics (class 0x9C9EBB), about 12 a second; each is **64 bytes** encoded.
- All 2,567 were captured, injected and applied, with 0 encode or decode failures and 0 sends off the game thread. The other classes sent were 0xE3E6277E (597), 0xFD5A8E3E (13) and 0x133442CF (1).
- The copy flew 5.7 km and stayed 146-147 m ahead of the local plane, within 4 m of the mirror point.
- The HUD locks it as a target ("TARGET: BRAVO 1", `146 F/A-18F RVNG_TEST_2`, SHOOT cue).
- It stayed offline all the way, and the room tables were emptied after the match.

**Role 3 (`dm_l3`, test 5 in game, 01:32, 23/23):**
- With the local plane set to role 3 before `vf+0xc68`, the game refreshes and sends Physics itself; RVNG made 0 refreshes.
- The copy flew within 4 m again.
- Role 3 also sends `FLiveMessageSelectedTarget` and `FLiveMessageLockedTarget` when the local plane locks the copy.

**Role-3 audit (static, 2026-11-19): role 3 for the whole match is safe offline.** Scratch files are in `build/re_scratch/role3/`.
- **The role predicates** are `vf+0xc38` (!=2), `vf+0xc40` (==3), `vf+0xc48` (==2) and `vf+0xc50` (==1), at 0x146db27c0..7f0. There are 44 role==3 tests and 14 role==1 tests, and no role test at all in HUD, camera, audio, flight or score code.
- **Every role-3-only branch** does one of three things:
  - builds a message and calls Send (D1 takes it);
  - lets the plane's hits count on a role-2 copy (CanBeDamagedBy 0x15c709b60 and its inline copies);
  - bumps a statistic.
- **Nothing waits for a reply**, nothing touches the Strix client global, and every sender null-checks N.
- **Death, respawn and score stay local:**
  - a terrain crash still kills and respawns the plane, with DestroyedLocation and RespawnTimeEnd going to D1;
  - the score function runs whenever `SM+0x1fa = 0`.
- **Role-3 senders:**

  | Group | Messages |
  |---|---|
  | Per tick | Physics + FlightEngineInput (0x147d5e790) |
  | Targeting | SelectedTarget, SelectedEmlTarget, LockedTarget |
  | Weapons | HoldingMachineGunButton, Explosive/Instant/Bullet/ElectronicMeasure fires, BulletWeaponFire, PushFlare, SpecialWeaponArmed |
  | Death and respawn | DestroyedLocation, RespawnTimeEnd, RequestTeleportToRespawnPoint |
  | Needs the game-mode network object | ExplosiveWeaponHit (`vf+0xc48`, `GM+0x738→+0x28 = 6<<56`, `vf+0xc50`) |
- **For D1:**
  - EscapeInClouds, ElectronicMeasureEffect and the host's Damage results are stamped with the *copy's* key, and are meant for the peer's own plane. The "drop anything with the copy's key" rule in 6.5 must not drop them.
  - TeleportToRespawnPoint and RespawnRescueResult (server-made) stay blocked on receive.
- **Nothing rewrites `+0xed8`** after spawn or respawn.

**The game mode's network object (01:57, `dm_l3`, 23/23):**
- GM `vf+0xc48` (jmp 0x1471cc030) creates it at `GM+0x738` when missing.
- RVNG writes its key `6<<56`, then `vf+0xc50` registers it through `N->vf+0x2b8`.
- `SM+0x2e0` then holds 1<<56, 7<<56, 2<<56|1, 2<<56|2 and 6<<56.
- With it registered the game also sends FLiveMessagePhaseClear (0x400DAC0F) and FLiveMessageMissionClear (0x172EED6A) at the end.
- Nothing else changed.

**Class ids and names seen at Send:**

| Id | Class |
|---|---|
| 0x9C9EBB | FLiveMessagePhysics |
| 0xE3E6277E | FLiveMessageGameModeState (about 2.7 a second) |
| 0xAC95825A | FLiveMessageSelectedTarget |
| 0xA96792EF | FLiveMessageLockedTarget |
| 0xFD5A8E3E | FLiveMessageCheat |
| 0x133442CF | FLiveMessagePreparingMissionEnd |

The id isn't a CRC32, FNV or Java hash of the name, so D1 classifies by the metaclass name (`+8`), cached per id. The exe holds 165 message classes (`jp.co.soft_gear.strix.server.ext.message.*`).

**The Cheat messages are the combat-zone check, not RVNG:**
- All 13 came every 5 s from 0x1474cecc0 (the Cheat builder), called by ReportCheat 0x1474b8bb0, with key 1/0 (system).
- Payload: `+0x20` u8 type 9, `+0x24` 2, `+0x28` 1, `+0x30` 0.
- ELiveNetworkCheatType, from the reflected enum: 0 none, 1 client_eac_kick, 2 client_npc_location, 3 client_player_location, 4 client_damage, 5 client_weapon_cooltime, 6 client_weapon_ammo, 7 client_weapon_id, 8 client_weapon_location, **9 client_combat_zone**.
- The test plane flies straight with no input and leaves the combat zone about 2.5 min into the match.
- D1 drops these messages. The in-memory NetworkCheatManager record still happens.
- The account save that holds CheatRecordList (ULiveAccountSaveGame "OnlineAccount") is read and written only behind gate B, which RVNG always refuses (9.2). The gate's save diff after every run shows only Campaign.sav changed: the boot save, as in the shipped game.

**What's next on the path:**
- Steam transport between two PCs: the API choice is open.
- The full D1 allow/deny list.
- Role 3 for the local plane: test 5. It is needed for damage and for sending input, weapons and flare events.
- D3/D4 and the host's ScoreUpdate.

### 9.6 Test 7, damage, kill, score and respawn on one PC (passed in game, 2026-11-19 02:51; runtime 0.3.0, suite `dm_h`, 29/29)

**Setup:** the loopback mirror with the local plane at role 3 (the host). The analysis is in `DAMAGE_PATH.md`.
- 20 s after the mirror is armed, RVNG calls the **copy's own TakeDamage** (vtable slot 0xa38) on the game thread, with the local plane as the attacker, DamageType 2 (a missile's) and no causer.
- The game then runs the host's path natively: CanBeDamagedBy (role 3 on role 2), CanTakeDamage, AuthoritativeApply, the score function, BroadcastDamage.

**Results:**

| Step | What happened |
|---|---|
| 30 % hit | TakeDamage returned 33.9; the copy's health went 113.0 → 79.1. The local score went 0 → 556. Send got a ScoreAddition (local key, dropped by D1) and a **Damage** keyed 2/2 (the copy). |
| Lethal hit | The copy's health went to 0 (Damage: 79, Killed 1). The score rose to 3,702. AWACS: "Alpha 1, hostile mercenary pilot downed!" The HUD shows 1st place, 3702 ALPHA 1 / RVNG_TEST_2 0 BRAVO 1. |
| Respawn | The copy's own respawn slot 0xbf8 (which a Respawn message calls online) brought it back at full health (113.0). |

The Damage message fields matched the static layout:
- attacker 2/1, DamageType 2;
- Damage 0x21, then 0x4F;
- `+0x30` = 0x80 (IsHost);
- `+0x31` Killed.

The run stayed offline throughout, and the mirror kept flying through the kill and the respawn.

**7b, the guest's hit on the host (03:01, `dm_h`, 33/33).** After the respawn, RVNG built a **FLiveMessageDamageClient** the way the guest's D3 will:
- the factory is the DamageClient metaclass's vtable slot 3; the getter is the E8 at DCHandler+0x34;
- victim key 2/1 (the host's plane); attacker 2/2 (the copy); weapon slot 0 (the copy's slot, checked to exist, because the host's cheat check crashes on an empty one); DamageType 2; 30 % damage.

What happened:
- It was encoded (**22 bytes**), decoded, passed D1's receive rule (DamageClient: host, own key) and was injected through the router as player 2.
- The game's own DamageClient handler (IsHost) applied it to the local plane: health 102.0 → 72.0, DMG 29 %, smoke.
- It credited the copy's score (0 → 545, 2nd place) and broadcast a Damage result.

**This proves the host referee's damage side on the game's own code, in both directions.**

**D3 and D4, the guest's half (03:18, runtime 0.3.1, suite `dm_g`, 30/30).** With `guest=1` this PC is the guest: player 2, key 2/2, Bravo. The copy is the host's plane: netId 1, key 2/1, Alpha.
- **D3** hooks AuthoritativeApply 0x147d104a0. When TakeDamage's local branch calls it (returning to 0x147d103e6) for the host's plane with the guest's own plane as attacker, D3 doesn't apply the hit.
  - It builds the FLiveMessageDamageClient: victim 2/1, attacker 2/2, the info's weapon, type, damage and attributes.
  - It encodes the message and frees the by-value info with the game's destructor 0x147053630.
  - Crash damage and other attackers on the host's plane are swallowed.
- **D4** hooks the score function 0x147d10f70 (exact float prototype) and returns at once on the guest.
- On one PC this PC's own DamageClient handler stands in for the host.

In game:
- 2 hits taken by D3 and 2 delivered; the host stand-in applied them (113.0 → 80.0, then 0).
- The guest's score function was blocked twice, and the guest's score stayed 0.
- The host's Damage results were broadcast, and the host's plane respawned.
- The mirror ran with swapped keys within 4 m.

`dm_h` (the host) still passes 33/33 on 0.3.1.

**The host's ScoreUpdate (03:33, runtime 0.3.2, `dm_h`, 35/35).** On the host, the score function 0x147d10f70 gets a post-hook. After the game scores a hit, RVNG builds the scorer's **FLiveMessageScoreUpdate**:
- **The message.** Its metaclass comes from the getter at handler 0x1474abca0 + 0x33; its element vtable (ScoreData 0x14bfd7bf0) from the `lea` at +0x101.
- **The elements.** They are allocated with the game's GMalloc (found through the DamageClient Create's `mov rcx,[GMalloc]`), because the message's destructor frees them.
- **The contents.** Each element is {u8 type at +8, i32 value at +0xc}, taken from the plane's TMap<u8,float> at `+0xe08`. The message is keyed to that plane.

In game:
- One was built after each of the 3 score runs (the local scorer twice, the copy once): 26 and 37 bytes.
- The local plane's ScoreUpdate, keyed to the copy and injected through encode/decode as the guest's handler would receive it, was applied by the game's own handler (SetScore `vf+0xc18`). The copy's score became exactly the local's (3,702).

**Death and respawn relayed (03:47, runtime 0.3.3, `dm_h`, 38/38).** The loopback now mirrors FLiveMessageDestroyedLocation and FLiveMessageRespawn as well as Physics, re-keyed to the copy. RVNG crashed the local plane: its own TakeDamage with type 7 and no attacker, so no CanBeDamagedBy and no spawn-protection check.
- **The crash.** The local plane died (health 0, "Crashed").
- **Death.** About 6 s later, once the death sequence had played, its DestroyedLocation (role 3) reached Send. Mirrored to the copy, its handler marked the copy destroyed (`+0x3c2e = 1`).
- **Respawn.** After the game's own auto sortie, the local plane respawned (health 102.0) and sent Respawn. Mirrored, it brought the copy back through `vf+0xbf8`: health 113.0, spawn protection `+0xdfc = 1`.
- A "controller disconnected" dialog in the pictures was the user's PS4 controller dropping out at that moment (a Steam toast shows it), not the game.

**Left for two PCs:**
- the link itself: Steam, hello, the clock offset into the guest's `c[0x20]`, heartbeat and link loss;
- carrying the ScoreUpdates and the DamageClients on it. What remains for two PCs is D3 on the guest (its hits on the host become DamageClient), D4 (the guest's score function off), the host's ScoreUpdate, and Respawn/DestroyedLocation over the link.

### 9.8 The lost link: the forced end (passed in game, 2026-11-19 04:57; runtime 0.3.4, suite `dm_x`, 13/13)

When the peer goes silent in GamePlaying, RVNG ends the match the way Bandai's server does: RecvPreparingMissionEnd, GM `vf+0xdd0` = 0x1471cb7e0(gm, memberId, coopResult, matchResult). The disassembly says:
- **It always runs PrepMEndSync** 0x1471cb5e0, with the game mode's stored flags `+0x729/+0x72a`.
- **It exits** if `vf+0xb80` (= `GM+0x521`, finishing) is 1, **or if memberId is not the local id** (0 offline, at 0x1471cb91c). A first run with memberId 1 did nothing.
- **Otherwise** `+0x804` = 2 (Finished) if either *argument* flag is set, else 1 (Aborted); then `+0x808 = 1`, `+0x538 = 4`, and OnGameFinish (`vf+0xab8`).

So the design's `vf+0xdd0(gm, 0, false, elapsed ≥ 105 s)` (6.6) is right.

**In game:** simulated at 120 s into state 14 (from the game-thread watch):
- `+0x804 = 2`, `+0x538 = 4`;
- GameTerminating (15) 2–3 s later, after the 3 s mission end sequence;
- PrepMEndSync had set `+0x80c = 1`, and W1 made it 2;
- Ended (19) 11 s later, then D6 to the main menu;
- offline throughout.

**Aborted (< 105 s) is not run yet.** It leads to the game's AbortPath travel to the online lobby (0x1471c5f70/0x147ec9fc0), which D6 does not redirect so far. That redirect comes before the link layer uses Aborted.

**Static look at that path (2026-11-19):**
- AbortPath 0x1471c5f70 jumps to 0x147ec9fc0.
- That calls 0x147ec9e40 with level 99995 (`mov edx, 0x1869b`): the level row lookup 0x14734ca30, then **RequestChangeMap 0x147901bf0**, which RVNG hooks.
- So D6 can redirect the OnlineLobby map by package, as it does the Result map.
- 0x147ec9fc0 also calls 0x147206880 and 0x14720c6f0. Their first-level calls show no Strix or online setup, but that should be checked before the Aborted test. Before state 14 the forced end can't act, so RVNG's own exit to the menu is needed there (6.6).

### 9.9 D8: the game's cheat reports switched off at the source (passed in game, 2026-11-19 08:29; runtime 0.3.5)

**Why:** D1, D5 and the never-set online flags already kept every cheat report on the PC (5, 9.5). D8 is one more wall, at the source: if a later RVNG bug let something past those, there would be nothing to leak. The user asked for it so players can trust RVNG installs.

**What the game's ReportCheat (`0x1474b8bb0`) does** (static): ReportCheat(NM, network id, type, ptr)
1. builds a Cheat message and passes it to Send (`0x1474cecc0`);
2. votes through the NetworkCheatManager (`0x1474b8de0` → `0x1474a3430`), which kicks only in a connected Strix room;
3. only if `NM+0x4c9` or `SM+0x1fa` is set, records the type in the room-member manager and `NetworkCheatManager+0x88`, which OnGameFinish turns into the match-end web report (behind gate A).

**Safe to make it return** (static, every caller checked):
- It returns nothing: none of its 9 callers reads `eax` after the call (`0x1474842d9` is a tail jump from the type-1 delegate).
- It takes no reference from its callers: the pointer argument is only passed on, and the callers release their own references after the call. The only memory it frees is its own local string.
- Callers and types: `0x1474a3de7` (7, 4: ApplyNetworkDamage's check), `0x1474a4177` (3), `0x1474a42b4`/`0x1474a4398` (6, 5), `0x1474c75cc`/`0x1474c78a7`/`0x1474c7b8c` (5), `0x147d5b6cf` (9, combat zone), `0x1474842d9` (1).

**D8:**
- An inline hook on ReportCheat (signature kSigReportCheat, 29 bytes with no wildcards; lens `5,5,1,1,2,2`), installed in every install next to D5, so a normal install has 3 hooks.
- Types 2–9 return at once, counted by type. Type 1 (client_eac_kick) comes from the game's anti-cheat manager and is handed to the game untouched: RVNG stays out of anything anti-cheat. It can't fire in a modded game anyway, which runs no anti-cheat client.
- Lua `RVNG_CheatInfo(k)`: k 0–9 = reports of that type seen, 10 switched off, 11 type 1 passed, 12 hooked, 13 Cheat messages that reached Send (loopback suites only).

**Results:**
- Offline: rt_test 120/120. The 8 new checks include running the game's real first 16 bytes (taken from the signature) through HookInline and its trampoline.
- `dm_l` 27/27 (08:29): the combat-zone check fired 13 times (type 9, every 5 s once the plane left the area); all 13 were switched off and 0 Cheat messages reached Send (the 0.3.4 runs had 11–13).
- `prod` 5/5 (08:31): 3 always-on hooks (the 2 web gates and D8), the login ended, the menu row, no gate asked again.
- `dm_h` 40/40 and `dm_g` 32/32 (08:37, 08:44): all earlier checks pass. Both runs switched off a **type 4, client_damage** report. It comes from ApplyNetworkDamage's check (`0x1474a3cb0`) on the test's DamageClient (7b, and the guest's D3 hits), which the check finds implausible; the check doesn't block, so the damage still applies. This explains the 1–2 Cheat messages earlier `dm_h`/`dm_g` runs logged. In the two-PC game the host runs this check on every guest hit; with D8 it reports nothing.

### 9.10 D9: the network wall (passed in game, 2026-11-19 14:17; runtime 0.3.6)

**Why:** D5 shut the two web gates a session was seen asking, but the online-screens audit found at least 9 more, plus senders with no gate at all. The user asked for a wall so that a modded RVNG client never contacts Bandai or any other outside service. That includes code paths no test walks: a screen, a timer, a Blueprint.

**Found by a static audit** (three maps with separate verifiers; details, labels and the gate table in ONLINE_UI.md 5):
- **Every LiveWebAPI request goes through one function.** All 111 endpoints are built from the queue's element Start `0x148088980`, gated or not.
- **Cosmos sends through one function.** All 20 Cosmos APIs, including an ungated boot-login branch, go through one sender `0x145449cc0`.
- **Every engine HTTP request starts at one point:** curl's `ProcessRequest` `0x141ef0c50`.
- **WebSockets** start at libwebsockets' client connect `0x14a38cba0`.
- **Strix and the Messenger** are set up only from the online lobby part's task: `0x1474ec7e0` and `0x1474f0200`.
- **The crash reporter's Slack post is compiled out.**

**D9** (every install, installed first):
- six send-point hooks and nine more gate hooks (false, like D5); the hooks and their answers are in the 6.8 change list;
- signatures: 16 new (`native/sigs.h`, all checked unique by the new `tools/re/sigcheck.py`, which also rechecked the 40 old ones);
- the curl refusal empties the request's URL and lets the engine run, so the engine's own PreProcess fails it with a failure callback before anything is resolved or queued. Returning without the engine would leave callers waiting forever. An object whose vtable slot 26 isn't the curl class's is returned unsent;
- URLs are logged only up to their query;
- Lua: `RVNG_WallInfo(k)` gives:
  - 0–3: hooked counts;
  - 4–9: refusals per send point;
  - 10–11: the more gates' calls and how many the game would have answered yes;
  - 12: the LiveWebAPI requests queued (the test logger watches AddRequest `0x147f82d00`);
- the self-test: every suite checks the wall is in and ends with an INFO line of what it refused.

**Scan speed:** the signature scan now buckets patterns by first byte. 56 signatures take 2.6 s; 41 used to take about 11 s. So all hooks, D9 first, are in about 4 s after the runtime starts. Before, gate B was first asked 10 ms after the hooks went in.

**Results:**
- Offline:
  - rt_test 176/176. The new checks run each send point's real prologue (the signature's bytes) through HookInline and its trampoline, and test the first-byte buckets, the curl vtable check, the URL cut and call-site gate finding;
  - the self-test's own test, kit_test and netwatch_test pass.
- `prod` 6/6 (14:10):
  - 3 always-on hooks plus D9's 6 send points and 9 more gates;
  - the boot login ended (D7), the menu rows built;
  - refusals: 0.
  - The master-data gate was asked about 9,700 times in 90 s by a per-frame tick at `0x1479a00a0`, and the game's gate would have answered yes to half of these calls. Its caller only acts when a pending flag (`+0xc8`) is set, and that action builds requests Start would drop, so false changes nothing visible. The menu picture is unchanged.
- `net_dm` 16/16 (14:17), the full deathmatch with D6 back to the main menu:
  - no LiveWebAPI request was queued in the whole session;
  - every refusal count was 0;
  - outside contact: only `EOSSDK-Win64-Shipping.dll` → `api.epicgames.dev` (Cloudflare `104.18.124/125.108:443`), the same as before D9.
  - This was the rerun of the 12:23 run that crashed (GPUCrash at 0.7 MB free RAM, with a code-reading workflow running beside the game).
- `dm_h` 41/41 (14:26): test 7 (damage, kill, score, respawn through the loopback) with D9 in: the earlier 40 checks plus the wall's. 0 refusals, 0 queued; outside contact again only EOS.
- **Memory:** this machine has 31 GB. The game alone takes free RAM from about 21 GB to 1.2 GB at the menu and to 0.38 GB in the deathmatch. Nothing heavy may run beside a gated game run.

**Not covered:** EOS's own sockets (the user's decision; anti-cheat-adjacent), Steam, the protector's WinINet (VM code), UE's unconfigured IoStore on-demand client, NVIDIA's update check.

### 9.11 The link between the two PCs (built 2026-11-19; runtime 0.4.0)

**The user's choice:** Steam's ISteamNetworkingMessages (the current API), relay-only.

**The transport** (`native/link.h`): the game's own `steam_api64.dll` (Steamworks 1.57, flat API, resolved by name).
- Relay-only: `P2P_Transport_ICE_Enable = 0` for the process. The setting's number (104) is checked by its name first, then read back. Every packet goes through Valve's relays (SDR), so neither PC learns the other's IP address.
- Each PC sends to the other's SteamID first. That is Steam's implicit accept of that one session; no Steam callback is registered. A message from any other sender is dropped.
- Channel 0 carries the link's own messages, channel 1 the game's.

**The protocol:** a 16-byte header (magic `RVNG`, version, type, length, sequence, and the match tag: the FNV of the matchmaker's match id, so messages from another match are dropped).

| Message | What it does |
|---|---|
| HELLO | Repeated until both sides have the other's. Carries the player number, the runtime version and the name. |
| PING / PONG | Every 0.25 s both ways. The heartbeat: no message for 6 s while up means the link is lost (2 minutes while still connecting). The guest's pings measure the clock: the lowest-round-trip sample of the last 16, as NTP does. Pings also carry the clock-synced flag, the game stage (12 = at the start gate) and the ready flag. |
| GO / GOACK | The host's start at an agreed host time, sent once the guest's clock is synced and the guest is at the start gate. GO also carries the host's relation between its game clock and link clock. |
| LAUNCH / LAUNCHACK | The same for the launch into the match (9.12). |
| BYE | A clean stop, with a reason. |
| DATA | The game's messages, queued for the game thread. |

A thread ticks the link every 5 ms.

**The clock:** the two PCs' synced game clocks are unrelated (D1_FILTER.md finding 5; `c[0x20]` = 0 offline). At the start gate the guest adds `10 × offset + hostK - myK` to its `c[0x20]`, as the server's RealTime does online. So both PCs then run the host's game clock.
- The game's clock functions are found at start by a new signature, kSigPhysFill (the Physics fill `0x1474c4380`; its calls at `+0x61` and `+0x69`).

**The wire** (`rvng_test.ini wire=`) carries test 4's captured messages.

| `wire` | What carries the messages | Behaviour |
|---|---|---|
| 0 | the in-memory ring, as before | the one-PC loopback |
| 1 | a pair of links inside the game process | one PC: every link feature with the game's real messages |
| 2 | Steam to the other PC, set by `link_peer`, `link_player` and `link_tag` | two PCs: see below |

On wire 2:
- every class D1 lets out is sent, Physics unreliable and the rest reliable;
- what arrives goes through D1's receive rule to the router as the peer's own, with nothing re-keyed (each PC keys a plane by its player number);
- the guest's DamageClients (D3) and the host's ScoreUpdates go over the link;
- D2's start gate opens at the agreed GO time on both PCs;
- a lost link is the game's forced end;
- the end of the match sends BYE.

**Pairing through the matchmaker:**
- the server has a new route, `POST /api/matches/:id/link {steamId}` (SteamID64 only); each pilot sees only the opponent's id, and the host's post opens the match;
- the companion relays the new bridge file `link.json`;
- `main.lua`'s `onLink` starts the link once `match.link.peer` is known.

The server tests for this are `server/test/link.test.js`.

**Results:**
- **Offline:** rt_test 232/232. The checks cover:
  - the link between two fake PCs with clocks 5 s apart and one-way delays of 30 and 50 ms: the guest's offset within 15 ms, and GO on both within 15 ms;
  - DATA in order;
  - a stranger's, another match's and a broken message all dropped;
  - loss after 6 s, BYE, and the 2-minute connect timeout;
  - the wire-1 start gate in real time;
  - the clock delta.

  Also: server 97/97, client 28/28, all mod Lua tests.
- **In game, one PC:**
  - `link` 14/14: Steam networking found, relay-only read back as 0, Valve's relay network ready in 6 s, this PC's account read, a link to itself refused. The only outside traffic was steamclient64.dll's relay pings to Valve; this is very likely the "~30 UDP sockets" seen in some earlier runs.
  - `dm_k` 31/31: wire 1. D2 opened at the GO time 3.1 s after the first gate call; 301 of the game's messages went through the link, received and mirrored, none lost.
  - `dm_kx` 17/17: the wire cut at 110 s, the link found itself lost at 116 s, then the forced end (Finished), W1, D6 and the main menu.
- **Regression on 0.4.0:** `dm_l` 29/29, `dm_h` 42/42, `dm_g` 34/34, `prod` (in `link`).

**Not yet:**
- the two-PC run itself (suite `pvp`);
- the opponent's real identity and airset in the room tables (FillOpponent still clones the local airset);
- a normal install's match flow (wire 2 needs the test switches today; done in 0.4.1, section 9.13);
- D6's OnlineLobby half.

### 9.12 The ready-up screen (built 2026-11-19, the user's request; runtime 0.4.0)

**What the user asked for:** "a ready up screen so both players launch into the match at the same time".

**How it works:**
- Once the link to the opponent starts, `Scripts/rvng_ready.lua` turns the main menu into the ready-up screen. It writes into the menu's own text widgets, which the `ui_scan` suite found: LiveLocalizeTextBlocks in `WBP_Menu_MainTop_000` for the header, the COMPETITIVE 1V1 row and the description line.
  - It writes them every tick, so the screen shows at once and comes back when the game rewrites the description for another row.
  - The game reads its text lookup only when it builds the menu, so RVNG's text hook alone can't change a row that is already on screen (measured: 0 lookups while the texts changed).
- **What it shows:**
  - MATCH FOUND / CONNECTING...;
  - READY UP (n/2) or READY (n/2), with both pilots' states in the description;
  - LAUNCHING IN 5..1.
- **The controls:** a press on the row readies or un-readies until the launch is set; after the match, `Ready.reset()` restores the menu's texts.
- **The launch:** each side's ready flag rides on the link's pings. When both are ready and the guest's clock is synced, the host sends LAUNCH for 5 s later, and both PCs launch at that moment on their own clocks, aligned by the link. Then the start gate's GO lines up the match itself, whatever each PC's loading time. Once agreed, the launch is committed even if the link drops during the countdown.

**Results:**
- Offline: within 15 ms on both PCs, no LAUNCH before both are ready, one per match; `mod/test/ready_test.lua` covers the screen's states, the widgets and the reset.
- **The result screen** (the same widgets, after the match):
  - at time-up the runtime reads both planes' TotalScore (`ResultCapture`; on the guest the host's ScoreUpdates have set them);
  - back at the main menu the screen shows MATCH RESULT, VICTORY / DEFEAT / DRAW with the scores, and the opponent, until the next press, which queues again;
  - only that match's result is shown;
  - `dm_r` 38/38 (17:07) shows MATCH RESULT and DRAW 0 - 0 (no shots in the test).
  - The description line is the game's for whichever row has focus; the screen writes it back every second.
- In game: `dm_r` 37/37 (wire 1, the stand-in peer readies with this PC).
- **The pages** (`Scripts/rvng_pages.lua`, the user: "MULTIPLAYER > RANKED 1v1, CASUAL 1v1 > LOBBY"):
  - RVNG's main-menu row reads MULTIPLAYER. A press opens RVNG's pages, drawn in the main menu's own header, five rows and description line.
  - The pages:

    | Page | Rows |
    |---|---|
    | MULTIPLAYER | RANKED 1V1 / CASUAL 1V1 / BACK |
    | LOBBY | the mode or the opponent / SEARCHING, READY UP (n/2) or LAUNCHING IN n / LEAVE LOBBY |
    | MATCH RESULT | the result / PLAY AGAIN / BACK |

  - Leaving the pages restores the stock texts.
  - While a page is up, the DLL takes every confirm press (`RVNG_MenuPage(1)`) and reports the selected row (`RVNG_MenuPress`). The game keeps its own cursor, highlight and sounds.
  - The texts are written every frame (UE4SS's `LoopInGameThreadAfterFrames`).
  - The approach follows what AC8ModSettings' pause-menu editor does (rewriting stock rows to draw pages), studied in the 17 Nov digest. RVNG's code and offsets are its own.
  - Offline: `mod/test/pages_test.lua`. In game: `dm_r`, with the self-test pressing for the pilot (posted keys don't reach the game). The real button presses need a hand check. The screen was shown in the header, the row and the description; the host's LAUNCH was set, the launch came exactly 5 s later, then the whole match ran. The pictures show READY UP (0/2) and LAUNCHING IN 4.
- **The menu's cursor (menu RE, 2026-11-19 evening):**
  - **The selected row** is an int16 at widget+0x688 (0 = the top visible row). The offset is read at runtime from the game's own getter, vtable slot 0xF3 (`movzx eax, word [rcx+0x688]; ret`), never hard-coded. The row count is the int16 at +0x68A. A press reports this row.
  - **Moving the cursor:** the menu's own SetSelectedIndex (0x147a7ab50, `kSigSetCmdIndex`) clamps to the row count, moves the highlight and refreshes, as the game's mouse hover does. The pages put the cursor on the first row that does something:
    - RANKED 1V1 on MULTIPLAYER;
    - the second row (READY UP) in the LOBBY;
    - back on MULTIPLAYER after BACK, not on whichever row BACK was.
  - **Mouse hover:** in mouse mode the menu tick selects the hovered row (int16 at +0x6D8) whenever it differs (0x147a79766, `kSigMenuHover`; both offsets read from that code). A cursor move sets the hover to the same row, so the move holds until the mouse moves.
  - **UE4SS's Lua getters pop:** `get_number` and `get_string` take the value they read off the stack. A function's arguments are read in order, each from index 1 (`ArgNextNum`/`ArgNextStr`).
    - Measured: `RVNG_MenuSelect`'s row, read at index 2, always came back 0.
    - The same bug was in `RVNG_LinkStart(peer, player, match id)`, `RVNG_MenuText` and `RVNG_LinkSend`. They had only run from the ini, never with Lua arguments, so the two-PC pairing from `main.lua` would have started with the wrong player number and match tag. All are fixed; rt_test's fake stack pops like UE4SS (239 checks).
  - **The menu on screen:** after a match the old main menu can still exist, with its own copies of every text. The pages only write widgets under the main menu that is in the viewport (or parented), checked once a second.
    - The header and description paths are matched exactly: `Header.WidgetTree_N.WBP_Menu_Text_000...Text_Body` and `HelpText.WidgetTree_N.WBP_Menu_Text_001...Text_Body`. A looser `.HelpText.` match picked another text block, and the result page's description stayed stock.
  - **Two crashes, both understood:**
    - 18:26: calling `GetText` on every UObject from Lua (`ForEachUObject`) crashed the game (access violation at 0x2FB). Only text widget classes are asked now.
    - 19:32 (`dm_s`, an airset dump in the test fill): the log line used `%03x`. The runtime's formatter (`vfmt.h`) supports only `%s %d %u %x %p`, with no widths. `%0` took no argument, so the next `%s` read the byte offset as a pointer: `<null>` for 0, then a crash at 0x20. Fixed (`%x`). `tools/re/fmtcheck.py` now checks every wide format string in `native/` and runs first in `native/tests/run.sh`; it finds the 19:32 string and none in the code.
  - **In game:**
    - `ui_pages` (new suite, 2 min, no match): 19/19 (19:13). MULTIPLAYER > RANKED 1V1 > LOBBY > LEAVE LOBBY > CASUAL 1V1 > LOBBY > LEAVE LOBBY > BACK, the cursor checked on every page.
    - `dm_r`: 46/46 (19:20). The pages, the cursor, ready-up, the launch, the match and the result page with its own description.
- **The opponent's name in the match** (19:20):
  - `RVNG_OppName(name)` sets the name the copy is shown with. In production, `main.lua` passes the opponent's RVNG name from the server's match, the same one the lobby shows.
  - FillOpponent writes it into the member's name (+0x10) and slot 1's selector name (+0x48). The user id stays `RVNG_TEST_2`, the room tables' key, so two pilots with the same name can't collide.
  - `RVNG_OppShown()` reads the name back from the game's selector. UTF-8 from Lua becomes UTF-16 (surrogate pairs; bad bytes become `?`; at most 31 characters).
  - In game: `dm_r` and `dm_k` (32/32) show "the stand-in" on the target box (above "F/A-18F") and on the scoreboard.
  - **Not solved: this PC's own name.** Its own scoreboard row is blank offline (the "---" is a separate field on both rows). Writing slot 0's selector and member name did not change it, so the scoreboard reads the local pilot's name elsewhere; that change was taken out.
- **Still open for the opponent: the airset** (layout found 19:40, `dm_s` 22/22 with a read-only dump):
  - **Today:** each PC sees the other flying its own loadout. The game's FillSel fills the opponent's selector from this PC's data, and FillOpponent copies this PC's weapons (UDM+0xdd8) and parts (UDM+0xde8).
  - **The selector** (an MRMM entry +0x10):

    | Offset | Holds |
    |---|---|
    | +0x2C | the player number |
    | +0x30 | the slot |
    | +0x48 | the name (FString) |
    | +0x78 | the aircraft id (int32; 24010 = F/A-18F) |
    | +0x7C | the skin (int32) |
    | +0x88 | weapons (TArray of int32) |
    | +0x98 | parts (TArray of int32) |
    | +0xC0 | specials (TArray, 2 here) |
    | +0xE0 | emblems (TArray, 8 here) |

  - **Copying arrays:** the game copies the weapon and parts arrays with a plain memcpy of count × 4 (0x1416d9f10). They hold game-data ids, not FNames, so they mean the same thing on both PCs.
  - **The plan:**
    1. The hello carries the aircraft, skin, weapons and parts (a protocol bump).
    2. FillOpponent writes them into slot 1's selector: +0x78/+0x7C directly, the arrays through the game's own copy from a TArray RVNG builds.
  - **Where the game's fill takes this PC's loadout** (static, 20:12; the selector fill 0x147491460, `kSigFillFromUdm`; the UDM comes from vf+0x188 → 0x147ece300). The opponent's selector gets the same fields from the hello:

    | UDM | → selector | Probably |
    |---|---|---|
    | +0xd28 | +0x78 | the aircraft id |
    | +0xdd0 | +0x7C | the skin |
    | +0xdcc | +0x80 | ? |
    | +0xd30 | +0xA8 | ? |
    | bytes +0xd2c, +0xd2d | the +0xC0 array (2 entries) | the special weapons |
    | bytes +0xd48..+0xd4a | +0xD0, +0xD4, +0xD8 | ? |
    | +0xd38 (count +0xd40) | the +0xE0 array (memcpy) | emblems |
    | +0xfd0 / +0x1038 | +0x100, +0x104 | ? |

    Weapons (+0x88) and parts (+0x98) are not filled there: FillOpponent copies them from UDM+0xdd8 and +0xde8 itself.

  - **The user's rule** (2026-11-19 20:05): "The Opponents plane should only be from the game or dlc". The opponent's aircraft must be a base-game or DLC aircraft, never a modded one.
    - The receiver accepts the peer's aircraft id only when its own game data knows it. The integrity check already blocks data mods, so a known id is the game's or a DLC's.
    - Anything else shows the opponent in a stock plane.
  - **Still open:** a DLC aircraft the receiving PC doesn't have. The default is the same fallback. Check whether the files ship without the DLC before the first two-PC match.

### 9.15 The match's result for the leaderboard (2026-11-21, runtime 0.4.4)

The user: "I want it to work the same way as survival" (the leaderboard on Cloudflare). Found first: the native deathmatch
never wrote `bridge/result.json` (main.lua's old match hooks are the original design's `/Script/TODO...` placeholders), so
no match reached the server.
- **`native/matchstats.h`:** from GamePlaying (14) to the result, once a second (the always-on tick, or the test logger's
  watch), each pilot's deaths from the death messages both PCs handle: this pilot's = FLiveMessageDestroyedLocation sent
  by its own plane (Send, D1); the opponent's = DestroyedLocation from the opponent routed in (WireIn; on one PC the
  mirror). Not the planes' state: the copy's health doesn't drop when the relay marks it destroyed, and its +0x3c2e stays
  set after the respawn (the damage test's log). Kills in a 1v1 = the other's deaths. At the result (ResultCapture:
  time-up or the forced end) its length and how it ended (`g_llFired`: the lost link). `RVNG_MatchStat(k)`,
  `RVNG_MatchEvent(i)`; kept until the next match's reset (the first try counted again from zero a second after the end).
- **main.lua** writes result.json once per match (`nativeResult`): `format: "native_dm"`, the length, `time_limit` or
  `disconnect`, each side's aircraft id, kills, deaths and score (both PCs hold the same scores: the host's
  ScoreUpdates), and a kill and a death event per death. The companion sends it as before.
- **In game:** `dm_h` 45/45 (14:07): 214 s, time-up, this pilot 1 death (the crash at 51.2 s), the copy 1 (relayed).
- **The server** (`server/src/matchlog.js` `reconcileNativeDm`, `service.js` resolveMatch): a `native_dm` log pair is
  decided by score (equal: a draw); both logs must agree on kills, deaths, aircraft, scores (within 0.5), the length
  (15 s) and the end; the kill events must account for the kills; time-up's length must fit the game's 210 s clock
  (195-240 s); a lost link (both `disconnect`) goes to an admin. The old design's sampled flight stats aren't asked for.
  `server/test/native-dm.test.js`: 5 tests, one through the API (scan, queue, link, two logs → verified, the score decides,
  ratings and the leaderboard); the server suite 102/102.
- **Still to do:** the move to Cloudflare (Worker + D1, like Survival's leaderboard), and the two-PC run's real reports.

### 9.14 The lobby in the stock hangar (2026-11-21, runtime 0.4.2-0.4.3)

The user replaced the main-menu ready-up with the stock pre-sortie hangar: a match found takes both PCs into the hangar
(Mission014: one wingman spot, the opponent's plane on it), each pilot sets up the plane on STANDBY, READY UP there, SORTIE
locked until both are ready, then the synced launch; the LOADOUT on the link puts the opponent's own plane on the spot and
in the match. Everything (research, hooks, runs, the crash and the fixes) is in `docs/re/HANGAR.md`.

### 9.13 A normal install's match, and B / Esc on the pages (built 2026-11-19 evening, the user's two answers; runtime 0.4.1)

**The user's answers** (2026-11-19, "Both"): install the match hooks at startup in every install, idle until an RVNG match launches; and B / Esc act as BACK on RVNG's pages.

**A normal install's match:**
- **Before 0.4.1:** a normal install (no `rvng_test.ini`) had only the always-on hooks. `RVNG_TravelDM` refused without `probe=1`, and every deathmatch hook was installed only with the test ini. The ready-up screen's LAUNCH did nothing.
- **The match hooks are in from the start in every install** (8 of them): the phaseIndex gate, SetState, NextState, RequestChangeMap, Send, the slot pump, the score function and AuthoritativeApply. A normal install now has 11 hooks.
- **Each passes the game's call straight on until a match is armed:**
  - Send and the slot pump: only with `loopback`;
  - the phaseIndex gate: only with `d2`;
  - SetState / NextState: only with the test logger or an armed match (they still keep the game-mode pointer);
  - the score function: only with `loopback` and the guest (D4) or `hit`;
  - AuthoritativeApply: only on the guest with `loopback`;
  - RequestChangeMap: logs every map and keeps the main menu's path at boot, which D6 needs later. Before, a normal install never saw that request.
- **The launch arms the match** (`MatchArm`, from `RVNG_TravelDM`):
  - It needs the Steam link to the other PC up, which sets this PC's role. It also needs every match hook in (and D3/D4 for the guest) and every piece of the copy and of the message layer found.
  - It then sets `d2`, `w1`, `d6`, `opponent`, `loopback` and wire 2 for that match, and `guest` from the link's player number.
  - Each refusal is logged and the travel doesn't start.
- **Per match:** the once-only steps are reset at the travel (`MatchReset`): the gate's release, the guest's clock shift, the lost-link end and leftover room tables. A second match in the same session runs like the first.
- **Disarm:** the first RequestChangeMap away from the deathmatch's own map (D6's Result redirect, or quitting) schedules it 8.5 s later, after the room tables' cleanup at 8 s. The always-on tick (`RVNG_Tick`) then restores the settings from before the match.
- **The always-on tick also runs an armed match's once-a-second steps**, which the test logger's Watch runs with `probe=1`: the lost link, the mirror's watch, the room tables' cleanup and the disarm.
- **The one-PC rehearsal:** the kit's `dm_p` suite (`probe=0`, `rehearse=1`) runs it on the in-process link pair instead of Steam. That switch exists only for the test kit; a real install always uses Steam.
- **In game:**
  - `prod` 8/8: 11 hooks, the match hooks in and idle.
  - `dm_p` 46/46, twice. The normal install's own launch armed the match (`match: armed ... wire 1`). Then: the pages, the ready-up, the travel, the copy filled and named, 321 messages through the pair with none lost, time-up, W1, D6, the result page, the tables emptied, and the disarm 8.5 s after the travel back.
  - Regression with the test logger on the new hook layout: `dm_r` 46/46, `dm_g` 35/35.
  - One self-test bug on the way: a flag defined after the shared steps that read it, so they saw nil.

**B / Esc on the pages:**
- **Menu RE.** The menu's tick (0x147a797ce..) handles input in order: confirm, cancel, then two more.
  - Confirm: "can decide" (slot 0xE4), then the confirm input (0xDF, the menu base 0x147a79a30), which ends in the decide (0xEE).
  - Cancel: "can cancel" (0xE5), then the cancel input (0xE0, 0x147a79af0), which ends in `jmp [rax+0x778]`, slot 0xEF.
  - The cancel input calls 0xEF only when the input layer's cancel flags are set this frame, or when the menu's pending-cancel byte (+0x6c4) is set.
  - After a handled cancel the tick sends the row notification (0x147a7dfc0, as after a decide), the menu's cancel event (+0x510), then the cancel sound.
- **The main menu answers "no" at 0xE5 and "not handled" at 0xEF** (the shared stubs 0x1416b50a0 `xor al, al; ret`), so the stock main menu has no cancel at all. Its footer shows only Confirm.
  - 51 of the 106 menu-page vtables override 0xEF; a page's override goes back a page and answers handled.
- **RVNG swaps the main menu vtable's 0xE5 and 0xEF.** While a page is up it answers yes, then takes the press (`main menu: B/Esc n on RVNG's page: BACK`). Lua then runs the page's BACK row (LEAVE LOBBY in the lobby).
  - With no page up, both pass on to the game's answers.
  - Both are swapped only when the cancel input is seen to end in 0xEF in this build; both or neither.
- **Test:** `RVNG_MenuBack(menu)` sets the menu's pending-cancel byte (its offset read from the cancel input's code), so the game's own tick runs the whole path. Posted keys don't reach an unfocused game.
  - The first try called the cancel input directly. It answered 0: with no cancel flag set it returns before 0xEF.
- **In game:** `ui_pages` 26/26 (22:39): B/Esc in the lobby went to MULTIPLAYER, and on MULTIPLAYER to the stock main menu with the cursor on MULTIPLAYER. The picture shows the menu as normal.
- **Found on the way:** `Ready.reset()` wrote the row's old name, COMPETITIVE 1V1, back over MULTIPLAYER. BACK then couldn't find MULTIPLAYER for the cursor. Fixed; it writes MULTIPLAYER.
- **Not tested by the kit:** the real controller and keyboard press. Step 7 of the hand check in `docs/IN_GAME_TESTS.md` covers it.

### 9.7 Where this leaves the two-PC test (2026-11-19 04:50)

**Proven in game on one PC (runtime 0.3.3; the full regression of 13 suites, 205 in-game checks, passed 04:00–04:48):**
- the offline state;
- travel, the state machine, the start (D2), the end (W1) and the exit (D6);
- the gates and the boot menu (D5, D7, in every install);
- the COMPETITIVE 1V1 row (the press itself still needs a hand check);
- factions;
- the opponent's copy (the native remote spawn);
- both planes' and the game mode's network objects;
- Send replaced (D1) with the per-class filter;
- the game's own encode, decode and router;
- the synced clock;
- role 3;
- host damage on the copy, the kill and score, the copy's respawn;
- the guest's DamageClient applied by the host's handler (7b);
- D3/D4 on a guest;
- the host's ScoreUpdate applied by the game's handler;
- death and respawn relayed;
- the game's cheat reports switched off at the source (D8, every install; 9.9);
- the network wall: every send point to Bandai's services refuses, all 11 gates false (D9, every install; 9.10).

The loopback stands in for the other PC in all of these.

**What remains, in order** (2026-11-19 evening: steps 1-3 are built, 9.11 and 9.12; the two-PC run is next):
1. **The Steam transport API:** decided: ISteamNetworkingMessages, relay-only (9.11).
   - Survival's link uses ISteamNetworking v006 (`SendP2PPacket`), which tries direct connections first and can expose IP addresses.
   - ISteamNetworkingMessages can be made relay-only (Valve's relays, no IPs).
2. **The link layer:**
   - framing;
   - **hello**: userId, name, player number, the full airset, the mod scan;
   - a heartbeat (link lost after about 6 s);
   - the **clock**: the guest writes the measured offset into its `c[0x20]`, as RealTime does, so one synced clock runs on both PCs;
   - **go**: D2 releases both PCs at one synced time;
   - **bye**.
3. **Wiring it to what exists:**
   - The player number (host 1, guest 2) comes from the matchmaker.
   - FillOpponent fills the peer's real identity and airset, instead of cloning the local airset. **The name is done** (2026-11-19 evening, 9.12: the server's opponent name through `RVNG_OppName`, seen on the HUD). **The airset is not:** its selector layout is found, and the plan and the open DLC question are in 9.12.
   - Factions: host Alpha, guest Bravo.
   - Registration happens at state 14.
   - D1 captures go to the link instead of the loopback. Received bytes go through decode → `RecvAllowed` → router, with sender = the peer's number.
   - D3/D4 on the guest.
   - The host's ScoreUpdates go to the link.
   - On link loss, `vf+0xdd0(gm, 0, 0, played ≥ 105 s)` (9.8). It is proven for Finished; Aborted first needs D6 to redirect AbortPath.
4. **The two-PC test (9, test 8):**
   - the release skew;
   - damage both ways;
   - score parity;
   - respawn relays;
   - link pulls at 60 s and 150 s.

## 10. Open questions

- Whether the Result map waits for EvaluationList or reward data offline.
- What else role 3 changes on an offline plane.
- Whether `GM+0x520` arms the combat-zone check in DM.
- The setter of `plane+0x8b1`, which is unknown.
- The writer of `ULiveAccountSaveGame.CheatRecordList +0x430`, which was not found. Partly answered (2026-11-19): that save is only read or written behind gate B, which RVNG always refuses. After every gated run only Campaign.sav differs (9.5).
