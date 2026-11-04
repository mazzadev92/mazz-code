"""Bib1 FTS5 deterministic knowledge base integration (spec 00 §3, spec 06 §7).

Provides conditional RAG on the 56,921 indexed fragments in SQLite FTS5.
Triggers only on API/architectural exploration queries with BM25 score >= 12.0.
Capped at 2 fragments maximum (< 1,000 tokens). Never triggers on code diff / edit tasks.
Safe: an error in RAG never interrupts request routing or streaming.
"""
import os
import re
import sqlite3
from typing import List, Dict, Optional

BIB1_DB_PATH = os.environ.get("MAZZ_BIB1_DB") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "Bib1", "data", "knowledge.db")
MIN_BM25_SCORE = 12.0
MAX_FRAGMENTS = 2

# Terms indicating code edition/diff tasks (RAG explicitly forbidden by spec 06 §7)
EXCLUDE_PATTERNS = re.compile(
    r"\b(corrige|applique|patch|remplace|diff|ligne\s*\d+|line\s*\d+|replace\s*line|syntax\s*error)\b",
    re.IGNORECASE
)

# Terms indicating architectural, API or knowledge exploration
TRIGGER_PATTERNS = re.compile(
    r"\b(comment|api|doc|documentation|architecture|spec|specification|spécification|fonctionne|expliquer|structure|protocole|format|reference|référence)\b",
    re.IGNORECASE
)


def should_trigger_bib1(query: str, headers: Optional[dict] = None) -> bool:
    """Classifies whether Bib1 knowledge retrieval should trigger."""
    headers = headers or {}
    if str(headers.get("x-mazz-bib1", "")).strip() == "1":
        return True
    if not query or len(query.strip()) < 5:
        return False
    if EXCLUDE_PATTERNS.search(query):
        return False
    return bool(TRIGGER_PATTERNS.search(query))


def _clean_fts_query(text: str) -> str:
    """Extracts alphanumeric keywords for FTS5 matching without query syntax errors."""
    words = re.findall(r"[A-Za-z0-9_]{3,}", text)
    if not words:
        return ""
    # Filter out common stop words to keep substantive terms
    stopwords = {"les", "des", "pour", "dans", "avec", "sur", "une", "the", "and", "for", "with", "from", "that"}
    substantive = [w for w in words if w.lower() not in stopwords]
    chosen = substantive[:6] if substantive else words[:4]
    return " OR ".join(f'"{w}"' for w in chosen)


def query_bib1(
    query: str,
    max_fragments: int = MAX_FRAGMENTS,
    min_score: float = MIN_BM25_SCORE,
    force: bool = False,
    db_path: str = BIB1_DB_PATH
) -> List[Dict]:
    """Retrieves relevant fragments from Bib1 FTS5 with BM25 score filtering."""
    if not os.path.exists(db_path):
        return []

    fts_query = _clean_fts_query(query)
    if not fts_query:
        return []

    fragments = []
    try:
        # SQLite connection with 2s timeout, read-only uri
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
        try:
            cursor = conn.cursor()
            sql = """
                SELECT rowid, -bm25(fts) as score, title, heading, body
                FROM fts
                WHERE fts MATCH ?
                ORDER BY bm25(fts)
                LIMIT ?
            """
            cursor.execute(sql, (fts_query, max_fragments * 4))
            for rowid, score, title, heading, body in cursor.fetchall():
                rel_score = float(score or 0.0)
                if not force and rel_score < min_score:
                    continue
                # Cap body length to 1500 chars to stay strictly within token budget (< 1000 tokens total)
                body_snippet = (body or "")[:1500].strip()
                # The index holds the same section under several documents: never send it twice.
                if any(f["body"] == body_snippet for f in fragments):
                    continue
                fragments.append({
                    "rowid": rowid,
                    "score": round(rel_score, 2),
                    "title": title or "",
                    "heading": heading or "",
                    "body": body_snippet
                })
                if len(fragments) >= max_fragments:
                    break
        finally:
            conn.close()
    except Exception:
        # Bib1 failure must never break streaming or request handling
        return []

    return fragments


def format_bib1_context(fragments: List[Dict]) -> str:
    """Formats retrieved fragments into an explicit reference section for the system prompt."""
    if not fragments:
        return ""
    parts = ["\n\n[CONTEXTE DE CONNAISSANCES FACTUELLES BIB1 - VÉRIFIÉ]"]
    for i, frag in enumerate(fragments, 1):
        header = f"--- Document {i} : {frag['title']}"
        if frag.get("heading"):
            header += f" > {frag['heading']}"
        header += f" (score BM25: {frag['score']}) ---"
        parts.append(header)
        parts.append(frag["body"])
    parts.append("[FIN CONTEXTE BIB1]\n")
    return "\n".join(parts)


def get_bib1_rag(user_prompt: str, headers: Optional[dict] = None) -> tuple[str, int]:
    """Helper that runs classification, query and formatting. Returns (context_str, fragment_count)."""
    if not should_trigger_bib1(user_prompt, headers):
        return "", 0
    force = bool(headers and str(headers.get("x-mazz-bib1", "")).strip() == "1")
    frags = query_bib1(user_prompt, force=force)
    if not frags:
        return "", 0
    return format_bib1_context(frags), len(frags)
