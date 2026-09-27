/**
 * Minimal in-process metrics registry. Deliberately dependency-free: the worker
 * exposes a Prometheus-compatible text rendering and nothing more. Teams that
 * want a real TSDB scrape this endpoint.
 */
export type MetricLabels = Record<string, string>;

interface Series {
  labels: MetricLabels;
  value: number;
  buckets?: Map<number, number>;
  sum?: number;
  count?: number;
}

const DEFAULT_BUCKETS = [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900];

export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, Series>>();
  private readonly gauges = new Map<string, Map<string, Series>>();
  private readonly histograms = new Map<string, Map<string, Series>>();

  private key(labels: MetricLabels): string {
    return Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(",");
  }

  private slot(
    store: Map<string, Map<string, Series>>,
    name: string,
    labels: MetricLabels,
  ): Series {
    let byLabel = store.get(name);
    if (!byLabel) { byLabel = new Map(); store.set(name, byLabel); }
    const k = this.key(labels);
    let series = byLabel.get(k);
    if (!series) { series = { labels, value: 0 }; byLabel.set(k, series); }
    return series;
  }

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    this.slot(this.counters, name, labels).value += by;
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.slot(this.gauges, name, labels).value = value;
  }

  observe(name: string, seconds: number, labels: MetricLabels = {}): void {
    const series = this.slot(this.histograms, name, labels);
    series.buckets ??= new Map(DEFAULT_BUCKETS.map((b) => [b, 0]));
    series.sum = (series.sum ?? 0) + seconds;
    series.count = (series.count ?? 0) + 1;
    for (const b of DEFAULT_BUCKETS) {
      if (seconds <= b) series.buckets.set(b, (series.buckets.get(b) ?? 0) + 1);
    }
  }

  snapshot(): Record<string, Array<{ labels: MetricLabels; value: number }>> {
    const out: Record<string, Array<{ labels: MetricLabels; value: number }>> = {};
    for (const [store] of [[this.counters], [this.gauges]] as const) {
      for (const [name, byLabel] of store) {
        out[name] = [...byLabel.values()].map((s) => ({ labels: s.labels, value: s.value }));
      }
    }
    for (const [name, byLabel] of this.histograms) {
      out[`${name}_sum`] = [...byLabel.values()].map((s) => ({ labels: s.labels, value: s.sum ?? 0 }));
      out[`${name}_count`] = [...byLabel.values()].map((s) => ({ labels: s.labels, value: s.count ?? 0 }));
    }
    return out;
  }

  private static fmtLabels(labels: MetricLabels): string {
    const entries = Object.entries(labels);
    if (!entries.length) return "";
    return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(",")}}`;
  }

  /** Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const [name, byLabel] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const s of byLabel.values()) lines.push(`${name}${MetricsRegistry.fmtLabels(s.labels)} ${s.value}`);
    }
    for (const [name, byLabel] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const s of byLabel.values()) lines.push(`${name}${MetricsRegistry.fmtLabels(s.labels)} ${s.value}`);
    }
    for (const [name, byLabel] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const s of byLabel.values()) {
        for (const [b, c] of s.buckets ?? []) {
          lines.push(`${name}_bucket${MetricsRegistry.fmtLabels({ ...s.labels, le: String(b) })} ${c}`);
        }
        lines.push(`${name}_bucket${MetricsRegistry.fmtLabels({ ...s.labels, le: "+Inf" })} ${s.count ?? 0}`);
        lines.push(`${name}_sum${MetricsRegistry.fmtLabels(s.labels)} ${s.sum ?? 0}`);
        lines.push(`${name}_count${MetricsRegistry.fmtLabels(s.labels)} ${s.count ?? 0}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

export const metrics = new MetricsRegistry();
