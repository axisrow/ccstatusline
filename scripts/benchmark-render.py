import argparse, concurrent.futures, hashlib, json, math, os, pathlib, platform, resource, shlex, shutil, signal, statistics, subprocess, sys, tempfile, time
# Set CCSTATUSLINE_BENCH_DIR to reuse a fixture across before/after invocations.
ROOT = pathlib.Path(os.environ.get('CCSTATUSLINE_BENCH_DIR') or tempfile.mkdtemp(prefix='ccstatusline-bench-')).resolve()
(ROOT / 'results').mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Legacy single-run mode (PR #397 before/after comparisons). Unchanged.
# ---------------------------------------------------------------------------

def setup():
    fixture = ROOT / 'transcript.jsonl'
    if not fixture.exists():
        with fixture.open('w') as f:
            for i in range(10000):
                row = {'type': 'assistant' if i % 2 else 'user', 'timestamp': '2026-09-25T01:%02d:%02dZ' % ((i // 60) % 60, i % 60), 'message': {'role': 'assistant' if i % 2 else 'user', 'content': [{'type':'text','text': 'x' * 1105}]}}
                if i % 2:
                    row['message'].update(id='msg-' + str(i), stop_reason='end_turn', usage={'input_tokens': 100, 'output_tokens': 50, 'cache_read_input_tokens': 200, 'cache_creation_input_tokens': 10})
                f.write(json.dumps(row, separators=(',', ':')) + '\n')
    return fixture

def environment(home, width=False):
    home.mkdir(parents=True, exist_ok=True)
    env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'USERPROFILE': str(home), 'CLAUDE_CONFIG_DIR': str(home / '.claude'), 'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_CACHE_HOME': str(home / '.cache'), 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'TMPDIR': str(ROOT)}
    if width: env['CCSTATUSLINE_WIDTH'] = '120'
    return env

def payload(fixture):
    return json.dumps({'model': {'id': 'claude-sonnet-4-5', 'display_name': 'Sonnet 4.5'}, 'session_id': 'perf-synthetic', 'transcript_path': str(fixture), 'cwd': str(ROOT / 'empty-project'), 'workspace': {'current_dir': str(ROOT / 'empty-project')}})

def run(runtime, entry, label, width=False, rounds=20):
    entry = str(pathlib.Path(entry).resolve())
    fixture = setup()
    (ROOT / 'empty-project').mkdir(exist_ok=True)
    data = payload(fixture)
    homes = [ROOT / 'homes' / label / str(i) for i in range(4)]
    envs = [environment(h, width) for h in homes]
    def once(i, warm=False):
        start = time.perf_counter()
        p = subprocess.run([runtime, entry], input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ROOT / 'empty-project', env=envs[i])
        if p.returncode or (p.stderr and not warm): raise RuntimeError((p.returncode, p.stderr))
        return (time.perf_counter() - start)*1000, hashlib.sha256(p.stdout.encode()).hexdigest()
    for i in range(4): once(i, True)
    def worker(i): return [once(i) for _ in range(rounds)]
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        samples = sum(pool.map(worker, range(4)), [])
    wall = time.perf_counter() - start
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime
    latencies = sorted(s[0] for s in samples)
    result = {'label': label, 'runtime': runtime, 'entry': entry, 'bytes': fixture.stat().st_size, 'renders': len(samples), 'width_override': width, 'cpu_total_s': round(cpu,4), 'cpu_per_render_ms': round(cpu*1000/len(samples),3), 'wall_s': round(wall,3), 'p50_ms': round(statistics.median(latencies),3), 'p95_ms': round(latencies[int(len(latencies)*.95)-1],3), 'hashes': sorted(set(s[1] for s in samples)), 'latencies_ms': latencies}
    (ROOT/'results'/f'{label}.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k:v for k,v in result.items() if k != 'latencies_ms'}), flush=True)

# ---------------------------------------------------------------------------
# N-session baseline harness (daemon epic, fork issue #14).
#
#   python3 scripts/benchmark-render.py baseline --runtime node --entry dist/ccstatusline.js --out <dir>
#
# One-shot baseline: every render is a fresh ccstatusline process, as Claude
# Code invokes it today. Each scenario runs in a dedicated child interpreter
# so getrusage(RUSAGE_CHILDREN) starts at zero and the CPU/RSS accounting
# covers that scenario only, including all reaped descendants (git etc.).
# ---------------------------------------------------------------------------

FIXTURE_ROWS = {'small': 500, 'large': 10000}
# Warm scenarios: steady state = persistent git cache (HOME/.cache/ccstatusline)
# and config already written by earlier renders. Cold: fresh HOME, the measured
# render is the session's first.
WARMUP_RENDERS, WARM_MEASURED = 2, 6
COUNT_WARMUP_RENDERS, COUNT_MEASURED = 1, 2
SHIM_BINS = {'git': '/usr/bin/git', 'security': '/usr/bin/security'}
LOAD_CHECK_INTERVAL_S = 10

def machine_context():
    try:
        model = subprocess.run(['sysctl', '-n', 'machdep.cpu.brand_string'], capture_output=True, text=True).stdout.strip()
    except OSError:
        model = ''
    return {'cpu_model': model or platform.machine(), 'cpu_count': os.cpu_count(), 'os': platform.platform(), 'python': sys.version.split()[0]}

def loadavg1():
    return round(os.getloadavg()[0], 2)

def make_fixture(path, rows):
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w') as f:
        for i in range(rows):
            row = {'type': 'assistant' if i % 2 else 'user', 'timestamp': '2026-09-25T01:%02d:%02dZ' % ((i // 60) % 60, i % 60), 'message': {'role': 'assistant' if i % 2 else 'user', 'content': [{'type':'text','text': 'x' * 1105}]}}
            if i % 2:
                row['message'].update(id='msg-' + str(i), stop_reason='end_turn', usage={'input_tokens': 100, 'output_tokens': 50, 'cache_read_input_tokens': 200, 'cache_creation_input_tokens': 10})
            f.write(json.dumps(row, separators=(',', ':')) + '\n')
    return path

def setup_repo():
    # Shared dirty git repo: the default widget line (model, context-length,
    # git-branch, git-changes) spawns git on every render in a real project.
    repo = ROOT / 'bench-repo'
    if not (repo / '.git').exists():
        repo.mkdir(parents=True, exist_ok=True)
        def git(*a): subprocess.run(['git', *a], cwd=repo, check=True, capture_output=True)
        git('init')
        git('config', 'user.email', 'bench@local')
        git('config', 'user.name', 'bench')
        (repo / 'app.js').write_text('const x = 1;\n' * 50)
        (repo / 'README.md').write_text('# bench\n')
        git('add', '.')
        git('commit', '-m', 'init')
        (repo / 'app.js').write_text('const x = 2;\n' * 50)
        (repo / 'notes.txt').write_text('untracked\n')
    return repo

def make_shims(run_dir):
    # Count-pass only: PATH shims log one line per invocation, then exec the
    # real binary. Numbers from this pass (CPU/latency) are never reported as
    # baseline - only the counts are.
    shim_dir = run_dir / 'shims'
    shim_dir.mkdir(parents=True, exist_ok=True)
    made = []
    for name, real in SHIM_BINS.items():
        if not pathlib.Path(real).exists():
            continue
        count_file = run_dir / f'count-{name}.log'
        script = shim_dir / name
        script.write_text('#!/bin/sh\nprintf \'1\\n\' >> %s\nexec %s "$@"\n' % (shlex.quote(str(count_file)), shlex.quote(real)))
        script.chmod(0o755)
        made.append((name, count_file))
    return shim_dir, made

def read_count(path):
    try:
        return len(path.read_text().split())
    except FileNotFoundError:
        return 0

def pctl(sorted_xs, q):
    # Nearest-rank percentile; degrades to the single sample when n == 1.
    return sorted_xs[min(len(sorted_xs) - 1, max(0, math.ceil(q * len(sorted_xs)) - 1))]

def cmd_sampler(args):
    # Runs as a detached child; excluded from the scenario's CPU accounting by
    # reaping order (terminated after the post-measurement rusage snapshot).
    stop = {'flag': False}
    def onterm(signum, frame): stop['flag'] = True
    signal.signal(signal.SIGTERM, onterm)
    me = os.getpid()
    samples, seen = [], set()
    while not stop['flag']:
        try:
            out = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss='], capture_output=True, text=True).stdout
            parent, rss = {}, {}
            for line in out.splitlines():
                parts = line.split()
                if len(parts) < 3:
                    continue
                try:
                    pid, ppid, mem = int(parts[0]), int(parts[1]), int(parts[2])
                except ValueError:
                    continue
                parent[pid], rss[pid] = ppid, mem
            children = {}
            for pid, pp in parent.items():
                children.setdefault(pp, []).append(pid)
            def descendants(root_pid):
                acc, stack = set(), [root_pid]
                while stack:
                    for child in children.get(stack.pop(), []):
                        if child not in acc:
                            acc.add(child)
                            stack.append(child)
                return acc
            # Live ccstatusline trees only: drop the sampler's own subtree and
            # the runner interpreter itself.
            live = descendants(args.target_pid) - descendants(me) - {me}
            samples.append(sum(rss.get(p, 0) for p in live))
            seen |= live
        except OSError:
            pass
        time.sleep(args.interval_ms / 1000.0)
    result = {'samples': len(samples), 'distinct_pids': len(seen)}
    if samples:
        result['aggregate_mean_kb'] = round(statistics.mean(samples), 1)
        result['aggregate_max_kb'] = max(samples)
    print(json.dumps(result), flush=True)

def cmd_run_one(args):
    label = 's%d-%s-%s%s%s' % (args.sessions, args.mode, args.transcript, '-counts' if args.count_pass else '', args.run_suffix)
    run_dir = ROOT / 'runs' / label
    if run_dir.exists():
        shutil.rmtree(run_dir)
    home = run_dir / 'home'
    home.mkdir(parents=True)
    fixture = make_fixture(ROOT / 'fixtures' / f'{args.transcript}.jsonl', FIXTURE_ROWS[args.transcript])
    repo = setup_repo()
    tx_dir = run_dir / 'tx'
    tx_dir.mkdir()
    payloads = []
    for i in range(args.sessions):
        session_tx = tx_dir / f's{i}.jsonl'
        try:
            os.link(fixture, session_tx)
        except OSError:
            shutil.copy(fixture, session_tx)
        payloads.append(json.dumps({'model': {'id': 'claude-sonnet-4-5', 'display_name': 'Sonnet 4.5'}, 'session_id': f'{label}-{i}', 'transcript_path': str(session_tx), 'cwd': str(repo), 'workspace': {'current_dir': str(repo)}}))
    # All sessions share one HOME per run: the daemon targets sessions of one
    # OS user, so persistent caches (git cache, settings) are shared like in
    # reality. Fresh HOME per run isolates cold from any earlier run's caches.
    env = environment(home, width=True)
    env['CCSL_FORK'] = '1'
    shim_info = {'shims': [], 'counts_measured': {}}
    shims = []
    if args.count_pass:
        shim_dir, shims = make_shims(run_dir)
        env['PATH'] = str(shim_dir) + os.pathsep + env['PATH']
        shim_info['shims'] = [name for name, _ in shims]
    entry = str(pathlib.Path(args.entry).resolve())
    warmups = 0 if args.mode == 'cold' else (COUNT_WARMUP_RENDERS if args.count_pass else WARMUP_RENDERS)
    measured = 1 if args.mode == 'cold' else (COUNT_MEASURED if args.count_pass else WARM_MEASURED)
    first_stderr = ''
    def once(i):
        nonlocal first_stderr
        start = time.perf_counter()
        p = subprocess.run([args.runtime, entry], input=payloads[i], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=repo, env=env, timeout=60)
        elapsed = (time.perf_counter() - start) * 1000
        if p.returncode:
            raise RuntimeError('render failed rc=%s stderr=%s' % (p.returncode, p.stderr[:500]))
        if p.stderr and not first_stderr:
            first_stderr = p.stderr[:500]
        return elapsed, hashlib.sha256(p.stdout.encode()).hexdigest()
    def wave(n):
        def worker(i): return [once(i) for _ in range(n)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.sessions) as pool:
            return sum(pool.map(worker, range(args.sessions)), [])
    for _ in range(warmups):
        wave(1)
    counts_before = {name: read_count(f) for name, f in shims} if args.count_pass else {}
    if args.max_load is not None:
        # Re-check inside the runner: the orchestrator gate ran seconds ago;
        # the measured phase must not land on a load spike.
        wait_for_load(args.max_load, 600)
    la_start = loadavg1()
    rbefore = resource.getrusage(resource.RUSAGE_CHILDREN)
    sampler = subprocess.Popen([sys.executable, __file__, '_sampler', '--target-pid', str(os.getpid()), '--interval-ms', str(args.interval_ms)], stdout=subprocess.PIPE, text=True)
    start = time.perf_counter()
    samples = wave(measured)
    wall = time.perf_counter() - start
    la_end = loadavg1()
    rafter = resource.getrusage(resource.RUSAGE_CHILDREN)
    sampler.terminate()
    try:
        rss = json.loads(sampler.communicate(timeout=15)[0] or '{}')
    except Exception:
        rss = {'samples': 0}
    counts_after = {name: read_count(f) for name, f in shims} if args.count_pass else {}
    latencies = sorted(s[0] for s in samples)
    cpu_user = rafter.ru_utime - rbefore.ru_utime
    cpu_sys = rafter.ru_stime - rbefore.ru_stime
    cpu_total = cpu_user + cpu_sys
    result = {
        'label': label, 'runtime': args.runtime, 'entry': entry,
        'sessions': args.sessions, 'mode': args.mode, 'transcript': args.transcript,
        'transcript_bytes': fixture.stat().st_size, 'count_pass': args.count_pass,
        'renders': len(samples), 'warmup_renders': warmups * args.sessions,
        'width_override': True, 'ccsl_fork': True,
        'cpu_user_s': round(cpu_user, 4), 'cpu_sys_s': round(cpu_sys, 4), 'cpu_total_s': round(cpu_total, 4),
        'cpu_per_render_ms': round(cpu_total * 1000 / len(samples), 3),
        'cpu_s_per_wall_minute': round(cpu_total / wall * 60, 3),
        'renders_per_wall_minute': round(len(samples) / wall * 60, 1),
        'wall_s': round(wall, 3),
        # ru_maxrss of the largest reaped child tree (includes warmup children;
        # identical workload, so representative of one render's peak).
        'peak_rss_kb': rafter.ru_maxrss // 1024,
        'rss_sampling': rss,
        'latency_ms': {'n': len(latencies), 'mean': round(statistics.mean(latencies), 2), 'p50': round(pctl(latencies, 0.5), 2), 'p95': round(pctl(latencies, 0.95), 2), 'p99': round(pctl(latencies, 0.99), 2)},
        'latencies_ms': latencies,
        'distinct_output_hashes': len(set(s[1] for s in samples)),
        'spawn_counts_measured': {name: counts_after.get(name, 0) - counts_before.get(name, 0) for name in counts_after},
        'spawn_counts_per_render': {name: round((counts_after.get(name, 0) - counts_before.get(name, 0)) / len(samples), 2) for name in counts_after},
        'first_stderr': first_stderr,
        'loadavg_start': la_start, 'loadavg_end': la_end,
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    }
    shim_info['counts_measured'] = result['spawn_counts_measured']
    result['shims'] = shim_info
    (ROOT / 'results' / f'{label}.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k != 'latencies_ms'}), flush=True)

def wait_for_load(max_load, deadline_s):
    start = time.time()
    while True:
        la = loadavg1()
        if la <= max_load:
            return la
        if time.time() - start > deadline_s:
            raise TimeoutError('loadavg %.1f still above %.1f after %ss' % (la, max_load, deadline_s))
        print('[baseline] loadavg %.1f > %.1f, waiting %ds...' % (la, max_load, LOAD_CHECK_INTERVAL_S), flush=True)
        time.sleep(LOAD_CHECK_INTERVAL_S)

def run_scenario(env, args, sessions, mode, transcript, count_pass, suffix):
    label = 's%d-%s-%s%s%s' % (sessions, mode, transcript, '-counts' if count_pass else '', suffix)
    cmd = [sys.executable, str(pathlib.Path(__file__).resolve()), 'run-one',
           '--runtime', args.runtime, '--entry', args.entry,
           '--sessions', str(sessions), '--mode', mode, '--transcript', transcript,
           '--interval-ms', str(args.interval_ms)]
    if count_pass:
        cmd.append('--count-pass')
    if suffix:
        cmd.append('--run-suffix=%s' % suffix)
    if args.max_load is not None:
        cmd += ['--max-load', str(args.max_load)]
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=900)
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip()[-800:])
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    print('[baseline] %-18s cpu/render=%sms cpu/wallmin=%ss peakRSS=%sMB aggRSS=%sMB p95=%sms%s' % (
        label, result['cpu_per_render_ms'], result['cpu_s_per_wall_minute'],
        round(result['peak_rss_kb'] / 1024, 1),
        '%s→%s' % (round(result['rss_sampling'].get('aggregate_mean_kb', 0) / 1024, 1), round(result['rss_sampling'].get('aggregate_max_kb', 0) / 1024, 1)),
        result['latency_ms']['p95'],
        (' git/render=%s' % result['spawn_counts_per_render'].get('git')) if result['spawn_counts_per_render'] else ''), flush=True)
    return result

def fmt_mb(kb):
    return round(kb / 1024, 1)

def write_summary(out_dir, meta, runs):
    lines = ['# ccstatusline one-shot baseline (N sessions)', '',
             'Baseline reference for daemon epic axisrow/ccstatusline#14: what the',
             'current per-invocation model costs today. The daemon red line is',
             'aggregate CPU and RSS not above these numbers.', '',
             '- runtime: `%s %s`%s' % (meta['runtime'], meta['entry'], ', CCSL_FORK=1' if meta.get('ccsl_fork') else ''),
             '- machine: %s, %s cores, %s' % (meta['machine']['cpu_model'], meta['machine']['cpu_count'], meta['machine']['os']),
             '- generated: %s, loadavg before/after: %s/%s' % (meta['generated'], meta['loadavg_start'], meta['loadavg_end']),
             '- spawn counts come from separate instrumented passes (PATH shims);',
             '  their CPU/latency numbers are excluded from this report.', '']

    def table(rows, show_counts):
        header = '| scenario | renders | CPU s/render | CPU s/wall-min | peak RSS MB | agg RSS MB mean→max | p50 ms | p95 ms | p99 ms |'
        if show_counts:
            header += ' git/render |'
        lines.append(header)
        lines.append('|' + '---|' * (10 if show_counts else 9))
        for r in rows:
            lat = r['latency_ms']
            counts = r.get('spawn_counts_per_render', {})
            row = '| %s | %d | %s | %s | %s | %s→%s | %s | %s | %s |' % (
                r['label'], r['renders'], r['cpu_per_render_ms'], r['cpu_s_per_wall_minute'],
                fmt_mb(r['peak_rss_kb']),
                fmt_mb(r['rss_sampling'].get('aggregate_mean_kb', 0)), fmt_mb(r['rss_sampling'].get('aggregate_max_kb', 0)),
                lat['p50'], lat['p95'], lat['p99'])
            if show_counts:
                row += ' %s |' % counts.get('git', 'n/a')
            lines.append(row)
        lines.append('')

    for mode in ('cold', 'warm'):
        rows = [r for r in runs if r['mode'] == mode and not r['count_pass'] and not r['label'].endswith(('r2', 'r3'))]
        if rows:
            lines.append('## %s (fresh HOME, first render per session)' % mode if mode == 'cold' else '## %s (%d warmup renders, then measured)' % (mode, WARMUP_RENDERS))
            lines.append('')
            table(rows, show_counts=False)

    count_rows = [r for r in runs if r['count_pass']]
    if count_rows:
        lines.append('## Spawn counts (instrumented passes)')
        lines.append('')
        lines.append('| scenario | git/render | security/render |')
        lines.append('|---|---|---|')
        for r in count_rows:
            c = r['spawn_counts_per_render']
            lines.append('| %s | %s | %s |' % (r['label'], c.get('git', 'n/a'), c.get('security', 'n/a')))
        lines.append('')

    repeats = [r for r in runs if r['label'].endswith(('r2', 'r3'))]
    base = [r for r in runs if r['label'] == 's36-warm-small' and not r['count_pass']]
    if base and repeats:
        lines.append('## Run-to-run variance (%s, repeated)' % base[0]['label'])
        lines.append('')
        lines.append('| run | CPU s/render | CPU s/wall-min | agg RSS MB max | p95 ms |')
        lines.append('|---|---|---|---|---|')
        for r in base + repeats:
            lines.append('| %s | %s | %s | %s | %s |' % (r['label'], r['cpu_per_render_ms'], r['cpu_s_per_wall_minute'], fmt_mb(r['rss_sampling'].get('aggregate_max_kb', 0)), r['latency_ms']['p95']))
        lines.append('')

    failures = [r for r in runs if r.get('error')]
    if failures:
        lines.append('## Failed scenarios')
        lines.append('')
        for r in failures:
            lines.append('- %s: %s' % (r['label'], r['error'][:300]))
        lines.append('')
    lines.append('## Noise and honesty notes')
    lines.append('')
    for note in meta['notes']:
        lines.append('- %s' % note)
    (out_dir / 'BASELINE.md').write_text('\n'.join(lines) + '\n')

def cmd_baseline(args):
    out_dir = pathlib.Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    fixture_root = out_dir / 'fixture-root'
    fixture_root.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env['CCSTATUSLINE_BENCH_DIR'] = str(fixture_root)
    max_load = args.max_load if args.max_load is not None else (os.cpu_count() or 4) / 2
    sessions = [int(s) for s in args.sessions.split(',')]
    transcripts = args.transcripts.split(',')
    la_start = wait_for_load(max_load, args.load_wait_sec)
    runs = []
    plan = []
    for s in sessions:
        for mode in ('cold', 'warm'):
            for t in transcripts:
                plan.append((s, mode, t, False, ''))
                plan.append((s, mode, t, True, ''))
    for extra in range(2, args.repeat + 1):
        plan.append((36, 'warm', 'small', False, '-r%d' % extra))
    for s, mode, t, count_pass, suffix in plan:
        try:
            wait_for_load(max_load, args.load_wait_sec)
            runs.append(run_scenario(env, args, s, mode, t, count_pass, suffix))
        except Exception as e:
            print('[baseline] FAILED s%d-%s-%s%s: %s' % (s, mode, t, suffix, e), flush=True)
            runs.append({'label': 's%d-%s-%s%s%s' % (s, mode, t, '-counts' if count_pass else '', suffix), 'mode': mode, 'count_pass': count_pass, 'error': str(e)})
    meta = {
        'runtime': args.runtime, 'entry': str(pathlib.Path(args.entry).resolve()), 'ccsl_fork': True,
        'machine': machine_context(), 'generated': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'loadavg_start': la_start, 'loadavg_end': loadavg1(), 'max_load_gate': max_load,
        'warmup_renders': WARMUP_RENDERS, 'warm_measured': WARM_MEASURED,
        'notes': [
            'Measured numbers only; no extrapolation from fewer sessions.',
            'Every render is a fresh ccstatusline process (one-shot mode as Claude Code invokes it today).',
            'CPU accounting covers user+sys of all reaped descendants (runtime + git + sh) via getrusage(RUSAGE_CHILDREN) in a dedicated interpreter per scenario.',
            'Aggregate RSS is sampled via ps over live process trees (~%sms cadence); short-lived git children can be missed, so it undercounts.' % args.interval_ms,
            'peak RSS is getrusage ru_maxrss of the largest reaped child tree; for warm runs it includes warmup children (identical workload).',
            'Spawn counts are from separate instrumented passes with PATH shims (git, security); shim overhead excludes their CPU/latency from baseline tables. Spawns via absolute paths (e.g. runtime self-spawn for git review refresh) are not shim-visible; the synthetic repo has no origin remote, so review-cache refresh does not trigger.',
            'macOS page cache is not purged; cold means fresh HOME and first render, not cold disk.',
            'Shared dirty git repo as cwd; all sessions share one HOME per run (same-OS-user realism); each session has its own transcript file.',
            'Runs were rejected/waited while system loadavg1 exceeded %s (gate recorded above); concurrent sibling sessions still add noise.' % max_load,
            'The harness sampler (ps loop) adds a small constant measurement overhead, identical across scenarios.',
        ],
    }
    (out_dir / 'baseline.json').write_text(json.dumps({'meta': meta, 'runs': runs}, indent=2))
    write_summary(out_dir, meta, runs)
    failed = sum(1 for r in runs if r.get('error'))
    print('[baseline] done: %d runs, %d failed. Results: %s/baseline.json, %s/BASELINE.md' % (len(runs), failed, out_dir, out_dir), flush=True)
    return 1 if failed else 0

def cmd_self_test():
    assert pctl([5.0], 0.5) == 5.0
    xs = sorted(range(1, 101))
    assert pctl(xs, 0.5) == 50 and pctl(xs, 0.99) == 99 and pctl(xs, 0.95) == 95
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='ccsl-bench-selftest-'))
    fixture = make_fixture(tmp / 'small.jsonl', FIXTURE_ROWS['small'])
    lines = fixture.read_text().splitlines()
    assert len(lines) == 500 and json.loads(lines[0])['type'] == 'user'
    shim_dir, shims = make_shims(tmp)
    assert ('git', tmp / 'count-git.log') in shims
    env = dict(os.environ, PATH=str(shim_dir) + os.pathsep + os.environ['PATH'], HOME=str(tmp))
    subprocess.run(['git', '--version'], env=env, check=True, capture_output=True)
    subprocess.run(['git', '--version'], env=env, check=True, capture_output=True)
    assert read_count(tmp / 'count-git.log') == 2, read_count(tmp / 'count-git.log')
    shutil.rmtree(tmp)
    print('self-test PASS')
    return 0

def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'baseline':
        p = argparse.ArgumentParser(prog='benchmark-render.py baseline')
        p.add_argument('--runtime', required=True)
        p.add_argument('--entry', required=True)
        p.add_argument('--out', required=True)
        p.add_argument('--sessions', default='1,10,36')
        p.add_argument('--transcripts', default='small,large')
        p.add_argument('--repeat', type=int, default=3, help='total runs of the variance scenario s36-warm-small (default 3)')
        p.add_argument('--max-load', type=float, default=None, help='loadavg1 gate, default cpu_count/2')
        p.add_argument('--load-wait-sec', type=int, default=1800)
        p.add_argument('--interval-ms', type=int, default=25)
        args = p.parse_args(sys.argv[2:])
        sys.exit(cmd_baseline(args))
    if len(sys.argv) > 1 and sys.argv[1] == 'run-one':
        p = argparse.ArgumentParser(prog='benchmark-render.py run-one')
        p.add_argument('--runtime', required=True)
        p.add_argument('--entry', required=True)
        p.add_argument('--sessions', type=int, required=True)
        p.add_argument('--mode', choices=['cold', 'warm'], required=True)
        p.add_argument('--transcript', choices=sorted(FIXTURE_ROWS), required=True)
        p.add_argument('--count-pass', action='store_true')
        p.add_argument('--run-suffix', default='')
        p.add_argument('--interval-ms', type=int, default=25)
        p.add_argument('--max-load', type=float, default=None)
        args = p.parse_args(sys.argv[2:])
        cmd_run_one(args)
        return
    if len(sys.argv) > 1 and sys.argv[1] == '_sampler':
        p = argparse.ArgumentParser(prog='benchmark-render.py _sampler')
        p.add_argument('--target-pid', type=int, required=True)
        p.add_argument('--interval-ms', type=int, default=25)
        args = p.parse_args(sys.argv[2:])
        cmd_sampler(args)
        return
    if len(sys.argv) > 1 and sys.argv[1] == '--self-test':
        sys.exit(cmd_self_test())
    if len(sys.argv) > 3:
        run(sys.argv[1], sys.argv[2], sys.argv[3], '--width' in sys.argv)
        return
    print('usage: benchmark-render.py <runtime> <entry> <label> [--width]  (legacy #397)\n'
          '       benchmark-render.py baseline --runtime R --entry E --out DIR [--sessions 1,10,36]\n'
          '       benchmark-render.py --self-test')

if __name__ == '__main__':
    main()
