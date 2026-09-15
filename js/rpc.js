// ---------------------------------------------------------------------------
// rpc.js — minimal Solana JSON-RPC client over fetch (no web3.js)
// ---------------------------------------------------------------------------
'use strict';

const RPC = {
  endpoint: (typeof localStorage !== 'undefined' && localStorage.getItem('v1-rpc')) || 'https://api.devnet.solana.com',
  _id: 0,

  async call(method, params = []) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this._id, method, params }),
      });
      if (res.status === 429 && attempt < 4) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
      const json = await res.json();
      if (json.error) {
        const err = new Error(json.error.message || JSON.stringify(json.error));
        err.rpcError = json.error;
        throw err;
      }
      return json.result;
    }
  },

  async getLatestBlockhash() {
    const r = await this.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return r.value.blockhash;
  },

  async getBalance(pubkeyB58) {
    const r = await this.call('getBalance', [pubkeyB58, { commitment: 'confirmed' }]);
    return r.value; // lamports
  },

  async getMinimumBalanceForRentExemption(space) {
    return this.call('getMinimumBalanceForRentExemption', [space]);
  },

  async requestAirdrop(pubkeyB58, lamports) {
    return this.call('requestAirdrop', [pubkeyB58, lamports]);
  },

  // Submit raw transaction bytes (any wire format — this is where a v1
  // transaction gets accepted or rejected by the node).
  async sendRawTransaction(bytes, { skipPreflight = false } = {}) {
    return this.call('sendTransaction', [
      bytesToBase64(bytes),
      { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed', maxRetries: 3 },
    ]);
  },

  async getSignatureStatus(sig) {
    const r = await this.call('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
    return r.value[0]; // null | {confirmationStatus, err, ...}
  },

  // Poll until the signature is confirmed/finalized or errors out.
  async confirmSignature(sig, { timeoutMs = 60000, onTick = () => {} } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const st = await this.getSignatureStatus(sig);
      if (st) {
        if (st.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(st.err)}`);
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return st;
      }
      onTick(st);
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`timed out waiting for confirmation of ${sig}`);
  },
};
