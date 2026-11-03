import type { Deps } from "./ports";

// Card-testing early warning. Counts failures in the current hour; the first time the count
// passes the threshold in that hour, alerts the operator once.

export const SPIKE_THRESHOLD_PER_HOUR = 20;

export async function noteFailure(d: Pick<Deps, "rpc" | "alerts">, kind: "charge_failed" | "setup_failed"): Promise<void> {
  const hour = new Date().toISOString().slice(0, 13);
  const withinLimit = await d.rpc<boolean>("hit_rate_limit", {
    p_key: `spike:${kind}:${hour}`, p_max: SPIKE_THRESHOLD_PER_HOUR, p_window: "1 hour",
  });
  if (withinLimit) return;
  const firstTime = await d.rpc<boolean>("hit_rate_limit", {
    p_key: `spike_alerted:${kind}:${hour}`, p_max: 1, p_window: "1 hour",
  });
  if (firstTime) {
    await d.alerts.notify(`Spike in ${kind.replace("_", " ")} events`, { kind, hour, threshold: SPIKE_THRESHOLD_PER_HOUR });
  }
}
