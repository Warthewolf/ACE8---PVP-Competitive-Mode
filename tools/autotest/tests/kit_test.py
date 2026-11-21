"""kit_test.py: kit.py install / restore against a fake game folder (no game, no real mods touched).
    python -I tools/autotest/tests/kit_test.py      (exits non-zero on the first failed check)
The fake game and the test's own state folder live in build/autotest_test (git-ignored), on the repo's drive, so the
moves are renames as in a real run."""
import json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
BASE = os.path.join(ROOT, 'build', 'autotest_test')
GAME = os.path.join(BASE, 'game')
STATE = os.path.join(BASE, 'state')
MODS = os.path.join(GAME, 'Game', 'Binaries', 'Win64', 'ue4ss', 'Mods')
KIT = os.path.join(HERE, '..', 'kit.py')
ENV = dict(os.environ, AC8_DIR=GAME, RVNG_AUTOTEST_STATE=STATE, RVNG_AUTOTEST_RUN=os.path.join(BASE, 'run'))


def kit(*args):
    r = subprocess.run([sys.executable, '-I', KIT] + list(args), capture_output=True, text=True, env=ENV)
    return r.returncode, r.stdout + r.stderr


def snap():
    out = {}
    for d, _, files in os.walk(MODS):
        for f in files:
            p = os.path.join(d, f)
            st = os.stat(p)
            out[os.path.relpath(p, MODS)] = [st.st_size, st.st_mtime_ns]
    return out


def fresh(user_rvng=False):
    shutil.rmtree(BASE, ignore_errors=True)
    for name in ('AC8SurvivalMode/Scripts', 'IoStoreLoaderMod', 'LandWalkSim', 'SkipIntro/Scripts', 'shared/x'):
        os.makedirs(os.path.join(MODS, name))
    open(os.path.join(MODS, 'AC8SurvivalMode', 'Scripts', 'main.lua'), 'w').write('-- survival')
    open(os.path.join(MODS, 'IoStoreLoaderMod', 'main.dll'), 'wb').write(b'\0' * 64)
    open(os.path.join(MODS, 'SkipIntro', 'Scripts', 'main.lua'), 'w').write('-- skip')
    open(os.path.join(MODS, 'mods.txt'), 'w').write('IoStoreLoaderMod : 1\n')
    if user_rvng:
        os.makedirs(os.path.join(MODS, 'ProjectRVNG'))
        open(os.path.join(MODS, 'ProjectRVNG', 'mine.txt'), 'w').write('the user\'s own RVNG install')


def check(ok, what):
    if not ok:
        print('FAIL: ' + what)
        sys.exit(1)
    print('ok - ' + what)


# 1. install + restore round trip
fresh()
before = snap()
rc, out = kit('install', '--suite', 'dm_c')
check(rc == 0, 'install: ' + out.strip().splitlines()[-1])
left = sorted(os.listdir(MODS))
check(left == ['ProjectRVNG', 'SkipIntro', 'mods.txt', 'shared'], 'only SkipIntro, shared and files stay; RVNG added (%s)' % left)
ini = open(os.path.join(MODS, 'ProjectRVNG', 'rvng_test.ini')).read()
check('probe=1' in ini and 'd2=1' in ini and 'w1=1' in ini and 'd6=1' in ini, 'dm_c settings: probe, d2, w1, d6')
main = open(os.path.join(MODS, 'ProjectRVNG', 'Scripts', 'main.lua'), encoding='utf-8').read()
check(main.count('require("rvng_selftest")') == 1 and os.path.isfile(os.path.join(MODS, 'ProjectRVNG', 'Scripts', 'rvng_selftest.lua')),
      'the self-test is installed and required once')
check(os.path.isfile(os.path.join(MODS, 'ProjectRVNG', 'dlls', 'main.dll')), 'the runtime DLL is installed')
rc, out = kit('install', '--suite', 'smoke')
check(rc != 0 and 'restore' in out, 'a second install is refused while one is in')
os.makedirs(os.path.join(MODS, 'ProjectRVNG', 'logs'))
open(os.path.join(MODS, 'ProjectRVNG', 'logs', 'RVNG_x.log'), 'w').write('log')
rc, out = kit('restore')
check(rc == 0 and 'kit: restored' in out, 'restore')
check(snap() == before, 'the Mods folder is exactly as before (names, sizes, mtimes)')
check(os.path.isfile(os.path.join(BASE, 'run', 'rvng_logs', 'RVNG_x.log')), "RVNG's logs are copied to the run folder")
check(not os.listdir(os.path.join(STATE, 'aside')), 'the aside folder is empty')
rc, out = kit('restore')
check(rc == 0 and 'nothing installed' in out, 'a second restore has nothing to do')

# 2. the user's own ProjectRVNG is theirs: moved aside, put back
fresh(user_rvng=True)
before = snap()
rc, out = kit('install', '--suite', 'smoke')
check(rc == 0 and not os.path.isfile(os.path.join(MODS, 'ProjectRVNG', 'mine.txt')), "the user's ProjectRVNG is moved aside")
rc, out = kit('restore')
check(rc == 0 and snap() == before, "the user's ProjectRVNG is back exactly")

# 3. a folder in the way of a move back: left alone, state kept, then a clean retry
fresh()
before = snap()
kit('install', '--suite', 'smoke')
os.makedirs(os.path.join(MODS, 'LandWalkSim'))
rc, out = kit('restore')
check(rc == 2 and 'NOT moved back' in out and os.path.isfile(os.path.join(STATE, 'kit_state.json')),
      'something in the way: reported, state kept, nothing overwritten')
os.rmdir(os.path.join(MODS, 'LandWalkSim'))
rc, out = kit('restore')
check(rc == 0 and snap() == before, 'once it is out of the way, restore finishes exactly')

# 4. an install cut short after the moves (no RVNG copied yet): restore still puts everything back
fresh()
before = snap()
kit('install', '--suite', 'smoke')
st = json.load(open(os.path.join(STATE, 'kit_state.json')))
shutil.rmtree(os.path.join(MODS, 'ProjectRVNG'))
st['installed'], st['phase'] = [], 'moved LandWalkSim'
json.dump(st, open(os.path.join(STATE, 'kit_state.json'), 'w'))
rc, out = kit('restore')
check(rc == 0 and snap() == before, 'an install cut short is restored exactly')

# 5. an aside folder with something in it (an earlier run's leftovers): install refuses and moves nothing
fresh()
before = snap()
os.makedirs(os.path.join(STATE, 'aside', 'Leftover'))
rc, out = kit('install', '--suite', 'smoke')
check(rc != 0 and 'aside is not empty' in out and snap() == before, 'leftovers in aside: install refused, nothing moved')

# the stats suite: the companion's bridge folder made for the run (the mod writes runtime.json there), kept with the
# run, and removed again; one that was there already is left as it was
fresh()
rvng_root = os.path.join(GAME, 'ProjectRVNG')
bridge = os.path.join(rvng_root, 'bridge')
rc, out = kit('install', '--suite', 'stats')
check(rc == 0 and os.path.isdir(bridge), 'stats: the bridge folder made for the run')
open(os.path.join(bridge, 'runtime.json'), 'w').write('{"stats":{}}')
open(os.path.join(bridge, 'runtime_match.json'), 'w').write('{"stats":{"m":1}}')
rc, out = kit('restore')
check(rc == 0 and 'kit: restored' in out, 'stats: restore')
check(not os.path.exists(rvng_root), 'stats: the folders the kit made are gone')
check(open(os.path.join(BASE, 'run', 'runtime.json')).read() == '{"stats":{}}', "stats: the run's runtime.json kept with the run")
check(open(os.path.join(BASE, 'run', 'runtime_match.json')).read() == '{"stats":{"m":1}}', "stats: and its runtime_match.json (the match capture)")
fresh()
os.makedirs(bridge)
open(os.path.join(bridge, 'state.json'), 'w').write('{}')                # (the user's companion's own file)
rc, out = kit('install', '--suite', 'stats')
rc, out = kit('restore')
check(rc == 0 and os.path.isfile(os.path.join(bridge, 'state.json')), "stats: a bridge that was there already is the user's: left as it was")
fresh()
rc, out = kit('install', '--suite', 'stats')
open(os.path.join(bridge, 'mine.txt'), 'w').write('not the run\'s')
rc, out = kit('restore')
check(rc != 0 and 'LEFT ALONE' in out and os.path.isfile(os.path.join(bridge, 'mine.txt')),
      'stats: a made folder holding something else is left alone, and said so')
shutil.rmtree(rvng_root, ignore_errors=True)
os.remove(os.path.join(STATE, 'kit_state.json')) if os.path.exists(os.path.join(STATE, 'kit_state.json')) else None

shutil.rmtree(BASE, ignore_errors=True)
print('all kit checks passed')
