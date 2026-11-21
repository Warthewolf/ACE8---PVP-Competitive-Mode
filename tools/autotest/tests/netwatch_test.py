"""netwatch_test.py: netwatch.py against this Python process itself (no game; loopback only, nothing leaves the PC).
    python -I tools/autotest/tests/netwatch_test.py      (exits non-zero on the first failed check)
It opens a loopback listener, connects to it, binds a loopback UDP socket, and checks the watch saw all three, as
loopback, with nothing put under `outside`; then it checks summary() and loopback() on made-up rows."""
import os, socket, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import netwatch as N  # noqa: E402

FAILS = 0


def check(cond, what):
    global FAILS
    print(('ok   ' if cond else 'FAIL ') + what)
    if not cond:
        FAILS += 1


image = os.path.basename(sys.executable)
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.bind(('127.0.0.1', 0))
srv.listen(1)
port = srv.getsockname()[1]
cli = socket.create_connection(('127.0.0.1', port))
acc, _ = srv.accept()
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.bind(('127.0.0.1', 0))
uport = udp.getsockname()[1]

check(os.getpid() in N.pids_of(image), 'pids_of finds this process (%s)' % image)
rows = [r for r in N.tcp_rows() if r[6] == os.getpid()]
check(any(r[4] == port and r[5] == 'ESTABLISHED' for r in rows), 'tcp_rows has the loopback connection')
check(any(r[2] == uport for r in N.udp_rows() if r[3] == os.getpid()), 'udp_rows has the UDP bind')

d = tempfile.mkdtemp()
w = N.NetWatch(image, d, period=0.1)
w.dns0 = {}
w._sample()
w._sample()
w.halt.set()
res = w.stop()
k = 'tcp4 127.0.0.1:%d' % port
check(k in w.tcp and w.tcp[k]['loopback'], 'the watch kept the connection, as loopback')
check(not any(e['remote'] == '127.0.0.1' for e in res['outside']), 'loopback is not under outside')
check(('tcp4 127.0.0.1:%d' % port) in res['listen'], 'the listener is under listen')
check(('udp4 127.0.0.1:%d' % uport) in res['udp'], 'the UDP bind is under udp')
check(os.path.isfile(os.path.join(d, 'net_watch.json')), 'net_watch.json written')

check(N.loopback('127.0.0.1') and N.loopback('::1') and N.loopback('::ffff:127.0.0.5') and N.loopback('0.0.0.0'),
      'loopback(): 127/8, ::1, mapped, unspecified')
check(not N.loopback('8.8.8.8') and not N.loopback('2001:db8::1'), 'loopback(): outside addresses are not')
check('0 samples' in N.summary({'samples': 0}), 'summary: no game')
check('no outside TCP' in N.summary({'samples': 5, 'outside': [], 'tcp': [{}], 'udp': {}}), 'summary: clean run')
s = N.summary({'samples': 5, 'outside': [{'remote': '203.0.113.7', 'port': 443, 'names': ['api.example.test']}]})
check('OUTSIDE TCP: 1' in s and '203.0.113.7:443' in s and 'api.example.test' in s, 'summary: an outside remote')

for s_ in (cli, acc, srv, udp):
    s_.close()
print('%d failed' % FAILS)
sys.exit(1 if FAILS else 0)
