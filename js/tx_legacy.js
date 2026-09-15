// ---------------------------------------------------------------------------
// tx_legacy.js — legacy Solana wire format, used as the automatic fallback
// when the RPC node rejects the SIMD-0385 v1 bytes (no cluster has activated
// the v1 format yet). Same compiled message content, different envelope:
// compact-u16 lengths, signatures at the FRONT, blockhash after accounts.
// ---------------------------------------------------------------------------
'use strict';

function encodeLegacyTransaction({ compiled, recentBlockhash, signers }) {
  const { addresses, header, compiledInstructions } = compiled;

  const message = concatBytes(
    Uint8Array.of(
      header.numRequiredSignatures,
      header.numReadonlySignedAccounts,
      header.numReadonlyUnsignedAccounts,
    ),
    shortvec(addresses.length),
    concatBytes(...addresses),
    recentBlockhash,
    shortvec(compiledInstructions.length),
    concatBytes(...compiledInstructions.map(ix => concatBytes(
      Uint8Array.of(ix.programAccountIndex),
      shortvec(ix.accountIndices.length),
      Uint8Array.from(ix.accountIndices),
      shortvec(ix.data.length),
      ix.data,
    ))),
  );

  const sigs = [];
  for (let i = 0; i < header.numRequiredSignatures; i++) {
    const signer = signers.find(kp => bytesEqual(kp.publicKey, addresses[i]));
    if (!signer) throw new Error(`missing signer for address index ${i}: ${b58encode(addresses[i])}`);
    sigs.push(nacl.sign.detached(message, signer.secretKey));
  }

  return {
    bytes: concatBytes(shortvec(sigs.length), concatBytes(...sigs, new Uint8Array(0)), message),
    txSignature: b58encode(sigs[0]),
  };
}
