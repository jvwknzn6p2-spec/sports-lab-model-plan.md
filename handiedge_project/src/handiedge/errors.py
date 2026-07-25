"""Canonical exception hierarchy for HandiEdge.

These types let the domain core distinguish *real* failures (bad data, leakage,
stale odds) from *environmental* gaps (an external system that is simply not
configured or not ready in this environment). The latter must never be presented
as if the external system works — see the skill's hard rules.
"""

from __future__ import annotations


class HandiEdgeError(Exception):
    """Base class for all HandiEdge domain errors."""


class NotConfigured(HandiEdgeError):
    """A required piece of configuration (env var, endpoint, credential) is absent.

    Raised by ports/adapters for external systems (DB, MLflow, vLLM, OIDC, odds
    provider) when they are asked to act without configuration. It is NOT a claim
    that the system is broken — only that it is not wired up in this environment.
    """


class NotReady(HandiEdgeError):
    """A component is configured but not yet in a usable state.

    e.g. a model registry with no promoted model, or a readiness probe for a
    dependency that has not reported healthy.
    """


class ValidationError(HandiEdgeError):
    """Input data failed a domain validation rule."""


class StaleDataError(ValidationError):
    """An odds quote / line is too old to be used for a decision."""


class LeakageError(HandiEdgeError):
    """A feature/join attempted to read information not available at `as_of`."""


class LeakDetectedError(HandiEdgeError):
    """L1-classified data was about to reach an external provider (masking failure)."""


class GuaranteedWinLanguageError(HandiEdgeError):
    """User-facing text contained prohibited guaranteed-win language."""


class ChaseLossError(HandiEdgeError):
    """A staking action attempted chase-loss / martingale behaviour."""


class JurisdictionBlocked(HandiEdgeError):
    """Request originates from a blocked/ineligible jurisdiction or fails age gate."""


class ConnectorError(HandiEdgeError):
    """A live connector call failed in a way that is not a simple config gap."""


class ConnectorUnavailable(NotConfigured):
    """The ``external-tool`` runtime is absent or the source is disconnected.

    Subclass of :class:`NotConfigured`: it is an environmental gap, not a bug, and
    callers/CLI should report it truthfully (no fabricated data) and degrade.
    """


class ConnectorTimeout(ConnectorError):
    """A connector call exceeded its deadline."""


class RateLimited(ConnectorError):
    """The upstream connector reported a rate-limit (HTTP 429 or equivalent)."""


class AuthRequired(ConnectorError):
    """The connector reported that authentication is required/failed (401/403).

    Credentials are injected by the runtime, never by this codebase; this signals
    the runtime-side connection needs (re)authorising.
    """


class MalformedResponse(ConnectorError):
    """The connector returned output that is not a valid, expected envelope."""


class LeagueMismatchError(HandiEdgeError):
    """An artifact/dataset built for one league was used for another.

    Enforces the hard isolation rule: MLB and NPB populations, models, calibrators
    and evaluations must never be crossed.
    """


class UnsupportedMarketError(HandiEdgeError):
    """A market is not yet trainable/servable (e.g. label contract unsatisfied)."""
