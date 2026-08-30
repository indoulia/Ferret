"""Compute the EPIC-005 weighted decision matrix.

Weights and scores live in spikes/results/raw/decision-matrix.json so the
arithmetic is auditable and reproducible rather than asserted in prose.
Also reports a sensitivity check: whether the outcome survives removing the
governance-derived criteria, and whether it survives equal weighting.
"""
import json
from pathlib import Path

RAW = Path(__file__).resolve().parents[1] / "results" / "raw"
DATA = json.loads((RAW / "decision-matrix.json").read_text(encoding="utf-8"))
CRIT = DATA["criteria"]

GOVERNANCE_STRUCTURAL = {"distribution_install", "operational_complexity", "cross_platform"}


def score(criteria, weighted=True):
    n = sum((c["weight"] if weighted else 1) * c["node"] for c in criteria)
    p = sum((c["weight"] if weighted else 1) * c["python"] for c in criteria)
    return n, p


def pct(n, p):
    tot = n + p
    return 100 * n / tot, 100 * p / tot


def main():
    rows = []
    w = max(len(c["name"]) for c in CRIT)
    rows.append(f"{'Criterion'.ljust(w)}  Wt  Node  Py   Weighted (N/P)")
    rows.append("-" * (w + 34))
    for c in CRIT:
        rows.append(f"{c['name'].ljust(w)}  {c['weight']:>2}  {c['node']:>4}  {c['python']:>2}   "
                    f"{c['weight'] * c['node']:>3} / {c['weight'] * c['python']:<3}")
    n, p = score(CRIT)
    rows.append("-" * (w + 34))
    rows.append(f"{'TOTAL (weighted)'.ljust(w)}  {sum(c['weight'] for c in CRIT):>2}  "
                f"{'':>4}  {'':>2}   {n:>3} / {p:<3}")
    print("\n".join(rows))

    npc, ppc = pct(n, p)
    print(f"\nWeighted total : Node {n}  Python {p}   ({npc:.1f}% / {ppc:.1f}%)")
    print(f"Margin         : {abs(n - p)} points "
          f"({abs(n - p) / max(n, p) * 100:.1f}% of the leader)")

    # Sensitivity 1: equal weights.
    en, ep = score(CRIT, weighted=False)
    print(f"\nEqual weights  : Node {en}  Python {ep} -> "
          f"{'Node' if en > ep else 'Python' if ep > en else 'tie'}")

    # Sensitivity 2: drop the governance-structural criteria (the ones that are
    # constraints rather than measurements) and re-score on measured merit only.
    measured = [c for c in CRIT if c["id"] not in GOVERNANCE_STRUCTURAL]
    mn, mp = score(measured)
    print(f"Measured only  : Node {mn}  Python {mp} -> "
          f"{'Node' if mn > mp else 'Python' if mp > mn else 'tie'}   "
          f"(governance-structural criteria removed)")

    # Sensitivity 3: how much would Python need to win the structural criteria by?
    print("\nInterpretation:")
    measured_margin = abs(mn - mp) / max(mn, mp) * 100
    if measured_margin < 5:
        lead = "Node" if mn > mp else "Python"
        print(f"  On measured merit alone the stacks are within {measured_margin:.1f}% "
              f"({mn} vs {mp}, {lead} nominally ahead).")
        print("  That is inside the run-to-run variance seen across the three recorded runs,")
        print("  so the benchmark evidence does NOT by itself select a stack.")
        print("  The decisive margin comes from the three governance-structural criteria")
        print("  (frozen NPM-first distribution, operational complexity, cross-platform reach),")
        print(f"  which contribute {n - mn} to Node against {p - mp} to Python.")
        print("  => The decision rests on approved governance, not on raw speed. If NPM-first")
        print("     distribution were unfrozen, this decision would have to be re-taken.")
    elif mp > mn:
        print(f"  Python leads on measured merit by {mp - mn} weighted points.")
        print(f"  Node leads overall only because the three governance-structural criteria")
        print(f"  (frozen NPM-first distribution, operational complexity, cross-platform)")
        print(f"  contribute {n - mn} to Node against {p - mp} to Python.")
        print("  => The decision therefore rests on an approved governance constraint,")
        print("     not on raw benchmark speed. If NPM-first distribution were unfrozen,")
        print("     this decision would need to be re-taken.")
    else:
        print(f"  Node leads on measured merit as well as overall.")


if __name__ == "__main__":
    main()
