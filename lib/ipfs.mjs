/**
 * IPFS storage via Pinata.
 *
 * Runs in Node (the CLI scripts) and in the browser (the dApp) from this one
 * file: both have `fetch`, `Blob` and `FormData` built in now.
 *
 * ─── A note for the report ──────────────────────────────────────────────
 * Pinata is a *pinning service*: it runs IPFS nodes that keep our file
 * available. The file is still addressed by its CID and can be fetched from
 * any IPFS gateway. What Pinata provides is persistence, not authority — it
 * cannot alter the file, because changing one byte changes the CID, and the
 * CID is anchored on-chain.
 *
 * Using a hosted pinning service is the one centralised piece in the design.
 * Being honest about that is better than pretending otherwise: the trust
 * assumption is *availability only*, never integrity. If Pinata vanished, the
 * certificate could not be fetched, but a copy from any source could still be
 * verified against the chain.
 * ────────────────────────────────────────────────────────────────────────
 */

const PINATA_API = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

/**
 * Gateways to try when fetching.
 *
 * Note what is NOT here: cloudflare-ipfs.com. Cloudflare shut its public IPFS
 * gateway down in August 2024 and now points people at ipfs.io and dweb.link,
 * so requests to it fail immediately. Public gateway availability shifts over
 * time, which is exactly why this is a list and why fetches race across all of
 * it rather than trying one and hoping.
 *
 * A *dedicated* gateway is dramatically more reliable than any of these. Every
 * Pinata account gets one (Pinata dashboard → Gateways), looking like
 * `https://plum-example-1234.mypinata.cloud`. Set it and it goes to the front
 * of the list:
 *
 *   .env                  PINATA_GATEWAY=https://your-name.mypinata.cloud
 *   frontend/.env.local   VITE_PINATA_GATEWAY=https://your-name.mypinata.cloud
 *
 * The shared gateways below are rate-limited across every user on the
 * internet, so they time out under load. That is a property of free
 * infrastructure, not a bug in this project — but it looks like one during a
 * live demo, so configure the dedicated gateway before presenting.
 */

/** Read an env var from either Node or Vite, whichever this is running in. */
function env(key) {
  // import.meta.env only exists under Vite; process only exists in Node.
  const vite = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  return (
    vite?.[`VITE_${key}`] ??
    (typeof process !== "undefined" ? process.env?.[key] : undefined) ??
    null
  );
}

const DEDICATED = (() => {
  const raw = env("PINATA_GATEWAY");
  if (!raw) return null;
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/ipfs") ? `${trimmed}/` : `${trimmed}/ipfs/`;
})();

export const PUBLIC_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://4everland.io/ipfs/",
];

export const GATEWAYS = DEDICATED
  ? [DEDICATED, ...PUBLIC_GATEWAYS]
  : PUBLIC_GATEWAYS;

/**
 * Pin a JSON payload and return its CID.
 *
 * @param {object} payload  the encrypted certificate payload
 * @param {string} jwt      Pinata JWT (scoped to pinJSONToIPFS is enough)
 * @param {string} [name]   label shown in the Pinata dashboard
 * @returns {Promise<string>} the CID
 */
export async function pinJSON(payload, jwt, name = "certificate") {
  if (!jwt) {
    throw new Error(
      "No Pinata JWT. Put PINATA_JWT in .env (scripts) or VITE_PINATA_JWT " +
        "in frontend/.env.local (dApp)."
    );
  }

  const res = await fetch(PINATA_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: payload,
      pinataMetadata: { name },
      // CIDv1 is the modern, case-insensitive form — safer inside a URL and
      // inside a QR code than the older CIDv0 "Qm..." style.
      pinataOptions: { cidVersion: 1 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Pinata rejected the credentials (${res.status}). Check the JWT is ` +
          `current and has pinJSONToIPFS permission. ${detail}`
      );
    }
    throw new Error(`Pinata upload failed (${res.status}): ${detail}`);
  }

  const { IpfsHash } = await res.json();
  if (!IpfsHash) throw new Error("Pinata returned no CID");
  return IpfsHash;
}

/**
 * Fetch a payload by CID, trying gateways in turn.
 *
 * Fetching needs no credentials at all — which is the point. An employer
 * verifying a certificate uses no account, ours or anyone else's.
 *
 * @param {string} cid
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=12000] per-gateway timeout
 * @param {string[]} [opts.gateways]
 */
export async function fetchJSON(cid, { timeoutMs = 20000, gateways = GATEWAYS } = {}) {
  /*
   * Race every gateway at once and keep the first good answer.
   *
   * Trying them one at a time means a single slow gateway holds up all the
   * others: with five gateways and a 20-second timeout, the worst case is a
   * 100-second wait before the user sees anything. Racing makes the worst case
   * one timeout, and in practice whichever gateway happens to be healthy right
   * now answers in well under a second.
   *
   * Content addressing is what makes this safe. Every gateway can only return
   * the bytes matching this CID, so "whichever replies first" cannot change
   * the answer — and the digest is checked against the blockchain afterwards
   * regardless.
   */
  const failures = [];
  const controllers = [];

  const attempts = gateways.map(async (gateway) => {
    const controller = new AbortController();
    controllers.push(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${gateway}${cid}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return { json, gateway };
    } catch (e) {
      const reason =
        e.name === "AbortError"
          ? "timed out"
          : e.message === "Failed to fetch"
            ? "blocked (CORS, DNS or network)"
            : e.message;
      failures.push(`${gateway} → ${reason}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });

  try {
    const winner = await Promise.any(attempts);
    // Stop the losers so they are not left downloading in the background.
    for (const c of controllers) c.abort();
    return winner.json;
  } catch {
    throw new Error(
      `Could not fetch ${cid} from any gateway:\n  ${failures.join("\n  ")}\n\n` +
        `Public IPFS gateways are shared and heavily rate-limited, so this ` +
        `happens.\nSet a dedicated Pinata gateway to fix it properly:\n` +
        `  .env                 PINATA_GATEWAY=https://your-name.mypinata.cloud\n` +
        `  frontend/.env.local  VITE_PINATA_GATEWAY=https://your-name.mypinata.cloud\n` +
        `Find yours in the Pinata dashboard under Gateways.`
    );
  }
}

/** Human-readable link, for logs and for the dApp's "view raw" button. */
export function gatewayUrl(cid, gateway = GATEWAYS[0]) {
  return `${gateway}${cid}`;
}
