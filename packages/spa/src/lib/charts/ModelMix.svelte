<script lang="ts">
/**
 * Per-model cost breakdown as a Chart.js doughnut. Cost-weighted; the
 * legend shows model name + provider.
 */

import { ArcElement, Chart, DoughnutController, Legend, Tooltip } from "chart.js";
import type { UsageByModel } from "../api.js";

Chart.register(ArcElement, DoughnutController, Legend, Tooltip);

const PALETTE = [
	"#0ea5e9", // sky-500
	"#10b981", // emerald-500
	"#f59e0b", // amber-500
	"#ef4444", // red-500
	"#8b5cf6", // violet-500
	"#14b8a6", // teal-500
	"#f43f5e", // rose-500
	"#84cc16", // lime-500
];

interface Props {
	readonly byModel: readonly UsageByModel[];
}

const { byModel }: Props = $props();

let canvas: HTMLCanvasElement | null = $state(null);
let chart: Chart | null = null;

function rebuild(rows: readonly UsageByModel[]): void {
	if (!canvas) return;
	if (chart) {
		chart.destroy();
		chart = null;
	}
	if (rows.length === 0) return;

	chart = new Chart(canvas, {
		type: "doughnut",
		data: {
			labels: rows.map((r) => `${r.model} (${r.provider})`),
			datasets: [
				{
					data: rows.map((r) => r.costUsd),
					backgroundColor: rows.map((_r, i) => PALETTE[i % PALETTE.length] ?? "#94a3b8"),
					borderWidth: 0,
				},
			],
		},
		options: {
			plugins: {
				legend: { position: "right" },
				tooltip: {
					callbacks: {
						label: (ctx) => {
							const v = typeof ctx.parsed === "number" ? ctx.parsed : 0;
							return `${ctx.label}: $${v.toFixed(4)}`;
						},
					},
				},
			},
			responsive: true,
			maintainAspectRatio: false,
		},
	});
}

$effect(() => {
	rebuild(byModel);
	return () => {
		if (chart) {
			chart.destroy();
			chart = null;
		}
	};
});
</script>

<div class="relative h-56 w-full">
	<canvas bind:this={canvas} aria-label="Model cost breakdown"></canvas>
</div>
