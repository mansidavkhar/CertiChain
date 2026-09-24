/**
 * Configuration check. Run this whenever something does not work:
 *
 *   node scripts/doctor.mjs
 *
 * It verifies every piece of external configuration in one go and says
 * exactly what to fix. Secrets are masked, so the output is safe to paste
 * into a chat or an issue.
 */

import fs from "fs";
import path from "path";
import "dotenv/config";

const PASS = "  ok  ";
const FAIL = " FAIL ";
const WARN = " warn ";

let failures = 0;
const notes = [];

function report(state, label, detail = "") {
  if (state === FAIL) failures++;
  console.log(`[${state}] ${label}${detail ? `  —  ${detail}` : ""}`);
}

/** Show enough of a secret to confirm it is the right one, never all of it. */
function mask(v) {
  if (!v) return "";
  return v.length <= 12 ? "*".repeat(v.length) : `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)`;
}

async function jsonRpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

console.log("\nCertChain configuration check\n" + "─".repeat(60));

/* ---------- 1. .env ------------------------------------------------ */

console.log("\nEnvironment files");

if (!fs.existsSync(".env")) {
  report(FAIL, ".env", "missing");
  notes.push("Create .env — copy .env.example and fill it in.");
} else {
  const size = fs.statSync(".env").size;
  if (size === 0) {
    report(FAIL, ".env", "exists but is EMPTY (0 bytes)");
    notes.push(
      "Your .env is empty. In PowerShell, `New-Item .env` and `echo. > .env` both\n" +
        "   create an empty file. Use:  Copy-Item .env.example .env  then edit it in\n" +
        "   VS Code (not Notepad, which may save it as .env.txt)."
    );
  } else {
    report(PASS, ".env", `${size} bytes`);
  }
}

const frontendEnv = path.join("frontend", ".env.local");
if (!fs.existsSync(frontendEnv)) {
  report(WARN, "frontend/.env.local", "missing — only needed to issue from the dApp");
} else {
  const hasJwt = /^\s*VITE_PINATA_JWT\s*=\s*\S/m.test(
    fs.readFileSync(frontendEnv, "utf8")
  );
  report(hasJwt ? PASS : FAIL, "frontend/.env.local", hasJwt ? "VITE_PINATA_JWT set" : "VITE_PINATA_JWT is empty");
}

/* ---------- 2. variables ------------------------------------------- */

console.log("\nVariables");

const { AMOY_RPC_URL, SEPOLIA_RPC_URL, PRIVATE_KEY, PINATA_JWT } = process.env;

report(AMOY_RPC_URL ? PASS : WARN, "AMOY_RPC_URL", AMOY_RPC_URL || "unset — a public endpoint will be used");
report(SEPOLIA_RPC_URL ? PASS : WARN, "SEPOLIA_RPC_URL", SEPOLIA_RPC_URL ? "set" : "unset — fine unless you deploy to Sepolia");

if (!PRIVATE_KEY) {
  report(FAIL, "PRIVATE_KEY", "unset — you cannot deploy or issue without it");
} else {
  const clean = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY.slice(2) : PRIVATE_KEY;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    report(FAIL, "PRIVATE_KEY", `malformed — expected 64 hex characters, got ${clean.length}`);
    notes.push(
      "A MetaMask private key is 64 hex characters. Export it from\n" +
        "   Account details → Show private key. Do not paste a seed phrase here."
    );
  } else {
    report(PASS, "PRIVATE_KEY", "well-formed (64 hex chars)");
  }
}

report(PINATA_JWT ? PASS : FAIL, "PINATA_JWT", PINATA_JWT ? mask(PINATA_JWT) : "unset — issuing will fail at the pinning step");

/* ---------- 3. network --------------------------------------------- */

console.log("\nNetwork");

const NETWORKS = [
  { name: "amoy", chainId: 80002, url: AMOY_RPC_URL || "https://rpc-amoy.polygon.technology" },
];
if (SEPOLIA_RPC_URL) NETWORKS.push({ name: "sepolia", chainId: 11155111, url: SEPOLIA_RPC_URL });

for (const net of NETWORKS) {
  try {
    const hex = await jsonRpc(net.url, "eth_chainId");
    const actual = parseInt(hex, 16);
    if (actual !== net.chainId) {
      report(FAIL, `RPC ${net.name}`, `reachable, but it is chain ${actual}, not ${net.chainId}`);
      notes.push(`The ${net.name} RPC points at the wrong network. Check the URL.`);
    } else {
      const block = parseInt(await jsonRpc(net.url, "eth_blockNumber"), 16);
      report(PASS, `RPC ${net.name}`, `chain ${actual}, block ${block.toLocaleString()}`);

      if (PRIVATE_KEY && /^(0x)?[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
        const { Wallet, formatEther } = await import("ethers");
        const addr = new Wallet(
          PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`
        ).address;
        const bal = BigInt(await jsonRpc(net.url, "eth_getBalance", [addr, "latest"]));
        const symbol = net.name === "amoy" ? "POL" : "ETH";
        if (bal === 0n) {
          report(FAIL, `balance ${net.name}`, `${addr} has 0 ${symbol}`);
          notes.push(
            net.name === "amoy"
              ? `Fund ${addr} from https://faucet.polygon.technology (select Amoy).`
              : `Fund ${addr} from a Sepolia faucet.`
          );
        } else {
          report(PASS, `balance ${net.name}`, `${formatEther(bal)} ${symbol} at ${addr}`);
        }
      }
    }
  } catch (e) {
    const msg = e.message ?? String(e);
    report(FAIL, `RPC ${net.name}`, msg);
    if (/ENOTFOUND|getaddrinfo|fetch failed|timeout/i.test(msg)) {
      notes.push(
        `Could not reach the ${net.name} RPC. Either the URL is wrong, or your\n` +
          `   network/DNS is blocking it. Alternatives for Amoy:\n` +
          `     https://rpc-amoy.polygon.technology\n` +
          `     https://polygon-amoy-bor-rpc.publicnode.com\n` +
          `     https://rpc.ankr.com/polygon_amoy\n` +
          `   Try each with:  node scripts/doctor.mjs  after editing AMOY_RPC_URL.`
      );
    }
  }
}

/* ---------- 4. Pinata ---------------------------------------------- */

console.log("\nPinata");

if (!PINATA_JWT) {
  report(WARN, "authentication", "skipped, no JWT");
} else {
  try {
    const res = await fetch("https://api.pinata.cloud/data/testAuthentication", {
      headers: { Authorization: `Bearer ${PINATA_JWT}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      report(PASS, "authentication", "JWT accepted");
    } else {
      report(FAIL, "authentication", `HTTP ${res.status} — ${(await res.text()).slice(0, 120)}`);
      notes.push(
        "Pinata rejected the JWT. In the Pinata dashboard go to API Keys, create a\n" +
          "   new key with pinJSONToIPFS permission, and copy the JWT (the long token),\n" +
          "   not the API Key or API Secret."
      );
    }
  } catch (e) {
    report(FAIL, "authentication", e.message);
  }
}

/* ---------- 4b. IPFS gateways --------------------------------------- */

console.log("\nIPFS gateways");

{
  const { GATEWAYS } = await import("../lib/ipfs.mjs");
  const gateway = process.env.PINATA_GATEWAY;

  report(
    gateway ? PASS : WARN,
    "dedicated gateway",
    gateway || "not set — falling back to shared public gateways, which are rate-limited"
  );
  if (!gateway) {
    notes.push(
      "Set a dedicated Pinata gateway. Public gateways are shared across the\n" +
        "   whole internet and time out under load, which is the usual cause of\n" +
        '   "Could not fetch … from any gateway" in the dApp. Find yours in the\n' +
        "   Pinata dashboard under Gateways, then add to BOTH files:\n" +
        "     .env                 PINATA_GATEWAY=https://your-name.mypinata.cloud\n" +
        "     frontend/.env.local  VITE_PINATA_GATEWAY=https://your-name.mypinata.cloud"
    );
  }

  // A CID that has existed since the early days of IPFS: the docs "hello world".
  const KNOWN = "bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am";
  let reachable = 0;

  for (const g of GATEWAYS) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${g}${KNOWN}`, { signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        reachable++;
        report(PASS, `  ${g}`, `${Date.now() - t0} ms`);
      } else {
        report(WARN, `  ${g}`, `HTTP ${res.status}`);
      }
    } catch (e) {
      report(WARN, `  ${g}`, e.name === "TimeoutError" ? "timed out" : e.message);
    }
  }

  if (reachable === 0) {
    report(FAIL, "gateway reachability", "none responded");
    notes.push(
      "No IPFS gateway responded. Either your network blocks them, or they are\n" +
        "   all rate-limiting you right now. A dedicated Pinata gateway avoids both."
    );
  } else {
    report(PASS, "gateway reachability", `${reachable} of ${GATEWAYS.length} responding`);
  }
}

/* ---------- 5. deployment ------------------------------------------ */

console.log("\nDeployment");

const deployments = fs.existsSync("deployments")
  ? fs.readdirSync("deployments").filter((f) => f.endsWith(".json"))
  : [];

if (deployments.length === 0) {
  report(WARN, "contract", "not deployed yet — run  npm run deploy:amoy");
} else {
  for (const file of deployments) {
    const d = JSON.parse(fs.readFileSync(path.join("deployments", file), "utf8"));
    report(PASS, `deployed on ${d.network}`, `${d.address} (chain ${d.chainId})`);
  }
  const fe = path.join("frontend", "src", "contract.json");
  if (fs.existsSync(fe)) {
    const d = JSON.parse(fs.readFileSync(fe, "utf8"));
    report(PASS, "frontend wired to", `${d.address} on ${d.network}`);
  } else {
    report(FAIL, "frontend/src/contract.json", "missing — redeploy to regenerate it");
  }
}

/* ---------- summary ------------------------------------------------ */

console.log("\n" + "─".repeat(60));
if (failures === 0) {
  console.log("Everything checks out. Next:  npm run deploy:amoy\n");
} else {
  console.log(`${failures} problem${failures > 1 ? "s" : ""} to fix:\n`);
  notes.forEach((n, i) => console.log(` ${i + 1}. ${n}\n`));
}

process.exitCode = failures > 0 ? 1 : 0;
