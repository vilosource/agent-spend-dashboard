<script lang="ts">
/**
 * Daily cost timeseries via uPlot. Single line for total cost per
 * day; the design says "by model" but for v1 we render the aggregate
 * line and let the model-mix pie carry the per-model breakdown.
 * Stacked-area-by-model is better paid off in 0.3.11 alongside the
 * /me/sessions/<id> drilldown.
 */

import uPlot, { type Options } from "uplot";
import type { UsageByDay } from "../api.js";

interface Props {
	readonly byDay: readonly UsageByDay[];
}

const { byDay }: Props = $props();

let container: HTMLDivElement | null = $state(null);
let chart: uPlot | null = null;

function rebuild(rows: readonly UsageByDay[]): void {
	if (!container) return;
	if (chart) {
		chart.destroy();
		chart = null;
	}
	if (rows.length === 0) return;

	const xs: number[] = [];
	const ys: number[] = [];
	for (const r of rows) {
		// "YYYY-MM-DD" → seconds-since-epoch (uPlot expects UNIX seconds).
		xs.push(Math.floor(new Date(`${r.day}T00:00:00Z`).getTime() / 1000));
		ys.push(r.costUsd);
	}

	const opts: Options = {
		title: "",
		width: container.clientWidth || 600,
		height: 220,
		legend: { show: false },
		scales: {
			x: { time: true },
			y: { range: (_u, min, max) => [Math.min(0, min), Math.max(max, 0.0001)] },
		},
		axes: [
			{ stroke: "#475569" },
			{
				stroke: "#475569",
				values: (_u, splits) => splits.map((v) => `$${v.toFixed(2)}`),
			},
		],
		series: [
			{},
			{
				label: "Cost",
				stroke: "#0ea5e9",
				width: 2,
				fill: "rgba(14,165,233,0.10)",
				points: { show: rows.length < 30 },
			},
		],
	};
	chart = new uPlot(opts, [xs, ys], container);
}

$effect(() => {
	rebuild(byDay);
	return () => {
		if (chart) {
			chart.destroy();
			chart = null;
		}
	};
});
</script>

<div bind:this={container} class="w-full" aria-label="Daily cost timeseries"></div>
