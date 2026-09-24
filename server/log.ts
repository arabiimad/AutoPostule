/** Journal structuré (une ligne JSON) : lisible par Cloud Logging, Datadog, Grafana Loki… */
export function logEvent(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
