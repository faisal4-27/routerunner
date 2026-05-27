#!/usr/bin/env python3
"""
Start Route Runner's frontend and backend together.

Usage (from the project root):

    python run.py          # start frontend + backend
    python run.py --stop   # free ports 8000 and 3001 if a previous run is stuck

Then open http://127.0.0.1:3001 in your browser.

Press Ctrl+C in the terminal running `python run.py` to stop both servers.
"""

from __future__ import annotations

import os

# Disable Python bytecode caching for this process AND any subprocesses we
# spawn (uvicorn, the static server). Setting it before importing anything
# project-related guarantees no `__pycache__` folders are ever written.
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import signal
import socket
import subprocess
import sys
import time

# Project folders (this file lives in the repo root).
ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(ROOT, "backend")

FRONTEND_PORT = 3001
# Backend port is configurable so deployment platforms (Render, Fly, etc.)
# can inject their own PORT env var without touching this file.
BACKEND_PORT = int(os.environ.get("PORT", "8000"))

# Child processes we start below — used to shut everything down on Ctrl+C.
children: list[subprocess.Popen] = []


def _port_is_open(host: str, port: int) -> bool:
    """Return True if something is already listening on host:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex((host, port)) == 0


def _pid_listening_on_port(port: int) -> int | None:
    """Best-effort lookup of the process ID using a TCP port (Windows)."""
    if sys.platform != "win32":
        return None
    try:
        out = subprocess.check_output(
            ["netstat", "-ano"],
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.CalledProcessError):
        return None

    for line in out.splitlines():
        # Example: TCP    127.0.0.1:8000    0.0.0.0:0    LISTENING    8500
        if f":{port}" not in line or "LISTENING" not in line:
            continue
        parts = line.split()
        if len(parts) >= 5 and parts[-1].isdigit():
            return int(parts[-1])
    return None


def _pids_on_port(port: int) -> list[int]:
    """Return process IDs listening on a TCP port (Windows via netstat)."""
    if sys.platform != "win32":
        pid = _pid_listening_on_port(port)
        return [pid] if pid else []
    try:
        out = subprocess.check_output(
            ["netstat", "-ano"],
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.CalledProcessError):
        return []

    pids: list[int] = []
    for line in out.splitlines():
        if f":{port}" not in line or "LISTENING" not in line:
            continue
        parts = line.split()
        if len(parts) >= 5 and parts[-1].isdigit():
            pid = int(parts[-1])
            if pid not in pids:
                pids.append(pid)
    return pids


def _orphan_server_pids() -> list[int]:
    """
    Uvicorn's reloader can die while a worker child keeps port 8000 open.
    Find leftover python.exe processes started for this project.
    """
    if sys.platform != "win32":
        return []
    try:
        ps = (
            "Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | "
            "Where-Object { "
            "($_.CommandLine -match 'uvicorn' -and $_.CommandLine -match 'app.main') "
            "-or ($_.CommandLine -match 'http.server' -and $_.CommandLine -match '3001') "
            "} | Select-Object -ExpandProperty ProcessId"
        )
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command", ps],
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return [int(line.strip()) for line in out.splitlines() if line.strip().isdigit()]
    except (OSError, subprocess.CalledProcessError, ValueError):
        return []


def _kill_pid(pid: int) -> None:
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/F", "/T"],
            check=False,
            capture_output=True,
        )
    else:
        os.kill(pid, signal.SIGTERM)


def stop_stale_servers() -> None:
    """Stop any process still listening on the Route Runner ports."""
    targets: set[int] = set()
    for port in (BACKEND_PORT, FRONTEND_PORT):
        targets.update(_pids_on_port(port))
    targets.update(_orphan_server_pids())

    if not targets:
        print("No servers were listening on ports 8000 or 3001.")
        return

    for pid in sorted(targets):
        print(f"Stopping PID {pid}…")
        _kill_pid(pid)

    time.sleep(0.5)
    print("Done. Run `python run.py` to start again.")


def _check_ports() -> None:
    """Fail fast with a helpful message if required ports are taken."""
    host = "127.0.0.1"
    blocked: list[tuple[int, int | None]] = []

    if _port_is_open(host, BACKEND_PORT):
        pids = _pids_on_port(BACKEND_PORT)
        blocked.append((BACKEND_PORT, pids[0] if pids else None))
    if _port_is_open(host, FRONTEND_PORT):
        pids = _pids_on_port(FRONTEND_PORT)
        blocked.append((FRONTEND_PORT, pids[0] if pids else None))

    if not blocked:
        return

    print("Cannot start — required port(s) already in use:\n")
    for port, pid in blocked:
        label = "backend (FastAPI)" if port == BACKEND_PORT else "frontend"
        print(f"  Port {port} ({label})")
        if pid:
            print(f"    Process ID: {pid}")
            if sys.platform == "win32":
                print(f"    Stop it:    taskkill /PID {pid} /F")
            else:
                print(f"    Stop it:    kill {pid}")
        print()

    print(
        "Route Runner is probably already running in another terminal.\n"
        "Either close that terminal, or run:\n\n"
        "    python run.py --stop\n"
    )
    sys.exit(1)


def _stop_children() -> None:
    """Terminate backend and frontend if they are still running."""
    for proc in children:
        if proc.poll() is None:
            proc.terminate()
    for proc in children:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _on_interrupt(_signum: int, _frame: object) -> None:
    print("\nStopping servers…")
    _stop_children()
    sys.exit(0)


def main() -> None:
    if not os.path.isdir(BACKEND_DIR):
        print("Error: backend/ folder not found. Run this script from the project root.")
        sys.exit(1)

    signal.signal(signal.SIGINT, _on_interrupt)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _on_interrupt)

    _check_ports()

    print("Starting Route Runner…")
    print(f"  Backend:  http://127.0.0.1:{BACKEND_PORT}  (FastAPI)")
    print(f"  Frontend: http://127.0.0.1:{FRONTEND_PORT}  (static files)")
    print("Press Ctrl+C to stop both.\n")

    # API server (must run with cwd=backend so `app.main` imports work).
    backend = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--reload",
            "--port",
            str(BACKEND_PORT),
        ],
        cwd=BACKEND_DIR,
    )
    children.append(backend)

    # Static site (index.html, app.js, style.css).
    frontend = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(FRONTEND_PORT), "--bind", "127.0.0.1"],
        cwd=ROOT,
    )
    children.append(frontend)

    # Give uvicorn a moment to bind before the user opens the browser.
    time.sleep(1.5)

    # If either process exited immediately, something failed (missing deps, port race).
    for proc in children:
        if proc.poll() is not None:
            print("A server exited unexpectedly. Check the output above for errors.")
            print("If you see WinError 10013, port 8000 is blocked or already in use.")
            print("Tip: install backend deps with:")
            print("  pip install -r backend/requirements.txt")
            _stop_children()
            sys.exit(1)

    print("Ready — open http://127.0.0.1:3001\n")

    try:
        while True:
            for proc in children:
                if proc.poll() is not None:
                    print("A server stopped. Shutting down the other…")
                    _stop_children()
                    sys.exit(proc.returncode or 1)
            time.sleep(0.5)
    except KeyboardInterrupt:
        _on_interrupt(0, None)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("--stop", "-stop", "stop"):
        stop_stale_servers()
    else:
        main()
