"""Start the local web server if needed, then open its page."""
import pathlib
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = pathlib.Path(__file__).resolve().parent
URL = 'http://127.0.0.1:8766'


def ready():
    try:
        with urllib.request.urlopen(URL, timeout=2) as response:
            return response.status == 200 and b'Atlas' in response.read()
    except OSError:
        return False


if not ready():
    with (ROOT / 'server_stdout.log').open('a') as out, (ROOT / 'server_stderr.log').open('a') as err:
        process = subprocess.Popen(
            [sys.executable, str(ROOT / 'server.py')], cwd=ROOT,
            stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW,
        )
    for _ in range(30):
        if ready():
            break
        if process.poll() is not None:
            break
        time.sleep(1)

if not ready():
    print('Server failed to start. See server_stderr.log in:', ROOT)
    sys.exit(1)
webbrowser.open(URL)
