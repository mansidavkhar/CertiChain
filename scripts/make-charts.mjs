/**
 * Turn the benchmark CSVs into charts for the report.
 *
 *   node scripts/make-charts.mjs
 *
 * Reads results/*.csv and writes:
 *   results/charts/*.svg   individual charts — paste straight into Word
 *   results/report.html    all of them on one page, open it in a browser
 *
 * Everything is hand-written SVG with no dependencies, so the files stay
 * small, scale without blurring in a printed report, and keep working years
 * from now.
 *
 * Colours come from a palette validated for colour-vision deficiency: blue
 * and orange stay distinguishable for deuteranopia, protanopia and
 * tritanopia, and both clear 3:1 contrast against the chart surface. Every
 * chart also carries direct labels, so nothing depends on colour alone.
 */

import fs from "fs";
import path from "path";

const RESULTS = "results";
const CHARTS = path.join(RESULTS, "charts");

/* ------------------------------------------------------------------ *
 * palette
 * ------------------------------------------------------------------ */

const LIGHT = {
  surface: "#fcfcfb",
  grid: "#e6e5e1",
  axis: "#b9b8b2",
  text: "#0b0b0b",
  muted: "#52514e",
  s1: "#2a78d6", // blue   — the paper's cipher / primary series
  s2: "#eb6834", // orange — AES-256-GCM
  s3: "#1baf7a", // aqua   — third series where needed
};

const DARK = {
  surface: "#1a1a19",
  grid: "#33332f",
  axis: "#5a5a55",
  text: "#ffffff",
  muted: "#c3c2b7",
  s1: "#3987e5",
  s2: "#d95926",
  s3: "#199e70",
};

const SERIES_LABEL = {
  "paper-v1": "Paper's cipher",
  "aes-256-gcm": "AES-256-GCM",
};

/* ------------------------------------------------------------------ *
 * tiny CSV reader
 * ------------------------------------------------------------------ */

function readCsv(file) {
  const full = path.join(RESULTS, file);
  if (!fs.existsSync(full)) return null;
  const [head, ...lines] = fs
    .readFileSync(full, "utf8")
    .trim()
    .split("\n");
  const headers = head.split(",");
  return lines.map((line) => {
    // Handles the quoted fields the benchmarks emit; no embedded quotes.
    const cells = line.match(/("[^"]*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
    return Object.fromEntries(
      headers.map((h, i) => {
        const raw = (cells[i] ?? "").replace(/^"|"$/g, "");
        const num = Number(raw);
        return [h, raw !== "" && !Number.isNaN(num) ? num : raw];
      })
    );
  });
}

/* ------------------------------------------------------------------ *
 * SVG helpers
 * ------------------------------------------------------------------ */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Round to at most `d` significant-ish digits for axis labels. */
function fmt(n) {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  if (abs >= 10) return n.toFixed(0);
  if (abs >= 1) return n.toFixed(1);
  return n.toFixed(abs >= 0.1 ? 2 : 3);
}

/** "Nice" axis maximum and tick step, so gridlines land on round numbers. */
function niceScale(max, targetTicks = 5) {
  if (max <= 0) return { max: 1, step: 0.25 };
  const rough = max / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

const PAD = { top: 34, right: 22, bottom: 52, left: 68 };
const W = 660;
const H = 340;

function frame(c, { title, subtitle, xLabel, yLabel, yMax, yStep, xTicks }) {
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  let s = "";

  // Title sits inside the SVG so a pasted image is self-describing.
  s += `<text x="${PAD.left}" y="16" fill="${c.text}" font-size="13.5" font-weight="600">${esc(title)}</text>`;
  if (subtitle) {
    s += `<text x="${PAD.left}" y="30" fill="${c.muted}" font-size="11">${esc(subtitle)}</text>`;
  }

  // Horizontal gridlines, recessive.
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    const y = PAD.top + plotH - (v / yMax) * plotH;
    s += `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${PAD.left + plotW}" y2="${y.toFixed(1)}" stroke="${c.grid}" stroke-width="1"/>`;
    s += `<text x="${PAD.left - 8}" y="${(y + 3.5).toFixed(1)}" fill="${c.muted}" font-size="10.5" text-anchor="end">${fmt(v)}</text>`;
  }

  // Baseline only; no box around the plot.
  s += `<line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${PAD.left + plotW}" y2="${PAD.top + plotH}" stroke="${c.axis}" stroke-width="1"/>`;

  for (const { x, label } of xTicks) {
    s += `<text x="${x.toFixed(1)}" y="${PAD.top + plotH + 16}" fill="${c.muted}" font-size="10.5" text-anchor="middle">${esc(label)}</text>`;
  }

  if (xLabel) {
    s += `<text x="${PAD.left + plotW / 2}" y="${H - 6}" fill="${c.muted}" font-size="11" text-anchor="middle">${esc(xLabel)}</text>`;
  }
  if (yLabel) {
    s += `<text transform="translate(14,${PAD.top + plotH / 2}) rotate(-90)" fill="${c.muted}" font-size="11" text-anchor="middle">${esc(yLabel)}</text>`;
  }

  return { svg: s, plotW, plotH };
}

/**
 * Legend, right-aligned in the header row beside the title.
 *
 * It lives up here rather than under the plot because a legend below the
 * x-axis collides with the tick labels at this width.
 */
function legend(c, entries, y = 16) {
  const widthOf = (label) => 14 + label.length * 5.9 + 14;
  const total = entries.reduce((w, e) => w + widthOf(e.label), 0) - 14;

  let x = W - PAD.right - total;
  let s = "";
  for (const { color, label } of entries) {
    s += `<rect x="${x.toFixed(1)}" y="${y - 8}" width="9" height="9" rx="2" fill="${color}"/>`;
    s += `<text x="${(x + 14).toFixed(1)}" y="${y}" fill="${c.muted}" font-size="11">${esc(label)}</text>`;
    x += widthOf(label);
  }
  return s;
}

function wrap(body, c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">
<rect width="${W}" height="${H}" fill="${c.surface}"/>
${body}
</svg>`;
}

/* ------------------------------------------------------------------ *
 * chart: grouped bars (two series over categories)
 * ------------------------------------------------------------------ */

function groupedBars(c, { title, subtitle, xLabel, yLabel, categories, series, valueFmt = fmt }) {
  const allValues = series.flatMap((s) => s.values);
  const { max: yMax, step: yStep } = niceScale(Math.max(...allValues));

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const groupW = plotW / categories.length;
  // A 2px gap between adjacent bars keeps the pair legible without a stroke.
  const barW = Math.min(26, (groupW - 16) / series.length - 2);

  const xTicks = categories.map((label, i) => ({
    x: PAD.left + groupW * (i + 0.5),
    label,
  }));

  const f = frame(c, { title, subtitle, xLabel, yLabel, yMax, yStep, xTicks });
  let s = f.svg;

  categories.forEach((_, i) => {
    series.forEach((ser, j) => {
      const v = ser.values[i];
      const h = (v / yMax) * plotH;
      const totalW = series.length * barW + (series.length - 1) * 2;
      const x = PAD.left + groupW * (i + 0.5) - totalW / 2 + j * (barW + 2);
      const y = PAD.top + plotH - h;
      // 4px rounded top, square foot: the bar stays anchored to the baseline.
      s += `<path d="M${x.toFixed(1)},${(y + h).toFixed(1)} L${x.toFixed(1)},${(y + 4).toFixed(1)} Q${x.toFixed(1)},${y.toFixed(1)} ${(x + 4).toFixed(1)},${y.toFixed(1)} L${(x + barW - 4).toFixed(1)},${y.toFixed(1)} Q${(x + barW).toFixed(1)},${y.toFixed(1)} ${(x + barW).toFixed(1)},${(y + 4).toFixed(1)} L${(x + barW).toFixed(1)},${(y + h).toFixed(1)} Z" fill="${ser.color}"><title>${esc(ser.label)} — ${valueFmt(v)}</title></path>`;
    });
  });

  s += legend(c, series.map((ser) => ({ color: ser.color, label: ser.label })));
  return wrap(s, c);
}

/* ------------------------------------------------------------------ *
 * chart: lines (one or more series over a numeric x)
 * ------------------------------------------------------------------ */

function lines(c, { title, subtitle, xLabel, yLabel, xs, series, labelLast = true, valueFmt = fmt }) {
  const allValues = series.flatMap((s) => s.values);
  const { max: yMax, step: yStep } = niceScale(Math.max(...allValues));

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const xAt = (i) => PAD.left + (xs.length === 1 ? plotW / 2 : (i / (xs.length - 1)) * plotW);
  const yAt = (v) => PAD.top + plotH - (v / yMax) * plotH;

  const xTicks = xs.map((x, i) => ({ x: xAt(i), label: fmt(x) }));
  const f = frame(c, { title, subtitle, xLabel, yLabel, yMax, yStep, xTicks });
  let s = f.svg;

  for (const ser of series) {
    const d = ser.values
      .map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
      .join(" ");
    s += `<path d="${d}" fill="none" stroke="${ser.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

    // Markers get a surface-coloured ring so overlapping series stay readable.
    ser.values.forEach((v, i) => {
      s += `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(v).toFixed(1)}" r="4" fill="${ser.color}" stroke="${c.surface}" stroke-width="2"><title>${esc(ser.label)} — ${valueFmt(v)}</title></circle>`;
    });

    // Direct-label the final point rather than every point.
    if (labelLast && series.length > 1) {
      const last = ser.values.length - 1;
      s += `<text x="${(xAt(last) - 8).toFixed(1)}" y="${(yAt(ser.values[last]) - 10).toFixed(1)}" fill="${c.muted}" font-size="10.5" text-anchor="end">${esc(ser.label)}</text>`;
    }
  }

  if (series.length > 1) {
    s += legend(c, series.map((ser) => ({ color: ser.color, label: ser.label })));
  }
  return wrap(s, c);
}

/* ------------------------------------------------------------------ *
 * chart: horizontal bars (gas per operation)
 * ------------------------------------------------------------------ */

function horizontalBars(c, { title, subtitle, xLabel, rows, color }) {
  const { max: xMax, step: xStep } = niceScale(Math.max(...rows.map((r) => r.value)));
  const labelW = 150;
  const plotW = W - labelW - 70;
  const rowH = 26;
  const height = 46 + rows.length * rowH + 34;

  let s = `<text x="16" y="18" fill="${c.text}" font-size="13.5" font-weight="600">${esc(title)}</text>`;
  if (subtitle) s += `<text x="16" y="32" fill="${c.muted}" font-size="11">${esc(subtitle)}</text>`;

  for (let v = 0; v <= xMax + 1e-9; v += xStep) {
    const x = labelW + (v / xMax) * plotW;
    s += `<line x1="${x.toFixed(1)}" y1="44" x2="${x.toFixed(1)}" y2="${44 + rows.length * rowH}" stroke="${c.grid}" stroke-width="1"/>`;
    s += `<text x="${x.toFixed(1)}" y="${44 + rows.length * rowH + 15}" fill="${c.muted}" font-size="10.5" text-anchor="middle">${fmt(v)}</text>`;
  }

  rows.forEach((r, i) => {
    const y = 50 + i * rowH;
    const w = (r.value / xMax) * plotW;
    const h = 14;
    s += `<text x="${labelW - 10}" y="${y + 11}" fill="${c.text}" font-size="11" text-anchor="end">${esc(r.label)}</text>`;
    s += `<path d="M${labelW},${y} L${(labelW + Math.max(w - 4, 0)).toFixed(1)},${y} Q${(labelW + w).toFixed(1)},${y} ${(labelW + w).toFixed(1)},${y + 4} L${(labelW + w).toFixed(1)},${y + h - 4} Q${(labelW + w).toFixed(1)},${y + h} ${(labelW + Math.max(w - 4, 0)).toFixed(1)},${y + h} L${labelW},${y + h} Z" fill="${r.muted ? c.axis : color}"/>`;
    s += `<text x="${(labelW + w + 8).toFixed(1)}" y="${y + 11}" fill="${c.muted}" font-size="10.5">${r.value.toLocaleString()}${r.muted ? " (free off-chain)" : ""}</text>`;
  });

  s += `<text x="${labelW + plotW / 2}" y="${height - 6}" fill="${c.muted}" font-size="11" text-anchor="middle">${esc(xLabel)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">
<rect width="${W}" height="${height}" fill="${c.surface}"/>
${s}
</svg>`;
}

/* ------------------------------------------------------------------ *
 * build every chart
 * ------------------------------------------------------------------ */

function buildCharts(c) {
  const out = {};

  /* --- cipher benchmarks --- */
  const sizes = readCsv("cipher-sizes.csv");
  if (sizes) {
    const cats = [...new Set(sizes.map((r) => r.plaintextBytes))].sort((a, b) => a - b);
    const bySeries = (scheme, field) =>
      cats.map((b) => sizes.find((r) => r.plaintextBytes === b && r.scheme === scheme)?.[field] ?? 0);

    const schemes = ["paper-v1", "aes-256-gcm"];
    const colors = [c.s1, c.s2];

    out["cipher-encrypt-time"] = groupedBars(c, {
      title: "Encryption time by payload size",
      subtitle: "median of 25 runs, lower is better",
      xLabel: "certificate size (bytes)",
      yLabel: "milliseconds",
      categories: cats.map(String),
      series: schemes.map((s, i) => ({
        label: SERIES_LABEL[s],
        color: colors[i],
        values: bySeries(s, "encryptMs"),
      })),
    });

    out["cipher-decrypt-time"] = groupedBars(c, {
      title: "Decryption time by payload size",
      subtitle: "median of 25 runs, lower is better",
      xLabel: "certificate size (bytes)",
      yLabel: "milliseconds",
      categories: cats.map(String),
      series: schemes.map((s, i) => ({
        label: SERIES_LABEL[s],
        color: colors[i],
        values: bySeries(s, "decryptMs"),
      })),
    });

    out["cipher-expansion"] = lines(c, {
      title: "Ciphertext expansion",
      subtitle: "bytes stored on IPFS per byte of certificate — lower is cheaper",
      xLabel: "certificate size (bytes)",
      yLabel: "expansion factor (x)",
      xs: cats,
      series: schemes.map((s, i) => ({
        label: SERIES_LABEL[s],
        color: colors[i],
        values: bySeries(s, "expansion"),
      })),
      valueFmt: (v) => `${v}x`,
    });

    out["cipher-size"] = lines(c, {
      title: "Stored ciphertext size",
      subtitle: "what actually gets pinned to IPFS",
      xLabel: "certificate size (bytes)",
      yLabel: "ciphertext (bytes)",
      xs: cats,
      series: schemes.map((s, i) => ({
        label: SERIES_LABEL[s],
        color: colors[i],
        values: bySeries(s, "ciphertextBytes"),
      })),
    });
  }

  /* --- chain benchmarks --- */
  const suffix = fs.existsSync(path.join(RESULTS, "chain-gas-amoy.csv")) ? "amoy" : "local";

  const gas = readCsv(`chain-gas-${suffix}.csv`);
  if (gas) {
    out["chain-gas"] = horizontalBars(c, {
      title: "Gas cost per operation",
      subtitle:
        "deployment happens once; verification is a free read for the employer",
      xLabel: "gas units",
      color: c.s1,
      rows: gas.map((r) => ({
        label: r.operation.replace(/ \(.*\)/, ""),
        value: r.gasUsed,
        muted: /view/.test(r.operation),
      })),
    });
  }

  const cost = readCsv(`chain-cost-${suffix}.csv`);
  if (cost) {
    out["chain-cost"] = lines(c, {
      title: "Cumulative cost of issuing certificates",
      subtitle: `on ${suffix === "amoy" ? "Polygon Amoy" : "a local chain"} — cost grows linearly, as the paper reports`,
      xLabel: "certificates issued",
      yLabel: `total cost (${cost[0].currency})`,
      xs: cost.map((r) => r.certificates),
      series: [{ label: "total cost", color: c.s1, values: cost.map((r) => r.totalCost) }],
      valueFmt: (v) => v.toFixed(6),
    });
  }

  const perf = readCsv(`chain-performance-${suffix}.csv`);
  if (perf) {
    out["chain-latency"] = lines(c, {
      title: "Transaction latency",
      subtitle:
        suffix === "amoy"
          ? "measured on Polygon Amoy"
          : "local auto-mining node — not representative of a real network",
      xLabel: "number of transactions",
      yLabel: "milliseconds",
      xs: perf.map((r) => r.transactions),
      series: [
        { label: "max", color: c.s2, values: perf.map((r) => r.maxLatencyMs) },
        { label: "average", color: c.s1, values: perf.map((r) => r.avgLatencyMs) },
        { label: "min", color: c.s3, values: perf.map((r) => r.minLatencyMs) },
      ],
    });

    out["chain-throughput"] = lines(c, {
      title: "Transaction throughput",
      subtitle:
        suffix === "amoy"
          ? "measured on Polygon Amoy"
          : "local auto-mining node — not representative of a real network",
      xLabel: "number of transactions",
      yLabel: "transactions per second",
      xs: perf.map((r) => r.transactions),
      series: [{ label: "throughput", color: c.s1, values: perf.map((r) => r.throughputTps) }],
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * HTML report
 * ------------------------------------------------------------------ */

function buildReport(lightCharts, darkCharts) {
  const props = readCsv("cipher-properties.csv");
  const brute = readCsv("cipher-bruteforce.csv")?.[0];

  const figures = Object.keys(lightCharts)
    .map(
      (key, i) => `
    <figure>
      <div class="light-only">${lightCharts[key]}</div>
      <div class="dark-only">${darkCharts[key]}</div>
      <figcaption>Figure ${i + 1}. ${esc(
        lightCharts[key].match(/font-weight="600">([^<]+)</)?.[1] ?? key
      )}</figcaption>
    </figure>`
    )
    .join("\n");

  const propTable = props
    ? `
  <h2>Qualitative comparison</h2>
  <table>
    <thead><tr><th>Property</th><th>Paper's cipher</th><th>AES-256-GCM</th></tr></thead>
    <tbody>
      ${props
        .map(
          (r) =>
            `<tr><td>${esc(r.property)}</td><td>${esc(r.paper)}</td><td>${esc(r.aes)}</td></tr>`
        )
        .join("\n      ")}
    </tbody>
  </table>`
    : "";

  const bruteNote = brute
    ? `
  <h2>Brute-force resistance</h2>
  <p>
    The paper's cipher draws its keystream from tetrahedral and pentatope
    numbers — a publicly known sequence — so the whole key reduces to two
    starting indices. Exhaustively searching that space recovered the
    plaintext after <strong>${brute.paperGuessesNeeded.toLocaleString()}</strong>
    guesses in <strong>${brute.paperSecondsToBreak} seconds</strong> on an
    ordinary laptop. AES-256 has a 2<sup>256</sup> keyspace, which is not
    searchable by any means.
  </p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CertChain — evaluation results</title>
<style>
  :root { color-scheme: light dark;
    --bg:#fcfcfb; --fg:#0b0b0b; --muted:#52514e; --border:#e6e5e1; --surface:#fff; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#111110; --fg:#f2f1ec; --muted:#c3c2b7; --border:#33332f; --surface:#1a1a19; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:760px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:24px; margin:0 0 6px; letter-spacing:-.02em }
  h2 { font-size:17px; margin:40px 0 10px; }
  p.lede { color:var(--muted); margin:0 0 6px }
  p { margin:0 0 14px }
  figure { margin:26px 0; }
  figure svg { max-width:100%; height:auto; display:block;
    border:1px solid var(--border); border-radius:10px; }
  figcaption { color:var(--muted); font-size:12.5px; margin-top:8px; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; margin:10px 0 20px }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border);
    vertical-align:top }
  th { color:var(--muted); font-weight:600; font-size:12.5px }
  code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12.5px }
  .dark-only { display:none }
  @media (prefers-color-scheme: dark) {
    .light-only { display:none } .dark-only { display:block }
  }
  @media print {
    .dark-only { display:none !important } .light-only { display:block !important }
    figure { break-inside:avoid }
  }
  footer { margin-top:48px; padding-top:16px; border-top:1px solid var(--border);
    color:var(--muted); font-size:12.5px }
</style>
</head>
<body>
<main>
  <h1>CertChain — evaluation results</h1>
  <p class="lede">
    Reproducing the evaluation of Sultana et al. (<em>Information</em> 14(8):446,
    2023), plus a comparison between the paper's cipher and AES-256-GCM.
  </p>
  <p class="lede">Generated ${new Date().toLocaleString()}</p>

  <h2>Charts</h2>
  <p>
    Each chart below is a standalone SVG, also saved individually in
    <code>results/charts/</code> — paste those straight into the report and they
    stay sharp at any size.
  </p>
${figures}
${bruteNote}
${propTable}

  <footer>
    Regenerate with <code>node scripts/bench-cipher.mjs</code>,
    <code>npx hardhat run scripts/bench-chain.mjs --network amoy</code>, then
    <code>node scripts/make-charts.mjs</code>.
  </footer>
</main>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function main() {
  if (!fs.existsSync(RESULTS)) {
    console.error(
      "No results/ folder. Run the benchmarks first:\n" +
        "  node scripts/bench-cipher.mjs\n" +
        "  npx hardhat run scripts/bench-chain.mjs"
    );
    process.exit(1);
  }
  fs.mkdirSync(CHARTS, { recursive: true });

  const light = buildCharts(LIGHT);
  const dark = buildCharts(DARK);

  const names = Object.keys(light);
  if (names.length === 0) {
    console.error("No CSVs found in results/. Run the benchmarks first.");
    process.exit(1);
  }

  for (const name of names) {
    fs.writeFileSync(path.join(CHARTS, `${name}.svg`), light[name]);
    fs.writeFileSync(path.join(CHARTS, `${name}-dark.svg`), dark[name]);
  }
  console.log(`Wrote ${names.length * 2} SVG files to ${CHARTS}/`);
  names.forEach((n) => console.log(`  ${n}.svg`));

  const reportPath = path.join(RESULTS, "report.html");
  fs.writeFileSync(reportPath, buildReport(light, dark));
  console.log(`\nWrote ${reportPath} — open it in a browser.`);
}

main();
