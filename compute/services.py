"""Catalogue of external services the app can guide the user through (accounts, keys, free quotas).

Pure data (services.yaml) + a strict loader. Facts the maintainer could not verify stay null: the UI shows "a verifier"
instead of an invented number. Every entry carries its official source and the date it was checked.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal, Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field

SERVICES_PATH = Path(__file__).with_name("services.yaml")

Category = Literal["gpu_notebook", "serverless_gpu", "gpu_vm", "managed_inference", "model_hub", "image_api", "video_api",
                   "3d_api", "speech_api", "search_api", "embedding_api", "vector_db", "storage", "tunnel", "other"]
Family = Literal["notebook", "serverless", "vm", "managed_api", "hub", "none"]
Support = Literal["full", "guide", "planned"]  # full: the app drives it; guide: the app explains it; planned: not yet
FreeKind = Literal["continuous", "daily", "weekly", "monthly", "one_time", "trial", "none", "unknown"]


class Service(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,40}$")
    name: str
    category: Category
    family: Family
    support: Support
    provider_id: Optional[str] = None  # id in the AI router registry / compute providers when the app drives it
    website: str
    signup_url: str
    free_tier: str  # human text, as stated by the provider
    free_kind: FreeKind
    requires_card: Optional[bool] = None
    requires_phone: Optional[bool] = None
    secret_name: str = ""  # what the user must copy (e.g. "API token")
    where_to_find: str = ""  # where in the provider's console
    where_saved: str = "Chiffre localement (Parametres > Cles)"
    steps: list[str] = Field(default_factory=list)
    notes: str = ""
    source_url: str
    verified_at: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


def load_services(path: Path | str = SERVICES_PATH) -> list[Service]:
    """services.yaml plus every services.d/*.yaml next to it (one file per research batch, no merge conflicts)."""
    base = Path(path)
    files = [base, *sorted((base.parent / "services.d").glob("*.yaml"))]
    services: list[Service] = []
    for file in files:
        raw = yaml.safe_load(file.read_text(encoding="utf-8")) or {}
        services += [Service(**item) for item in raw.get("services", [])]
    ids = [s.id for s in services]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise ValueError(f"ids dupliques : {', '.join(dup)}")
    return services
