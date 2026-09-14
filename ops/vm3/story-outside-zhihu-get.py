#!/usr/bin/python3
"""Private SSH helper: one unauthenticated, bounded HTTPS story GET."""
import base64
import re
import subprocess
import sys
import urllib.parse

if len(sys.argv) != 2 or not re.fullmatch(r'[A-Za-z0-9_-]{1,1024}', sys.argv[1]):
    sys.exit(2)
try:
    work_id = base64.urlsafe_b64decode(sys.argv[1] + '=' * (-len(sys.argv[1]) % 4)).decode('utf-8')
except (ValueError, UnicodeError):
    sys.exit(2)
if (not work_id or len(work_id) > 128 or work_id.strip() != work_id
        or work_id in ('.', '..') or re.search(r'[/?#\x00-\x1f\x7f]', work_id)):
    sys.exit(2)
url = 'https://api.zhihu.com/km-indep-home/hackathon/v2/story/' + urllib.parse.quote(work_id, safe='')
# No redirects, cookies, Authorization, arbitrary targets or listening port.
try:
    result = subprocess.run([
        '/usr/bin/curl', '--silent', '--show-error', '--proto', '=https',
        '--connect-timeout', '2', '--max-time', '6', '--max-filesize', '1048576',
        '--header', 'Accept: application/json',
        '--user-agent', 'story-outside/0.1 (zhihu-hackathon-2026-p2; read-only)',
        '--write-out', '\n%{http_code}', url,
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=7)
except subprocess.TimeoutExpired:
    sys.exit(1)
if result.returncode or len(result.stdout) > 1049600:
    sys.exit(1)
sys.stdout.buffer.write(result.stdout)
