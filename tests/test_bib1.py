import pytest
from rag.bib1 import should_trigger_bib1, query_bib1, format_bib1_context, get_bib1_rag


def test_bib1_classification_rejects_diff_and_edit_tasks():
    assert not should_trigger_bib1("corrige la ligne 42 de main.c")
    assert not should_trigger_bib1("applique ce patch sur app.py")
    assert not should_trigger_bib1("remplace le diff ci-dessous")


def test_bib1_classification_triggers_on_api_and_architecture():
    assert should_trigger_bib1("Comment fonctionne l'architecture de la passerelle ?")
    assert should_trigger_bib1("Explique la spécification de l'API Anthropic")
    assert should_trigger_bib1("Quelle est la documentation du protocole ?")


def test_bib1_classification_manual_override_header():
    assert should_trigger_bib1("patch code", headers={"x-mazz-bib1": "1"})


def test_bib1_query_enforces_max_2_fragments_and_relevance():
    frags = query_bib1("unicode codecs", max_fragments=2, min_score=8.0)
    assert isinstance(frags, list)
    assert len(frags) <= 2
    for f in frags:
        assert f["score"] >= 8.0
        assert f["title"]
        assert len(f["body"]) <= 1500


def test_bib1_query_handles_missing_db_gracefully(tmp_path):
    missing = str(tmp_path / "absent.db")
    frags = query_bib1("anything", db_path=missing)
    assert frags == []


def test_bib1_formatting_creates_clean_context():
    sample = [
        {"title": "Doc A", "heading": "Sec 1", "score": 14.5, "body": "Contenu A"},
        {"title": "Doc B", "heading": "", "score": 12.2, "body": "Contenu B"}
    ]
    formatted = format_bib1_context(sample)
    assert "[CONTEXTE DE CONNAISSANCES FACTUELLES BIB1 - VÉRIFIÉ]" in formatted
    assert "Doc A > Sec 1 (score BM25: 14.5)" in formatted
    assert "Doc B (score BM25: 12.2)" in formatted
    assert "[FIN CONTEXTE BIB1]" in formatted
