// ---------------------------------------------------------------------------
// instructions.js — hand-encoded System / SPL-Token / Memo / ComputeBudget
// instructions, plus account compilation shared by both wire formats.
//
// An instruction here is: { programId: Uint8Array(32),
//                           keys: [{ pubkey, isSigner, isWritable }],
//                           data: Uint8Array }
// ---------------------------------------------------------------------------
'use strict';

const SYSTEM_PROGRAM_ID = b58decode('11111111111111111111111111111111');
const TOKEN_PROGRAM_ID = b58decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MEMO_PROGRAM_ID = b58decode('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const COMPUTE_BUDGET_PROGRAM_ID = b58decode('ComputeBudget111111111111111111111111111111');

const MINT_ACCOUNT_SIZE = 82;
const TOKEN_ACCOUNT_SIZE = 165;

// SystemProgram::CreateAccount — u32 discriminant 0, lamports u64, space u64, owner
function ixCreateAccount(fromPubkey, newAccountPubkey, lamports, space, ownerProgramId) {
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: newAccountPubkey, isSigner: true, isWritable: true },
    ],
    data: concatBytes(u32le(0), u64le(lamports), u64le(space), ownerProgramId),
  };
}

// SPL Token::InitializeMint2 — u8 20, decimals u8, mint_authority, COption freeze
function ixInitializeMint2(mintPubkey, decimals, mintAuthority) {
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: mintPubkey, isSigner: false, isWritable: true }],
    data: concatBytes(Uint8Array.of(20, decimals), mintAuthority, Uint8Array.of(0)), // freeze authority: none
  };
}

// SPL Token::InitializeAccount3 — u8 18, owner pubkey
function ixInitializeAccount3(accountPubkey, mintPubkey, ownerPubkey) {
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: accountPubkey, isSigner: false, isWritable: true },
      { pubkey: mintPubkey, isSigner: false, isWritable: false },
    ],
    data: concatBytes(Uint8Array.of(18), ownerPubkey),
  };
}

// SPL Token::MintTo — u8 7, amount u64
function ixMintTo(mintPubkey, destPubkey, authorityPubkey, amount) {
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mintPubkey, isSigner: false, isWritable: true },
      { pubkey: destPubkey, isSigner: false, isWritable: true },
      { pubkey: authorityPubkey, isSigner: true, isWritable: false },
    ],
    data: concatBytes(Uint8Array.of(7), u64le(amount)),
  };
}

// SPL Token::SetAuthority — u8 6, authority_type u8 (0 = MintTokens),
// COption new authority (null = revoke)
function ixSetMintAuthority(mintPubkey, currentAuthority, newAuthority) {
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mintPubkey, isSigner: false, isWritable: true },
      { pubkey: currentAuthority, isSigner: true, isWritable: false },
    ],
    data: newAuthority
      ? concatBytes(Uint8Array.of(6, 0, 1), newAuthority)
      : Uint8Array.of(6, 0, 0),
  };
}

function ixMemo(text) {
  return { programId: MEMO_PROGRAM_ID, keys: [], data: utf8(text) };
}

// ComputeBudget::SetComputeUnitLimit — u8 2, units u32
function ixSetComputeUnitLimit(units) {
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: concatBytes(Uint8Array.of(2), u32le(units)) };
}

// ComputeBudget::SetComputeUnitPrice — u8 3, micro-lamports per CU u64
function ixSetComputeUnitPrice(microLamports) {
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: concatBytes(Uint8Array.of(3), u64le(microLamports)) };
}

// ---------------------------------------------------------------------------
// Compile the deduplicated, ordered account list + header shared by legacy
// and v1 messages. Ordering per both specs:
//   writable signers (fee payer first) → readonly signers →
//   writable non-signers → readonly non-signers
// ---------------------------------------------------------------------------
function compileAccounts(payerPubkey, instructions) {
  const map = new Map(); // b58 -> { pubkey, signer, writable }
  const add = (pubkey, signer, writable) => {
    const k = b58encode(pubkey);
    const cur = map.get(k);
    if (cur) {
      cur.signer = cur.signer || signer;
      cur.writable = cur.writable || writable;
    } else {
      map.set(k, { pubkey, signer, writable });
    }
  };

  add(payerPubkey, true, true);
  for (const ix of instructions) {
    for (const key of ix.keys) add(key.pubkey, key.isSigner, key.isWritable);
    add(ix.programId, false, false);
  }

  const all = [...map.values()];
  const payerB58 = b58encode(payerPubkey);
  const ws = all.filter(a => a.signer && a.writable);
  const rs = all.filter(a => a.signer && !a.writable);
  const wu = all.filter(a => !a.signer && a.writable);
  const ru = all.filter(a => !a.signer && !a.writable);
  ws.sort((a, b) => (b58encode(a.pubkey) === payerB58 ? -1 : b58encode(b.pubkey) === payerB58 ? 1 : 0));

  const ordered = [...ws, ...rs, ...wu, ...ru];
  const addresses = ordered.map(a => a.pubkey);
  const indexOf = pk => {
    const k = b58encode(pk);
    return ordered.findIndex(a => b58encode(a.pubkey) === k);
  };

  return {
    addresses,
    header: {
      numRequiredSignatures: ws.length + rs.length,
      numReadonlySignedAccounts: rs.length,
      numReadonlyUnsignedAccounts: ru.length,
    },
    compiledInstructions: instructions.map(ix => ({
      programAccountIndex: indexOf(ix.programId),
      accountIndices: ix.keys.map(k => indexOf(k.pubkey)),
      data: ix.data,
    })),
  };
}
