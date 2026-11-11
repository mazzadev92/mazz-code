"""Régression : une erreur Modal doit rester lisible, jamais masquée par le parsing JSON."""
from core import quotas


def test_modal_failure_reports_real_error(monkeypatch):
    monkeypatch.setattr(quotas, "_run", lambda *a, **k: (1, "", "No Modal config found"))
    entry = quotas.modal()
    assert entry["status"] == "error"
    assert "No Modal config found" in entry["error"]
    assert "substring" not in entry["error"].lower()


def test_modal_success_parses_json_even_with_prefix_noise(monkeypatch):
    monkeypatch.setattr(quotas, "_run", lambda *a, **k: (0, 'warning\n{"metered_cost": 2.5, "billed_cost": 0}', ""))
    entry = quotas.modal()
    assert entry["status"] == "ok"
    assert entry["used"] == 2.5
    assert entry["remaining"] == 27.5
