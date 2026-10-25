import { useState, useEffect, useCallback } from "react";
import {
  getReadOnlyContract,
  getReadOnlyContracts,
  getSignerContracts,
  CONTRACT_ADDRESS,
  chainInfo,
  addressUrl,
} from "../lib/chain";
import { hashCiphertext, openCertificate } from "@lib/certificate.mjs";
import { fetchJSON, gatewayUrl } from "@lib/ipfs.mjs";

/**
 * The verification page — the heart of the project.
 *
 * Deliberately usable with no wallet, no extension and no account: an employer
 * scans the QR code on a phone, the browser opens this page with the
 * parameters filled in, and the check runs automatically.
 *
 * Integrity and confidentiality are separate steps here, and the UI keeps them
 * separate on purpose:
 *
 *   - Steps 1-3 (read the chain, fetch IPFS, compare digests) need no key.
 *     Anyone can confirm a certificate is authentic and unaltered.
 *   - Step 4 (decrypt) needs the key from the QR code. Only someone the
 *     student gave the code to can read the contents.
 */

const STATUS = ["NotFound", "Valid", "Tampered", "Revoked"];

const VERDICTS = {
  Valid: {
    cls: "valid",
    mark: "✓",
    title: "Authentic",
    detail: "Issued by a whitelisted authority, unaltered, and not revoked.",
  },
  Tampered: {
    cls: "tampered",
    mark: "✗",
    title: "Tampered with",
    detail:
      "The stored file does not match the digest recorded on chain at issuance. It has been modified.",
  },
  Revoked: {
    cls: "revoked",
    mark: "!",
    title: "Revoked",
    detail:
      "This certificate was genuinely issued, but the issuing authority has since withdrawn it.",
  },
  NotFound: {
    cls: "notfound",
    mark: "✗",
    title: "Not found",
    detail:
      "No certificate with this id has ever been issued through this registry.",
  },
};

export default function Verify() {
  const [form, setForm] = useState({ id: "", cid: "", key: "", scheme: "" });
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [revealed, setRevealed] = useState(null);
  const [revealError, setRevealError] = useState("");
  const [logged, setLogged] = useState(false);

  /* Pull parameters out of the QR link, e.g. #/verify?id=0x..&cid=..&key=.. */
  useEffect(() => {
    const qs = window.location.hash.split("?")[1];
    if (!qs) return;
    const p = new URLSearchParams(qs);
    const next = {
      id: p.get("id") ?? "",
      cid: p.get("cid") ?? "",
      key: p.get("key") ?? "",
      scheme: p.get("scheme") ?? "",
    };
    setForm(next);
    if (next.id && next.cid) run(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const run = useCallback(async (input) => {
    const { id, cid } = input;
    setBusy(true);
    setError("");
    setResult(null);
    setRevealed(null);
    setRevealError("");

    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(id.trim())) {
        throw new Error("Certificate id must be a 0x-prefixed 32-byte hash.");
      }
      if (!cid.trim()) throw new Error("An IPFS CID is required.");

      // 1. Fetch the encrypted file. No credentials involved.
      setStage("Fetching the certificate from IPFS…");
      const payload = await fetchJSON(cid.trim());
      if (!payload?.ciphertext) {
        throw new Error("That CID does not hold a CertChain payload.");
      }

      // 2. Recompute the digest locally, in the browser.
      setStage("Recomputing the digest…");
      const digest = hashCiphertext(payload.ciphertext);

      // 3. Ask the chain. A free `view` call through a public RPC.
      setStage("Reading the registry…");
      const registry = await getReadOnlyContract();

      let statusCode, cert;
      try {
        if (payload.batchRoot && Array.isArray(payload.proof)) {
          const { BatchRegistry: batch } = await getReadOnlyContracts();
          statusCode = await batch.verifyInBatch(
            payload.batchRoot, payload.proof, id.trim(), digest
          );
          cert = { cid: cid.trim(), dataHash: digest, issuer: "", issuedAt: 0, revokedAt: 0 };
        } else {
          [statusCode, cert] = await registry.verifyCertificate(id.trim(), digest);
        }
      } catch (e) {
        // A bare "Failed to fetch" here is a dead RPC, not a bad certificate.
        // Say which step broke, so it is never mistaken for a verdict.
        throw new Error(
          `Reached the network but the registry call failed: ` +
            `${e.shortMessage ?? e.message}. This is an RPC problem, not a ` +
            `problem with the certificate.`
        );
      }

      setResult({
        status: STATUS[Number(statusCode)],
        digest,
        payload,
        cid: cid.trim(),
        cert: {
          cid: cert.cid,
          dataHash: cert.dataHash,
          issuer: cert.issuer,
          issuedAt: Number(cert.issuedAt),
          revokedAt: Number(cert.revokedAt),
        },
      });
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
      setStage("");
    }
  }, []);

  async function logVerification() {
    try {
      const { contracts } = await getSignerContracts();
      await (await contracts.AccessManager.recordVerification(form.id, result.digest)).wait();
      setLogged(true);
    } catch (e) { setError(e.message ?? String(e)); }
  }

  async function reveal() {
    setRevealError("");
    try {
      let material = form.key.trim();
      if (!material) throw new Error("No decryption key supplied.");
      // The paper's scheme uses a small JSON object; AES uses a plain string.
      if (material.startsWith("{")) material = JSON.parse(material);
      setRevealed(await openCertificate(result.payload, material));
    } catch (e) {
      setRevealError(
        e.message?.includes("JSON")
          ? "That key does not look right for this certificate."
          : e.message
      );
    }
  }

  const verdict = result ? VERDICTS[result.status] : null;

  return (
    <>
      <div className="card">
        <h2>Verify a certificate</h2>
        <p className="hint">
          Scanning the QR code fills this in automatically. No wallet, account
          or sign-in is needed — the check is a free read of the public ledger.
        </p>
        {result?.status === "Valid" && (
          <button className="secondary" onClick={logVerification} disabled={logged}>
            {logged ? "Verification logged" : "Log this verification on-chain"}
          </button>
        )}

        <div style={{ marginBottom: 12 }}>
          <label>Certificate id</label>
          <input
            value={form.id}
            onChange={set("id")}
            placeholder="0x…"
            spellCheck={false}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label>IPFS CID</label>
          <input
            value={form.cid}
            onChange={set("cid")}
            placeholder="bafkrei…"
            spellCheck={false}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label>
            Decryption key — optional, only to read the contents
          </label>
          <input
            value={form.key}
            onChange={set("key")}
            placeholder="from the student's QR code"
            spellCheck={false}
          />
        </div>

        <div className="row">
          <button onClick={() => run(form)} disabled={busy}>
            {busy ? <><span className="spin" /> Checking…</> : "Verify"}
          </button>
          {stage && <span className="muted small">{stage}</span>}
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {result && (
        <>
          <div className={`verdict ${verdict.cls}`}>
            <div className="mark">{verdict.mark}</div>
            <div>
              <div className="title">{verdict.title}</div>
              <div className="detail">{verdict.detail}</div>
            </div>
          </div>

          <div className="card">
            <h2>What was checked</h2>
            <p className="hint">
              Every step below ran in your browser against public data. Nothing
              was taken on trust from the issuer or from us.
            </p>
            <dl className="facts">
              <dt>Digest recomputed</dt>
              <dd>{result.digest}</dd>
              <dt>Digest on chain</dt>
              <dd>
                {result.cert.issuedAt
                  ? result.cert.dataHash
                  : "— no record for this id —"}
              </dd>
              <dt>Match</dt>
              <dd>
                {result.cert.issuedAt
                  ? result.digest.toLowerCase() ===
                    result.cert.dataHash.toLowerCase()
                    ? "yes — the file is byte-for-byte as issued"
                    : "NO — the file has changed since issuance"
                  : "n/a"}
              </dd>
              {result.cert.issuedAt > 0 && (
                <>
                  <dt>Issued by</dt>
                  <dd>
                    {addressUrl(result.cert.issuer) ? (
                      <a
                        href={addressUrl(result.cert.issuer)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {result.cert.issuer}
                      </a>
                    ) : (
                      result.cert.issuer
                    )}
                  </dd>
                  <dt>Issued at</dt>
                  <dd>{new Date(result.cert.issuedAt * 1000).toLocaleString()}</dd>
                </>
              )}
              {result.cert.revokedAt > 0 && (
                <>
                  <dt>Revoked at</dt>
                  <dd>{new Date(result.cert.revokedAt * 1000).toLocaleString()}</dd>
                </>
              )}
              <dt>Encryption</dt>
              <dd>{result.payload.scheme}</dd>
              <dt>Registry</dt>
              <dd>
                {addressUrl(CONTRACT_ADDRESS) ? (
                  <a href={addressUrl(CONTRACT_ADDRESS)} target="_blank" rel="noreferrer">
                    {CONTRACT_ADDRESS}
                  </a>
                ) : (
                  CONTRACT_ADDRESS
                )}{" "}
                on {chainInfo.name}
              </dd>
              <dt>Stored file</dt>
              <dd>
                <a href={gatewayUrl(result.cid)} target="_blank" rel="noreferrer">
                  view the raw encrypted payload
                </a>
              </dd>
            </dl>
          </div>

          <div className="card">
            <h2>Read the certificate</h2>
            <p className="hint">
              The contents are encrypted. Everything above was verified without
              them — integrity does not require the ability to read.
            </p>

            {revealed ? (
              <dl className="facts">
                {Object.entries(revealed).map(([k, v]) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt>{k}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <>
                <button
                  className="secondary"
                  onClick={reveal}
                  disabled={!form.key.trim()}
                >
                  Decrypt with the supplied key
                </button>
                {!form.key.trim() && (
                  <p className="muted small" style={{ marginBottom: 0 }}>
                    No key was provided, so the contents stay sealed.
                  </p>
                )}
              </>
            )}
            {revealError && (
              <div className="banner error" style={{ marginTop: 12 }}>
                {revealError}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
