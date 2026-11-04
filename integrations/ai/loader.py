"""Registry loading, validation and configuration access for the AI router.

Boot-time work is limited to parsing registry.yaml and reading .env: no network access happens here.
"""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Literal, Optional
from zoneinfo import ZoneInfo

import yaml
from core.paths import mazz_path
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ROOT = Path(__file__).resolve().parent
REGISTRY_PATH = ROOT / "registry.yaml"
DEFAULT_ENV_FILE = ROOT.parent.parent / ".env"
ANONYMOUS = "anonymous"  # value of an optional key meaning "use this provider without an Authorization header"

Capability = Literal["chat", "vision", "embedding", "rerank", "tts", "stt", "image", "3d", "search", "scrape"]
CostClass = Literal["selfhost", "free", "credit", "paid"]
ResetKind = Literal["continuous", "daily", "weekly", "monthly", "never"]


class RegistryError(ValueError):
    """registry.yaml is invalid: raised at boot with the provider id and the field."""


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Auth(Strict):
    type: Literal["bearer", "header", "body", "none"]
    env: Optional[str] = None
    header: Optional[str] = None
    scheme: Optional[str] = None
    field: Optional[str] = None
    optional: bool = False
    headers: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _coherent(self):
        if self.type != "none" and not self.env:
            raise ValueError("auth.env est obligatoire")
        if self.type == "header" and not self.header:
            raise ValueError("auth.header est obligatoire pour type: header")
        if self.type == "body" and not self.field:
            raise ValueError("auth.field est obligatoire pour type: body")
        return self


class ModelRef(Strict):
    alias: str
    id: str


class Limits(Strict):
    rpm: Optional[int] = None
    tpm: Optional[int] = None
    rpd: Optional[int] = None
    tpd: Optional[int] = None
    rpmonth: Optional[int] = None
    tpmonth: Optional[int] = None
    units: Optional[str] = None
    unit_cap: Optional[int] = None
    reset: ResetKind
    reset_tz: str = "UTC"
    reset_hour: int = 0

    @field_validator("reset_tz")
    @classmethod
    def _tz(cls, v):
        try:
            ZoneInfo(v)
        except Exception as exc:  # unknown IANA name or missing tzdata
            raise ValueError(f"fuseau inconnu : {v}") from exc
        return v

    @field_validator("reset_hour")
    @classmethod
    def _hour(cls, v):
        if not 0 <= v <= 23:
            raise ValueError("reset_hour doit etre entre 0 et 23")
        return v


class Provider(Strict):
    id: str
    label: str
    base_url: Optional[str]
    auth: Auth
    adapter: str
    capabilities: list[Capability]
    models: list[ModelRef]
    model_pattern: Optional[str] = None
    limits: Limits
    priority: int
    cost_class: CostClass
    requires_card: bool
    requires_phone: bool
    signup_url: str
    enabled: bool
    notes: str
    key_path: str = ""
    practical: str = ""
    budget_note: Optional[str] = None
    embed_extra: dict[str, str] = Field(default_factory=dict)  # extra fields of /embeddings (NVIDIA NIM needs input_type)

    @field_validator("id")
    @classmethod
    def _id(cls, v):
        if not re.fullmatch(r"[a-z0-9][a-z0-9_]{1,31}", v):
            raise ValueError("id invalide (minuscules, chiffres, _)")
        return v

    @field_validator("capabilities")
    @classmethod
    def _caps(cls, v):
        if not v:
            raise ValueError("au moins une capability")
        return v

    def model_id(self, alias: str) -> Optional[str]:
        return next((m.id for m in self.models if m.alias == alias), None)

    @property
    def key_env(self) -> Optional[str]:
        return self.auth.env


class BreakerSettings(Strict):
    failures: int
    cooldown_s: int
    max_backoff_s: int


class RouterSettings(Strict):
    timeout_s: float
    max_retries: int
    retry_after_cap_s: int
    breaker: BreakerSettings
    cost_order: list[CostClass]


class Registry(Strict):
    router: RouterSettings
    providers: list[Provider]

    @model_validator(mode="after")
    def _unique(self):
        ids = [p.id for p in self.providers]
        dup = sorted({i for i in ids if ids.count(i) > 1})
        if dup:
            raise ValueError(f"ids dupliques : {', '.join(dup)}")
        return self

    def get(self, provider_id: str) -> Optional[Provider]:
        return next((p for p in self.providers if p.id == provider_id), None)


USER_PROVIDERS_PATH = Path(mazz_path("user_providers.yaml"))


def load_registry(path: Path | str = REGISTRY_PATH, known_adapters: Optional[set[str]] = None,
                  user_path: Path | str | None = None) -> Registry:
    """Parses and validates the registry, plus the providers the user added from the app (`user_path`).
    Raises RegistryError naming the faulty provider."""
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise RegistryError(f"registry illisible : {exc}") from exc
    if not isinstance(data, dict) or "providers" not in data:
        raise RegistryError("registry.yaml doit contenir `router` et `providers`")
    try:
        registry = Registry.model_validate(data)
    except Exception as exc:
        raise RegistryError(str(exc)) from exc
    if user_path and Path(user_path).exists():
        try:
            extra = (yaml.safe_load(Path(user_path).read_text(encoding="utf-8")) or {}).get("providers", [])
            users = [Provider.model_validate(item) for item in extra]
        except Exception as exc:
            raise RegistryError(f"fournisseurs utilisateur illisibles : {exc}") from exc
        clash = sorted({p.id for p in registry.providers} & {u.id for u in users})
        if clash:
            raise RegistryError(f"fournisseurs utilisateur en conflit avec le registre : {', '.join(clash)}")
        registry = registry.model_copy(update={"providers": [*registry.providers, *users]})
    if known_adapters is not None:
        for p in registry.providers:
            if p.adapter not in known_adapters:
                raise RegistryError(f"{p.id} : adapter inconnu `{p.adapter}`")
    return registry


class EnvStore:
    """Configuration read from the process environment first, then from a .env file reloaded when it changes.

    A key pasted into .env is seen on the next access (the file's mtime is checked, no restart needed).
    """

    def __init__(self, path: Path | str | None = None):
        self.path = Path(path or os.environ.get("AI_ENV_FILE") or DEFAULT_ENV_FILE)
        self._lock = threading.Lock()
        self._mtime: tuple[int, int] | None = None
        self._values: dict[str, str] = {}

    def _reload(self) -> None:
        try:
            info = self.path.stat()
            mtime = (info.st_mtime_ns, info.st_size)  # size too: two quick writes can share a timestamp
        except OSError:
            mtime, values = None, {}
        else:
            if mtime == self._mtime:
                return
            values = _parse_env(self.path.read_text(encoding="utf-8", errors="replace"))
        self._mtime, self._values = mtime, values

    def get(self, name: str) -> Optional[str]:
        """Value of `name`, or None when absent or empty."""
        with self._lock:
            self._reload()
            value = os.environ.get(name) or self._values.get(name)
        return value.strip() if value and value.strip() else None


def _parse_env(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, raw = line.partition("=")
        raw = raw.strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
            raw = raw[1:-1]
        elif " #" in raw:
            raw = raw.split(" #", 1)[0].strip()
        values[name.strip().removeprefix("export ").strip()] = raw
    return values


_VAR = re.compile(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}")


def expand(template: Optional[str], env: EnvStore) -> Optional[str]:
    """Replaces ${VAR} and ${VAR:-default}; None when a variable has neither a value nor a default."""
    if not template:
        return None
    missing = False

    def sub(match: re.Match) -> str:
        nonlocal missing
        value = env.get(match.group(1))
        if value is None:
            value = match.group(2)
        if value is None:
            missing = True
            return ""
        return value

    result = _VAR.sub(sub, template)
    return None if missing else result


def router_enabled(env: EnvStore) -> bool:
    return (env.get("AI_ROUTER_ENABLED") or "false").lower() in ("1", "true", "yes", "on")


def provider_key(provider: Provider, env: EnvStore) -> Optional[str]:
    """The API key, "" for the anonymous sentinel on an optional-key provider, None when not configured."""
    if provider.auth.type == "none":
        return ""
    value = env.get(provider.auth.env or "")
    if value is None:
        return None
    if value.lower() == ANONYMOUS:
        return "" if provider.auth.optional else None
    return value


def provider_disabled(provider: Provider, env: EnvStore) -> bool:
    return (env.get(f"AI_{provider.id.upper()}_DISABLED") or "").lower() in ("1", "true", "yes", "on")
