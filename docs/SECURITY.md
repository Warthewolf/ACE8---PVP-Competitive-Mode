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
   - Symlinks and junctions anywhere in the install are critical (`link_in_install`), because they can point a mod folder anywhere on the disk. The scanner reports every link, whatever its name or place: the exclude list (logs, crash dumps, `Saved`, the bridge folder) only ever skips regular files, so a junction named `x.log`, or `Saved` itself as a link, is still reported.
   - Values in a report are only used if they have the right type; anything else is treated as a mismatch, never as an error. File paths over 1024 characters, module names over 260 and aircraft ids over 128 are refused (413).
3. **Mod detection.** Each file not in the baseline is either an approved mod (pinned by path, size and hash) or classified as one of:
   - `unapproved_pak_mod`: `.pak/.ucas/.utoc/.sig`, `~mods`, `LogicMods` (the folder itself or anything in it)
   - `proxy_dll_injection`: `dxgi.dll`, `version.dll`, `dinput8.dll`, `dwmapi.dll`, …
   - `unapproved_binary`
   - `unapproved_script_mod`: any `.lua/.py/.js`, wherever it is (the loader's mods folder can be moved with one config line)
   - `unapproved_loader_file`: anything in a `ue4ss/` folder, and `UE4SS-settings.ini`, `mods.txt`, `mods.json`, `enabled.txt` or `override.txt` anywhere (`override.txt` next to the proxy DLL points UE4SS at a whole loader elsewhere on the disk)
   - `unapproved_config`: other `.ini` files (high)
   - `unknown_file`: low severity

   Other rules:
   - An approved mod whose hash changed is `approved_mod_tampered`, and it flags the account.
   - A **required** mod (the loader, its settings, the competitive mod) must be installed as one complete pinned build, every file with exactly its pinned hash. Builds of a mod share a name and differ by `version`; while players update, admins can require two builds at once and either passes. Cosmetic copies at the same paths never count.
   - Each build lists every one of its files, including files it shares with another build, so uploading, retiring or re-uploading one build never changes another. A file that several builds list is approved while any of them is; it is out of date only when all of them are retired.
   - A file belongs to one mod: an upload that would pin a file another mod already pins is refused (409). The competitive mod sits inside the loader's Mods folder, so the loader is approved with `rvng approve --exclude Mods/ProjectRVNG`. Otherwise the loader's build would require one release of the competitive mod, and updating either would lock everyone out.
   - Old builds are **retired**, not deleted (`POST /api/admin/mods/retire`, or `DELETE /api/admin/mods/:id`, which retires). A retired build is still recognised: a pilot who has it is rejected with `outdated_mod` and is never flagged. Only `?purge=1` deletes a row, for one added by mistake; a purged build that is still installed reads as tampered.
   - `rvng approve` never pins files the players' scanner does not report (logs, crash dumps).
   - Every detected mod is stored with its name and size and shown on the player's profile.
   - Retired game builds (`POST /api/admin/baselines/:version/active`) cannot scan clean, and their tokens stop working.
4. **Live aircraft stats.**
   - Stats read from game memory must be within 0.5% of the reference values. A report with no aircraft stats at all is rejected.
   - The mod also samples the stats during the match and sends the **lowest and highest** sampled value of each stat with the match log. The server checks both, so a changed value shows up whenever it was active, even if a trainer was already on at match start or off for the last sample. The pilot's own aircraft must be in both.
   - Tampered values in a pilot's **own** scan or log flag that pilot's account for review.
5. **Match-log cross-validation.** The server checks:
   - both logs agree on score, deaths, aircraft, duration and end reason
   - the end fits the room rules: a kill-target end needs the kill target, a time-limit end needs the time limit, and every match must last at least 30 s
   - a surrender or disconnect only decides the match when **both** logs name the same pilot as the leaver. A one-sided claim, or both pilots blaming each other, is disputed.
   - kill events match the claimed kills
   - banned aircraft and special-weapon rules, checked in **both** logs (a pilot cannot hide their own special-weapon use by stripping it from their log)
   - each pilot's top speed as recorded **by the opponent's client**, against the aircraft's real maximum (+5%). The reference comes from the build both players scanned clean on, never from the logs. A missing reference is disputed, not skipped.

   Any failure → `disputed`, no rating change, and a tournament series gets no rematch until an admin rules.

   A room that went live but got no log from either pilot is closed once the time limit (3 hours for rooms without one) plus 15 minutes has passed, so a fake room code cannot lock both pilots out of the queue. A ranked room is voided. An event game goes to an admin instead: voiding it would hand the series a rematch, and a pilot who is losing could stall the room to get one.

   Logs for a room the sweep closed are still accepted for 24 hours. Two logs settle the match as usual. A single log sends it to an admin (`missing_opponent_report`), like a match where the opponent never reported, so a pilot who is losing cannot make the room's result disappear by holding back their log. An admin can settle or void any room the sweep closed, at any time, and an admin's ruling or void is final. Rooms closed by an older release, or voided by an admin there, never reopen.

   An opponent-observed anomaly does **not** flag the suspect's account automatically: one opponent's number is evidence for the admin, not a verdict.
6. **Admin tools.**
   - Ban/flag players.
   - Settle disputes, and void any match. Voiding a verified match reverts the rating deltas, record and K/D, and the match no longer shows a winner, score or rating change (the flag `admin_void` keeps what was undone).
   - Voiding one of the wins that decided an event series reopens the series: the winner leaves the next round again, or for a final the title is cleared. This is refused once games of the next round have been played; void those games first. The admin can then replay the series or walk it over.
   - If the next round was decided by walkover without games (typically after a ban), the void still reverts the match's rating, record and K/D, but the bracket result stands: a walkover cannot be undone. The `admin_void` flag then records `series: "kept"`.
   - Walk a series over (`POST /api/admin/series/:id/forfeit`) when an entrant is banned, flagged or does not show.
7. **Abuse limits.**
   - Sign-ups are limited per client address, counting an IPv6 client per /64 network (the address is fully expanded first, so every spelling of a network gives the same key). Behind a reverse proxy set `TRUST_PROXY` to the number of proxy hops (`1`) or to the proxy addresses (`loopback, 10.0.0.0/8`), otherwise every client shares the proxy's address. `TRUST_PROXY=true` is refused at startup: it trusts every `X-Forwarded-For` entry, and with a proxy that appends to the header each client would pick its own address. A forwarded value that is not an IP address counts as the connection's address.
   - Integrity reports are limited to one per 10 s per player (the companion waits and repeats the scan by itself) and capped in size. Stored findings are kept within 200 entries and 128 KB, with a per-code summary of the rest. One finding of every code is kept first, those that flag the account before all others, so the evidence for a flag is never the part that is cut. Old reports are deleted.
   - Query parameters must be plain values and are range-checked; anything else counts as absent. Request bodies may nest at most 32 levels. Large bodies are only accepted on the report and admin upload routes.
   - The matchmaker never runs on status polls, and only accepts a fixed list of regions.
8. **Website.**
   - Strict CSP: `script-src 'self'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`.
   - All user text is escaped, and only the site's own routes can render.

## Known limits (be honest with players)

- **Client-side trust.** All client-side checks run on hardware the cheater controls. A determined attacker can patch the scanner or the mod so it reports a clean install. The strongest checks are the ones that need **both** clients to agree, and the opponent-observed physics.
- **Scan cache.** The cache is keyed by size, mtime, ctime and inode, but it lives on the player's PC. Use `--no-cache` for event matches. The server cannot enforce this; reports include `scanStats` (hashed vs cached counts) for admins.
- **Settings outside the install.** UE5 keeps user config (for example `Engine.ini` console variables) in `%LOCALAPPDATA%\<Project>\Saved`, outside the install, and the scanner does not read it.
- **Loader launch options and environment.** UE4SS's `--ue4ss-path` launch argument (for example in Steam launch options) loads a UE4SS.dll, its settings and its Mods folder from anywhere on the disk and leaves no file in the install. Newer UE4SS builds also read extra Mods folders from the `UE4SS_MODS_PATHS` environment variable. Neither the scanner nor the mod reads the game's command line or environment. The proxy DLL itself is pinned, and loaded modules are compared by file name; reporting loaded modules with full paths (planned) would catch a UE4SS.dll loaded from elsewhere, but not extra Mods folders.
- **Collusion.** Coordinated cheating by both players (match fixing) is not detected.
- **Re-registration.** Accounts are anonymous, so a banned player can sign up again, limited only by the per-IP sign-up limit. Binding accounts to a verified Steam identity (Steam OpenID on sign-up, or a Steam session ticket checked with `ISteamUserAuth/AuthenticateUserTicket`) is the planned fix. The server does not accept a self-reported Steam ID, because an unverified unique ID would let anyone reserve someone else's.
- **Secrets.** The API secret is stored on the player's PC (`credentials.json`, owner-only on Linux/macOS). If it leaks, the account can be impersonated, so an admin should rotate it.
- **Voiding.** Voiding a verified match does not recompute `peak_rating`, or ratings of later matches that used the old rating. A series decided by walkover is not reopened by voiding one of its games, and a series whose next round was walked over keeps its result.
- **High-stakes finals.** Add human measures: streamed matches with a referee and a scan on a supervised machine.
- **Hardening for later.** Sign the mod/scanner builds, move checks into a native module, and add server-side replay review once replay files are understood.
