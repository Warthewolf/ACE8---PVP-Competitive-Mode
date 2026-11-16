# Security model

## Checks

1. **Request signing.** Each player request carries `x-player-key`, `x-timestamp`, `x-nonce` and `x-signature`. The signature is `HMAC-SHA256(secret, METHOD\nPATH\nTS\nNONCE\nsha256(body))`. Requests older than 5 minutes and reused nonces are rejected.
2. **File integrity.** Every file in the install is compared to a clean baseline by **size and SHA-256**.
   - A size or hash mismatch on a game file is critical.
   - A missing file is high.
3. **Mod detection.** Each file not in the baseline is either an approved mod (pinned by path, size and hash) or classified as one of:
   - `unapproved_pak_mod`: `.pak/.ucas/.utoc`, `~mods`, `LogicMods`
   - `proxy_dll_injection`: `dxgi.dll`, `version.dll`, `dinput8.dll`, …
   - `unapproved_binary`
   - `unapproved_script_mod`: UE4SS Lua
   - `unknown_file`: low severity

   An approved mod whose hash changed is `approved_mod_tampered`. A missing required mod is rejected. Every detected mod is stored with its name and size and shown on the player's profile.
4. **Live aircraft stats.** Stats read from game memory must be within 0.5% of the reference values. If they aren't, the scan is rejected and the account is flagged for review.
5. **Match-log cross-validation.** The server checks:
   - both logs agree on score, deaths, aircraft and duration
   - kill events match the claimed kills
   - banned aircraft and special-weapon rules
   - each pilot's top speed as recorded **by the opponent's client**, against the aircraft's real maximum (+5%)

   Any failure → `disputed`, no rating change. A speed anomaly flags the suspect's account.
6. Admins can ban/flag players, void matches or settle disputes.

## Known limits (be honest with players)

- All client-side checks run on hardware the cheater controls. A determined attacker can patch the scanner or the mod so it reports a clean install. The scan cache (keyed by size + mtime) can also be edited, so use `scan --no-cache` for tournament matches.
- The strongest checks are the ones that need **both** clients to agree, and the opponent-observed physics. Coordinated cheating by both players (match fixing) is not detected.
- The API secret is stored on the player's PC. If it leaks, the account can be impersonated, so an admin should rotate it.
- For high-stakes finals, add human measures: streamed matches with a referee and a scan on a supervised machine.
- Hardening for later: sign the mod/scanner builds, move checks into a native module, add server-side replay review once replay files are understood.
