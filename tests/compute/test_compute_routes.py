import time

import pytest

from compute.jobs import JobStore
from compute.routes import set_service
from compute.service import ComputeService
from test_compute import FakeHf, FakeProvider
from test_gateway import KEY, env  # noqa: F401  (pytest fixture)


@pytest.fixture()
def svc():
    service = ComputeService({"fake": FakeProvider()}, JobStore(None), announce_timeout=1, announce_poll=0.01, hf_module=FakeHf(sizes={("u/models", "m.gguf"): 1}))
    set_service(service)
    yield service
    set_service(None)


def test_computeRoutes_listProvidersWithStateAndDeployments(env, svc):
    # Arrange
    client, _, _ = env
    # Act
    reply = client.get("/compute/providers")
    # Assert
    item = reply.json()["providers"][0]
    assert reply.status_code == 200 and item["id"] == "fake" and item["state"]["ok"] is True and item["deployments"] == []


def test_computeRoutes_sendRequiresTheControlKeyAndStartsAJob(env, svc):
    # Arrange
    client, _, _ = env
    payload = {"source": {"type": "hf", "repo": "u/models", "file": "m.gguf"}, "target": "fake"}
    # Act
    anonymous = client.post("/compute/send", json=payload)
    started = client.post("/compute/send", json=payload, headers=KEY)
    time.sleep(0.3)
    polled = client.get(f"/compute/jobs/{started.json()['id']}")
    # Assert
    assert anonymous.status_code == 401 and started.status_code == 202 and polled.status_code == 200
    assert polled.json()["title"].endswith("Fake GPU") and len(client.get("/compute/jobs").json()["jobs"]) == 1


def test_computeRoutes_unknownTargetOrJob_returnClearErrors(env, svc):
    # Arrange
    client, _, _ = env
    # Act
    bad = client.post("/compute/send", json={"source": {"type": "hf", "file": "m.gguf"}, "target": "nope"}, headers=KEY)
    missing = client.get("/compute/jobs/unknown")
    # Assert
    assert bad.status_code == 400 and "inconnu" in bad.json()["error"]["message"] and missing.status_code == 404


def test_computeRoutes_configureOnAProviderWithoutSecret_isRefused(env, svc):
    # Arrange
    client, _, _ = env
    # Act
    reply = client.post("/compute/providers/fake/configure", json={"token": "x"}, headers=KEY)
    # Assert
    assert reply.status_code == 400


def test_computeLogsRoutes_requireTheControlKey_andRefuseTraversal(env, svc):
    # Arrange
    from compute import logs
    client, _, _ = env
    name = logs.save("colab", "mazz-m", "hello hf_AbCdEfGhIjKlMnOpQrSt1234")
    # Act / Assert
    anon = {"x-api-key": ""}
    assert client.get("/compute/logs", headers=anon).status_code == 401 and client.get(f"/compute/logs/{name}", headers=anon).status_code == 401
    assert client.get("/compute/logs", headers=KEY).status_code == 200
    ok = client.get(f"/compute/logs/{name}", headers=KEY)
    assert ok.status_code == 200 and "hf_AbCd" not in ok.text
    assert client.get("/compute/logs/..%2F..%2Fapp.py", headers=KEY).status_code in (400, 404)
    assert client.get("/compute/logs/%2e%2e%2fapp.log", headers=KEY).status_code in (400, 404)
