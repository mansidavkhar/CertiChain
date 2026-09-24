/**
 * Wallet and contract plumbing.
 *
 * Two distinct ways of reaching the chain, and the difference matters:
 *
 *   getReadOnlyContract()  — a plain JSON-RPC provider. No wallet, no
 *                            extension, no account. This is what the Verify
 *                            page uses, which is why an employer can check a
 *                            certificate on a phone with nothing installed.
 *
 *   getSignerContract()    — goes through MetaMask. Only the Issue and Admin
 *                            pages need it, because only they write.
 */

import { BrowserProvider, JsonRpcProvider, Contract } from "ethers";
import deployment from "../contract.json";

/**
 * Each chain carries several RPC endpoints rather than one.
 *
 * Public RPC endpoints are shared infrastructure: they rate-limit, go down,
 * and are sometimes unreachable from a particular network or ISP entirely
 * (DNS for rpc-amoy.polygon.technology fails on some Indian connections, for
 * instance). One hardcoded endpoint therefore means the dApp simply does not
 * work for some users, with no recourse.
 *
 * To force a specific endpoint — your own Alchemy or Infura URL, say — set
 * VITE_RPC_URL in frontend/.env.local and it takes priority over everything
 * below. Restart the dev server afterwards; Vite reads env files at startup,
 * so a browser refresh alone will not pick up the change.
 */
export const CHAINS = {
  80002: {
    name: "Polygon Amoy",
    rpcs: [
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://rpc-amoy.polygon.technology",
      "https://rpc.ankr.com/polygon_amoy",
      "https://polygon-amoy.drpc.org",
    ],
    explorer: "https://amoy.polygonscan.com",
    currency: { name: "POL", symbol: "POL", decimals: 18 },
  },
  11155111: {
    name: "Sepolia",
    rpcs: [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://rpc.sepolia.org",
      "https://sepolia.drpc.org",
    ],
    explorer: "https://sepolia.etherscan.io",
    currency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  },
  31337: {
    name: "Hardhat (local)",
    rpcs: ["http://127.0.0.1:8545"],
    explorer: null,
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
};

export const TARGET_CHAIN_ID = deployment.chainId;
export const CONTRACT_ADDRESS = deployment.address;
export const chainInfo = CHAINS[TARGET_CHAIN_ID] ?? {
  name: `chain ${TARGET_CHAIN_ID}`,
  rpc: null,
  explorer: null,
};

export function txUrl(hash) {
  return chainInfo.explorer ? `${chainInfo.explorer}/tx/${hash}` : null;
}

export function addressUrl(addr) {
  return chainInfo.explorer ? `${chainInfo.explorer}/address/${addr}` : null;
}

/** Endpoints to try, with any explicit override first. */
const RPC_ENDPOINTS = [
  import.meta.env.VITE_RPC_URL,
  ...(chainInfo.rpcs ?? []),
].filter(Boolean);

let cachedContract = null;

/**
 * Read-only contract. Needs no wallet at all.
 *
 * Races every endpoint and keeps the first that answers with the right chain
 * id, then caches it for the rest of the session. Racing rather than trying
 * each in turn matters: a dead endpoint usually hangs until it times out
 * rather than failing fast, so sequential attempts would leave the user
 * staring at a spinner for however long the slowest one takes.
 *
 * Checking the chain id is not paranoia — an endpoint that quietly serves a
 * different network would report every certificate as "not found", which
 * looks exactly like a forged certificate. Better to reject the endpoint.
 */
export async function getReadOnlyContract() {
  if (cachedContract) return cachedContract;

  if (RPC_ENDPOINTS.length === 0) {
    throw new Error(`No RPC endpoint configured for chain ${TARGET_CHAIN_ID}.`);
  }

  const failures = [];
  const attempts = RPC_ENDPOINTS.map(async (url) => {
    const provider = new JsonRpcProvider(url, TARGET_CHAIN_ID, {
      staticNetwork: true, // no chainId round-trip on every later call
    });
    try {
      const id = Number((await provider.getNetwork()).chainId);
      if (id !== TARGET_CHAIN_ID) {
        throw new Error(`serves chain ${id}, expected ${TARGET_CHAIN_ID}`);
      }
      return provider;
    } catch (e) {
      failures.push(`${url} — ${e.shortMessage ?? e.message}`);
      throw e;
    }
  });

  let provider;
  try {
    provider = await Promise.any(attempts);
  } catch {
    throw new Error(
      `Could not reach ${chainInfo.name}. Tried:\n${failures.join("\n")}\n\n` +
        `Public RPC endpoints are shared and sometimes blocked by an ISP. ` +
        `Set VITE_RPC_URL in frontend/.env.local to an endpoint that works ` +
        `for you (the same one as AMOY_RPC_URL in .env is a good start), then ` +
        `restart the dev server.`
    );
  }

  cachedContract = new Contract(CONTRACT_ADDRESS, deployment.abi, provider);
  return cachedContract;
}

export function hasWallet() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

/**
 * Connect MetaMask and make sure it is on the right network, prompting to add
 * the chain if the user does not have it yet.
 */
export async function connectWallet() {
  if (!hasWallet()) {
    throw new Error(
      "No wallet found. Install the MetaMask extension, then reload."
    );
  }

  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);

  const current = Number((await provider.getNetwork()).chainId);
  if (current !== TARGET_CHAIN_ID) {
    await switchChain();
  }

  // Re-wrap: the provider caches the network it saw at construction time.
  const fresh = new BrowserProvider(window.ethereum);
  const signer = await fresh.getSigner();
  return { provider: fresh, signer, address: await signer.getAddress() };
}

async function switchChain() {
  const hexId = `0x${TARGET_CHAIN_ID.toString(16)}`;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  } catch (e) {
    // 4902 = the wallet does not know this chain yet, so offer to add it.
    if (e.code === 4902 || e.data?.originalError?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: chainInfo.name,
            rpcUrls: [chainInfo.rpc],
            nativeCurrency: chainInfo.currency,
            blockExplorerUrls: chainInfo.explorer ? [chainInfo.explorer] : [],
          },
        ],
      });
    } else {
      throw e;
    }
  }
}

/** Contract bound to the connected wallet, for issuing and revoking. */
export async function getSignerContract() {
  const { signer, address } = await connectWallet();
  return {
    contract: new Contract(CONTRACT_ADDRESS, deployment.abi, signer),
    address,
  };
}

/**
 * MetaMask errors are verbose and nested. Pull out something a person can read.
 */
export function readableError(e) {
  if (e.code === "ACTION_REJECTED" || e.code === 4001) {
    return "You rejected the transaction in MetaMask.";
  }
  // Custom errors from the contract, e.g. "NotIssuer()"
  const custom = e.revert?.name ?? e.message?.match(/custom error '(\w+)/)?.[1];
  if (custom) {
    const explanations = {
      NotIssuer: "This wallet is not whitelisted as an issuer.",
      NotOwner: "Only the contract owner can do that.",
      AlreadyIssued: "A certificate with this id already exists.",
      AlreadyRevoked: "This certificate is already revoked.",
      UnknownCertificate: "No certificate with this id was found.",
      EmptyCid: "The IPFS CID is empty.",
      ZeroHash: "The certificate digest is empty.",
      ZeroCertId: "The certificate id is empty.",
      ZeroAddress: "That address is empty.",
    };
    return explanations[custom] ?? `Rejected by the contract: ${custom}`;
  }
  if (e.message?.includes("insufficient funds")) {
    return `Not enough ${chainInfo.currency?.symbol ?? "gas token"} to pay for the transaction.`;
  }
  return e.shortMessage ?? e.message ?? String(e);
}
