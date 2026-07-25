# Evaluation Metric Reference (Category 7)

Use these definitions consistently so metrics are comparable across audits/components. All
formulas assume binary outcome \(y \in \{0,1\}\) (e.g., side A covers = 1) and predicted
probability \(\hat{p} \in [0,1]\) for the same event.

## Log Loss (binary cross-entropy)

\[
\text{LogLoss} = -\frac{1}{n}\sum_{i=1}^{n}\Big(y_i \log(\hat{p}_i) + (1-y_i)\log(1-\hat{p}_i)\Big)
\]

Lower is better. Sensitive to confident wrong predictions — a single \(\hat{p}\) near 0 or 1 on a
wrong pick dominates the score. Always clip \(\hat{p}\) away from exactly 0/1 before computing to
avoid \(-\infty\).

## Brier Score

\[
\text{Brier} = \frac{1}{n}\sum_{i=1}^{n} (\hat{p}_i - y_i)^2
\]

Lower is better; range [0, 1]. Less sensitive to extreme miscalibration than log loss but easier
to decompose into calibration + resolution + uncertainty components (Murphy decomposition) —
useful when explaining *why* a model's Brier score is weak.

## Calibration Error (Expected Calibration Error, ECE)

1. Bin predictions \(\hat{p}_i\) into \(K\) bins (e.g., deciles).
2. For each bin \(k\), compute mean predicted probability \(\bar{p}_k\) and observed frequency
   \(\bar{y}_k\).
3. \[
   \text{ECE} = \sum_{k=1}^{K} \frac{n_k}{n} \,\big|\bar{p}_k - \bar{y}_k\big|
   \]

Report the bin table (or reliability diagram) alongside the scalar ECE — a single number hides
whether miscalibration is concentrated at high or low confidence.

## Closing Line Value (CLV)

For a bet placed at entry (fair, vig-removed) probability \(p_{\text{entry}}\) on the side
actually picked, versus the closing (fair) probability \(p_{\text{close}}\) on that same side:

\[
\text{CLV} = \frac{p_{\text{entry}}}{p_{\text{close}}} - 1
\]

(Equivalently expressed via decimal odds ratios — the HandiEdge skeleton's `clv()` function
computes this via odds ratios; either formulation is acceptable as long as it is applied
consistently and always to the *same picked side* on both ends.) Positive CLV indicates the bet
was placed at better-than-closing value — a leading indicator of edge that is less sample-size-
hungry than ROI.

## ROI With Confidence Interval

\[
\text{ROI} = \frac{\sum_i (\text{payout}_i - \text{stake}_i)}{\sum_i \text{stake}_i}
\]

Never report ROI as a bare point estimate. At minimum, compute a bootstrap or normal-approximation
confidence interval across bets, and always report \(n\_bets\) alongside it. With small \(n\), the
CI will often span from clearly negative to clearly positive — that is itself the finding, not a
detail to omit.

## Hit Rate With Confidence Interval

\[
\text{HitRate} = \frac{\text{wins}}{n}, \quad \text{CI via Wilson or exact binomial interval}
\]

Hit rate alone must never be presented without (a) its CI and (b) at least one of log loss / Brier
/ calibration error alongside it — a model can have a "good" hit rate against a weak baseline while
being poorly calibrated or unprofitable net of vig.

## Maximum Drawdown

Given a cumulative bankroll/equity series \(B_1, \dots, B_n\) from a bankroll simulation:

\[
\text{MaxDD} = \max_{t} \left( \frac{\max_{s \le t} B_s - B_t}{\max_{s \le t} B_s} \right)
\]

Report alongside ROI — a strategy can have positive mean ROI but an unacceptable drawdown path
that would trigger real-world stop conditions (see category 10) long before the mean is realized.

## Statistical Comparison Between Models

- **Diebold-Mariano test**: use to test whether two models' error series differ significantly,
  rather than comparing point-estimate metrics directly.
- **Multiple-comparison correction** (e.g., Bonferroni: threshold \(\alpha/k\) for \(k\)
  simultaneous comparisons): required whenever comparing more than two models/markets/segments
  at once, to avoid false "significant edge" claims from multiple testing.

## Sample Size Discipline

Every metric in this file must be reported with its \(n\) (bets, games, or predictions). A metric
computed on \(n < 30\) should be explicitly flagged as low-confidence regardless of how favorable
it looks, and should never be cited alone to support a "the model works" or "production-ready"
claim.
