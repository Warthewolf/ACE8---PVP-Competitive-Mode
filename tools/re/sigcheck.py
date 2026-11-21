"""sigcheck.py : checks every byte signature in native/sigs.h against AceCombat8.exe (static: it only reads the file).

  python sigcheck.py [path/to/sigs.h] [name ...]

Each `static const uint8_t kSig...[N] = {...};` array (with its `...Mask` array when there is one, 0 = wildcard) must
match exactly once in the exe's code sections, as the runtime's scanner expects. Prints one line per signature (the
count and the first match's VA) and exits non-zero when any signature is missing or matches more than once.
For a call-site signature (its first byte E8) the line also shows the call's target.
Settings: AC8_EXE or AC8_DIR, LLVM_BIN (see exe.py).
"""
import os, re, struct, sys
from exe import Exe
from mksig import count

HERE = os.path.dirname(os.path.abspath(__file__))
ARR = re.compile(r'static\s+const\s+uint8_t\s+(\w+)\s*\[\s*(\d*)\s*\]\s*=\s*\{([^}]*)\}', re.S)


def parse(path):
    arrays = {}
    for name, n, body in ARR.findall(open(path, encoding='utf-8').read()):
        vals = [int(t, 0) for t in re.findall(r'0x[0-9A-Fa-f]+|\d+', body)]
        if n and int(n) > len(vals):         # C fills the rest with zeros (in a mask: wildcards)
            print('note: %s declares %s bytes but lists %d; the rest are zeros, as in C' % (name, n, len(vals)))
            vals += [0] * (int(n) - len(vals))
        elif n and int(n) < len(vals):
            sys.exit('%s: %s declares %s bytes but lists %d' % (path, name, n, len(vals)))
        arrays[name] = bytes(vals)
    return arrays


def main():
    args = sys.argv[1:]
    path = args.pop(0) if args and args[0].endswith('.h') else os.path.join(HERE, '..', '..', 'native', 'sigs.h')
    arrays = parse(path)
    names = [a for a in arrays if a.startswith('kSig') and not a.endswith('Mask')]
    if args: names = [a for a in names if a in args]
    x = Exe()
    bad = 0
    for name in names:
        pat = arrays[name]
        mask = arrays.get(name + 'Mask', b'\x01' * len(pat))
        if len(mask) != len(pat):
            print('%-28s mask length %d != %d' % (name, len(mask), len(pat))); bad += 1; continue
        n, first = count(x, pat, mask)
        extra = ''
        if n == 1 and pat[0] == 0xE8:
            rel = struct.unpack('<i', x.read(first + 1, 4))[0]
            extra = ' -> calls %#x' % (first + 5 + rel)
        print('%-28s %2d bytes, %d wildcards: %s%s' % (name, len(pat), list(mask).count(0),
              'unique at %#x' % first if n == 1 else ('NOT FOUND' if n == 0 else 'MORE THAN ONE MATCH'), extra))
        bad += n != 1
    print('%d signatures, %d bad' % (len(names), bad))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
