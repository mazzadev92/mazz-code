import os
import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from compute import logs
from compute.providers import Colab, Kaggle
from compute.routes import router
from test_compute import ColabFake, kaggle_home  # noqa: F401  (fixture)

NONCE = "a" * 32
SECRET_TEXT = f"token hf_AbCdEfGhIjKlMnOpQrSt1234 and sk-abcdefghijklmnop1234 Authorization: Bearer abcdefgh12345678 'nonce': '{NONCE}' key {'b' * 64} sha {'c' * 40}"


def test_redact_removesTokensNonceAndKey_butKeepsGitShas():
    out = logs.redact(SECRET_TEXT)
    assert "hf_AbCd" not in out and "sk-abcd" not in out and "abcdefgh12345678" not in out and NONCE not in out and "b" * 64 not in out


@pytest.mark.parametrize("secret", ["ghp_" + "A1b2C3d4E5" * 3, "github_pat_" + "A1b2C3d4E5" * 3, "AIza" + "SyA1b2C3d4E5F6G7h8", "gsk_" + "A1b2C3d4E5f6", "nvapi-" + "A1b2C3d4E5f6",
                                    "xoxb-123456789012-abcdefghij", "xoxp-123456789012-abcdefghij", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
                                    "d" * 32, "e" * 64, "Bearer zzzzzzzz9999", "api_key = Zq9Xw8Vu7", "PASSWORD: hunter2hunter", "Token=abc123def", "secret: 'shh1234'"])
def test_redact_everyPatternIsRemoved(secret):
    assert secret.split()[-1].strip("'") not in logs.redact(f"before {secret} after") and "[REDACTED]" in logs.redact(secret)


def test_save_keepsLast200kBAndPrunesToTwentyNewest():
    names = []
    for i in range(23):
        names.append(logs.save("kaggle", f"bob/k{i}", "x" * 300_000 if i == 22 else f"log {i}"))
        os.utime(logs.logs_dir() / names[-1], ns=(i * 10**9, i * 10**9))
    listed = [item["name"] for item in logs.list_logs()]
    assert len(listed) == 20 and names[22] in listed and names[0] not in listed
    assert (logs.logs_dir() / names[22]).stat().st_size == logs.KEEP_BYTES


def test_routes_listAndReadLogs_refuseTraversalAndBadNames():
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    name = logs.save("colab", "mazz-m", SECRET_TEXT)
    assert client.get("/compute/logs").json()["logs"][0]["name"] == name
    body = client.get(f"/compute/logs/{name}")
    assert body.status_code == 200 and "hf_AbCd" not in body.text
    for bad in ("..%2F..%2Fapp.py", "%2e%2e%2fapp.log", "..", "a.txt", "x%5Cy.log", "missing.log"):
        assert client.get(f"/compute/logs/{bad}").status_code in (404, 400)
    assert logs.read("../x.log") is None and logs.read("sub/x.log") is None


def test_kaggle_stop_savesRedactedLogBeforeDeleting_andSurvivesFetchFailure(kaggle_home):
    calls = []

    def runner(argv, timeout):
        calls.append(argv[4])
        if argv[4] == "output":
            with open(os.path.join(argv[argv.index("-p") + 1], "k.log"), "wb") as f:
                f.write(b"boot hf_AbCdEfGhIjKlMnOpQrSt1234 \xff end")
        return subprocess.CompletedProcess(argv, 0, "ok", "")

    result = Kaggle(runner).stop("bob/k")
    assert calls == ["output", "delete"] and result["stopped"] is True
    saved = logs.read(result["log"])
    assert "hf_AbCd" not in saved and saved.endswith("end")

    def broken(argv, timeout):
        if argv[4] == "output":
            raise OSError("net")
        return subprocess.CompletedProcess(argv, 0, "ok", "")

    after = Kaggle(broken).stop("bob/k")
    assert after["stopped"] is True and after["log"] == ""


def test_colab_stop_savesServerLog_andFailedFetchDoesNotBlockStop():
    class Fake(ColabFake):
        def __call__(self, argv, timeout):
            if "colab exec" in argv[-1]:
                self.calls.append("exec")
                return subprocess.CompletedProcess(argv, 0, "server up hf_AbCdEfGhIjKlMnOpQrSt1234", "")
            return super().__call__(argv, timeout)

    fake = Fake()
    result = Colab(runner=fake).stop("mazz-m")
    assert fake.calls == ["exec", "stop"] and "hf_AbCd" not in logs.read(result["log"])
    boom = ColabFake(fail="exec")
    assert Colab(runner=boom).stop("mazz-m")["stopped"] is True and "stop" in boom.calls

