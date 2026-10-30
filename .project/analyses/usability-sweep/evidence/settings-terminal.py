import json, os, pathlib, shlex, subprocess, tempfile, time

ROOT = pathlib.Path(__file__).resolve().parents[4]
OUT = ROOT / '.project/analyses/usability-sweep/captures'
OUT.mkdir(parents=True, exist_ok=True)
SCRATCH = pathlib.Path(tempfile.mkdtemp(prefix='navigator-usability-'))
SOCKET = os.environ.get('QA_SOCKET', 'nav-usability-' + str(os.getpid()))
TARGET = 'qa'

def tmux(*args):
    return subprocess.check_output(['tmux', '-L', SOCKET, *args], text=True)

def screen():
    return tmux('capture-pane', '-p', '-t', TARGET)

def wait_for(text, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = screen()
        if text in value:
            return value
        time.sleep(0.08)
    raise AssertionError('Missing ' + repr(text) + '\n' + screen())

def key(*keys):
    tmux('send-keys', '-t', TARGET, *keys)
    time.sleep(0.15)

def type_text(text):
    tmux('send-keys', '-t', TARGET, '-l', text)
    time.sleep(0.15)

def capture(name):
    text = screen()
    (OUT / (name + '.txt')).write_text(text)
    return text

agent = SCRATCH / 'agent'
work = SCRATCH / 'work'
home = SCRATCH / 'home'
for p in (agent, work, home):
    p.mkdir()
config = {'anchorStartAfterTurns': 2, 'continuity': {'capture': False}, 'auto_navigate': {'enabled': True}}
(agent / 'tree-navigator.json').write_text(json.dumps(config))
if os.environ.get('QA_KEYS') == '1':
    (agent / 'keybindings.json').write_text(json.dumps({'tui.select.cancel': ['alt+s', 'escape', 'ctrl+c'], 'tui.altScreen.top': ['home'], 'tui.altScreen.bottom': ['end']}))
(agent / 'settings.json').write_text(json.dumps({'quietStartup': True, 'theme': os.environ.get('QA_THEME', 'dark'), 'tuiMode': os.environ.get('QA_MODE', 'fullscreen'), 'enableInstallTelemetry': False, 'enableAnalytics': False}))
env = ['env', '-i', 'PATH=' + os.environ['PATH'], 'HOME=' + str(home), 'TERM=xterm-256color', 'LANG=C.UTF-8', 'PI_CODING_AGENT_DIR=' + str(agent), 'XDG_CONFIG_HOME=' + str(SCRATCH / 'config'), 'XDG_CACHE_HOME=' + str(SCRATCH / 'cache'), 'XDG_STATE_HOME=' + str(SCRATCH / 'state'), 'XDG_DATA_HOME=' + str(SCRATCH / 'data'), 'PI_OFFLINE=1', 'PI_TELEMETRY=0', 'pi-bolt', '--offline', '-ne', '-nc', '-ns', '-np', '--no-mcp', '-na', '--no-session', '-e', str(ROOT / 'src/index.ts')]
command = 'cd ' + shlex.quote(str(work)) + ' && ' + shlex.join(env)
try:
    tmux('new-session', '-d', '-s', TARGET, '-x', '140', '-y', '30', command)
    wait_for('No models available')
    type_text('/anchor settings')
    key('Enter')
    if 'Anchor/Settings' not in screen():
        key('Enter')
    wait_for('Anchor/Settings')
    capture(os.environ.get('QA_PREFIX', 'dark-fullscreen') + '-settings-initial-140x30')
    print('READY', str(SCRATCH), SOCKET, flush=True)
    if os.environ.get('QA_KEEP') == '1':
        print('KEPT', flush=True)
    else:
        import runpy
        os.environ['QA_SOCKET'] = SOCKET
        runpy.run_path(str(pathlib.Path(__file__).with_name('settings-terminal-drive.py')))
finally:
    if os.environ.get('QA_KEEP') != '1':
        subprocess.run(['tmux', '-L', SOCKET, 'kill-server'], check=False)
        import shutil
        shutil.rmtree(SCRATCH)
