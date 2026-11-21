"""kit.py: puts RVNG's mod into the game for one test run, with the self-test, and takes it all out again exactly.

    python -I tools/autotest/kit.py install --suite <name> [--max-s N] [--conf name=value ...]
    python -I tools/autotest/kit.py restore
    python -I tools/autotest/kit.py status

install: every mod folder in ue4ss/Mods except KEEP_MODS (SkipIntro, shared) is MOVED aside into build/autotest/aside
(a rename on the same drive: never copied over, never deleted; the user's choice of 2026-11-18: "Move them aside per
run", SkipIntro kept so the title page needs no input). A ProjectRVNG the user installed counts as theirs and moves too.
Then RVNG's mod is copied in as a NEW folder (a marker first, a sha256 manifest): the Lua scripts, build/native/main.dll,
and the self-test overlay, which only this kit ever installs: rvng_selftest.lua, selftest.txt, an rvng_test.ini for the
suite (probe=1; d2/w1 per suite), and `require("rvng_selftest")` added to the INSTALLED main.lua (the copy only).
restore: RVNG's logs copied to the run folder, our folder removed (only with this install's marker), the user's folders
moved back. A move is recorded as it happens, so a run cut short is still restored exactly."""
import argparse
import glob
import os
import re
import shutil
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

MARKER = '.rvng_autotest_install'
LUA = os.path.join(C.HERE, 'lua')
SUITES = {           # suite: rvng_test.ini lines (docs/IN_GAME_TESTS.md)
    'smoke': {'d2': 0, 'w1': 0, 'd6': 0, 'd7': 1},
    'menu': {'d2': 0, 'w1': 0, 'd6': 0, 'd7': 1},    # (d7: the boot login gate B refuses, ended as failed; 0.2.3)
    'flags': {'d2': 0, 'w1': 0, 'd6': 0, 'd7': 1},
    'dm_a': {'d2': 0, 'w1': 0, 'd6': 0, 'd7': 1},
    'dm_b': {'d2': 1, 'w1': 0, 'd6': 0, 'd7': 1},
    'dm_c': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1},   # (d6: the Result map crashes offline; run of 2026-11-18 18:35)
    'dm_f': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'faction': 2},   # test 6: the local user written as Bravo (0.2.5)
    'dm_s': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'opponent': 1},  # test 3: the opponent's copy, native remote spawn (0.2.6)
    'dm_l': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'opponent': 1, 'loopback': 1},  # test 4: the loopback mirror (0.2.7)
    'dm_l3': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'opponent': 1, 'loopback': 1, 'lb_role3': 1},  # test 5: dm_l, local role 3
    'dm_h': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'opponent': 1, 'loopback': 1, 'lb_role3': 1, 'hit': 1},  # test 7 (0.3.0)
    'dm_g': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'opponent': 1, 'loopback': 1, 'lb_role3': 1, 'hit': 1, 'guest': 1},  # D3/D4
    'dm_x': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'linkloss': 120},   # the lost link: the forced end at 120 s (0.3.4)
    # the link (link.h) on one PC, 2026-11-19: dm_l's mirror carried by a pair of links in the game (wire 1): framing,
    # hello, clock, D2 opened by the agreed GO time; dm_kx: the wire cut 110 s into the match, the link's own loss
    # detection then ends it (the forced end)
    'dm_k': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'opponent': 1, 'loopback': 1, 'wire': 1},
    'dm_kx': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'opponent': 1, 'loopback': 1, 'wire': 1, 'linkloss': 110},
    # the ready-up screen on one PC (2026-11-19): dm_k with the screen first: this PC readies (the stand-in peer with it),
    # the host's LAUNCH, the countdown on the COMPETITIVE 1V1 row, the launch into the match at the agreed time
    'dm_r': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'opponent': 1, 'loopback': 1, 'wire': 1},
    # THE TWO-PC TEST (wire 2): run on both PCs at the same time, each with the other's SteamID (--link-peer), its own
    # player number (--link-player 1 on the host, 2 on the guest) and the same --link-tag. Steam relay-only between
    # them: the hello, the clock, D2 opened at the link's GO time on both, each plane flown on the other PC by its own
    # Physics, then time-up, W1, D6. (Hits across the PCs, D3 to the host and its ScoreUpdates back, are not wired yet.)
    'pvp': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'opponent': 1, 'loopback': 1, 'wire': 2, 'netlog': 1},
    # a normal install's settings (probe=0, no test logger): the web gates shut and the boot menu's login ended anyway
    'prod': {'probe': 0, 'd2': 0, 'w1': 0, 'd6': 0, 'd7': 1},
    # D9 (2026-11-19): prod / dm_c with netlog.h's observe-only network log, to name who opens what (never blocks)
    'net': {'probe': 0, 'd2': 0, 'w1': 0, 'd6': 0, 'd7': 1, 'netlog': 1},
    'net_dm': {'d2': 1, 'w1': 1, 'd6': 1, 'd7': 1, 'netlog': 1},
    # the link's Steam side on one PC (2026-11-19): prod's steps, then Steam's networking found, relay-only set, Valve's
    # relay network ready, this PC's account read, a link to itself refused (netlog=1 shows who reaches out)
    'link': {'probe': 0, 'd2': 0, 'w1': 0, 'd6': 0, 'd7': 1, 'netlog': 1},
    # the main menu's text widgets (2026-11-19): which classes hold the header, the rows and the description line,
    # for the ready-up screen (read only: their classes and texts are logged)
    'ui_scan': {'probe': 0, 'd2': 0, 'w1': 0, 'd6': 0, 'd7': 1},
    # RVNG's menu pages at the main menu, no match (2 min): MULTIPLAYER > RANKED 1V1 > LOBBY > LEAVE > BACK, the cursor
    'ui_pages': {'probe': 0, 'd2': 0, 'w1': 0, 'd6': 0, 'd7': 1},
    # a normal install's match on one PC (0.4.1): probe=0, so the match hooks idle from the start until the ready-up
    # screen's launch arms the match (RVNG_TravelDM with the link up); dm_r's pages, ready-up, match and result, on the
    # in-process link pair (rehearse=1: a stand-in peer instead of Steam); then the disarm after the travel back
    'dm_p': {'probe': 0, 'd2': 0, 'w1': 0, 'd6': 0, 'd7': 1, 'rehearse': 1},
    # the stock pre-sortie hangar from the main menu (2026-11-21, native/hangar.h): a normal install's settings plus
    # hangar=1: the travel into PL_Hangar002, a picture of every page to STANDBY (SORTIE never pressed), the opponent's
    # plane on the wingman's spot, B back out, the other HANGAR MENU pages, QUIT back to the main menu (~6 min)
    'hangar': {'probe': 0, 'd2': 0, 'w1': 0, 'd6': 0, 'd7': 1, 'hangar': 1},
    # RVNG's lobby in the hangar on one PC (0.4.3, rvng_hangar.lua + lobby.h): dm_p's normal install and stand-in peer
    # (rehearse=1, an F-14A): RANKED 1V1, the match found, into the hangar, the walk to STANDBY, READY UP, SORTIE refused
    # then open, the synced launch, the deathmatch with the opponent's copy in its own plane (~6 min)
    'hangar_p': {'probe': 0, 'd2': 0, 'w1': 0, 'd6': 0, 'd7': 1, 'rehearse': 1},
}


def state_path():
    return os.path.join(C.state_dir(), 'kit_state.json')


def save_state(st):
    C.write_json(state_path(), st)


def same_drive(a, b):
    return os.path.splitdrive(os.path.abspath(a))[0].lower() == os.path.splitdrive(os.path.abspath(b))[0].lower()


def manifest(root):
    out = {}
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            out[os.path.relpath(p, root).replace('\\', '/')] = C.sha256(p)
    return out


def patch_main(path):
    src = open(path, encoding='utf-8', newline='').read()
    line = 'require("rvng_probe")'
    if src.count(line) != 1:
        raise SystemExit('kit: the installed main.lua has no single %s to put the self-test after (%s)' % (line, path))
    nl = '\r\n' if '\r\n' in src else '\n'
    src = src.replace(line, line + nl + 'require("rvng_selftest")   -- (tools/autotest/kit.py: test runs only)', 1)
    open(path, 'w', encoding='utf-8', newline='').write(src)


def cmd_install(a):
    if a.suite not in SUITES:
        raise SystemExit('kit: unknown suite %s (%s)' % (a.suite, ', '.join(SUITES)))
    if SUITES[a.suite].get('wire') == 2:                 # the two-PC test: the other PC, this PC's number, the match
        if not re.fullmatch(r'7656119\d{10}', a.link_peer or ''):
            raise SystemExit('kit: --link-peer must be the other PC\'s SteamID64 (17 digits, 7656119...)')
        if a.link_player not in (1, 2):
            raise SystemExit('kit: --link-player must be 1 (the host) or 2 (the guest)')
        if not re.fullmatch(r'[A-Za-z0-9_-]{3,40}', a.link_tag or ''):
            raise SystemExit('kit: --link-tag must be 3-40 letters, digits, _ or - (the same on both PCs)')
    if C.game_running():
        raise SystemExit('kit: the game is running: nothing installed')
    if os.path.exists(state_path()):
        raise SystemExit('kit: an earlier install is still in (build/autotest/kit_state.json): run `kit.py restore` first')
    dll = os.path.join(C.ROOT, 'build', 'native', 'main.dll')
    if not os.path.isfile(dll):
        raise SystemExit('kit: no build/native/main.dll: build it first (sh native/build.sh)')
    mods = C.mods_dir()
    if not os.path.isdir(mods):
        raise SystemExit('kit: no UE4SS Mods folder at %s' % mods)
    aside = C.state_dir('aside')
    if os.listdir(aside):
        raise SystemExit("kit: build/autotest/aside is not empty (an earlier run left the user's folders there?): "
                         'look at it before anything else')
    if not same_drive(mods, aside):
        raise SystemExit('kit: the Mods folder is on another drive than build/autotest: moving aside would be a copy')
    token = uuid.uuid4().hex
    tgt = os.path.join(mods, C.MOD_NAME)
    st = {'token': token, 'suite': a.suite, 'at': time.time(), 'moved': [], 'installed': [], 'phase': 'checking',
          'mods': mods}
    save_state(st)
    keep = {k.lower() for k in C.KEEP_MODS}
    for name in sorted(os.listdir(mods)):                # the user's folders aside first, each move recorded at once
        src = os.path.join(mods, name)
        if not os.path.isdir(src) or name.lower() in keep:
            continue
        if os.path.exists(os.path.join(src, MARKER)):
            raise SystemExit('kit: %s is a test install (its marker): run `kit.py restore`' % src)
        os.rename(src, os.path.join(aside, name))
        st['moved'].append({'name': name, 'target': src})
        st['phase'] = 'moved ' + name
        save_state(st)
    print("kit: the user's mods moved aside: %s (kept: %s)" % (', '.join(m['name'] for m in st['moved']) or 'none',
                                                              ', '.join(C.KEEP_MODS)))
    st['installed'].append({'name': C.MOD_NAME, 'target': tgt})
    st['phase'] = 'copying'
    save_state(st)
    os.makedirs(tgt)                                     # the marker first: a copy cut short is still ours to remove
    open(os.path.join(tgt, MARKER), 'w').write(token)
    src_mod = os.path.join(C.ROOT, 'mod', C.MOD_NAME)
    scripts = os.path.join(tgt, 'Scripts')
    os.makedirs(scripts)
    for f in glob.glob(os.path.join(src_mod, 'Scripts', '*.lua')):
        shutil.copy2(f, scripts)
    shutil.copy2(os.path.join(src_mod, 'enabled.txt'), tgt)
    os.makedirs(os.path.join(tgt, 'dlls'))
    shutil.copy2(dll, os.path.join(tgt, 'dlls', 'main.dll'))
    shutil.copy2(os.path.join(LUA, 'rvng_selftest.lua'), scripts)
    cfg = SUITES[a.suite]
    with open(os.path.join(tgt, 'rvng_test.ini'), 'w', encoding='utf-8') as f:
        f.write('# written by tools/autotest/kit.py for the %s suite (test runs only)\n' % a.suite)
        f.write('probe=%d\ngates=block\nd2=%d\nw1=%d\nd6=%d\nd7=%d\nmission=%d\n' % (cfg.get('probe', 1), cfg['d2'], cfg['w1'],
                                                                                    cfg['d6'], cfg['d7'], a.mission))
        f.write('faction=%d\nopponent=%d\nloopback=%d\nlb_role3=%d\nhit=%d\n' % (cfg.get('faction', 0), cfg.get('opponent', 0),
                                                                               cfg.get('loopback', 0), cfg.get('lb_role3', 0),
                                                                               cfg.get('hit', 0)))
        f.write('guest=%d\nlinkloss=%d\nnetlog=%d\nwire=%d\n' % (cfg.get('guest', 0), cfg.get('linkloss', 0), cfg.get('netlog', 0),
                                                                cfg.get('wire', 0)))
        if cfg.get('rehearse'):
            f.write('rehearse=1\n')
        if cfg.get('hangar'):
            f.write('hangar=1\n')
        if cfg.get('wire') == 2:
            f.write('link_peer=%s\nlink_player=%d\nlink_tag=%s\n' % (a.link_peer, a.link_player, a.link_tag))
    with open(os.path.join(scripts, 'selftest.txt'), 'w', encoding='utf-8') as f:
        f.write('suite=%s\nmax_s=%d\n' % (a.suite, a.max_s))
        if cfg.get('wire') == 2 and a.link_player == 2:
            f.write('hooks=13\n')                        # (the guest: + D3/D4)
        for kv in a.conf or []:
            f.write(kv.strip() + '\n')
    patch_main(os.path.join(scripts, 'main.lua'))
    st['manifest'] = manifest(tgt)
    st['phase'] = 'installed'
    save_state(st)
    print('kit: installed RVNG (suite %s, d2=%d w1=%d d6=%d d7=%d) at %s' % (a.suite, cfg['d2'], cfg['w1'], cfg['d6'], cfg['d7'], tgt))
    return 0


def cmd_restore(_):
    st = C.read_json(state_path())
    if not st:
        print('kit: nothing installed')
        return 0
    if C.game_running():
        raise SystemExit('kit: the game is running: nothing restored (close it, then restore)')
    run_dir = os.environ.get('RVNG_AUTOTEST_RUN') or C.state_dir('runs', 'kit_' + C.now_stamp())
    os.makedirs(run_dir, exist_ok=True)
    bad = 0
    for i in st.get('installed', []):
        tgt = i['target']
        if not os.path.exists(tgt):
            continue
        mk = os.path.join(tgt, MARKER)
        if not (os.path.isfile(mk) and open(mk).read().strip() == st['token']):
            print('kit: %s has no marker of this install: LEFT ALONE (look at it)' % tgt)
            bad += 1
            continue
        logs = os.path.join(tgt, 'logs')
        if os.path.isdir(logs):
            shutil.copytree(logs, os.path.join(run_dir, 'rvng_logs'), dirs_exist_ok=True)
        before = st.get('manifest', {})
        changed = [p for p, h in before.items()
                   if os.path.isfile(os.path.join(tgt, p)) and C.sha256(os.path.join(tgt, p)) != h]
        if changed:
            print('kit: %d installed file(s) changed during the run: %s' % (len(changed), ', '.join(changed[:8])))
        shutil.rmtree(tgt)
        print('kit: the test %s removed' % i['name'])
    aside = C.state_dir('aside')
    for m in reversed(st.get('moved', [])):
        src = os.path.join(aside, m['name'])
        if not os.path.exists(src):
            if os.path.exists(m['target']):
                continue                                  # (already back: an earlier restore that stopped part-way)
            print("kit: the user's %s is neither in build/autotest/aside nor back in place (look at it)" % m['name'])
            bad += 1
            continue
        if os.path.exists(m['target']):
            print("kit: %s is in the way of the user's %s: NOT moved back (look at it)" % (m['target'], m['name']))
            bad += 1
            continue
        os.rename(src, m['target'])
    print("kit: the user's mods moved back: %s" % (', '.join(m['name'] for m in st.get('moved', [])) or 'none'))
    left = os.listdir(aside)
    if left:
        print('kit: build/autotest/aside still holds %s: look at it' % ', '.join(left))
        bad += 1
    if bad:
        print('kit: restore incomplete (%d problem(s)); kit_state.json kept' % bad)
        return 2
    os.remove(state_path())
    print('kit: restored')
    return 0


def cmd_status(_):
    st = C.read_json(state_path())
    if not st:
        print('kit: nothing installed')
    else:
        print('kit: suite %s, phase %s, at %s; moved aside: %s' % (
            st['suite'], st['phase'], time.ctime(st['at']), ', '.join(m['name'] for m in st['moved']) or '-'))
    return 0


def main(argv):
    ap = argparse.ArgumentParser(prog='kit.py')
    sp = ap.add_subparsers(dest='cmd', required=True)
    i = sp.add_parser('install')
    i.add_argument('--suite', default='smoke')
    i.add_argument('--max-s', type=int, default=900)
    i.add_argument('--mission', type=int, default=160010)
    i.add_argument('--conf', action='append', help='name=value for selftest.txt (menu_timeout_s=, watch_s=, ...)')
    i.add_argument('--link-peer', help='pvp: the other PC\'s SteamID64')
    i.add_argument('--link-player', type=int, default=0, help='pvp: 1 host, 2 guest')
    i.add_argument('--link-tag', help='pvp: the match id, the same on both PCs')
    sp.add_parser('restore')
    sp.add_parser('status')
    a = ap.parse_args(argv)
    return {'install': cmd_install, 'restore': cmd_restore, 'status': cmd_status}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
