"""job.py: one RVNG self-test run, started BY the gate (never on its own: it asks the gate to launch the game).

    python -I tools/autotest/gate.py run --who rvng --label "dm_a" --max-minutes 15 \
        --cleanup "python -I tools/autotest/kit.py restore" -- \
        python -I tools/autotest/job.py --suite dm_a

Order: the game not running; kit.py install (RVNG + the self-test, the user's other mods aside); provenance (RVNG's
git HEAD and dirty state, main.dll's version and sha256, the self-test's sha256) in the run folder; the gate's launch;
then RVNG's log (Mods/ProjectRVNG/logs/RVNG_<stamp>.log, the native runtime's, which the self-test writes into) followed:
every `selftest:` line copied to the verdict; no new line for WATCHDOG_S = the watchdog (the game closed). On
`selftest: RESULT n/m` the game is closed (taskkill: the deathmatch fast path must not run into the game's own exit) and
kit.py restore copies the logs out. verdict.txt in the run folder; rc 0 all passed, 1 a check failed, 2 no RESULT
(watchdog, the game gone, a refused launch). Copied from Survival Mode's tools/autotest/job.py and adapted."""
import argparse
import glob
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

WATCHDOG_S = 180          # (a level load holds Lua's tick; the runtime still logs every 10 s at most)
PY = [sys.executable, '-I']


def git(*args):
    try:
        return subprocess.run(['git', *args], cwd=C.ROOT, capture_output=True, text=True,
                              creationflags=C.NO_WINDOW).stdout.strip()
    except OSError:
        return '?'


def provenance(out):
    dll = os.path.join(C.ROOT, 'build', 'native', 'main.dll')
    src = open(os.path.join(C.ROOT, 'native', 'rvng_rt.c'), encoding='utf-8').read()
    ver = (re.search(r'#define RT_VERSION_A\s+"([^"]+)"', src) or [None, '?'])[1]
    st = os.stat(dll)
    lines = [
        'runtime %s: main.dll %d bytes, built %s, sha256 %s' % (ver, st.st_size, time.ctime(st.st_mtime), C.sha256(dll)[:16]),
        'self-test rvng_selftest.lua sha256 %s' % C.sha256(os.path.join(C.HERE, 'lua', 'rvng_selftest.lua'))[:16],
        'RVNG git %s (%s)' % (git('rev-parse', '--short', 'HEAD'),
                              'dirty' if git('status', '--porcelain', '--', 'native', 'mod', 'tools') else 'clean'),
        'path: the fast path (no input; the deathmatch by the game\'s own mission-by-ID travel), test-only overlay (kit.py)',
    ]
    open(out, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    return lines


def newest_log(after):
    d = os.path.join(C.mods_dir(), C.MOD_NAME, 'logs')
    best = None
    for p in glob.glob(os.path.join(d, 'RVNG_*.log')):
        m = os.path.getmtime(p)
        if os.path.getctime(p) >= after - 5 and (best is None or m > best[0]):
            best = (m, p)
    return best[1] if best else None


SHOTS = {'n': 0}


def shoot(line, note):
    """a `selftest: SHOT <name>` line: the game's window captured (PrintWindow, no focus taken) to the run folder's
    shots/NN_<name>.png, and whether the window answers messages (IsHungAppWindow)"""
    m = re.search(r'selftest: SHOT (\S+)', line)
    if not m:
        return
    SHOTS['n'] += 1
    d = os.path.join(os.environ['RVNG_AUTOTEST_RUN'], 'shots')
    os.makedirs(d, exist_ok=True)
    out = os.path.join(d, '%02d_%s.png' % (SHOTS['n'], m.group(1)))
    try:
        hw = C.game_window(set(C.pids_of(C.GAME_EXE)))
        hung = bool(hw and C._user32.IsHungAppWindow(hw))
        size = C.capture_window(hw, out) if hw else None
        note('job: picture %s: %s; the window %s' % (m.group(1), ('%dx%d %s' % (size[0], size[1], os.path.basename(out)))
                                                    if size else 'not captured', 'is NOT responding' if hung else 'responds'))
    except Exception as ex:                          # (only a picture: never in the way of the run)
        note('job: picture %s failed: %s' % (m.group(1), ex))


VK = {'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27, 'enter': 0x0D, 'esc': 0x1B, 'space': 0x20}


def keys(line, note):
    """a `selftest: KEYS down,down,enter` line: the keys posted to the game's window (WM_KEYDOWN/WM_KEYUP; no focus
    taken), 0.5 s apart"""
    m = re.search(r'selftest: KEYS (\S+)', line)
    if not m:
        return
    try:
        hw = C.game_window(set(C.pids_of(C.GAME_EXE)))
        if not hw:
            note('job: keys %s: no game window' % m.group(1))
            return
        from ctypes import wintypes
        C._user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
        C._user32.MapVirtualKeyW.argtypes = (wintypes.UINT, wintypes.UINT)
        for k in m.group(1).split(','):
            vk = VK.get(k.lower())
            if vk is None:
                continue
            scan = C._user32.MapVirtualKeyW(vk, 0)
            C._user32.PostMessageW(hw, 0x0100, vk, 1 | (scan << 16))                    # WM_KEYDOWN
            time.sleep(0.08)
            C._user32.PostMessageW(hw, 0x0101, vk, 1 | (scan << 16) | (3 << 30))        # WM_KEYUP
            time.sleep(0.5)
        note('job: keys %s posted to the game window' % m.group(1))
    except Exception as ex:                          # (never in the way of the run)
        note('job: keys %s failed: %s' % (m.group(1), ex))


def stalled_start():
    """UE4SS.log's last 30 lines all "Still waiting for object construction, N objects" with one N."""
    try:
        tail = open(C.ue4ss_log(), encoding='utf-8', errors='replace').read().splitlines()[-30:]
    except OSError:
        return False
    counts = {l.rsplit(',', 1)[-1].strip() for l in tail if 'Still waiting for object construction' in l}
    return len(tail) == 30 and all('Still waiting for object construction' in l for l in tail) and len(counts) == 1


def main(argv):
    ap = argparse.ArgumentParser(prog='job.py')
    ap.add_argument('--suite', default='smoke')
    ap.add_argument('--max-s', type=int, default=900)
    ap.add_argument('--mission', type=int, default=160010, help='the deathmatch MissionID (160010/20/30/40/60)')
    ap.add_argument('--conf', action='append', default=[], help='name=value for the self-test (selftest.txt)')
    ap.add_argument('--link-peer', default='', help='pvp: the other PC\'s SteamID64')
    ap.add_argument('--link-player', type=int, default=0, help='pvp: 1 host, 2 guest')
    ap.add_argument('--link-tag', default='', help='pvp: the match id, the same on both PCs')
    a = ap.parse_args(argv)
    who = os.environ.get('RVNG_AUTOTEST_WHO')
    run_dir = os.environ.get('RVNG_AUTOTEST_RUN')
    if not (who and run_dir):
        print('job: run me through gate.py run (it sets RVNG_AUTOTEST_WHO / RVNG_AUTOTEST_RUN)')
        return 2
    verdict = os.path.join(run_dir, 'verdict.txt')

    def note(line):
        C.log_to(verdict, line)
        print(line, flush=True)
    if C.game_running():
        note('job: the game is running: nothing done')
        return 2
    r = subprocess.run(PY + [os.path.join(C.HERE, 'kit.py'), 'install', '--suite', a.suite, '--max-s', str(a.max_s), '--mission', str(a.mission)]
                       + [x for kv in a.conf for x in ('--conf', kv)]
                       + (['--link-peer', a.link_peer, '--link-player', str(a.link_player), '--link-tag', a.link_tag]
                          if a.link_peer else []),
                       capture_output=True, text=True, creationflags=C.NO_WINDOW)
    note((r.stdout + r.stderr).strip())
    if r.returncode != 0:
        note('job: the install failed: no launch')
        return 2
    for line in provenance(os.path.join(run_dir, 'provenance.txt')):
        note('provenance: ' + line)
    t_launch = time.time()
    r = subprocess.run(PY + [os.path.join(C.HERE, 'gate.py'), 'launch', '--who', who], capture_output=True, text=True,
                       creationflags=C.NO_WINDOW)
    note('launch: ' + (r.stdout + r.stderr).strip())
    rc = 2
    if r.returncode == 0:
        rc = follow(t_launch, a, note)
    if C.game_running():
        C.kill(C.GAME_EXE)
        time.sleep(4)
    try:
        import shutil
        if os.path.isfile(C.ue4ss_log()):
            shutil.copy2(C.ue4ss_log(), os.path.join(run_dir, 'UE4SS.log'))
    except OSError as ex:
        note('job: UE4SS.log not copied: %s' % ex)
    r = subprocess.run(PY + [os.path.join(C.HERE, 'kit.py'), 'restore'], capture_output=True, text=True,
                       creationflags=C.NO_WINDOW, env=dict(os.environ, RVNG_AUTOTEST_RUN=run_dir))
    note((r.stdout + r.stderr).strip())
    note('job: rc %d' % rc)
    return rc


def follow(t_launch, a, note):
    log_p, pos, last_new, result, fails = None, 0, time.time(), None, 0
    deadline = t_launch + a.max_s + 300
    while time.time() < deadline:
        time.sleep(1)
        if not C.game_running():
            note('job: the game is gone (closed or crashed) before a RESULT')
            return 2
        if not log_p:
            log_p = newest_log(t_launch)
            if not log_p:
                if time.time() - t_launch > 75 and stalled_start():
                    note('job: the game stalled at its start (UE4SS.log: "Still waiting for object construction" with '
                         'the count unchanged for over a minute)')
                    return 2
                if time.time() - t_launch > 180:
                    note("job: no RVNG log 180 s after the launch (RVNG's runtime didn't load?)")
                    return 2
                continue
            note('job: following ' + os.path.basename(log_p))
            last_new = time.time()
        with open(log_p, 'rb') as f:
            f.seek(pos)
            chunk = f.read()
        if chunk:
            nl = chunk.rfind(b'\n')
            if nl >= 0:
                pos += nl + 1
                last_new = time.time()
                for raw in chunk[:nl].splitlines():
                    line = raw.decode('utf-8', 'replace').rstrip('\r')
                    if 'selftest: SHOT ' in line:
                        shoot(line, note)
                    if 'selftest: KEYS ' in line:
                        keys(line, note)
                    if 'selftest: ' in line or 'NOT OFFLINE' in line or 'D6:' in line or 'state ' in line and ' -> ' in line:
                        note(line.strip())
                        if 'selftest: FAIL' in line:
                            fails += 1
                        if 'selftest: RESULT' in line:
                            result = line
        if result:
            time.sleep(2)
            m = re.search(r'RESULT (\d+)/(\d+)', result)
            return 0 if fails == 0 and m and m.group(2) != '0' else 1
        if time.time() - last_new > WATCHDOG_S:
            note('job: the watchdog: no new RVNG log line for %d s' % WATCHDOG_S)
            return 2
    note('job: no RESULT by the job deadline')
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
