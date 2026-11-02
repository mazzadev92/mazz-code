"""Per-backend circuit breaker (spec 06).

CLOSED: requests pass. FAIL_THRESHOLD consecutive failures open the circuit: the backend is skipped for
OPEN_SECONDS, then HALF_OPEN lets requests probe it; a success closes it, a failure reopens it at once.
Only a missing endpoint (404), timeouts, rate limits, server errors and network errors count (trips);
a 4xx such as 400, 401 or 403 is the caller's problem and never moves the circuit.
"""
import time

FAIL_THRESHOLD = 3
OPEN_SECONDS = 60.0

_clock = time.monotonic
_circuits = {}  # backend id -> {"failures": int, "opened_at": float | None}


def trips(status):
    # 404 on a remote chat endpoint means the deployment is gone (stopped Modal app, dead tunnel).
    return status in (404, 408, 429) or status >= 500


def state(backend_id):
    c = _circuits.get(backend_id)
    if not c or c["opened_at"] is None:
        return "closed"
    return "open" if _clock() - c["opened_at"] < OPEN_SECONDS else "half_open"


def allow(backend_id):
    return state(backend_id) != "open"


def record_success(backend_id):
    _circuits.pop(backend_id, None)


def record_failure(backend_id):
    c = _circuits.setdefault(backend_id, {"failures": 0, "opened_at": None})
    c["failures"] += 1
    if c["failures"] >= FAIL_THRESHOLD:
        c["opened_at"] = _clock()


def reset():
    _circuits.clear()
