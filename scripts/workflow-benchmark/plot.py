"""Optional report figure: python3 plot.py <published-results-dir> (requires matplotlib)."""
import json
import pathlib
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

directory = pathlib.Path(sys.argv[1])
summary = json.loads((directory / "summary.json").read_text())
manifest = json.loads((directory / "manifest.json").read_text())
arms = manifest.get("arms", ["plainwright", "playwright"])
treatment, control = arms
models = manifest["models"]
labels = [model.split("/")[1] for model in models]
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "svg.fonttype": "none"})
fig, axes = plt.subplots(1, 3, figsize=(14, 4.6), gridspec_kw={"width_ratios": [1, 1, 1.2]})
fig.suptitle(f"Whole browser workflows: {treatment} vs {control}", fontsize=16, fontweight="bold", y=.98)
for ax, key, title in zip(axes[:2], ["cost", "time"], ["API cost ratio", "Elapsed-time ratio"]):
    values = [summary["byModel"][m]["comparison"][key + "Ratio"] for m in models]
    intervals = [summary["byModel"][m]["comparison"][key + "Ratio95"] for m in models]
    for i, (value, bounds) in enumerate(zip(values, intervals)):
        ax.plot(bounds, [i, i], color="#c76728", linewidth=2)
        ax.scatter([value], [i], color="#c76728", s=55, zorder=3)
        ax.annotate(f"{value:.2f}×", (value, i), xytext=(0, 13), textcoords="offset points", ha="center", weight="bold")
    ax.axvline(1, color="#65718a", linestyle="--", linewidth=1)
    lower = min(.5, min(bounds[0] for bounds in intervals) * .9)
    upper = max(1.25, max(bounds[1] for bounds in intervals) * 1.08)
    step = .5 if key == "cost" else .25
    ticks = np.arange(np.ceil(lower / step) * step, upper, step)
    ax.set_xlim(lower, upper)
    ax.set_xticks(ticks, [f"{value:g}×" for value in ticks])
    ax.set_yticks(range(len(models)), labels if key == "cost" else [])
    ax.set_ylim(len(models) - .5, -.7)
    ax.set_title(title, pad=15, weight="bold")
    ax.set_xlabel("Lower is better · baseline = 1")
    ax.grid(axis="x", color="#e7e9ed")
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.tick_params(axis="y", length=0)
ax = axes[2]
for arm, offset, color, label in [(control, -.17, "#4167a5", control), (treatment, .17, "#c76728", treatment)]:
    values = [summary["byModel"][m][arm] for m in models]
    positions = np.arange(len(models)) + offset
    ax.barh(positions, [v["successes"] / v["trials"] * 100 for v in values], height=.28, color=color, label=label)
    for y, value in zip(positions, values):
        ax.text(103, y, f'{value["successes"]}/{value["trials"]}', va="center", fontsize=10)
ax.set_yticks(range(len(models)), [])
ax.set_ylim(len(models) - .5, -.7)
ax.set_xlim(0, 124)
ax.set_xticks([0, 50, 100], ["0%", "50%", "100%"])
ax.set_title("Independent task success", pad=15, weight="bold")
ax.set_xlabel("Requested state or answer reached")
ax.spines[["top", "right", "left"]].set_visible(False)
ax.tick_params(axis="y", length=0)
ax.legend(loc="lower right", bbox_to_anchor=(1.02, -.38), frameon=False, fontsize=9)
fig.text(.04, .035, f"{summary['trials']} local trials · {len(manifest['tasks'])} synthetic workflows · {manifest['repeats']} repetitions · low reasoning effort\nCost/time include failures. Intervals: 95% task-cluster bootstrap. Results apply to this suite; see the report for limits.", fontsize=9, color="#4e596c")
fig.subplots_adjust(left=.12, right=.96, top=.78, bottom=.25, wspace=.23)
fig.savefig(directory / "comparison.svg", facecolor="white")
svg = directory / "comparison.svg"
svg.write_text("\n".join(line.rstrip() for line in svg.read_text().splitlines()) + "\n")
fig.savefig(directory / "comparison.png", dpi=150, facecolor="white")
