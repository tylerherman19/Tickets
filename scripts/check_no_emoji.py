#!/usr/bin/env python3
from pathlib import Path
import sys
roots=[Path('.')]
skip={'.git'}
# Emoji and pictograph blocks. Text punctuation and symbols such as the minus sign are allowed.
ranges=[(0x1F000,0x1FAFF),(0x2600,0x27BF),(0x2300,0x23FF),(0x2B00,0x2BFF)]
bad=[]
for path in Path('.').rglob('*'):
    if not path.is_file() or any(part in skip for part in path.parts): continue
    if path.suffix.lower() not in {'.html','.css','.js','.cjs','.py','.md','.yml','.yaml','.sql','.svg'}: continue
    text=path.read_text(errors='ignore')
    hits=[(i,c) for i,c in enumerate(text) if any(a<=ord(c)<=b for a,b in ranges)]
    if hits: bad.append((path,hits[:5]))
if bad:
    for path,hits in bad: print(f'{path}: emoji/pictograph codepoint found: '+', '.join(f'U+{ord(c):04X}' for _,c in hits))
    sys.exit(1)
print('Emoji guard passed.')
