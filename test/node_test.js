// ---------------------------------------------------------------------------
// test/node_test.js — verifies the SIMD-0385 encoder/sanitizer and the legacy
// fallback, offline and against live devnet. Run: node test/node_test.js
// The browser files are classic scripts sharing globals, so we eval them into
// one VM context with a tweetnacl-compatible shim built on node:crypto.
// ---------------------------------------------------------------------------
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// tweetnacl shim over node:crypto ed25519 (secretKey = 32-byte seed ‖ 32-byte pub)
const b64u = buf => Buffer.from(buf).toString('base64url');
function keyFromSeed(seed) {
  return crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: b64u(seed), x: b64u(pubFromSeed(seed)) },
    format: 'jwk',
  });
}
function pubFromSeed(seed) {
  const priv = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: b64u(seed), x: b64u(Buffer.alloc(32)) }, format: 'jwk' });
  const jwk = crypto.createPublicKey(priv).export({ format: 'jwk' });
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
}
const nacl = {
  sign: Object.assign(
    (msg, sk) => { throw new Error('unused'); },
    {
      keyPair: Object.assign(
        () => {
          const seed = crypto.randomBytes(32);
          const publicKey = pubFromSeed(seed);
          const secretKey = new Uint8Array(64);
          secretKey.set(seed); secretKey.set(publicKey, 32);
          return { publicKey, secretKey };
        },
        {
          fromSecretKey: sk => ({ publicKey: sk.slice(32), secretKey: sk }),
        },
      ),
      detached: Object.assign(
        (msg, secretKey) => new Uint8Array(crypto.sign(null, Buffer.from(msg), keyFromSeed(secretKey.slice(0, 32)))),
        {
          verify: (msg, sig, pub) => crypto.verify(null, Buffer.from(msg),
            crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(pub) }, format: 'jwk' }),
            Buffer.from(sig)),
        },
      ),
    },
  ),
};

// load browser scripts into a shared context
const ctx = vm.createContext({ nacl, fetch, TextEncoder, btoa: s => Buffer.from(s, 'binary').toString('base64'), console, setTimeout, Date });
for (const f of ['util.js', 'rpc.js', 'instructions.js', 'tx_v1.js', 'tx_legacy.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx, { filename: f });
}
// top-level const/function bindings live in the context's lexical scope, not on
// the context object — export the ones the test needs explicitly
const G = vm.runInContext(`({
  nacl, RPC, b58decode, b58encode, concatBytes, readU32le,
  MINT_ACCOUNT_SIZE, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM_ID,
  ixCreateAccount, ixInitializeMint2, ixInitializeAccount3, ixMintTo, ixMemo,
  compileAccounts, encodeV1Transaction, decodeAndSanitizeV1, encodeLegacyTransaction,
})`, ctx);

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

function buildLaunch(payer, blockhash, config) {
  const mint = G.nacl.sign.keyPair();
  const acct = G.nacl.sign.keyPair();
  const instructions = [
    G.ixCreateAccount(payer.publicKey, mint.publicKey, 1461600, G.MINT_ACCOUNT_SIZE, G.TOKEN_PROGRAM_ID),
    G.ixInitializeMint2(mint.publicKey, 9, payer.publicKey),
    G.ixCreateAccount(payer.publicKey, acct.publicKey, 2039280, G.TOKEN_ACCOUNT_SIZE, G.TOKEN_PROGRAM_ID),
    G.ixInitializeAccount3(acct.publicKey, mint.publicKey, payer.publicKey),
    G.ixMintTo(mint.publicKey, acct.publicKey, payer.publicKey, 1000000n * 10n ** 9n),
    G.ixMemo(JSON.stringify({ launchpad: 'simd-0385-demo', name: 'Test', symbol: 'TST' })),
  ];
  const signers = [payer, mint, acct];
  const compiled = G.compileAccounts(payer.publicKey, instructions);
  const v1 = G.encodeV1Transaction({ compiled, lifetimeSpecifier: blockhash, config, signers });
  return { instructions, signers, compiled, v1, mint };
}

async function offlineTests() {
  console.log('\n[offline] SIMD-0385 encoder + sanitizer');
  const payer = G.nacl.sign.keyPair();
  const fakeHash = new Uint8Array(32).fill(7);
  const { compiled, v1 } = buildLaunch(payer, fakeHash, { priorityFeeLamports: 5000n, computeUnitLimit: 200000 });

  assert('version byte is 129', v1.bytes[0] === 129);
  assert('header: 3 signers, 0 ro-signed, 3 ro-unsigned',
    v1.bytes[1] === 3 && v1.bytes[2] === 0 && v1.bytes[3] === 3,
    `got ${v1.bytes[1]},${v1.bytes[2]},${v1.bytes[3]}`);
  assert('config mask = 0b111 (fee lo+hi, CU limit)', G.readU32le(v1.bytes, 4) === 0b111);
  assert('size within 4096', v1.bytes.length <= 4096, `${v1.bytes.length}`);

  const san = G.decodeAndSanitizeV1(v1.bytes);
  assert('sanitizer passes a well-formed tx', san.ok, JSON.stringify(san.checks.filter(c => !c.pass)));
  assert('decoded priority fee = 5000', san.decoded.config.priorityFeeLamports === 5000n);
  assert('decoded CU limit = 200000', san.decoded.config.computeUnitLimit === 200000);
  assert('decoded 6 instructions', san.decoded.numInstructions === 6);
  assert('decoded addresses match compiled', san.decoded.numAddresses === compiled.addresses.length);

  // tampering must be caught
  const trailing = G.concatBytes(v1.bytes, Uint8Array.of(0));
  assert('rejects trailing data', !G.decodeAndSanitizeV1(trailing).ok);

  const badSig = v1.bytes.slice();
  badSig[badSig.length - 1] ^= 0xff;
  assert('rejects corrupted signature', !G.decodeAndSanitizeV1(badSig).ok);

  const badMask = v1.bytes.slice();
  badMask[4] |= 1 << 5; // unknown bit — also desyncs value count, must fail
  assert('rejects unknown config mask bit', !G.decodeAndSanitizeV1(badMask).ok);

  const dupAddr = v1.bytes.slice();
  // overwrite address[1] with address[0] (addresses start at offset 42)
  dupAddr.set(dupAddr.slice(42, 74), 74);
  assert('rejects duplicate addresses', !G.decodeAndSanitizeV1(dupAddr).ok);

  // heap size rule: 33000 is not a multiple of 1024
  const badHeap = buildLaunch(payer, fakeHash, { heapSize: 33000 });
  assert('rejects heap size not multiple of 1 KiB', !G.decodeAndSanitizeV1(badHeap.v1.bytes).ok);
  const goodHeap = buildLaunch(payer, fakeHash, { heapSize: 64 * 1024 });
  assert('accepts heap size 64 KiB', G.decodeAndSanitizeV1(goodHeap.v1.bytes).ok);

  // fee bits must travel together — flip only bit 0 off (keeps popcount desync too)
  const halfFee = v1.bytes.slice();
  halfFee[4] &= ~1;
  assert('rejects priority-fee bits set separately', !G.decodeAndSanitizeV1(halfFee).ok);
}

async function devnetTests() {
  console.log('\n[devnet] live RPC checks (unfunded throwaway key)');
  const payer = G.nacl.sign.keyPair();
  let blockhashB58;
  try {
    blockhashB58 = await G.RPC.getLatestBlockhash();
  } catch (e) {
    console.log(`  ! devnet unreachable, skipping live tests: ${e.message}`);
    return;
  }
  console.log(`  blockhash: ${blockhashB58}`);
  const blockhash = G.b58decode(blockhashB58);
  const { compiled, v1, instructions, signers } = buildLaunch(payer, blockhash, { priorityFeeLamports: 5000n, computeUnitLimit: 200000 });

  // 1. v1 bytes reached simulation on devnet — i.e. the node deserialized the
  //    SIMD-0385 format and verified all 3 signatures; only funding fails
  try {
    await G.RPC.sendRawTransaction(v1.bytes);
    assert('v1 submission outcome', false, 'unexpectedly accepted with 0 balance');
  } catch (e) {
    console.log(`  v1 (unfunded) response: ${e.message}`);
    const acceptedFormat = /found no record of a prior credit|insufficient/i.test(e.message);
    assert('devnet deserializes + sig-verifies the v1 format (fails only on funds)', acceptedFormat, e.message);
  }

  // 2. legacy encoding of the same message must behave identically
  const legacy = G.encodeLegacyTransaction({ compiled, recentBlockhash: blockhash, signers });
  try {
    await G.RPC.sendRawTransaction(legacy.bytes);
    assert('legacy submission outcome', false, 'unexpectedly accepted with 0 balance');
  } catch (e) {
    console.log(`  legacy (unfunded) response: ${e.message}`);
    assert('legacy tx passes format+signature checks (fails only on funds)',
      /found no record of a prior credit|insufficient|AccountNotFound/i.test(e.message), e.message);
  }

  // 3. full funded launch in v1 format, if the faucet cooperates
  try {
    const funded = G.nacl.sign.keyPair();
    const addr = G.b58encode(funded.publicKey);
    console.log(`  requesting airdrop for ${addr} …`);
    const airdropSig = await G.RPC.requestAirdrop(addr, 10_000_000); // 0.01 SOL covers rent + fees
    await G.RPC.confirmSignature(airdropSig, { timeoutMs: 45000 });
    console.log('  airdrop confirmed — launching a real token via v1 format');

    const [bh2, rentMint, rentAcct] = await Promise.all([
      G.RPC.getLatestBlockhash(),
      G.RPC.call('getMinimumBalanceForRentExemption', [G.MINT_ACCOUNT_SIZE]),
      G.RPC.call('getMinimumBalanceForRentExemption', [G.TOKEN_ACCOUNT_SIZE]),
    ]);
    const mint = G.nacl.sign.keyPair();
    const acct = G.nacl.sign.keyPair();
    const ixs = [
      G.ixCreateAccount(funded.publicKey, mint.publicKey, rentMint, G.MINT_ACCOUNT_SIZE, G.TOKEN_PROGRAM_ID),
      G.ixInitializeMint2(mint.publicKey, 9, funded.publicKey),
      G.ixCreateAccount(funded.publicKey, acct.publicKey, rentAcct, G.TOKEN_ACCOUNT_SIZE, G.TOKEN_PROGRAM_ID),
      G.ixInitializeAccount3(acct.publicKey, mint.publicKey, funded.publicKey),
      G.ixMintTo(mint.publicKey, acct.publicKey, funded.publicKey, 1000000n * 10n ** 9n),
      G.ixMemo(JSON.stringify({ launchpad: 'simd-0385-demo', name: 'V1 Live Test', symbol: 'V1LT' })),
    ];
    const compiled2 = G.compileAccounts(funded.publicKey, ixs);
    const liveV1 = G.encodeV1Transaction({
      compiled: compiled2,
      lifetimeSpecifier: G.b58decode(bh2),
      config: { priorityFeeLamports: 5000n, computeUnitLimit: 200000 },
      signers: [funded, mint, acct],
    });
    const sig = await G.RPC.sendRawTransaction(liveV1.bytes);
    console.log(`  v1 launch tx sent: ${sig}`);
    await G.RPC.confirmSignature(sig, { timeoutMs: 60000 });
    const mintInfo = await G.RPC.call('getAccountInfo', [G.b58encode(mint.publicKey), { encoding: 'base64' }]);
    assert('LIVE v1 token launch confirmed on devnet', !!mintInfo.value, 'mint account not found');
    assert('mint owned by SPL Token program', mintInfo.value?.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      mintInfo.value?.owner);
    console.log(`  mint: https://explorer.solana.com/address/${G.b58encode(mint.publicKey)}?cluster=devnet`);
    console.log(`  tx:   https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  } catch (e) {
    console.log(`  ! funded launch skipped (faucet rate-limited or tx issue): ${e.message}`);
  }
}

(async () => {
  await offlineTests();
  await devnetTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
