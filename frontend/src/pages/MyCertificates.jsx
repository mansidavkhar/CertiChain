import { useEffect, useState } from "react";
import { connectWallet, getReadOnlyContracts, getSignerContracts, readableError } from "../lib/chain";

export default function MyCertificates() {
  const [wallet, setWallet] = useState("");
  const [tokens, setTokens] = useState([]);
  const [form, setForm] = useState({ id: "", verifier: "", expiresAt: "" });
  const [message, setMessage] = useState("");

  async function load() {
    try {
      const { address } = await connectWallet();
      setWallet(address);
      const { CertificateSBT: sbt } = await getReadOnlyContracts();
      const count = Number(await sbt.balanceOf(address));
      const ids = [];
      for (let i = 0; i < count; i++) ids.push((await sbt.tokenOfOwnerByIndex(address, i)).toString());
      setTokens(ids);
    } catch (e) { setMessage(readableError(e)); }
  }

  async function grant(e) {
    e.preventDefault();
    try {
      const { contracts } = await getSignerContracts();
      const tx = await contracts.AccessManager.grantAccess(
        form.id, form.verifier, Math.floor(new Date(form.expiresAt).getTime() / 1000)
      );
      await tx.wait();
      setMessage("Access granted.");
    } catch (e) { setMessage(readableError(e)); }
  }

  async function revoke() {
    try {
      const { contracts } = await getSignerContracts();
      await (await contracts.AccessManager.revokeAccess(form.id, form.verifier)).wait();
      setMessage("Access revoked.");
    } catch (e) { setMessage(readableError(e)); }
  }

  return <div className="card">
    <h2>My certificates</h2>
    <p className="hint">SBTs are read with tokenOfOwnerByIndex, avoiding public-RPC log range limits.</p>
    <button onClick={load}>{wallet ? "Refresh" : "Connect wallet"}</button>
    {message && <div className="banner error">{message}</div>}
    <ul>{tokens.map((id) => <li key={id} className="mono">
      {id} — <a href={`#/verify?id=${id}`}>Verify</a>
    </li>)}</ul>
    {wallet && <form onSubmit={grant}>
      <label>Certificate id</label><input required value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
      <label>Verifier address</label><input required value={form.verifier} onChange={(e) => setForm({ ...form, verifier: e.target.value })} />
      <label>Expiry</label><input required type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
      <div className="row"><button type="submit">Grant access</button><button type="button" className="secondary" onClick={revoke}>Revoke access</button></div>
    </form>}
  </div>;
}
