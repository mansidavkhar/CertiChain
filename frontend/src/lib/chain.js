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

export const CHAINS = {
  80002: {
    name: "Polygon Amoy",
    rpc: "https://rpc-amoy.polygon.technology",
    explorer: "https://amoy.polygonscan.com",
    currency: { name: "POL", symbol: "POL", decimals: 18 },
  },
  11155111: {
    name: "Sepolia",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    currency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  },
  31337: {
    name: "Hardhat (local)",
    rpc: "http://127.0.0.1:8545",
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

/** Read-only contract. Needs no wallet at all. */
export function getReadOnlyContract() {
  if (!chainInfo.rpc) {
    throw new Error(`No RPC endpoint configured for chain ${TARGET_CHAIN_ID}`);
  }
  const provider = new JsonRpcProvider(chainInfo.rpc, TARGET_CHAIN_ID, {
    staticNetwork: true, // skip the extra chainId round-trip on every call
  });
  return new Contract(CONTRACT_ADDRESS, deployment.abi, provider);
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
