"""Checks every wide format string in native/ against what the runtime's formatter (native/vfmt.h) supports: %s %d %u
%x %p, with no flags or widths. Anything else takes no argument there, so the arguments after it are read as the wrong
types; a %s after it reads a number as a pointer and the game crashes (2026-11-19 19:32: "%03x" in an airset dump).

Usage: python -I tools/re/fmtcheck.py [native dir]   (exit 1 when one is found)"""
import glob
import os
import re
import sys

SUPPORTED = set('sduxp')
STRING = re.compile(r'L"((?:[^"\\]|\\.)*)"')
CONV = re.compile(r'%(.)')


def check(root):
    bad = []
    files = sorted(glob.glob(os.path.join(root, '*.c')) + glob.glob(os.path.join(root, '*.h')))
    for f in files:
        src = open(f, encoding='utf-8').read()
        for m in STRING.finditer(src):
            text = m.group(1).replace('%%', '')
            for c in CONV.finditer(text):
                if c.group(1) not in SUPPORTED:
                    line = src.count('\n', 0, m.start()) + 1
                    bad.append((os.path.basename(f), line, c.group(0), text[:90]))
    return bad


if __name__ == '__main__':
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'native')
    found = check(root)
    for f, line, conv, text in found:
        print(f'{f}:{line}: "{conv}" is not supported by vfmt.h: {text}')
    print(f'fmtcheck: {len(found)} unsupported conversion(s)')
    sys.exit(1 if found else 0)
