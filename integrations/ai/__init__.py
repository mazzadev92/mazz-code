"""Multi-provider AI orchestration layer. Additive: nothing here runs unless AI_ROUTER_ENABLED is true."""
from .loader import EnvStore, RegistryError, load_registry, router_enabled
from .router import AllProvidersFailed, NoProviderAvailable, Router

__all__ = ["AllProvidersFailed", "EnvStore", "NoProviderAvailable", "RegistryError", "Router", "load_registry", "router_enabled"]
