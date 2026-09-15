// ---------------------------------------------------------------------------
// tx_v1.js — SIMD-0385 "Transaction V1 Format" implementation
//
// Wire layout (all fixed-width, little-endian, no padding, no trailing data):
//   VersionByte            u8        = 129
//   LegacyHeader           u8 ×3       num_required_signatures,
//                                       num_readonly_signed_accounts,
//                                       num_readonly_unsigned_accounts
//   TransactionConfigMask  u32 LE      which config requests are present
//   LifetimeSpecifier      [u8;32]     the recent blockhash, renamed
//   NumInstructions        u8
//   NumAddresses           u8
//   Addresses              [[u8;32]]   length = NumAddresses
//   ConfigValues           [[u8;4]]    length = popcount(mask)
//   InstructionHeaders     (u8,u8,u16) × NumInstructions
//   InstructionPayloads    per ix: account indices, then data
//   Signatures             [[u8;64]]   length = num_required_signatures;
//                                      Signatures[i] signs every byte before
//                                      the Signatures field with Addresses[i]
//
// Config mask bits (each set bit ↔ one 4-byte ConfigValues entry, ascending):
//   bits 0+1  priority fee, TOTAL lamports, u64 LE across both entries
//             (both bits MUST be set together)
//   bit 2     compute-unit limit, u32 LE
//   bit 3     loaded accounts data size limit, u32 LE
//   bit 4     heap size, u32 LE — multiple of 1 KiB, in [32 KiB, 256 KiB]
// ---------------------------------------------------------------------------
'use strict';

const V1_VERSION_BYTE = 129;
const V1_MAX_TRANSACTION_SIZE = 4096;
const V1_MAX_SIGNATURES = 12;
const V1_MAX_ACCOUNTS = 64;
const V1_MAX_INSTRUCTIONS = 64;
const V1_KNOWN_CONFIG_BITS = 0b11111; // bits 0..4 assigned by the SIMD

const V1_CONFIG_BITS = {
  PRIORITY_FEE_LO: 0,
  PRIORITY_FEE_HI: 1,
  COMPUTE_UNIT_LIMIT: 2,
  LOADED_ACCOUNTS_DATA_SIZE_LIMIT: 3,
  HEAP_SIZE: 4,
};

function popcount32(n) {
  let c = 0;
  for (let i = 0; i < 32; i++) if ((n >>> i) & 1) c++;
  return c;
}

// config: { priorityFeeLamports?: bigint, computeUnitLimit?: number,
//           loadedAccountsDataSizeLimit?: number, heapSize?: number }
// Returns { mask, values: Uint8Array (4-byte entries in ascending bit order) }
function buildConfigSection(config = {}) {
  let mask = 0;
  const entries = []; // [bit, Uint8Array(4)]

  if (config.priorityFeeLamports !== undefined && config.priorityFeeLamports !== null) {
    const fee = u64le(config.priorityFeeLamports);
    mask |= (1 << V1_CONFIG_BITS.PRIORITY_FEE_LO) | (1 << V1_CONFIG_BITS.PRIORITY_FEE_HI);
    entries.push([V1_CONFIG_BITS.PRIORITY_FEE_LO, fee.slice(0, 4)]);
    entries.push([V1_CONFIG_BITS.PRIORITY_FEE_HI, fee.slice(4, 8)]);
  }
  if (config.computeUnitLimit !== undefined && config.computeUnitLimit !== null) {
    mask |= 1 << V1_CONFIG_BITS.COMPUTE_UNIT_LIMIT;
    entries.push([V1_CONFIG_BITS.COMPUTE_UNIT_LIMIT, u32le(config.computeUnitLimit)]);
  }
  if (config.loadedAccountsDataSizeLimit !== undefined && config.loadedAccountsDataSizeLimit !== null) {
    mask |= 1 << V1_CONFIG_BITS.LOADED_ACCOUNTS_DATA_SIZE_LIMIT;
    entries.push([V1_CONFIG_BITS.LOADED_ACCOUNTS_DATA_SIZE_LIMIT, u32le(config.loadedAccountsDataSizeLimit)]);
  }
  if (config.heapSize !== undefined && config.heapSize !== null) {
    mask |= 1 << V1_CONFIG_BITS.HEAP_SIZE;
    entries.push([V1_CONFIG_BITS.HEAP_SIZE, u32le(config.heapSize)]);
  }

  entries.sort((a, b) => a[0] - b[0]);
  return { mask, values: concatBytes(...entries.map(e => e[1]), new Uint8Array(0)) };
}

// Build + sign a complete v1 transaction.
//   compiled: output of compileAccounts()
//   lifetimeSpecifier: Uint8Array(32) — the recent blockhash
//   config: see buildConfigSection
//   signers: array of nacl keypairs ({ publicKey, secretKey }); must cover
//            Addresses[0..num_required_signatures)
// Returns { bytes, sections } where sections is an annotated byte map for display.
function encodeV1Transaction({ compiled, lifetimeSpecifier, config, signers }) {
  const { addresses, header, compiledInstructions } = compiled;
  const { mask, values } = buildConfigSection(config);

  const sections = [];
  const push = (label, bytes) => {
    sections.push({ label, bytes });
    return bytes;
  };

  const parts = [
    push('VersionByte (129 = v1)', Uint8Array.of(V1_VERSION_BYTE)),
    push('LegacyHeader (req sigs, ro signed, ro unsigned)', Uint8Array.of(
      header.numRequiredSignatures,
      header.numReadonlySignedAccounts,
      header.numReadonlyUnsignedAccounts,
    )),
    push(`TransactionConfigMask (0b${mask.toString(2).padStart(8, '0')})`, u32le(mask)),
    push('LifetimeSpecifier (recent blockhash)', lifetimeSpecifier),
    push('NumInstructions', Uint8Array.of(compiledInstructions.length)),
    push('NumAddresses', Uint8Array.of(addresses.length)),
    push('Addresses', concatBytes(...addresses)),
    push(`ConfigValues (${popcount32(mask)} × 4 bytes)`, values),
    push('InstructionHeaders (program idx u8, n accounts u8, data len u16)',
      concatBytes(...compiledInstructions.map(ix =>
        concatBytes(Uint8Array.of(ix.programAccountIndex, ix.accountIndices.length), u16le(ix.data.length))))),
    push('InstructionPayloads (account indices ‖ data, per instruction)',
      concatBytes(...compiledInstructions.map(ix =>
        concatBytes(Uint8Array.from(ix.accountIndices), ix.data)))),
  ];

  const message = concatBytes(...parts);

  // Signatures[i] signs everything before the Signatures field, with the
  // keypair whose public key is Addresses[i].
  const sigs = [];
  for (let i = 0; i < header.numRequiredSignatures; i++) {
    const signer = signers.find(kp => bytesEqual(kp.publicKey, addresses[i]));
    if (!signer) throw new Error(`missing signer for address index ${i}: ${b58encode(addresses[i])}`);
    sigs.push(nacl.sign.detached(message, signer.secretKey));
  }
  const signatures = push(`Signatures (${sigs.length} × 64)`, concatBytes(...sigs, new Uint8Array(0)));

  return { bytes: concatBytes(message, signatures), sections, txSignature: b58encode(sigs[0]) };
}

// ---------------------------------------------------------------------------
// Decoder + sanitizer: parses raw bytes and enforces every sanitization rule
// in SIMD-0385. Returns { ok, checks: [{rule, pass, detail}], decoded }.
// ---------------------------------------------------------------------------
function decodeAndSanitizeV1(bytes) {
  const checks = [];
  const check = (rule, pass, detail = '') => {
    checks.push({ rule, pass, detail });
    return pass;
  };
  const fail = decoded => ({ ok: false, checks, decoded });

  check('transaction size ≤ 4096 bytes', bytes.length <= V1_MAX_TRANSACTION_SIZE, `${bytes.length} bytes`);
  if (bytes.length < 1 + 3 + 4 + 32 + 2) return fail(null);
  if (!check('version byte is 129 (v1)', bytes[0] === V1_VERSION_BYTE, `got ${bytes[0]}`)) return fail(null);

  let off = 1;
  const header = {
    numRequiredSignatures: bytes[off++],
    numReadonlySignedAccounts: bytes[off++],
    numReadonlyUnsignedAccounts: bytes[off++],
  };
  const mask = readU32le(bytes, off); off += 4;
  const lifetimeSpecifier = bytes.slice(off, off + 32); off += 32;
  const numInstructions = bytes[off++];
  const numAddresses = bytes[off++];

  const addresses = [];
  for (let i = 0; i < numAddresses; i++) {
    addresses.push(bytes.slice(off, off + 32));
    off += 32;
  }

  const numConfigValues = popcount32(mask);
  const configValues = [];
  for (let i = 0; i < numConfigValues; i++) {
    configValues.push(bytes.slice(off, off + 4));
    off += 4;
  }

  const ixHeaders = [];
  for (let i = 0; i < numInstructions; i++) {
    ixHeaders.push({
      programAccountIndex: bytes[off],
      numAccounts: bytes[off + 1],
      dataLen: readU16le(bytes, off + 2),
    });
    off += 4;
  }

  const instructions = [];
  for (const h of ixHeaders) {
    const accountIndices = Array.from(bytes.slice(off, off + h.numAccounts));
    off += h.numAccounts;
    const data = bytes.slice(off, off + h.dataLen);
    off += h.dataLen;
    instructions.push({ ...h, accountIndices, data });
  }

  const signatures = [];
  for (let i = 0; i < header.numRequiredSignatures; i++) {
    signatures.push(bytes.slice(off, off + 64));
    off += 64;
  }

  const decoded = { header, mask, lifetimeSpecifier, numInstructions, numAddresses, addresses, configValues, instructions, signatures };

  // --- sanitization rules from the SIMD ---
  check('no trailing data after signatures', off === bytes.length, `parsed ${off} of ${bytes.length} bytes`);
  check('at least one signature (fee payer)', header.numRequiredSignatures >= 1);
  check('signatures ≤ 12', header.numRequiredSignatures <= V1_MAX_SIGNATURES, `${header.numRequiredSignatures}`);
  check('accounts ≤ 64', numAddresses <= V1_MAX_ACCOUNTS, `${numAddresses}`);
  check('instructions ≤ 64', numInstructions <= V1_MAX_INSTRUCTIONS, `${numInstructions}`);
  check('num_readonly_signed_accounts < num_required_signatures (fee payer stays writable)',
    header.numReadonlySignedAccounts < header.numRequiredSignatures,
    `${header.numReadonlySignedAccounts} vs ${header.numRequiredSignatures}`);
  check('num_addresses ≥ num_required_signatures + num_readonly_unsigned_accounts',
    numAddresses >= header.numRequiredSignatures + header.numReadonlyUnsignedAccounts,
    `${numAddresses} vs ${header.numRequiredSignatures + header.numReadonlyUnsignedAccounts}`);

  const seen = new Set();
  let dup = null;
  for (const a of addresses) {
    const k = toHex(a);
    if (seen.has(k)) { dup = b58encode(a); break; }
    seen.add(k);
  }
  check('no duplicate addresses', dup === null, dup ? `duplicate: ${dup}` : '');

  let badIndex = null;
  for (const ix of instructions) {
    if (ix.programAccountIndex >= numAddresses) badIndex = `program index ${ix.programAccountIndex}`;
    for (const ai of ix.accountIndices) if (ai >= numAddresses) badIndex = `account index ${ai}`;
  }
  check('every instruction account/program index < num_addresses', badIndex === null, badIndex || '');

  check('no unknown config mask bits', (mask & ~V1_KNOWN_CONFIG_BITS) === 0, `mask 0b${mask.toString(2)}`);
  const feeLo = (mask >> V1_CONFIG_BITS.PRIORITY_FEE_LO) & 1;
  const feeHi = (mask >> V1_CONFIG_BITS.PRIORITY_FEE_HI) & 1;
  check('priority-fee bits 0 and 1 set together or not at all', feeLo === feeHi);

  // Interpret config values (entries appear in ascending bit order).
  const cfg = {};
  let vi = 0;
  const takeValue = () => configValues[vi++];
  if (feeLo && feeHi) cfg.priorityFeeLamports = readU64le(concatBytes(takeValue(), takeValue()), 0);
  if ((mask >> V1_CONFIG_BITS.COMPUTE_UNIT_LIMIT) & 1) cfg.computeUnitLimit = readU32le(takeValue(), 0);
  if ((mask >> V1_CONFIG_BITS.LOADED_ACCOUNTS_DATA_SIZE_LIMIT) & 1) cfg.loadedAccountsDataSizeLimit = readU32le(takeValue(), 0);
  if ((mask >> V1_CONFIG_BITS.HEAP_SIZE) & 1) {
    cfg.heapSize = readU32le(takeValue(), 0);
    check('heap size is a multiple of 1 KiB in [32 KiB, 256 KiB]',
      cfg.heapSize % 1024 === 0 && cfg.heapSize >= 32 * 1024 && cfg.heapSize <= 256 * 1024,
      `${cfg.heapSize}`);
  }
  decoded.config = cfg;

  // Verify each signature over the pre-signature bytes against Addresses[i].
  const messageEnd = bytes.length - header.numRequiredSignatures * 64;
  const message = bytes.slice(0, messageEnd);
  let sigOk = true;
  for (let i = 0; i < signatures.length; i++) {
    if (!nacl.sign.detached.verify(message, signatures[i], addresses[i])) sigOk = false;
  }
  check('all signatures verify over the pre-signature bytes', sigOk);

  return { ok: checks.every(c => c.pass), checks, decoded };
}
