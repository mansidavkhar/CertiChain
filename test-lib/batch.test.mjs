import test from "node:test";
import assert from "node:assert/strict";
import { prepareBatch } from "../lib/batch.mjs";
import { hashCiphertext } from "../lib/certificate.mjs";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

test("batch proofs round-trip and payload metadata is outside ciphertext hash", async () => {
  const result = await prepareBatch([
    { studentId: "S1", name: "A", course: "C", issueDate: "2026-01-01" },
    { studentId: "S2", name: "B", course: "C", issueDate: "2026-01-02" },
  ]);
  assert.equal(result.items.length, 2);
  const tree = StandardMerkleTree.of(
    result.items.map((item) => [item.certId, item.dataHash]),
    ["bytes32", "bytes32"]
  );
  assert.equal(tree.root, result.root);
  result.items.forEach((item, index) => {
    assert.equal(tree.verify([item.certId, item.dataHash], tree.getProof(index)), true);
    assert.equal(item.dataHash, hashCiphertext(item.ciphertext));
    assert.deepEqual(item.payload.proof, item.proof);
    assert.equal(item.payload.batchRoot, result.root);
  });
});
