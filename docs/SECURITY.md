# Security model

## Checks

1. **Request signing.**
   - Each player request carries `x-player-key`, `x-timestamp`, `x-nonce` and `x-signature`.
   - The signature is `HMAC-SHA256(secret, METHOD\nPATH?QUERY\nTS\nNONCE\nsha256(body))`. The query string is part of the signed path.
   - Requests older than 5 minutes and reused nonces are rejected.
2. **File integrity.**
   - Every file in the install is compared to a clean baseline by **size and SHA-256**.
   - A size or hash mismatch on a game file is critical. A missing file is high.
   - Two entries for the same path (case or look-alike twins) are critical (`duplicate_path`). Paths are compared with ASCII-only lowercasing, so a Unicode look-alike such as the Kelvin sign cannot collide with a real file.
   - Symlinks and junctions anywhere in the install are critical (`link_in_install`), because they can point a mod folder anywhere on the disk.
3. **Mod detection.** Each file not in the baseline is either an approved mod (pinned by path, size and hash) or classified as one of:
   - `unapproved_pak_mod`: `.pak/.ucas/.utoc/.sig`, `~mods`, `LogicMods` (the folder itself or anything in it)
   - `proxy_dll_injection`: `dxgi.dll`, `version.dll`, `dinput8.dll`, `dwmapi.dll`, …
   - `unapproved_binary`
   - `unapproved_script_mod`: any `.lua/.py/.js`, wherever it is (the loader's mods folder can be moved with one config line)
   - `unapproved_loader_file`: anything in a `ue4ss/` folder, and `UE4SS-settings.ini`, `mods.txt`, `mods.json` or `enabled.txt` anywhere
   - `unapproved_config`: other `.ini` files (high)
   - `unknown_file`: low severity

   Other rules:
   - An approved mod whose hash changed is `approved_mod_tampered`.
   - A **required** file must be present with exactly its pinned hash. An older approved version at the same path does not count.
   - Admins pin the loader, its settings file and the competitive mod as required; see the README.
   - Every detected mod is stored with its name and size and shown on the player's profile.
   - Retired game builds (`POST /api/admin/baselines/:version/active`) cannot scan clean, and their tokens stop working.
4. **Live aircraft stats.**
   - Stats read from game memory must be within 0.5% of the reference values. A report with no aircraft stats at all is rejected.
   - The mod also samples the stats during the match and sends the most-deviating value with the match log. The pilot's own aircraft must be in it.
   - Tampered values in a pilot's **own** scan or log flag that pilot's account for review.
5. **Match-log cross-validation.** The server checks:
   - both logs agree on score, deaths, aircraft, duration and end reason
   - the end fits the room rules: a kill-target end needs the kill target, a time-limit end needs the time limit, and every match must last at least 30 s
   - a surrender or disconnect only decides the match when **both** logs name the same pilot as the leaver. A one-sided claim, or both pilots blaming each other, is disputed.
   - kill events match the claimed kills
   - banned aircraft and special-weapon rules, checked in **both** logs (a pilot cannot hide their own special-weapon use by stripping it from their log)
   - each pilot's top speed as recorded **by the opponent's client**, against the aircraft's real maximum (+5%). The reference comes from the build both players scanned clean on, never from the logs. A missing reference is disputed, not skipped.

   Any failure → `disputed`, no rating change, and a tournament series gets no rematch until an admin rules.

   An opponent-observed anomaly does **not** flag the suspect's account automatically: one opponent's number is evidence for the admin, not a verdict.
6. **Admin tools.**
   - Ban/flag players.
   - Settle disputes, and void any match. Voiding a verified match reverts the rating deltas, record and K/D. If it belongs to an event series that is already decided, the void is refused.
   - Walk a series over (`POST /api/admin/series/:id/forfeit`) when an entrant is banned, flagged or does not show.
7. **Abuse limits.**
   - Sign-ups are limited per IP. Set `TRUST_PROXY` behind a reverse proxy.
   - Integrity reports are limited to one per 10 s per player and capped in size. Only a summary of very long finding lists is stored, and old reports are deleted.
   - Query parameters are range-checked. Large bodies are only accepted on the report and admin upload routes.
   - The matchmaker never runs on status polls, and only accepts a fixed list of regions.
8. **Website.**
   - Strict CSP: `script-src 'self'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`.
   - All user text is escaped, and only the site's own routes can render.

## Known limits (be honest with players)

- **Client-side trust.** All client-side checks run on hardware the cheater controls. A determined attacker can patch the scanner or the mod so it reports a clean install. The strongest checks are the ones that need **both** clients to agree, and the opponent-observed physics.
- **Scan cache.** The cache is keyed by size, mtime, ctime and inode, but it lives on the player's PC. Use `--no-cache` for event matches. The server cannot enforce this; reports include `scanStats` (hashed vs cached counts) for admins.
- **Settings outside the install.** UE5 keeps user config (for example `Engine.ini` console variables) in `%LOCALAPPDATA%\<Project>\Saved`, outside the install, and the scanner does not read it.
- **Collusion.** Coordinated cheating by both players (match fixing) is not detected.
- **Re-registration.** Accounts are anonymous, so a banned player can sign up again, limited only by the per-IP sign-up limit. Binding accounts to a verified Steam identity (Steam OpenID on sign-up, or a Steam session ticket checked with `ISteamUserAuth/AuthenticateUserTicket`) is the planned fix. The server does not accept a self-reported Steam ID, because an unverified unique ID would let anyone reserve someone else's.
- **Secrets.** The API secret is stored on the player's PC (`credentials.json`, owner-only on Linux/macOS). If it leaks, the account can be impersonated, so an admin should rotate it.
- **Voiding.** Voiding a verified match does not recompute `peak_rating`, or ratings of later matches that used the old rating.
- **High-stakes finals.** Add human measures: streamed matches with a referee and a scan on a supervised machine.
- **Hardening for later.** Sign the mod/scanner builds, move checks into a native module, and add server-side replay review once replay files are understood.
