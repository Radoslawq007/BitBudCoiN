# BitBudCoin (BbC)
## Exchange & Institutional Integration

**Document version:** 1.4 — September 2026
**Chain height at publication:** 102,744
**Author:** Radosław Iwański

---

### Before you read further

This document states known limitations plainly, including several that
may disqualify BbC from listing on your platform. Sections 13 and 15
contain that material. They are not buried at the end as a formality —
read them first if your evaluation is time-boxed.

Every figure here was read from the running node or the source tree. No
number in this document is estimated, projected, or rounded upward.

---

## 01 · Network overview

BitBudCoin is a proof-of-work blockchain written from scratch in
Node.js. It is not a fork of Bitcoin, Litecoin, or any other codebase.
Consensus, networking, wallet, and the BTC bridge were implemented
independently.

| | |
|---|---|
| Network name | BitBudCoin |
| Ticker | BbC |
| Chain ID | 28000000 |
| Software version | 1.0.0 |
| Consensus | SHA-256 proof of work |
| Transaction signatures | Ed25519 |
| Ledger model | Account/balance (not UTXO) |
| Storage | SQLite (WAL, synchronous=FULL) |
| Node count at publication | 3 |
| Public API | `https://141-147-98-57.sslip.io` |
| Repository | `github.com/Radoslawq007/BitBudCoiN` |

The project is developed and operated by one person. There is no
company, foundation, treasury, or funding round behind it.

---

## 02 · Chain parameters & supply

| Parameter | Value |
|---|---|
| Target block time | 480 s (8 minutes) |
| Initial block reward | 50 BbC |
| Halving interval | 210,000 blocks (see emission note below) |
| Blocks until next halving | 107,256 |
| Genesis address | `BbC694f9417395ed990fce2b3c3fe3d756959bf3b1e` |
| Premine | 700 BbC |
| Circulating supply | 5,131,400 BbC |
| Max block size | 1,000,000 bytes |
| Max transactions per block | 5,000 |

### Supply ceiling — read this carefully

The node's `/info` endpoint reports `maxSupply: 28000000`. **That figure
is not the real ceiling and should not be used.**

Geometric PoW emission with a 50 BbC reward halving every 210,000 blocks
sums to exactly 21,000,000 BbC. Adding the 700 BbC premine:

```
PoW emission        21,000,000
premine                    700
─────────────────────────────
true maximum supply 21,000,700
```

The `28,000,000` constant in `config.js` is a cap that is set above what
emission can ever reach. **6,999,300 BbC of that figure will never
exist.** Use **21,000,700** for any supply calculation, listing form, or
market-cap methodology.

The premine of 700 BbC (0.0033% of final supply) was allocated to the
mining pool operating address `BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7`
and is used for pool payout float.

### Emission has not been uniform

At the target block time of 480 s, 210,000 blocks would take roughly
3.19 years. **Historical issuance ran considerably faster than that.**

Before ASERT activated at height 100,000, the legacy retarget interval of
2,028 blocks could not keep pace with hashrate changes. Several days in
August 2026 produced blocks at intervals of five to ten seconds:

| Date | Blocks in 24 h | Effective interval |
|---|---|---|
| 2026-08-04 | 18,496 | ~5 s |
| 2026-08-23 | 16,205 | ~5 s |
| 2026-08-09 | 13,532 | ~6 s |
| 2026-08-03 | 9,401 | ~9 s |
| 2026-08-02 | 8,667 | ~10 s |

The chain reached height 103,000 in 251 days rather than the ~5.7 years
uniform 480 s blocks would imply. Circulating supply is consequently
5,131,400 BbC — roughly 24% of the 21,000,700 ceiling — within the first
year.

Since ASERT activation the rate has held at target: 184 blocks per day
measured over the last two weeks, against a target of 180. The first
halving is now projected at approximately 1,141 days from now, close to
the 1,167 days uniform target blocks would give.

Any analysis of BbC emission should use block height, not elapsed time.

---

## 03 · Consensus & difficulty

SHA-256 proof of work. A block is valid when its hash is numerically
below the target, where `target = (2^256 - 1) / difficulty`.

Difficulty retargeting has two regimes:

**Below height 100,000 — legacy DAA.** Retarget every 2,028 blocks.

**From height 100,000 — ASERT (vMax).** Active on mainnet now.

| ASERT parameter | Value |
|---|---|
| Activation height | 100,000 |
| Anchor height | 99,999 |
| Ideal block time | 480 s |
| Half-life | 3,600 s (1 hour) |
| Integer-only arithmetic | yes |
| Legacy DAA after activation | disabled |
| Emergency adjustment | disabled |

ASERT is fully deterministic: difficulty for any block is a pure
function of the anchor and the block's timestamp. Two nodes with the
same chain always compute the same value.

Current network difficulty: **811,976,546**

---

## 04 · Finality & confirmation policy

### There is no protocol-level finality rule

BbC does **not** define a maximum reorganisation depth. There is no
`MAX_REORG_DEPTH` constant and no checkpointing. An integrating platform
must choose its own confirmation threshold; the protocol will not
enforce one.

### Chain selection is by length, not by cumulative work

`replaceChain()` accepts a candidate chain when it is **longer** than
the current chain. Cumulative work is never computed anywhere in the
codebase.

This differs from Bitcoin, which selects on most-cumulative-work
specifically because length is exploitable when difficulty varies. See
section 13.

### Signature enforcement

Every `transfer` in a block at or above height 3,070 must carry a valid
Ed25519 signature, verified on both the single-block and full-chain
paths. See section 14 for why the threshold exists and what lies below
it.

### Timestamp rules

| Rule | Value |
|---|---|
| Must be strictly later than previous block | enforced |
| Maximum drift ahead of node clock | 10,000 ms |

The 10-second future limit is far tighter than Bitcoin's 2 hours. It is
enforced on both single-block receipt and full-chain replacement.

### Suggested confirmation depth

Given ~1.7 MH/s of network hashrate (section 13), no confirmation count
provides economic finality against a motivated attacker. If you list
BbC, set deposit confirmations based on your own risk tolerance and
exposure limit, not on a number this document could supply honestly.

---

## 05 · Address format & validation

```
BbC + 40 hexadecimal characters
```

Derivation: the network prefix concatenated with the first 40 characters
of the SHA-256 hash of the public key.

| Network | Prefix | Example | Length |
|---|---|---|---|
| Mainnet | `BbC` | `BbC694f94…` | 43 |
| Testnet | `tBbC` | `tBbCcbcfc…` | 44 |

Validation regex, used identically in every component:

```
/^t?BbC[0-9a-fA-F]{40}$/
```

The 40 hex characters derive from the key alone, not from the network.
The same key therefore produces the same hex on both networks; only the
prefix differs.

### Checksum — case-encoded, EIP-55 style

Addresses carry an optional checksum encoded in the **letter case** of
the hexadecimal portion, using the scheme Ethereum adopted in EIP-55 for
the same retrofit problem. The address characters themselves do not
change; only which of the letters `a`–`f` are uppercase.

```
lowercase input   BbC98a0eea6c7ffd31066fa670c3e415fe6631a35ca
checksummed       BbC98a0eea6c7FfD31066FA670c3E415FE6631A35Ca
```

Algorithm: take the 40 hex characters in lowercase, compute
`SHA-256` over that string, and for each position where the character is
a letter, uppercase it when the corresponding nibble of the hash is
`>= 8`.

Reference implementations, byte-identical in output:

| Implementation | Location |
|---|---|
| Node | `backend/address-checksum.js` |
| Browser | `frontend/assets/address-checksum-frontend.js` |

Both were verified to agree across 300 randomly generated addresses.

### Three validation states

| State | Meaning | Action |
|---|---|---|
| `valid` | checksum matches | accept |
| `invalid` | checksum does not match — a typo | **reject** |
| `legacy` | all-lowercase or all-uppercase; carries no case information | accept, unprotected |

The three-state model exists because "no checksum present" is not the
same condition as "checksum is wrong". Every address created before
September 2026 is all-lowercase and therefore `legacy`. Rejecting those
would strand every existing holder, so they are accepted without
protection. Only an explicitly wrong checksum is rejected, because that
is always an error and never an intention.

### Measured typo detection

Across 3,000 randomly generated single-character corruptions of
checksummed addresses:

```
typos tested     3,000
detected         2,998   (99.9%)
passed undetected    2
```

Detection is not absolute. Checksum information is carried only by the
letters `a`–`f`; an address composed largely of digits carries weaker
protection. Ethereum has the identical limitation. **Do not treat a
`valid` result as a guarantee** — treat it as removing the overwhelming
majority of an otherwise unmitigated risk.

### Where the checksum is enforced today

Enforcement is currently in the **reference wallet only**. Pasting an
address with a broken checksum blocks the send before signing.

The consensus layer does **not** enforce checksums. The network-level
regex accepts any case combination, exactly as it did before, so no
consensus change was made and there is no fork risk. A node will accept
a transaction to an address with a wrong checksum if something other
than the reference wallet submits it.

If your platform accepts user-entered BbC addresses, **implement the
check on your side** using either reference implementation above. Do not
rely on the network to reject a mistyped address; it will not.

### Network normalisation — required reading for integrators

Balances are keyed by the raw address string. `BbCabc…` and `BbCAbC…`
would be two distinct accounts.

**Always transmit addresses to the network in all-lowercase form.** Use
`toNetworkForm()` (Node) or `bbcToNetworkForm()` (browser) before
signing, since the signature covers the `to` field. The checksummed form
is for display and user input only, never for the wire.

The entire existing chain — genesis, the pool address, and all 27,884
transfers — is all-lowercase, so this normalisation is backward
compatible with every record in the chain.

## 06 · Block & transaction format

### Block

```json
{
  "height": 102744,
  "timestamp": 1788791792206,
  "previousHash": "0000...",
  "hash": "00000000497...",
  "nonce": 48211,
  "difficulty": 811976546,
  "transactions": [ ... ]
}
```

`timestamp` is milliseconds since epoch.

### Transaction

```json
{
  "from": "BbC...",
  "to": "BbC...",
  "amount": 10,
  "fee": 0.001,
  "timestamp": 1788790000000,
  "type": "transfer",
  "publicKey": "...",
  "signature": "base64",
  "txid": "sha256 hex"
}
```

### Transaction types in the live chain

| Type | Count | Signed |
|---|---|---|
| `coinbase` | 102,612 | no |
| `transfer` | 27,884 | yes |
| `fee` | 8,231 | no |
| `protocol_fee` | 7,283 | no |
| `HTLC_CREATE` | 15 | yes |
| `HTLC_CLAIM` | 1 | yes |
| `genesis` | 1 | no |

### txid

```
txid = SHA256(JSON{from, to, amount, fee, timestamp})
```

The signature is deliberately **not** part of the txid, so signing does
not change the identifier.

### Signing payload

```
JSON.stringify({from, to, amount, fee, timestamp})
```

Signed with Ed25519. Field order is significant and must be exactly as
listed.

Note that the payload contains **no nonce, no chain identifier, and no
expiry**. See section 13.

---

## 07 · Node deployment

Requirements: Node.js v22+, SQLite, roughly 300 MB RAM at current chain
height, and TCP port 6001 reachable for P2P.

```bash
git clone https://github.com/Radoslawq007/BitBudCoiN
cd BitBudCoiN/backend
npm install
node server.js
```

`config.js` must be byte-identical across all connected peers. Genesis
address, block time, halving interval, and ASERT parameters are
consensus-critical.

### A full node cannot sync from genesis

**Read section 15 before deploying.** The canonical chain has 129
missing blocks, and full-chain synchronisation rejects any chain whose
block heights are not contiguous. A new node must be bootstrapped from a
database snapshot; it cannot build the chain from the network.

Contact us for a current snapshot.

---

## 08 · HTTP API

There is no JSON-RPC interface. All access is over HTTP.

### Chain

| Endpoint | Purpose |
|---|---|
| `GET /info` | Network status, height, difficulty, supply, peers |
| `GET /blocks` | Block list |
| `GET /blocks/:height` | Single block |
| `GET /state` | Chain state |
| `GET /events` | Server-sent events stream |

### Accounts

| Endpoint | Purpose |
|---|---|
| `GET /balance/:address` | Address balance |
| `GET /transactions/address/:address` | Address transaction history |
| `POST /transactions/send` | Submit a signed transaction |

### Network

| Endpoint | Purpose |
|---|---|
| `GET /peers` | Connected and configured peers |
| `POST /peers/connect` | Add a peer |
| `GET /network/addresses` | Known addresses |
| `GET /network/miners` | Active miners |

### Mining

`GET /pool/work`, `POST /pool/submit`, `GET /pool/status`,
`GET /pool/credits/:address`, `GET /solo/work`, `POST /solo/submit`,
`POST /solo/heartbeat`, `POST /mine/start`

### Atomic swap

`GET /swap/offers`, `GET /swap/offers/:id`, `POST /swap/offers`,
`POST /swap/offers/:id/accept`, `POST /swap/offers/:id/reject`,
`POST /htlc/submit`, `GET /htlc/:id`

### `/info` reports `isValid` — do not rely on it

The `isValid` field in `/info` is a hardcoded literal `true`. It
performs no validation and would report `true` on a corrupt chain. It is
retained only for response-shape compatibility and will be removed or
made real in a future release. Ignore it.

---

## 09 · Wallet integration

Private keys are Ed25519. The reference wallet is browser-based; keys
are generated in the browser and never transmitted. A 12-word mnemonic
phrase deterministically regenerates the same keypair.

To construct a transaction:

1. Build `{from, to, amount, fee, timestamp}`
2. Serialise with `JSON.stringify` — field order exactly as above
3. Sign with Ed25519, encode the signature base64
4. `POST /transactions/send` with the signed object plus `publicKey`

Signature verification also confirms that the address derived from
`publicKey` equals `from`. A signature valid for a different address
will be rejected.

---

## 10 · Deposit & withdrawal flow

### Deposits

Poll `GET /balance/:address`, or subscribe to `GET /events`. Match
incoming transfers by `txid`. Apply your chosen confirmation depth
(section 04).

### Withdrawals

Sign locally and submit to `POST /transactions/send`. The response
carries acceptance or a rejection reason.

Rejections you should handle:

| Reason | Meaning |
|---|---|
| `Nieprawidłowy podpis` | signature does not verify |
| `Opłata poniżej minimalnej` | fee below `MIN_FEE` |
| `Nieprawidlowy format adresu odbiorcy` | recipient fails the address regex |
| — | note: a wrong **checksum** is not rejected by the node; see section 05 |
| `Ta transakcja już jest w mempoolu` | duplicate, still pending |
| `Ta transakcja już jest w łańcuchu (powtórzenie)` | duplicate, already mined |

Error strings are Polish. English error codes are not yet implemented.

### Address reuse and replay

Until September 2026, a signed transaction already included in the chain
could be resubmitted and would transfer funds a second time. This was
found and fixed; see section 14. Any integration must run node software
dated after that fix.

---

## 11 · Fees

| Parameter | Value |
|---|---|
| Minimum fee | 0.001 BbC |
| Protocol fee | 2% of transfer amount |
| Protocol fee active from height | 1,716 |
| Pool fee | 2% of block reward |

The protocol fee is deducted from the credited amount: a recipient of a
100 BbC transfer receives 98 BbC. **Account for this when crediting
deposits** — the amount credited on-chain is not the amount sent.

The `fee` field is separate and goes to the miner.

---

## 12 · Explorer & tooling

Block explorer: `https://radoslawq007.github.io/BitBudCoiN/explorer.html`

Supports lookup by height and by address, and shows per-block
transactions. There is no third-party explorer.

For support and dispute resolution, `GET /transactions/address/:address`
returns full address history in JSON.

---

## 13 · Security model & known limitations

### 51% attack cost

This is the section that will decide your evaluation.

```
network difficulty        811,976,546
target block time                480 s
network hashrate      ≈    1.7 MH/s
```

Since `target = (2^256 − 1) / difficulty`, expected hashes per block
equal the difficulty. Network hashrate is therefore difficulty divided
by block time.

**One current-generation SHA-256 ASIC (~100 TH/s) is approximately
59,000,000 times the entire BbC network.** Majority hashrate can be
acquired for a rounding error on any hashpower rental market. There is
no merge-mining, no checkpointing, and no alternative finality
mechanism.

We state this plainly because you would calculate it in five minutes
anyway, and because BbC does not claim security it does not have.

### Chain selection by length

As noted in section 04, `replaceChain()` selects on chain length rather
than cumulative work. Combined with per-block difficulty adjustment,
this is a weaker rule than Bitcoin's. The timestamp bounds in section 04
close the most direct exploitation path, but the underlying selection
rule has not been changed to cumulative work.

### No transaction nonce or expiry

The signing payload contains no account nonce, no chain identifier, and
no expiry height. Replay is currently prevented by an index of all
signatures already present in the chain (section 14), which is effective
but is a different mechanism from a nonce and does not survive a chain
rollback in the way a nonce would.

### Address checksum is wallet-side only

A case-encoded checksum was added in September 2026 (section 05) and
detects 99.9% of single-character typos in measurement. It is enforced
by the reference wallet, **not by consensus**. A platform that accepts
user-entered addresses must run the check itself; the network will
accept a mistyped address without complaint.

This is a substantial improvement over the previous state, in which no
error detection existed at any layer. It is not equivalent to a
protocol-enforced checksum.

### Single-operator infrastructure

The public API, the mining pool, and the seed node run on one virtual
machine operated by one person. There is no redundancy, no on-call
rotation, and no organisational continuity plan.

### Testnet is new and single-operator

The testnet described in section 15 runs on the same virtual machine as
mainnet, operated by the same person. It has no redundancy and may be
restarted from genesis. It is adequate for exercising integration paths;
it is not a durable environment.

### No formal third-party audit

The cryptographic primitives — BIP143 sighash, DER encoding, Bech32,
secp256k1, SegWit serialisation, HTLC scripts — were verified against
official test vectors, and all 43 tests pass. Consensus code has
targeted regression tests, including for the two issues in section 14.

The consensus layer was reviewed systematically across three sessions:
signature verification, chain replacement, difficulty adjustment,
timestamp handling, transaction replay, and address validation. Three
vulnerabilities were found, reproduced by execution, and closed. That
work is real and section 14 documents it in full.

**It was nonetheless conducted by the maintainer, not by an independent
security firm.** We use "test coverage" rather than "audit" throughout
this document for that reason — the word carries a specific meaning in
your process, and we would rather be precise than borrow it.

What we can point to is the process. The first systematic review of the
consensus layer found three issues, reproduced each one by execution
before claiming it, closed all three, and shipped a regression test with
every fix — including tests that confirm the fixes do not reject honest
traffic. The findings are documented in section 14 with the same detail
we would want if we were evaluating someone else's chain.

That is how a review is supposed to work, and it is the standard we
intend to hold. It is not a substitute for an independent audit, which
remains the appropriate next step and which we would welcome as part of
an integration process.

---

## 14 · Test coverage & disclosed fixes

### Fixed, September 2026: timestamp validation asymmetry

`receiveBlock()` enforced timestamp monotonicity and a 10-second future
bound. `replaceChain()` — the path used by full-chain P2P
synchronisation — enforced neither.

The same block carrying a timestamp one year in the future was rejected
by one path and accepted by the other, verified by execution. Because
ASERT derives difficulty from timestamp deltas, a chain with inflated
timestamps computes a lower difficulty that is internally
self-consistent; combined with length-based selection, a longer chain of
cheap blocks would have been accepted.

Both checks now run on both paths. Regression tests confirm that honest
longer chains are still accepted.

### Fixed, September 2026: unverified signatures in peer blocks

**This was the most severe of the three.**

`verifyTransactionSignature()` was called in exactly one place:
`mempool.js`, when a transaction arrived through this node's own API.
A block delivered over P2P bypasses the mempool entirely. A comment in
`receiveBlock()` had already identified this gap and closed it for
*address format* — but signature verification was never added.

The result: `receiveBlock()` checked that a transfer's recipient address
was well-formed, and never checked whether the sender had authorised the
transfer at all.

Verified by execution. A block containing a transfer signed with the
literal string `AAAApodrobionyPodpis...` was accepted, and the victim's
balance fell from 50 to 9.999 while the attacker's rose to 90. **Any
peer could drain any address in the network without possessing its
private key.** Mining the block required real proof of work; nothing
else stood in the way.

Signature verification now runs on both paths — single-block receipt and
full-chain replacement — for every `transfer` and for legacy transfers
that carry no `type` field. Protocol-generated types (`coinbase`, `fee`,
`protocol_fee`, `genesis`) have no signature by construction and are
exempt. HTLC transactions use their own verification in
`htlc-wallet.js`.

**Enforcement begins at height 3,070**, and the reason matters for
anyone auditing the chain. A scan of all 28,229 historical transfers
found 2,920 with no `publicKey` or `signature` at all, spanning heights
109 to 2,704 — every one of them from a single address, the mining pool,
predating the introduction of signing. One further transaction at height
3,069 belongs to an earlier HTLC implementation that no longer exists in
the codebase. All 24,748 transfers above that point verify.

Requiring signatures retroactively would have caused the node to reject
its own history on the next resynchronisation and halt the network —
worse than the vulnerability being closed. The activation-height
approach follows the same principle Bitcoin applies to rule changes: new
rules take effect at a stated height; history is not rewritten. Coverage
is 99.997% of the chain, and no new block can fall below the threshold,
since the chain now stands above height 103,000.

### Fixed, September 2026: transaction replay

`mempool.addTransaction()` rejected duplicates only against the current
pending queue. Once a transaction was mined, it left the queue and its
signature remained valid; nothing tested whether the signature had
already appeared in the chain. Neither `receiveBlock()` nor
`replaceChain()` tested for it either.

Verified by execution: a signed transfer already contained in block #1
was accepted again in block #2 and moved funds a second time —
recipient balance 10 → 20 from a single signature. Any payment recipient
could have replayed the transaction repeatedly to drain the sender.

The chain now maintains an index of every signature it has seen, rebuilt
whenever chain indexes are rebuilt. Duplicates are rejected at all three
entry points: mempool, single-block receipt, and full-chain replacement.

Chain audit after deployment found **no duplicate signatures in
BbC's history**. The vulnerability existed but was never exploited.

### Test suites

| Suite | Result |
|---|---|
| `test-asert.js` | 14 pass, 0 fail |
| Cryptographic primitives vs official vectors | 43 pass |
| `test-replacechain-czas.js` | attack rejected, honest sync unaffected |
| `test-replay.js` | replay rejected, normal traffic unaffected |
| `test-podrobiony-podpis.js` | forged signature rejected, genuine transfers unaffected |
| `sprawdz-podpisy.js` | 24,748 / 24,748 historical transfers verify |

---

## 15 · Networks

### Mainnet

Live. Height 102,744 at publication.

### Testnet

A public testnet went live in September 2026. **Testnet coins have no
value and never will.**

| | Mainnet | Testnet |
|---|---|---|
| Endpoint | `https://141-147-98-57.sslip.io` | `https://testnet.141-147-98-57.sslip.io` |
| Chain ID | 28000000 | 28000001 |
| Ticker | BbC | tBbC |
| Address prefix | `BbC` | `tBbC` |
| Block time | 480 s | 60 s |
| ASERT activation | height 100,000 | height 10 |
| P2P port | 6001 | 6002 |
| Premine | 700 | 1,000,000 |

The two networks cannot be mixed. Their genesis hashes differ, and
`replaceChain()` rejects any chain whose genesis does not match with
*"inny genesis - inna siec"* (different genesis, different network).
This was verified by execution, not by inspection.

**Address prefixes differ by network**, following the same reasoning as
Bitcoin's `bc1` / `tb1` split. A testnet address begins `tBbC`; a
mainnet address begins `BbC`. Note that both are derived from the key
alone, so the same seed phrase produces the same 40 hex characters on
both networks — only the prefix changes.

Validation accepts `/^t?BbC[0-9a-fA-F]{40}$/`. The rule was widened, not
narrowed, so every address that validated before this change still
validates. Consensus does **not** currently reject a mainnet-prefixed
address on testnet or vice versa; since addresses derive from keys, a
misdirected transfer reaches the key holder's wallet on the other
network rather than being lost. This is untidy, not dangerous, and will
be tightened.

Testnet block time is deliberately 60 s rather than 480 s so an
integration can exercise deposit, confirmation, and withdrawal in
minutes rather than half a day. ASERT activates at height 10 so the
testnet exercises the same difficulty code path mainnet runs today — a
testnet validating a different branch than production would be worse
than no testnet.

The testnet may be restarted from a fresh genesis during early
integration work. Treat any testnet chain state as disposable.

### Some early coinbase rewards were paid to invalid addresses

A small number of blocks mined before address validation was enforced
paid their coinbase reward to strings that are not valid BbC addresses —
for example the literal `gpusolo1...`, a miner label rather than an
address. These sit at heights 22,962 to 23,078 and 73,271 to 73,275.

The coins exist in the ledger and count toward circulating supply, but
no private key corresponds to those strings. They cannot be spent and
cannot be attributed to anyone. Treat them as permanently burned when
calculating effective circulating supply.

Both `POST /solo/submit` and `POST /pool/submit` now reject a miner
address that fails the format check, and `receiveBlock()` rejects any
block whose coinbase recipient is malformed. A block of this kind cannot
enter the chain today.

### 129 blocks are missing from the canonical chain

The database contains 102,615 blocks across a height range of 0 to
102,744. **129 blocks are absent**, almost all single blocks scattered
between heights 3,497 and 47,097, with one run of 23 consecutive blocks
at 27,877–27,899.

Cause: block persistence failures during a period of repeated
out-of-memory process restarts. The blocks were valid when mined — the
next block's `previousHash` references them — but were never written to
disk, and were lost from memory at the next restart. No peer retains
them. They are not recoverable.

Both mechanisms responsible are now closed: block persistence completes
before the block enters memory, and SQLite runs WAL with
`synchronous=FULL`. No new gaps have appeared since height 47,097.

Consequences you must plan for:

- **The chain cannot be validated from genesis.** Hash linkage is broken
  at each gap.
- **A new full node cannot synchronise from the network.** Full-chain
  sync requires contiguous heights and will reject the canonical chain.
  Bootstrap requires a database snapshot.
- Balances, transactions, mining, and payouts are unaffected. All three
  operating nodes agree on current state.

This is a permanent property of BbC. It cannot be repaired.

---

## 16 · Contact & integration process

**Maintainer:** Radosław Iwański
**Repository:** `github.com/Radoslawq007/BitBudCoiN`
**API:** `https://141-147-98-57.sslip.io`

### What we can provide

- Database snapshot for node bootstrap
- Integration support during your evaluation
- Written response to any technical question, including ones this
  document answers unfavourably

### What we do not claim

BbC has no trading history, no market price, and no existing exchange
listing. Volume is untested. Total network hashrate is under 2 MH/s.
The project is one person's work with no organisation behind it.

We would rather be evaluated accurately and declined than listed on a
misunderstanding.
