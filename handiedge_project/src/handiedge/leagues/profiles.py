"""League profiles: the single source of per-league configuration.

Each league declares its own feature schema per market, abstention thresholds,
settlement/tie rules, timezone (display-only), artifact namespace and drift
baseline slot. These deliberately differ between MLB and NPB so that an artifact
trained for one cannot silently be used for the other (the feature-schema length
and league tag both act as guards).

Baseball tie/settlement facts encoded here:
- MLB regular/postseason games do not end in ties (extra innings until decided);
  a suspended/abandoned game is handled as VOID, never guessed.
- NPB regular-season games CAN end in a tie (capped extra innings), so a two-way
  moneyline tie is a PUSH (stake returned) — configurable, not assumed silently.
- Run line is a ±1.5 half-line: no push possible.
- Totals can land exactly on an integer line: PUSH.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from ..domain.taxonomy import MarketType, Sport
from ..modeling.abstention import AbstentionPolicy


class League(str, Enum):
    """OpticOdds league ids, used verbatim as the canonical league key."""

    MLB = "mlb"
    NPB = "npb"


class BaseballMarket(str, Enum):
    MONEYLINE = "moneyline"
    RUN_LINE = "run_line"
    TOTAL_RUNS = "total_runs"


class TieRule(str, Enum):
    NONE = "none"  # a tie cannot occur / not applicable (e.g. half-line)
    PUSH = "push"  # tie returns stake
    DRAW = "draw"  # tie is a distinct priced outcome (three-way)


# Map each baseball market to the domain settlement MarketType.
MARKET_TYPE: dict[BaseballMarket, MarketType] = {
    BaseballMarket.MONEYLINE: MarketType.MONEYLINE,
    BaseballMarket.RUN_LINE: MarketType.HANDICAP,
    BaseballMarket.TOTAL_RUNS: MarketType.TOTAL,
}


@dataclass(frozen=True, slots=True)
class MarketSettlement:
    market: BaseballMarket
    tie_rule: TieRule
    default_line: float | None = None  # run line points / typical total (informational)
    draw_allowed: bool = False


@dataclass(frozen=True, slots=True)
class LeagueProfile:
    league: League
    sport: Sport
    opticodds_league_id: str
    display_timezone: str  # display only; everything is persisted in UTC
    feature_schemas: dict[BaseballMarket, tuple[str, ...]]
    thresholds: dict[BaseballMarket, AbstentionPolicy]
    settlement: dict[BaseballMarket, MarketSettlement]
    # Drift baselines are populated only after a real dataset is ingested; None =>
    # not yet established (UNTRAINED). Kept per league so populations never merge.
    drift_baseline: dict[BaseballMarket, dict[str, tuple[float, float]]] = field(
        default_factory=dict
    )

    @property
    def artifact_namespace(self) -> str:
        return self.league.value

    def feature_names(self, market: BaseballMarket) -> tuple[str, ...]:
        return self.feature_schemas[market]


_MLB_SCHEMAS: dict[BaseballMarket, tuple[str, ...]] = {
    BaseballMarket.MONEYLINE: (
        "devig_prob_home",
        "log_price_home",
        "log_price_away",
        "book_count",
        "price_dispersion",
    ),
    BaseballMarket.RUN_LINE: (
        "devig_prob_home_cover",
        "run_line_points",
        "log_price_home",
        "log_price_away",
        "book_count",
    ),
    BaseballMarket.TOTAL_RUNS: (
        "devig_prob_over",
        "total_line",
        "log_price_over",
        "log_price_under",
        "book_count",
    ),
}

# NPB schemas intentionally carry an extra league-specific column per market, so a
# schema-length/name check alone catches a cross-league artifact load.
_NPB_SCHEMAS: dict[BaseballMarket, tuple[str, ...]] = {
    BaseballMarket.MONEYLINE: (*_MLB_SCHEMAS[BaseballMarket.MONEYLINE], "npb_tie_prior"),
    BaseballMarket.RUN_LINE: (*_MLB_SCHEMAS[BaseballMarket.RUN_LINE], "npb_tie_adjust"),
    BaseballMarket.TOTAL_RUNS: (*_MLB_SCHEMAS[BaseballMarket.TOTAL_RUNS], "npb_low_scoring_prior"),
}


def _default_thresholds() -> dict[BaseballMarket, AbstentionPolicy]:
    return {
        BaseballMarket.MONEYLINE: AbstentionPolicy(
            min_edge=0.02, min_confidence=0.55, min_history_lines=1
        ),
        BaseballMarket.RUN_LINE: AbstentionPolicy(
            min_edge=0.03, min_confidence=0.55, min_history_lines=1
        ),
        BaseballMarket.TOTAL_RUNS: AbstentionPolicy(
            min_edge=0.03, min_confidence=0.54, min_history_lines=1
        ),
    }


MLB_PROFILE = LeagueProfile(
    league=League.MLB,
    sport=Sport.MLB,
    opticodds_league_id="mlb",
    display_timezone="America/New_York",
    feature_schemas=_MLB_SCHEMAS,
    thresholds=_default_thresholds(),
    settlement={
        BaseballMarket.MONEYLINE: MarketSettlement(
            BaseballMarket.MONEYLINE, TieRule.NONE, draw_allowed=False
        ),
        BaseballMarket.RUN_LINE: MarketSettlement(
            BaseballMarket.RUN_LINE, TieRule.NONE, default_line=-1.5
        ),
        BaseballMarket.TOTAL_RUNS: MarketSettlement(
            BaseballMarket.TOTAL_RUNS, TieRule.PUSH, default_line=8.5
        ),
    },
)

NPB_PROFILE = LeagueProfile(
    league=League.NPB,
    sport=Sport.NPB,
    opticodds_league_id="npb",
    display_timezone="Asia/Tokyo",
    feature_schemas=_NPB_SCHEMAS,
    thresholds=_default_thresholds(),
    settlement={
        # NPB two-way moneyline tie => stake returned (PUSH), not a silent loss.
        BaseballMarket.MONEYLINE: MarketSettlement(
            BaseballMarket.MONEYLINE, TieRule.PUSH, draw_allowed=False
        ),
        BaseballMarket.RUN_LINE: MarketSettlement(
            BaseballMarket.RUN_LINE, TieRule.NONE, default_line=-1.5
        ),
        BaseballMarket.TOTAL_RUNS: MarketSettlement(
            BaseballMarket.TOTAL_RUNS, TieRule.PUSH, default_line=7.5
        ),
    },
)

PROFILES: dict[League, LeagueProfile] = {League.MLB: MLB_PROFILE, League.NPB: NPB_PROFILE}


def parse_league(value: str) -> League:
    try:
        return League(value.strip().lower())
    except ValueError as exc:
        supported = ", ".join(sorted(m.value for m in League))
        raise ValueError(f"unsupported league {value!r}; supported: {supported}") from exc


def get_profile(league: League | str) -> LeagueProfile:
    if isinstance(league, str):
        league = parse_league(league)
    return PROFILES[league]


def parse_market(value: str) -> BaseballMarket:
    try:
        return BaseballMarket(value.strip().lower())
    except ValueError as exc:
        supported = ", ".join(sorted(m.value for m in BaseballMarket))
        raise ValueError(f"unsupported market {value!r}; supported: {supported}") from exc
