import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const round = (value, places = 5) => Number(value.toFixed(places));
const average = values => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};

export function summarizeV46Stats(events) {
  const eligible = events.filter(event => event.marketType === "CRYPTO_PERP"
    && event.confirmationType === "CLEAN"
    && event.confirmedFeatures?.comfortState != null
    && event.confirmedMetrics?.["60m"]?.matured === true);

  const group = rows => {
    const metrics = rows.map(event => event.confirmedMetrics["60m"]);
    const n = metrics.length;
    const hits = threshold => metrics.filter(metric => metric[`hit${threshold}`] === true).length;
    const hit05 = hits("05"), hit10 = hits("10"), hit20 = hits("20");
    const mae = metrics.map(metric => metric.maePct).filter(Number.isFinite).map(value => value / 100);
    const timeTo05 = metrics.map(metric => metric.timeTo05).filter(Number.isFinite);
    return {
      n, hit05, hit05Rate: n ? round(hit05 / n) : null,
      hit10, hit10Rate: n ? round(hit10 / n) : null,
      hit20, hit20Rate: n ? round(hit20 / n) : null,
      failedBefore05: metrics.filter(metric => metric.failedBefore05 === true).length,
      avgMAE: average(mae), medianMAE: median(mae),
      avgTimeTo05: average(timeTo05), medianTimeTo05: median(timeTo05),
    };
  };

  return {
    ALL: group(eligible),
    FAST: group(eligible.filter(event => event.confirmedFeatures.comfortState === "FAST")),
    WAIT: group(eligible.filter(event => event.confirmedFeatures.comfortState === "WAIT")),
  };
}

export function createV46Stats(ledger) {
  return {
    generatedAt: ledger.updatedAt,
    version: ledger.version,
    scope: "CRYPTO_PERP+CLEAN+confirmedFeatures.comfortState+confirmedMetrics.60m.matured",
    ...summarizeV46Stats(ledger.events),
  };
}

export function run({ root = process.cwd() } = {}) {
  const ledger = JSON.parse(fs.readFileSync(path.join(root, "data", "v46-ledger.json"), "utf8"));
  const stats = createV46Stats(ledger);
  fs.writeFileSync(path.join(root, "data", "v46-stats.json"), JSON.stringify(stats, null, 2) + "\n");
  console.log("V4.6 stats updated. ALL=" + stats.ALL.n + " FAST=" + stats.FAST.n + " WAIT=" + stats.WAIT.n);
  return stats;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) run();
