import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { packageCertificate } from "./certificate.mjs";
import { pinJSON } from "./ipfs.mjs";

/**
 * Encrypt every item before building the tree. Proof metadata is added after
 * hashing, so dataHash remains the digest of ciphertext only.
 */
export async function prepareBatch(inputs, scheme) {
  const packaged = await Promise.all(inputs.map((input) => packageCertificate(input, scheme)));
  const tree = StandardMerkleTree.of(
    packaged.map(({ certId, dataHash }) => [certId, dataHash]),
    ["bytes32", "bytes32"]
  );
  return {
    root: tree.root,
    items: packaged.map((item, index) => ({
      ...item,
      proof: tree.getProof(index),
      payload: { ...item.payload, batchRoot: tree.root, proof: tree.getProof(index) },
    })),
  };
}

export async function pinBatch(inputs, scheme, jwt, name = "certchain-batch") {
  const prepared = await prepareBatch(inputs, scheme);
  const items = [];
  for (let i = 0; i < prepared.items.length; i++) {
    const item = prepared.items[i];
    const cid = await pinJSON(item.payload, jwt, `${name}-${i + 1}`);
    items.push({ ...item, cid });
  }
  return { root: prepared.root, items };
}
