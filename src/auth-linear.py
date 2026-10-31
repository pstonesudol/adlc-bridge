"""Local hidden token entry; never accepts a token as a command argument."""
import getpass
import os
import tempfile
from pathlib import Path

folder = Path.home() / 'Library/Application Support/ADLC Bridge'
folder.mkdir(mode=0o700, parents=True, exist_ok=True)
target = folder / 'linear-token'
if target.exists():
    print('Replacing the saved Linear key. Cancel with Control-C to keep the existing key.')
token = getpass.getpass('Dedicated Linear API key (hidden; stored locally): ').strip()
if not token or '\n' in token or '\r' in token:
    raise SystemExit('Invalid key; nothing saved.')
fd, temporary = tempfile.mkstemp(prefix='.linear-token-', dir=folder)
try:
    with os.fdopen(fd, 'w') as handle:
        handle.write(token + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('Saved local credential with owner-only file permissions. No API request was made.')
