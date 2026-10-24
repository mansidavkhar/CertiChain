import { useState, useEffect } from "react";
import {
  getSignerContract,
  getReadOnlyContract,
  getReadOnlyContracts,
  getSignerContracts,
  connectWallet,
  hasWallet,
  txUrl,
  addressUrl,
  readableError,
  CONTRACT_ADDRESS,
  chainInfo,
} from "../lib/chain";

/**
 * Admin page: manage issuers (owner only) and revoke certificates (the
 * issuing university only).
 *
 * The page reads the contract to work out what the connected wallet is allowed
 * to do and disables the rest. That is a convenience, not a security control —
 * the contract enforces the same rules regardless of what the UI shows, which
 * is the point of putting the access rules on chain in the first place.
 */

export default function Admin() {
  const [wallet, setWallet] = useState(null);
  const [roles, setRoles] = useState({ owner: null, isOwner: false, isIssuer: false });
  const [total, setTotal] = useState(null);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState("");

  const [issuerAddr, setIssuerAddr] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [revokeId, setRevokeId] = useState("");
  const [revokeReason, setRevokeReason] = useState("");

  useEffect(() => {
    getReadOnlyContract()
      .then((c) => c.totalIssued())
      .then((n) => setTotal(Number(n)))
      .catch(() => {}); // the banner on the next action will explain
  }, []);

  async function connect() {
    setBanner(null);
    try {
      const { address } = await connectWallet();
      setWallet(address);
      const registry = await getReadOnlyContract();
      const { InstitutionRegistry: institutions } = await getReadOnlyContracts();
      const [owner, issuer] = await Promise.all([
        institutions.owner(),
        institutions.isApproved(address),
      ]);
      setRoles({
        owner,
        isOwner: owner.toLowerCase() === address.toLowerCase(),
        isIssuer: issuer,
      });
    } catch (e) {
      setBanner({ kind: "error", text: readableError(e) });
    }
  }

  /** Wrap a write so every button gets the same busy/feedback handling. */
  async function send(key, label, fn) {
    setBusy(key);
    setBanner(null);
    try {
      const { contract } = await getSignerContract();
      const tx = await fn(contract);
      setBanner({ kind: "warn", text: `${label} — waiting to be mined…` });
      await tx.wait();
      setBanner({ kind: "ok", text: `${label} confirmed.`, hash: tx.hash });
      getReadOnlyContract()
        .then((c) => c.totalIssued())
        .then((n) => setTotal(Number(n)))
        .catch(() => {});
    } catch (e) {
      setBanner({ kind: "error", text: readableError(e) });
    } finally {
      setBusy("");
    }

    async function sendInstitution(key, label, fn) {
      setBusy(key);
      setBanner(null);
      try {
        const { contracts } = await getSignerContracts();
        const tx = await fn(contracts.InstitutionRegistry);
        await tx.wait();
        setBanner({ kind: "ok", text: `${label} confirmed.`, hash: tx.hash });
      } catch (e) { setBanner({ kind: "error", text: readableError(e) }); }
      finally { setBusy(""); }
    }
  }

  const validAddr = /^0x[0-9a-fA-F]{40}$/.test(issuerAddr.trim());
  const validId = /^0x[0-9a-fA-F]{64}$/.test(revokeId.trim());

  return (
    <>
      <div className="card">
        <h2>Registry</h2>
        <dl className="facts">
          <dt>Contract</dt>
          <dd>
            {addressUrl(CONTRACT_ADDRESS) ? (
              <a href={addressUrl(CONTRACT_ADDRESS)} target="_blank" rel="noreferrer">
                {CONTRACT_ADDRESS}
              </a>
            ) : (
              CONTRACT_ADDRESS
            )}
          </dd>
          <dt>Network</dt>
          <dd>{chainInfo.name}</dd>
          <dt>Certificates issued</dt>
          <dd>{total ?? "…"}</dd>
          {roles.owner && (
            <>
              <dt>Owner</dt>
              <dd>{roles.owner}</dd>
            </>
          )}
        </dl>

        <div className="row" style={{ marginTop: 16 }}>
          {wallet ? (
            <>
              <span className="mono">{wallet}</span>
              <span className={`pill ${roles.isOwner ? "on" : "off"}`}>
                {roles.isOwner ? "owner" : "not owner"}
              </span>
              <span className={`pill ${roles.isIssuer ? "on" : "off"}`}>
                {roles.isIssuer ? "issuer" : "not issuer"}
              </span>
            </>
          ) : (
            <button onClick={connect} disabled={!hasWallet()}>
              {hasWallet() ? "Connect wallet" : "MetaMask not found"}
            </button>
          )}
        </div>
      </div>

      {banner && (
        <div className={`banner ${banner.kind}`}>
          {banner.text}
          {banner.hash && txUrl(banner.hash) && (
            <>
              {" "}
              <a href={txUrl(banner.hash)} target="_blank" rel="noreferrer">
                view transaction
              </a>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2>Issuing authorities</h2>
        <p className="hint">
          Only the contract owner can change this list. An approved institution
          can issue certificates and revoke the ones it issued — never another
          university's.
        </p>
        <label>Wallet address</label>
        <input
          value={issuerAddr}
          onChange={(e) => setIssuerAddr(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
        />
        <label>Institution name</label>
        <input value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} placeholder="Example University" />
        <div className="row" style={{ marginTop: 12 }}>
          <button
            disabled={!roles.isOwner || !validAddr || busy}
            onClick={() =>
              sendInstitution("add", "Institution added", (c) => c.addInstitution(issuerAddr.trim(), institutionName.trim()))
            }
          >
            {busy === "add" ? <><span className="spin" /> …</> : "Add issuer"}
          </button>
          <button
            className="secondary"
            disabled={!roles.isOwner || !validAddr || busy}
            onClick={() =>
              sendInstitution("remove", "Institution removed", (c) =>
                c.removeInstitution(issuerAddr.trim())
              )
            }
          >
            Remove issuer
          </button>
          {wallet && !roles.isOwner && (
            <span className="muted small">owner only</span>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Revoke a certificate</h2>
        <p className="hint">
          The record is kept, never deleted — an employer must still be able to
          see that the certificate existed and was withdrawn. Verification will
          report it as Revoked from the next block onwards.
        </p>
        <div style={{ marginBottom: 12 }}>
          <label>Certificate id</label>
          <input
            value={revokeId}
            onChange={(e) => setRevokeId(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label>Reason — stored publicly in the event log</label>
          <input
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            placeholder="e.g. awarded in error"
          />
        </div>
        <div className="row">
          <button
            className="danger"
            disabled={!roles.isIssuer || !validId || busy}
            onClick={() =>
              send("revoke", "Certificate revoked", (c) =>
                c.revokeCertificate(revokeId.trim(), revokeReason || "revoked")
              )
            }
          >
            {busy === "revoke" ? <><span className="spin" /> …</> : "Revoke"}
          </button>
          {wallet && !roles.isIssuer && (
            <span className="muted small">issuers only</span>
          )}
        </div>
      </div>
    </>
  );
}
