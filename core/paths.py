"""Racine unique des donnees utilisateur MAZZ (mode portable : MAZZ_HOME).

Aucun effet de bord : pas de mkdir ici, les ecrivains creent leurs dossiers.
"""
import os


def mazz_home() -> str:
    """MAZZ_HOME (absolu, ~ developpe) s'il est defini et non vide, sinon ~/.mazz."""
    env = os.environ.get("MAZZ_HOME", "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    return os.path.expanduser(os.path.join("~", ".mazz"))


def mazz_path(*parts: str) -> str:
    return os.path.join(mazz_home(), *parts)
