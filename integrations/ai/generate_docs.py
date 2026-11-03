"""Generates .env.example and SETUP.md from registry.yaml, so documentation can never drift from the registry.

Run: C:\\Python314\\python.exe -m integrations.ai.generate_docs   (from mazz_control)
"""
from __future__ import annotations

from pathlib import Path

from .loader import ROOT, Provider, Registry, load_registry

GROUPS = [
    ("Auto-heberges (essayes en premier)", lambda p: p.cost_class == "selfhost"),
    ("Chat (gratuits, par priorite)", lambda p: p.cost_class != "selfhost" and "chat" in p.capabilities),
    ("Embeddings et rerank", lambda p: p.cost_class != "selfhost" and "chat" not in p.capabilities and ({"embedding", "rerank"} & set(p.capabilities))),
    ("Audio (voix, transcription)", lambda p: not ({"chat", "embedding", "rerank"} & set(p.capabilities)) and ({"tts", "stt"} & set(p.capabilities))),
    ("Image et 3D", lambda p: not ({"chat", "embedding", "rerank", "tts", "stt"} & set(p.capabilities)) and ({"image", "3d"} & set(p.capabilities))),
    ("Recherche et extraction web", lambda p: bool({"search", "scrape"} & set(p.capabilities)) and not ({"chat", "image", "tts", "stt", "embedding"} & set(p.capabilities))),
]

# Variables read by adapters or base_url templates besides the API keys.
EXTRA_ENV = {
    "cloudflare": ["CLOUDFLARE_ACCOUNT_ID"],
    "local_oracle": ["LOCAL_ORACLE_URL"],
    "local_modal": ["LOCAL_MODAL_URL"],
    "local_hf_space": ["HF_SPACE_USER", "HF_SPACE_NAME"],
    "elevenlabs": ["ELEVENLABS_VOICE_ID"],
    "cartesia": ["CARTESIA_VOICE_ID"],
}


def env_names(provider: Provider) -> list[str]:
    return [provider.auth.env, *EXTRA_ENV.get(provider.id, [])] if provider.auth.env else EXTRA_ENV.get(provider.id, [])


def render_env_example(registry: Registry) -> str:
    lines = [
        "# MAZZ Control - cles des fournisseurs IA. Copiez ce fichier en `.env` (jamais commite) et collez vos cles.",
        "# Une cle collee est prise en compte en moins de 5 s, sans redemarrage. Valeurs vides = fournisseur ignore.",
        "# Cle optionnelle sans compte : mettez `anonymous` (llm7, ovh_endpoints, local_*).",
        "",
        "# Interrupteur general : false = l'application se comporte exactement comme avant.",
        "AI_ROUTER_ENABLED=false",
        "# Fichier d'etat (breaker, quotas). Vide = %USERPROFILE%\\.mazz\\router_state.json",
        "AI_ROUTER_STATE=",
        "",
    ]
    for title, belongs in GROUPS:
        lines.append(f"# --- {title}")
        for provider in (p for p in registry.providers if belongs(p)):
            lines.append(f"# {provider.label} - {provider.signup_url}")
            lines += [f"{name}=" for name in env_names(provider)]
            lines.append(f"# AI_{provider.id.upper()}_DISABLED=1   (couper ce fournisseur sans toucher au registre)")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _quota_text(p: Provider) -> str:
    limits, parts = p.limits, []
    for label, value in (("rpm", limits.rpm), ("tpm", limits.tpm), ("req/fenetre", limits.rpd or limits.rpmonth), ("tokens/fenetre", limits.tpd or limits.tpmonth)):
        if value:
            parts.append(f"{value:,} {label}".replace(",", " "))
    if limits.unit_cap:
        parts.append(f"{limits.unit_cap:,} {limits.units}".replace(",", " "))
    if p.budget_note:
        parts.append(f"budget : {p.budget_note}")
    return ", ".join(parts) or "non plafonne cote client"


def _reset_text(p: Provider) -> str:
    l = p.limits
    return {"continuous": "continu (fenetre glissante)", "never": "jamais (credit unique)", "weekly": "dimanche 00:00 UTC",
            "daily": f"chaque jour a {l.reset_hour:02d}:00 ({l.reset_tz})", "monthly": f"le 1er du mois a {l.reset_hour:02d}:00 ({l.reset_tz})"}[l.reset]


def render_setup(registry: Registry) -> str:
    free_daily = sum(p.limits.rpd or 0 for p in registry.providers if p.limits.rpd)
    out = [
        "# SETUP - checklist des fournisseurs IA",
        "",
        "Genere depuis `registry.yaml` par `python -m integrations.ai.generate_docs` : ne modifiez pas ce fichier a la main.",
        "Cochez les cases au fil de vos inscriptions ; les noms de variables sont ceux a coller dans `mazz_control/.env`.",
        "Les chemins de menus des consoles changent : en cas d'ecart, fiez-vous au libelle a l'ecran.",
        "",
        "| Suivi | Valeur |", "|---|---|",
        f"| Fournisseurs dans le registre | {len(registry.providers)} |",
        "| Fournisseurs configures (cle posee) | __ / " + str(len(registry.providers)) + " (voir GET /integrations/status) |",
        f"| Capacite quotidienne cumulee si tout est configure (requetes/jour declarees) | {free_daily:,} + tokens et credits non convertibles |".replace(",", " "),
        "",
        "## Regles de protection carte (fournisseurs avec carte ou depot)",
        "",
        "- Utilisez une carte virtuelle plafonnee a 1-2 EUR (ou une carte prepayee), jamais votre carte principale.",
        "- Desactivez l'auto-recharge / le renouvellement automatique et fixez une limite de depense a 0 quand l'option existe.",
        "- Surveillez la premiere facture : un depassement silencieux est le seul vrai risque.",
        "- Rotation : creez une nouvelle cle, remplacez-la dans `.env` (prise en compte en moins de 5 s), puis revoquez l'ancienne dans la console.",
        "",
    ]
    for title, belongs in GROUPS:
        out += [f"## {title}", ""]
        for p in (p for p in registry.providers if belongs(p)):
            card = "oui - carte requise" if p.requires_card else "non"
            phone = "oui - verification telephone" if p.requires_phone else "non"
            names = env_names(p)
            out += [
                f"### {p.label} (`{p.id}`)", "",
                f"- **Inscription** : {p.signup_url}",
                f"- **Prerequis** : carte : {card} ; telephone : {phone}.",
                f"- **Ou trouver la cle** : {p.key_path or 'voir la console du fournisseur'}",
                f"- **Variable(s) `.env`** : " + ", ".join(f"`{n}`" for n in names) + (" (cle optionnelle : `anonymous` sans compte)" if p.auth.optional else ""),
                f"- **Quota** : {_quota_text(p)}. **Reinitialisation** : {_reset_text(p)}.",
                f"- **En pratique** : {p.practical or 'voir notes'}",
                f"- **Notes** : {p.notes}",
                f"- **Routage** : {'aucun (cle stockee et testee, API par taches)' if p.adapter == 'registry_only' else 'priorite ' + str(p.priority) + ', classe ' + p.cost_class}.",
                "- **Protection carte** : " + ("carte virtuelle 1-2 EUR, auto-recharge desactivee, limite de depense a 0." if p.requires_card else "aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas."),
                "",
                "- [ ] compte cree",
                "- [ ] cle posee dans `.env`",
                "- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)",
                "",
            ]
    return "\n".join(out).rstrip() + "\n"


def main() -> None:
    registry = load_registry()
    (ROOT / ".env.example").write_text(render_env_example(registry), encoding="utf-8", newline="\n")
    (ROOT / "SETUP.md").write_text(render_setup(registry), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
