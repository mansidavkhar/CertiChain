import { useState } from "react";
import QRCode from "qrcode";
import {
  getSignerContract,
  getReadOnlyContract,
  txUrl,
  readableError,
} from "../lib/chain";
import { packageCertificate, SCHEMES } from "@lib/certificate.mjs";
import { pinJSON, gatewayUrl } from "@lib/ipfs.mjs";

/**
 * Issuer page. Only a whitelisted university address can complete this.
 *
 * Order of operations matters and is worth defending in the viva: encrypt,
 * then pin to IPFS, then anchor on chain. The chain write is last because it
 * is the only irreversible step — if pinning fails we have simply wasted some
 * local work, whereas an on-chain record pointing at a CID that was never
 * stored would be permanently broken.
 */

const BLANK = {
  studentId: "",
  name: "",
  course: "",
  cgpa: "",
  issueDate: new Date().toISOString().slice(0, 10),
  institution: "",
};

export default function Issue() {
  const [fields, setFields] = useState(BLANK);
  const [scheme, setScheme] = useState(SCHEMES.AES);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [issued, setIssued] = useState(null);

  const set = (k) => (e) => setFields({ ...fields, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setIssued(null);

    try {
      const jwt = import.meta.env.VITE_PINATA_JWT;
      if (!jwt) {
        throw new Error(
          "No Pinata JWT configured. Copy frontend/.env.example to " +
            "frontend/.env.local, add VITE_PINATA_JWT, and restart the dev server."
        );
      }

      setStage("Connecting wallet…");
      const { contract, address } = await getSignerContract();

      /*
       * Reads go through our own provider, not MetaMask's.
       *
       * MetaMask talks to whatever RPC it has configured for this network,
       * which we cannot see or choose. When that endpoint is overloaded it
       * returns malformed responses and ethers reports the unhelpful
       * "could not coalesce error". Routing the read-only checks through the
       * racing provider in chain.js keeps MetaMask's flaky endpoint out of
       * everything except the one step that genuinely needs a signature.
       */
      const reader = await getReadOnlyContract();

      if (!(await reader.isIssuer(address))) {
        throw new Error(
          `${address} is not whitelisted as an issuer. Add it from the Admin ` +
            `page using the contract owner's wallet.`
        );
      }

      setStage("Encrypting…");
      const pkg = await packageCertificate(fields, scheme);

      // Catch the clash before spending gas on a transaction that will revert.
      const [existing] = await reader.verifyCertificate(pkg.certId, pkg.dataHash);
      if (existing !== 0n) {
        throw new Error(
          "A certificate already exists for this student id, course and date."
        );
      }

      setStage("Pinning to IPFS…");
      const cid = await pinJSON(
        pkg.payload,
        jwt,
        `cert-${fields.studentId}-${fields.issueDate}`
      );

      setStage("Waiting for you to confirm in MetaMask…");
      const tx = await contract.issueCertificate(pkg.certId, cid, pkg.dataHash);

      setStage("Waiting for the transaction to be mined…");
      const receipt = await tx.wait();

      const params = new URLSearchParams({
        id: pkg.certId,
        cid,
        key:
          typeof pkg.keyMaterial === "string"
            ? pkg.keyMaterial
            : JSON.stringify(pkg.keyMaterial),
        scheme,
      });
      const link = `${window.location.origin}${window.location.pathname}#/verify?${params}`;

      setIssued({
        ...pkg,
        cid,
        link,
        txHash: tx.hash,
        gasUsed: receipt.gasUsed.toString(),
        qr: await QRCode.toDataURL(link, { width: 600, margin: 2 }),
      });
      setFields(BLANK);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
      setStage("");
    }
  }

  if (issued) {
    return (
      <>
        <div className="banner ok">
          Certificate issued and anchored on chain.
        </div>

        <div className="card">
          <h2>Give this to the student</h2>
          <p className="hint">
            The QR code carries the decryption key, so it is confidential.
            Anyone holding it can read the certificate — though nobody can forge
            one, since issuing requires a whitelisted wallet.
          </p>
          <img className="qr" src={issued.qr} alt="Verification QR code" />
          <p className="mono" style={{ textAlign: "center" }}>
            <a href={issued.link}>open the verification link</a>
          </p>
        </div>

        <div className="card">
          <h2>Record</h2>
          <dl className="facts">
            <dt>Certificate id</dt>
            <dd>{issued.certId}</dd>
            <dt>IPFS CID</dt>
            <dd>
              <a href={gatewayUrl(issued.cid)} target="_blank" rel="noreferrer">
                {issued.cid}
              </a>
            </dd>
            <dt>Digest on chain</dt>
            <dd>{issued.dataHash}</dd>
            <dt>Decryption key</dt>
            <dd>
              {typeof issued.keyMaterial === "string"
                ? issued.keyMaterial
                : JSON.stringify(issued.keyMaterial)}
            </dd>
            <dt>Transaction</dt>
            <dd>
              {txUrl(issued.txHash) ? (
                <a href={txUrl(issued.txHash)} target="_blank" rel="noreferrer">
                  {issued.txHash}
                </a>
              ) : (
                issued.txHash
              )}
            </dd>
            <dt>Gas used</dt>
            <dd>{issued.gasUsed}</dd>
          </dl>
        </div>

        <button className="secondary" onClick={() => setIssued(null)}>
          Issue another
        </button>
      </>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Issue a certificate</h2>
      <p className="hint">
        The details are encrypted in your browser before they go anywhere. Only
        the IPFS address and a digest reach the blockchain — no personal data
        is ever written to the public ledger.
      </p>

      <div className="grid">
        <div>
          <label>Student id *</label>
          <input required value={fields.studentId} onChange={set("studentId")} />
        </div>
        <div>
          <label>Full name</label>
          <input value={fields.name} onChange={set("name")} />
        </div>
        <div>
          <label>Course *</label>
          <input required value={fields.course} onChange={set("course")} />
        </div>
        <div>
          <label>CGPA / grade</label>
          <input value={fields.cgpa} onChange={set("cgpa")} />
        </div>
        <div>
          <label>Issue date *</label>
          <input
            required
            type="date"
            value={fields.issueDate}
            onChange={set("issueDate")}
          />
        </div>
        <div>
          <label>Institution</label>
          <input value={fields.institution} onChange={set("institution")} />
        </div>
      </div>

      <div style={{ margin: "14px 0" }}>
        <label>Encryption scheme</label>
        <select value={scheme} onChange={(e) => setScheme(e.target.value)}>
          <option value={SCHEMES.AES}>
            AES-256-GCM — authenticated, recommended
          </option>
          <option value={SCHEMES.PAPER}>
            Paper's cipher — for the comparison only
          </option>
        </select>
        <p className="muted small" style={{ margin: "6px 0 0" }}>
          Student id, course and issue date together determine the certificate
          id, so they cannot be reused for a second certificate.
        </p>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? <><span className="spin" /> Working…</> : "Encrypt, pin and issue"}
        </button>
        {stage && <span className="muted small">{stage}</span>}
      </div>
    </form>
  );
}
