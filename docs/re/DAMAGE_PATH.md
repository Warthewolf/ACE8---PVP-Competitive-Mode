# The damage path: test 7, D3 and D4

This is static analysis of the 2026-11-02 exe (2026-11-19). Part A was confirmed in game the same night (DEATHMATCH_NATIVE.md 9.6). Scratch files are in `build/re_scratch/damage/`, including `sigs.txt` with every signature below.

Labels: [S] = static-verified; [I] = inferred.

## One hit, step by step [S]

1. **Weapon hit.** `ALiveExplosiveWeapon::Explode` 0x147f22c50 → `ApplyDamageTo` 0x147f246e0. That builds an `FLiveDamageEvent` and calls `target->vf[0xa38](target, dmg, &ev, attacker = weapon+0x368, causer = weapon)`.
2. **Plane TakeDamage** 0x147d49d30, plane vtable 0x14cbef168, slot 0xa38:
   - returns 0 if now < `+0x3ae0`;
   - multiplies by the defence factor `+0x1328→+0x1a7fc` (except type 0xe);
   - the DeathToEndure/Endure parts (0x341/0x342) can cap a lethal hit at 1 HP;
   - then base TakeDamage 0x147d0fde0.
3. **Base TakeDamage** 0x147d0fde0:
   - needs `+0xdb9`;
   - crash = type 7/8/9;
   - CanBeDamagedBy (E8 at +0xc6 → 0x147d1a990 → 0x15c709b60) for an attacker that isn't a crash;
   - CanTakeDamage 0x147d12950 (E8 at +0xed): alive, enemy, and spawn protection `+0xdfc` = 0 unless a crash;
   - modifiers `vf+0xa40` (none when there is no causer);
   - clamps the damage to health + shield;
   - builds the `FLiveDamageInfo`;
   - at 0x147d1037d, `SM+0x1fa == 0` → **AuthoritativeApply** (call 0x147d103e1, returns to **0x147d103e6**).
4. **AuthoritativeApply** 0x147d104a0(victim, info by value):
   - kill if damage ≥ shield + health;
   - ApplyDamageResult 0x147d1b070;
   - children and parent sharing;
   - **BroadcastDamage** 0x147d1af10, which ends in the info destructor 0x147053630 (the callee frees the info).
5. **ApplyDamageResult / ApplyDamageInternal** 0x147d10820:
   - shield first, then ModifyHealth 0x147d0c830;
   - `+0xda8 = clamp(health × 10)`;
   - last hit `+0x480/+0x484/+0x48c` and last player attacker `+0x498/+0x4a0`;
   - death check 0x147d15270 → `vf+0xb38`;
   - at 0x147d10ea1 (`SM+0x1fa == 0`) the **score function** 0x147d10f70.
6. **Score function** 0x147d10f70(victim, dmg, attacker, weaponId, indirect):
   - the calculator 0x147d11450 makes `{u8 type, i32 value}` per scorer;
   - if the scorer has a network object: **ScoreAddition** 0x1474a9c70 → Send;
   - AddScore `vf+0xc10` into `+0xe08` (TMap<u8, float>), plus the pop-up `vf+0xc20` for the local plane;
   - TotalScore is 0x147d19600.
   - Two more callers have no `+0x1fa` gate: 0x147e8f892 and 0x147e8f913.
7. **BroadcastDamage:**
   - remaps WeaponId 0x68→0x1b and 0x69→0x1a;
   - bit7 = IsHost(NM) 0x1474b38d0;
   - SendDamage 0x1474a9360 stamps **the victim's** key and the synced time.
8. **Death:**
   - Death 0x147d56780 sets `+0x3c2c/+0x3c2e = 1`. DestroyedLocation (0x147d61450) is sent for role 3 only.
   - The respawn timer runs in the plane tick with no role gate.
   - **A role-2 copy comes back only through a Respawn message.** Its handler 0x1474ab4f0 calls `vf+0xbf8` 0x147d5cd60, which also sets spawn protection 0x147d187f0: 5 s, in `GM+0x818` by key.

**CanBeDamagedBy** returns false when:
- the attacker is a player of role 2; or
- the victim is role 2 and the attacker is NULL or role 1.

A replica's explosions therefore never damage anything.

## Structs [S]

```c
typedef struct { void *data; int32_t num, max; } TArr;
typedef struct {            /* FLiveDamageEvent, 0x40, const& (the caller owns it) */
  double  HitLoc[3];        /* +0x00 (used only with a causer) */
  uint8_t DamageType;       /* +0x18 missile 2, bomb 6, crash 7/8/9 */
  uint8_t Flag19;           /* +0x19 0 for a direct hit */
  uint8_t _p[6]; TArr A20;  /* +0x20 */
  TArr A30;                 /* +0x30 -> info.A38 */
} FLiveDamageEvent;
typedef struct {            /* FLiveDamageInfo, 0x48, by value; the CALLEE runs the destructor 0x147053630 */
  float Damage; uint8_t DamageType; uint8_t _p[3];  /* +0x00, +0x04 */
  void *Attacker;                                   /* +0x08 */
  uint8_t WeaponNumber, WeaponId; uint8_t _q[6];    /* +0x10, +0x11 (0/0 without a causer) */
  void *WeaponObj;                                  /* +0x18 */
  uint8_t Killed, B21, B22, B23, B24; uint8_t _r[3];/* +0x20 .. +0x24 */
  TArr A28, A38;                                    /* +0x28, +0x38 */
} FLiveDamageInfo;
```

**FLiveMessageDamage** (0x48 bytes, vtable 0x14bfd70d0) and **FLiveMessageDamageClient** (0x38 bytes, vtable 0x14bfd70b0):

| Offset | Field |
|---|---|
| +0x08 | TriggerTime |
| +0x10 / +0x14 | key |
| +0x20 | u8 attacker key type |
| +0x24 | u32 attacker key id |
| +0x28 | u8 WeaponNumber |
| +0x29 | u8 WeaponId |
| +0x2a | u8 DamageType |
| +0x2c | i32 Damage = (int)(dmg + 1e-5) |
| +0x30 | u8 Attribute: bit0 B21, bit1 B22, bit3 B23, bit4 B24, bit7 IsHost |
| +0x31 | u8 Killed |
| +0x34 | Damage only: Health |
| +0x38 | Damage only: TArray of EM data |

**In game (test 7)** two Damage messages, both keyed 2/2 (the copy), attacker 2/1, DamageType 2:

| Hit | Damage | +0x30 | Killed |
|---|---|---|---|
| 1 | 0x21 (33) | 0x80 | 0 |
| Lethal | 0x4F (79) | 0x80 | 1 |

## A. Test 7 on one PC: done, runtime 0.3.0

- RVNG calls the copy's `vf[0xa38](copy, dmg, &ev, localPlane, NULL)` with `ev.DamageType = 2` and HitLoc = the copy's location. The local plane is role 3 and the host. The call runs on the game thread, in the slot pump's pre-hook.
- It hits for 30 % of MaxHealth (`+0x3b4`, float), then for health + shield + 10 (lethal), then respawns the copy with `vf[0xbf8](copy, &loc, &rot, 0)`.
- **Proof read:** health `+0xda8` (×10), shield `+0x1400` (×10), TotalScore 0x147d19600, and the Damage and ScoreAddition messages at Send. See DEATHMATCH_NATIVE.md 9.6.
- **Variant A2:** AuthoritativeApply directly with a hand-filled info. It skips CanBeDamagedBy.
- **Variant 7b, done (runtime 0.3.0, 33/33):** the host half of D3 on one PC: a DamageClient keyed 2/1 with attacker 2/2, non-lethal, through serialize → DeserSp → Router (uid+8 = 2).
  - It encodes to 22 bytes.
  - The host's handler damaged the local plane (102 → 72) and scored the copy (545).

## B. D3 and D4 on the guest (for the two-PC step)

### D3: detour AuthoritativeApply 0x147d104a0

`void(ALiveGameObject* victim, FLiveDamageInfo* info)`. Its first 14 bytes hold no RIP-relative instruction, so an inline hook is fine.
- **TakeDamage's local branch ⇔ the return address is 0x147d103e6** (TD_localAuthCall + 0x19).
- Other callers return to 0x147d106be (children), 0x147d1078f (parent) and 0x1474aaf74 (DamageClient).
- **Alternative:** patch the E8 at 0x147d103e1 to an RVNG thunk through a jump island.

```c
if (!guest || ret != g_tdLocalRet || *(u8*)(v+0xed8) != 2 || !N(v) || *(u64*)(N(v)+0x28) != (2ull<<56|1)) return Orig(v,i);
if (i->DamageType==7||i->DamageType==8||i->DamageType==9 || i->Attacker != g_myPlane) { InfoDtor(i); return; }  /* the host decides */
uint8_t wid = i->WeaponId; if (wid==0x68) wid=0x1b; else if (wid==0x69) wid=0x1a;      /* BroadcastDamage's remap */
void *mc = DCGetter();                      /* E8 target at DCHandler+0x34 (0x1452b4150); metaclass 0x14e4c2440 */
uint8_t *m = ((void*(**)(void*))*(void**)mc)[3](mc);   /* Create 0x1452b40d0: GMalloc(0x38,0x10), zeroed, vtbl 0x14bfd70b0 */
*(i64*)(m+0x08)=SyncedNow(); m[0x10]=2; *(u32*)(m+0x14)=1;     /* victim = the host's plane */
m[0x20]=2; *(u32*)(m+0x24)=2;                                  /* attacker = the guest's own key */
m[0x28]=i->WeaponNumber; m[0x29]=wid; m[0x2a]=i->DamageType;
*(i32*)(m+0x2c)=(int)(i->Damage+1e-5f);
m[0x30]=(i->B21?1:0)|(i->B22?2:0)|(i->B23?8:0)|(i->B24?0x10:0);  /* bit7 = 0 */
m[0x31]=i->Killed;
/* serialize and put it on the link (D1 send rule DamageClient: guest, key = host) */
((void(**)(void*,int))*(void**)m)[2](m,1);  /* scalar-deleting destructor 0x1452140e0 */
InfoDtor(i);                                /* 0x147053630: the callee owns the by-value info */
```

- **Native shared_ptr, if needed:** `blk = GMalloc->vf[0x28](0x18, 0x10)` = `{vtbl 0x14af12de0, uses 1, weaks 1, obj}`, the same shape DeserSp makes. GMalloc is `*(FMalloc**)0x14e410280`; if it is null, call 0x141725640.
- **Host side, all native.** The DamageClient handler 0x1474aaae0 → ProcessDamage 0x1474aacb0(N, sp, 1):
  - attacker lookup by key on `GI+0x910` (0x1474bbfe0);
  - cheat check 0x1474a3cb0;
  - IsHost → AuthoritativeApply(host plane) → score (the scorer is the guest copy) → BroadcastDamage → a Damage keyed 2/1 with attacker 2/2 goes back to the guest.
  - CanBeDamagedBy and spawn protection are not re-checked on the host.
- **Critical host risk:**
  - In 0x1474a3cb0, if `attackerCopy->vf960(WeaponNumber)` is NULL (or an ALiveWeaponUAV with null `+0xc00`), it crashes at 0x1474a3e46.
  - Before injecting, check that WeaponNumber is less than `*(int*)(*(*(*(copy+0x16a8)+0x2e0)+0xb0)+0x30)` and that the element's object at +0x40 is non-null. Check the same on the guest against its own plane.
  - Also accept only a key equal to the host's own plane, an attacker `2<<56|peer`, a type other than 7/8/9, and a sane damage value.

### D4: on the guest, the score function returns at once

- Inline hook on 0x147d10f70, `void(victim, float, attacker, u8, u8)`. No caller uses a result.
- It covers all three callers: 0x147d10ed4, 0x147e8f892 and 0x147e8f913.
- The first 15 bytes have no RIP-relative instruction; the cookie load is at +0xf.
- Install it before the first Damage result arrives.

### Unknowns

- The exact score types and values.
- Whether the copy's `+0xf90` is set.
- Whether a copy emits Health messages.
- Whether ElectronicMeasureEffect damage bypasses TakeDamage.
- Whether DeathToEndure is on the cloned airset. Test 7's lethal hit killed it, so probably not on the test airset.

## Signatures (all unique in the file; fallbacks in `build/re_scratch/damage/sigs.txt`)

| Name | VA | Bytes |
|---|---|---|
| AuthApply | 0x147d104a0 | `48 8B C4 48 89 50 10 48 89 48 08 55 53 56 57 41 56` |
| TD_localAuthCall | 0x147d103cd | `48 8D 54 24 40 48 8D 4D D0 E8 ?? ?? ?? ?? 48 8B D0 48 8B CF E8 ?? ?? ?? ?? 80 7C 24 60 00` (call at +0x14, return at +0x19) |
| TakeDamageBase | 0x147d0fde0 | `48 8B C4 4C 89 40 18 48 89 48 08 55 53 56 57 41 54 41 56 48 8D A8 28 FF FF FF` |
| ScoreFn | 0x147d10f70 | `4C 8B DC 55 49 8D 6B 98 48 81 EC 60 01 00 00 48 8B 05 ?? ?? ?? ?? 48 33 C4 48 89 45 00` |
| DCHandler | 0x1474aaae0 | `48 89 5C 24 08 48 89 74 24 10 48 89 7C 24 18 4C 89 74 24 20 41 57 48 83 EC 40 48 8B 42 08 4C 8B F2` (E8 at +0x34 = DCGetter) |
| TotalScore | 0x147d19600 | `48 89 5C 24 10 48 89 74 24 18 55 57 41 56 48 8D 6C 24 B9 48 81 EC 90 00 00 00 48 8D B1 08 0E 00 00` |
| ProcessDamage | 0x1474aacb0 | `44 88 44 24 18 55 53 56 57 41 54 41 55 41 56 41 57 48 8D AC 24 78 FF FF FF` |
| IsHost | 0x1474b38d0 | `40 53 48 83 EC 20 48 8B D9 E8 ?? ?? ?? ?? 3C C8` |
