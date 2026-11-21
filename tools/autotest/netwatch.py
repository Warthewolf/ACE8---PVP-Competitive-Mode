"""tools/autotest/netwatch.py: what the game process does on the network during a gated run, measured from outside.
Python 3.8, standard library only, Windows only. Read-only: it lists connections and never opens one.

The gate starts a NetWatch before a run and stops it after the game is closed. While the game runs, it samples the
system's TCP and UDP tables (iphlpapi GetExtendedTcpTable / GetExtendedUdpTable, the same data `netstat -ano` shows)
every 0.25 s and keeps every row owned by the game's process:
  - TCP: each remote address:port the game connected to, with first/last seen, the states seen and the local port;
  - UDP: each local address:port the game bound (UDP has no remote in these tables);
  - listening TCP ports.
TIME_WAIT rows lose their pid, so a row in TIME_WAIT is kept when its local port was seen owned by the game before.
A connection that opens and closes between two samples can still be missed: the DLL's own D9 log (the refused web
requests, with their hosts) is the in-process half of this check.

It also takes the DNS client cache (Get-DnsClientCache) before and after. The cache is system-wide, so new names can be
any app's lookups. It is used only to put names on the game's remote addresses, never to look anything up.

Result: <run>/net_watch.json, and summary() for the gate log. RVNG's rule is that a modded client never contacts
Bandai's online services; `outside` lists every non-loopback TCP remote the game reached.
"""
import ctypes
import ctypes.wintypes as wt
import ipaddress
import json
import os
import socket
import struct
import subprocess
import threading
import time

NO_WINDOW = 0x08000000
AF_INET, AF_INET6 = 2, 23
TCP_TABLE_OWNER_PID_ALL = 5
UDP_TABLE_OWNER_PID = 1
TCP_STATES = {1: 'CLOSED', 2: 'LISTEN', 3: 'SYN_SENT', 4: 'SYN_RCVD', 5: 'ESTABLISHED', 6: 'FIN_WAIT1',
              7: 'FIN_WAIT2', 8: 'CLOSE_WAIT', 9: 'CLOSING', 10: 'LAST_ACK', 11: 'TIME_WAIT', 12: 'DELETE_TCB'}

_iphlp = ctypes.windll.iphlpapi
_k32 = ctypes.windll.kernel32


def _table(fn, af, cls):
    size = wt.DWORD(0)
    fn(None, ctypes.byref(size), False, af, cls, 0)
    for _ in range(4):
        buf = ctypes.create_string_buffer(size.value + 4096)
        size = wt.DWORD(len(buf))
        r = fn(buf, ctypes.byref(size), False, af, cls, 0)
        if r == 0:
            return buf.raw
        if r != 122:                      # ERROR_INSUFFICIENT_BUFFER: the table grew, try again
            return b''
    return b''


def _port(dw):
    return socket.ntohs(dw & 0xFFFF)


def tcp_rows():
    """[(proto, local ip, local port, remote ip, remote port, state, pid)] for IPv4 and IPv6."""
    out = []
    raw = _table(_iphlp.GetExtendedTcpTable, AF_INET, TCP_TABLE_OWNER_PID_ALL)
    if len(raw) >= 4:
        n = struct.unpack_from('<I', raw, 0)[0]
        for i in range(n):
            st, la, lp, ra, rp, pid = struct.unpack_from('<6I', raw, 4 + i * 24)
            out.append(('tcp4', socket.inet_ntoa(struct.pack('<I', la)), _port(lp),
                        socket.inet_ntoa(struct.pack('<I', ra)), _port(rp), TCP_STATES.get(st, str(st)), pid))
    raw = _table(_iphlp.GetExtendedTcpTable, AF_INET6, TCP_TABLE_OWNER_PID_ALL)
    if len(raw) >= 4:
        n = struct.unpack_from('<I', raw, 0)[0]
        for i in range(n):
            o = 4 + i * 56
            la = raw[o:o + 16]
            lp = struct.unpack_from('<I', raw, o + 20)[0]
            ra = raw[o + 24:o + 40]
            rp, st, pid = struct.unpack_from('<3I', raw, o + 44)
            out.append(('tcp6', str(ipaddress.IPv6Address(la)), _port(lp), str(ipaddress.IPv6Address(ra)), _port(rp),
                        TCP_STATES.get(st, str(st)), pid))
    return out


def udp_rows():
    """[(proto, local ip, local port, pid)] for IPv4 and IPv6."""
    out = []
    raw = _table(_iphlp.GetExtendedUdpTable, AF_INET, UDP_TABLE_OWNER_PID)
    if len(raw) >= 4:
        n = struct.unpack_from('<I', raw, 0)[0]
        for i in range(n):
            la, lp, pid = struct.unpack_from('<3I', raw, 4 + i * 12)
            out.append(('udp4', socket.inet_ntoa(struct.pack('<I', la)), _port(lp), pid))
    raw = _table(_iphlp.GetExtendedUdpTable, AF_INET6, UDP_TABLE_OWNER_PID)
    if len(raw) >= 4:
        n = struct.unpack_from('<I', raw, 0)[0]
        for i in range(n):
            o = 4 + i * 28
            la = raw[o:o + 16]
            lp, pid = struct.unpack_from('<2I', raw, o + 20)
            out.append(('udp6', str(ipaddress.IPv6Address(la)), _port(lp), pid))
    return out


class _PE(ctypes.Structure):
    _fields_ = [('dwSize', wt.DWORD), ('cntUsage', wt.DWORD), ('th32ProcessID', wt.DWORD),
                ('th32DefaultHeapID', ctypes.c_void_p), ('th32ModuleID', wt.DWORD), ('cntThreads', wt.DWORD),
                ('th32ParentProcessID', wt.DWORD), ('pcPriClassBase', ctypes.c_long), ('dwFlags', wt.DWORD),
                ('szExeFile', ctypes.c_wchar * 260)]


def pids_of(image):
    """Pids of every process with this image name (Toolhelp snapshot: fast, no child process)."""
    image = image.lower()
    snap = _k32.CreateToolhelp32Snapshot(2, 0)          # TH32CS_SNAPPROCESS
    if snap in (0, -1, 0xFFFFFFFF, 0xFFFFFFFFFFFFFFFF):
        return set()
    out = set()
    try:
        e = _PE()
        e.dwSize = ctypes.sizeof(_PE)
        ok = _k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            if e.szExeFile.lower() == image:
                out.add(e.th32ProcessID)
            ok = _k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        _k32.CloseHandle(snap)
    return out


def loopback(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a.is_loopback or a.is_unspecified


def dns_cache():
    """{name: [ip, ...]} from Get-DnsClientCache (the local cache only; no lookup is made)."""
    ps = ('$ErrorActionPreference="SilentlyContinue"; Get-DnsClientCache | Where-Object { $_.Type -eq 1 -or $_.Type '
          '-eq 28 } | Select-Object Entry,Data | ConvertTo-Json -Compress')
    try:
        r = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], capture_output=True,
                           text=True, creationflags=NO_WINDOW, timeout=60)
        rows = json.loads(r.stdout or '[]')
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}
    if isinstance(rows, dict):
        rows = [rows]
    out = {}
    for row in rows or []:
        n, d = (row.get('Entry') or '').lower(), row.get('Data') or ''
        if n and d:
            out.setdefault(n, [])
            if d not in out[n]:
                out[n].append(d)
    return out


class NetWatch(threading.Thread):
    def __init__(self, image, run_dir, period=0.25):
        super().__init__(daemon=True)
        self.image, self.run_dir, self.period = image, run_dir, period
        self.halt = threading.Event()
        self.samples, self.errors = 0, []
        self.tcp, self.udp, self.listen = {}, {}, {}
        self.ports = set()                # local TCP ports seen owned by the game, to keep its TIME_WAIT rows
        self.game_pids = set()
        self.dns0 = {}
        self.t0 = time.time()

    def run(self):
        try:
            self.dns0 = dns_cache()
        except Exception as ex:               # never break the gate
            self.errors.append('dns before: %r' % ex)
        while not self.halt.is_set():
            try:
                self._sample()
            except Exception as ex:
                if len(self.errors) < 20:
                    self.errors.append('sample: %r' % ex)
            self.halt.wait(self.period)

    def _sample(self):
        pids = pids_of(self.image)
        if not pids:
            return
        self.game_pids |= pids
        self.samples += 1
        t = round(time.time() - self.t0, 2)
        for proto, lip, lp, rip, rp, st, pid in tcp_rows():
            mine = pid in pids or (st == 'TIME_WAIT' and pid == 0 and (proto, lp) in self.ports)
            if not mine:
                continue
            if st == 'LISTEN':
                self.listen.setdefault('%s %s:%d' % (proto, lip, lp), t)
                continue
            self.ports.add((proto, lp))
            k = '%s %s:%d' % (proto, rip, rp)
            e = self.tcp.setdefault(k, {'remote': rip, 'port': rp, 'proto': proto, 'first': t, 'last': t,
                                        'states': [], 'local_ports': []})
            e['last'] = t
            if st not in e['states']:
                e['states'].append(st)
            if lp not in e['local_ports'] and len(e['local_ports']) < 50:
                e['local_ports'].append(lp)
        for proto, lip, lp, pid in udp_rows():
            if pid in pids:
                self.udp.setdefault('%s %s:%d' % (proto, lip, lp), t)

    def stop(self):
        self.halt.set()
        if self.is_alive():
            self.join(10)
        dns1 = {}
        try:
            dns1 = dns_cache()
        except Exception as ex:
            self.errors.append('dns after: %r' % ex)
        names = {}
        for n, ips in dns1.items():
            for ip in ips:
                names.setdefault(ip, [])
                if n not in names[ip]:
                    names[ip].append(n)
        for e in self.tcp.values():
            e['names'] = names.get(e['remote'], [])
            e['loopback'] = loopback(e['remote'])
        outside = sorted((e for e in self.tcp.values() if not e['loopback']), key=lambda e: e['first'])
        new_names = sorted(n for n in dns1 if n not in self.dns0)
        res = {'image': self.image, 'pids': sorted(self.game_pids), 'period_s': self.period, 'samples': self.samples,
               'seconds': round(time.time() - self.t0, 1), 'outside': outside,
               'tcp': sorted(self.tcp.values(), key=lambda e: e['first']), 'udp': self.udp, 'listen': self.listen,
               'dns_new_names_system_wide': new_names, 'errors': self.errors}
        if self.run_dir:
            with open(os.path.join(self.run_dir, 'net_watch.json'), 'w', encoding='utf-8') as f:
                json.dump(res, f, indent=1)
        return res


def summary(res):
    """One line for the gate log."""
    if not res.get('samples'):
        return 'NET: the game never ran while watched (0 samples)'
    out = res.get('outside') or []
    head = 'NET: %d samples over the run; ' % res['samples']
    if not out:
        loop = len(res.get('tcp') or [])
        return head + 'no outside TCP connection by the game (%d loopback); %d UDP binds' % (loop, len(res.get('udp') or {}))
    shown = ', '.join('%s:%d%s' % (e['remote'], e['port'], (' (%s)' % '/'.join(e['names'][:2])) if e['names'] else '')
                      for e in out[:8])
    return head + 'OUTSIDE TCP: %d remote(s): %s%s' % (len(out), shown, ' ...' if len(out) > 8 else '')


if __name__ == '__main__':
    # A quick look at the game's connections now: python -I netwatch.py [image] [seconds]
    import sys
    img = sys.argv[1] if len(sys.argv) > 1 else 'AceCombat8.exe'
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 3
    w = NetWatch(img, None)
    w.start()
    time.sleep(secs)
    r = w.stop()
    print(summary(r))
    print(json.dumps({k: r[k] for k in ('outside', 'udp', 'listen', 'errors')}, indent=1))
