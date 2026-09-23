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

/** Public gateways, tried in order. The first is Pinata's own. */
export const GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://dweb.link/ipfs/",
];

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
export async function fetchJSON(cid, { timeoutMs = 12000, gateways = GATEWAYS } = {}) {
  const failures = [];

  for (const gateway of gateways) {
    const url = `${gateway}${cid}`;
    try {
      // Gateways go unresponsive fairly often; move on rather than hang.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        failures.push(`${gateway} → HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (e) {
      failures.push(`${gateway} → ${e.name === "AbortError" ? "timed out" : e.message}`);
    }
  }

  throw new Error(
    `Could not fetch ${cid} from any gateway:\n  ${failures.join("\n  ")}`
  );
}

/** Human-readable link, for logs and for the dApp's "view raw" button. */
export function gatewayUrl(cid, gateway = GATEWAYS[0]) {
  return `${gateway}${cid}`;
}
