"""Run the frozen original-v1 suite serially; preserve every process result."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
directory = Path(sys.argv[1]).resolve()
suite = json.loads((directory / "suite.json").read_text())
lms = "/Users/amir/.lmstudio/bin/lms"
records = []
keep_awake = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])


def save():
    (directory / "processes.json").write_text(json.dumps(records, indent=2) + "\n")


def model_command(arguments, label):
    result = subprocess.run([lms, *arguments], capture_output=True, text=True)
    (directory / f"{label}.stdout.txt").write_text(result.stdout)
    (directory / f"{label}.stderr.txt").write_text(result.stderr)
    if result.returncode:
        raise RuntimeError(f"LM Studio command failed: {arguments}")


try:
    for model in suite["models"]:
        name = model.split("/")[1]
        loaded = json.loads(subprocess.check_output([lms, "ps", "--json"], text=True))
        if not loaded:
            model_command(["load", model, "--context-length", "8192", "--parallel", "1", "--yes"], f"{name}-load")
        elif len(loaded) != 1 or model not in json.dumps(loaded):
            raise RuntimeError("Unexpected model already loaded; preserving its state")
        for task in suite["tasks"]:
            for arm in ["v1", "v2"]:
                job = directory / name / arm / task["id"]
                if (job / "final.json").exists() or (job / "fatal.json").exists():
                    records.append({"model": model, "arm": arm, "task": task["id"], "previouslyCompleted": True, "fatal": (job / "fatal.json").exists()})
                    save()
                    continue
                job.mkdir(parents=True, exist_ok=True)
                record = {"model": model, "arm": arm, "task": task["id"], "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                print("START", model, arm, task["id"], flush=True)
                with (job / "stdout.txt").open("w") as stdout, (job / "stderr.txt").open("w") as stderr:
                    try:
                        result = subprocess.run(["node", "--import", "tsx", "evals/scripts/original-v1-qwen-comparison.ts", "--worker", str(directory), model, arm, task["id"]], cwd=root, stdout=stdout, stderr=stderr, timeout=3600)
                        record["exitCode"] = result.returncode
                    except subprocess.TimeoutExpired:
                        record["timedOut"] = True
                record["completedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                record["hasFinal"] = (job / "final.json").exists()
                records.append(record)
                save()
                print("END", model, arm, task["id"], record, flush=True)
        model_command(["unload", model], f"{name}-unload")
finally:
    loaded = json.loads(subprocess.check_output([lms, "ps", "--json"], text=True))
    if len(loaded) == 1 and any(model in json.dumps(loaded) for model in suite["models"]):
        subprocess.run([lms, "unload"], capture_output=True, text=True)
    keep_awake.terminate()
