import { useState, useEffect } from "react";
import Verify from "./pages/Verify";
import Issue from "./pages/Issue";
import Admin from "./pages/Admin";
import MyCertificates from "./pages/MyCertificates";
import { CONTRACT_ADDRESS, chainInfo, addressUrl, TARGET_CHAIN_ID, hasWallet } from "./lib/chain";

/**
 * Hash-based routing, hand-rolled.
 *
 * Three routes do not justify pulling in a router. Hashes also mean the app
 * works from a plain static host with no server rewrite rules, which matters
 * because the QR codes point at #/verify?… links that must survive a cold
 * load on someone's phone.
 */

const ROUTES = {
  "/verify": { label: "Verify", component: Verify },
  "/issue": { label: "Issue", component: Issue },
  "/admin": { label: "Admin", component: Admin },
  "/mine": { label: "My certificates", component: MyCertificates },
};

function currentPath() {
  const raw = window.location.hash.replace(/^#/, "").split("?")[0];
  return ROUTES[raw] ? raw : "/verify";
}

export default function App() {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const Page = ROUTES[path].component;
  const deployed = CONTRACT_ADDRESS && !/^0x0{40}$/i.test(CONTRACT_ADDRESS);

  return (
    <div className="shell">
      <header>
        <div className="brand">
          <h1>CertChain</h1>
          <span className="sub">
            academic certificates on {chainInfo.name} + IPFS
          </span>
        </div>

        <nav>
          {Object.entries(ROUTES).map(([p, { label }]) => (
            <a key={p} href={`#${p}`} className={p === path ? "active" : ""}>
              {label}
            </a>
          ))}
        </nav>

        <div className="chainbar">
          <span>
            registry{" "}
            {addressUrl(CONTRACT_ADDRESS) ? (
              <a href={addressUrl(CONTRACT_ADDRESS)} target="_blank" rel="noreferrer">
                {CONTRACT_ADDRESS.slice(0, 10)}…{CONTRACT_ADDRESS.slice(-6)}
              </a>
            ) : (
              CONTRACT_ADDRESS
            )}
          </span>
        </div>
      </header>

      {!deployed && (
        <div className="banner error">
          No contract address configured. Deploy first:{" "}
          <span className="mono">
            npx hardhat run scripts/deploy.js --network amoy
          </span>{" "}
          — that writes the address and ABI into{" "}
          <span className="mono">frontend/src/contract.json</span>. Restart the
          dev server afterwards.
        </div>
      )}
      {hasWallet() && window.ethereum?.chainId &&
        Number(window.ethereum.chainId) !== TARGET_CHAIN_ID && (
        <div className="banner error">
          MetaMask is not on Polygon Amoy. Connect or switch networks before writing.
        </div>
      )}

      <Page />

      <footer>
        Mini project implementing Sultana, Rupa, Malleswari and Gadekallu,
        “IPFS-Blockchain Smart Contracts Based Conceptual Framework to Reduce
        Certificate Frauds in the Academic Field”,{" "}
        <em>Information</em> 14(8):446, 2023 —{" "}
        <a
          href="https://doi.org/10.3390/info14080446"
          target="_blank"
          rel="noreferrer"
        >
          doi:10.3390/info14080446
        </a>{" "}
        (CC BY).
      </footer>
    </div>
  );
}
