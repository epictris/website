"""The scene export's growth workers: the ivy and the moss it has to grow,
grown side by side in factory-startup Blenders instead of one after another
in the export's own (172 s of the river's 415 s export on 2026-11-13, nearly
all of it Python on one core).

A growth needs nothing of the scene but its hosts' world triangles, its
paint and its settings (ivy/ops.py `build_job`, moss/ops.py `_Inputs.job`):
the export takes those, the workers union the hosts (stampbrush/hosts.py)
and build, and the export writes each result into its object exactly as a
rebuild in place would (`ivy.ops.apply`, `moss.ops.apply_grown`).

The protocol is the bake workers' (scene_export.run_workers): a worker
prints `[growth_worker] ready`, the export writes the number of the next
job or closes stdin; the jobs and their results are pickles in one
directory. A worker that fails fails the export, with its last lines.

    blender -b --factory-startup --python growth_pool.py -- --grow-worker DIR
"""

import os
import pickle
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# How many growth workers at most (SCENE_EXPORT_GROWERS overrides it; 1
# grows everything in the export's own Blender). Each is a few hundred MB;
# the moss build runs threads of its own.
GROWERS = int(os.environ.get("SCENE_EXPORT_GROWERS", "0")) or max(1, (os.cpu_count() or 2) // 2)


def run(jobs, log):
    """Grow `jobs`, [(key, kind, job, estimate)] with `kind` "ivy" or "moss"
    and `estimate` its last build's milliseconds, largest first, in up to
    GROWERS workers. Returns {key: (result, why, build_ms)}: `why` is why a
    moss did not grow (result None), `build_ms` the worker's wall time.

    Growths on the same hosts go to one worker, one after another: the union
    of their hosts is made once and kept (stampbrush/hosts.py), where two
    workers would each make it (two ivies on Terrace.002 + Cube.002, 31 s
    each, 2026-11-13)."""
    import queue
    import shutil
    import subprocess
    import tempfile
    import threading

    import bpy

    from moss.stampbrush.hosts import parts_key

    t0 = time.time()
    work = tempfile.mkdtemp(prefix="scene-export-growth-")
    try:
        groups = {}
        for i, (_key, kind, job, _est) in enumerate(jobs):
            with open(os.path.join(work, f"{i}.job"), "wb") as f:
                pickle.dump((kind, job), f, protocol=pickle.HIGHEST_PROTOCOL)
            groups.setdefault(parts_key(job["parts"]), []).append(i)
        names = queue.Queue()
        for group in sorted(groups.values(), key=lambda g: -sum(jobs[i][3] for i in g)):
            names.put(" ".join(map(str, sorted(group, key=lambda i: -jobs[i][3]))))
        count = min(GROWERS, len(groups))
        cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python-exit-code", "1",
               "--python", os.path.abspath(__file__), "--", "--grow-worker", work]
        failures, lock = [], threading.Lock()

        def drive(n):
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1)
            tail = []
            for line in proc.stdout:
                line = line.rstrip("\n")
                tail = (tail + [line])[-40:]
                if line == "[growth_worker] ready":
                    try:
                        proc.stdin.write(names.get_nowait() + "\n")
                        proc.stdin.flush()
                    except queue.Empty:
                        proc.stdin.close()
            if proc.wait() != 0:
                with lock:
                    failures.append(f"growth worker {n} (exit {proc.returncode}):\n" + "\n".join(tail))

        threads = [threading.Thread(target=drive, args=(n,)) for n in range(count)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        if failures:
            raise SystemExit("a growth worker failed; nothing shipped:\n" + "\n".join(failures))
        out = {}
        for i, (key, _kind, _job, _est) in enumerate(jobs):
            path = os.path.join(work, f"{i}.out")
            if not os.path.isfile(path):
                raise SystemExit(f"{key}: its growth worker handed back no result")
            with open(path, "rb") as f:
                out[key] = pickle.load(f)
        log(f"growth: {len(jobs)} grown in {count} workers ({len(groups)} sets of hosts) in {time.time() - t0:.1f}s")
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)


def grow(kind, job):
    """(result, why): one growth, here."""
    if kind == "ivy":
        from ivy import ops
        return ops.grow_job(job), None
    from moss import ops
    return ops.grow_job(job)


def worker_main(argv):
    work = argv[argv.index("--grow-worker") + 1]
    while True:
        print("[growth_worker] ready", flush=True)
        names = sys.stdin.readline().split()
        if not names:
            return
        for name in names:
            with open(os.path.join(work, f"{name}.job"), "rb") as f:
                kind, job = pickle.load(f)
            t0 = time.perf_counter()
            result, why = grow(kind, job)
            ms = (time.perf_counter() - t0) * 1000.0
            tmp = os.path.join(work, f"{name}.out.tmp")
            with open(tmp, "wb") as f:
                pickle.dump((result, why, ms), f, protocol=pickle.HIGHEST_PROTOCOL)
            os.replace(tmp, os.path.join(work, f"{name}.out"))


if __name__ == "__main__" and "--grow-worker" in sys.argv:
    sys.path.insert(0, HERE)
    # Unpickling names the classes by these packages' modules (ivy.build,
    # moss.stampbrush.stamps, ...), as the export imports them.
    import ivy  # noqa: F401
    import moss  # noqa: F401
    worker_main(sys.argv)
