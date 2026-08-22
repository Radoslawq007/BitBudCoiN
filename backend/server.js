"use strict";

const express = require("express");
const cors = require("cors");

const CONFIG = require("./config");
const Blockchain = require("./bbcblockchain");
const Mempool = require("./mempool");
const Pool = require("./pool");
const P2P = require("./p2p");
const SoloTracker = require("./solo-tracker");

const {
    rateLimiter,
    strictLimiter
} = require("./rate-limit");

const {
    difficultyToTargetHex
} = require("./bbcblockchain");

const bridgeTags = require("./bridge-tags");
const swapOffers = require("./swap-offers");

const {
    verifyAcceptOfferSignature,
    verifyRejectOfferSignature
} = require("./swap-offer-auth");

const {
    verifyHtlcCreateSignature,
    verifyHtlcClaimSignature,
    verifyHtlcRefundSignature
} = require("./htlc-wallet");


/*
 * ============================================================
 * BITBUDCOIN SERVER
 * vMax LEGENDARY MODE
 * ============================================================
 *
 * Zasady:
 *
 * 1. Blockchain jest źródłem prawdy dla konsensusu.
 * 2. ASERT jest obsługiwany przez bbcblockchain.js.
 * 3. server.js NIE zmienia difficulty ręcznie.
 * 4. P2P korzysta z tego samego mempoola co API.
 * 5. Wszystkie ścieżki submitujące blok przechodzą przez
 *    blockchain.receiveBlock().
 * 6. Po zaakceptowaniu bloku mempool jest czyszczony.
 * 7. Po zaakceptowaniu bloku P2P dostaje NEW_BLOCK.
 * 8. SSE pokazuje jeden spójny stan sieci.
 *
 * Nie ma tutaj drugiego mechanizmu DAA.
 */


/*
 * ============================================================
 * EXPRESS
 * ============================================================
 */

const app = express();

app.disable("x-powered-by");

app.use(cors());

app.use(express.json({
    limit: "1mb"
}));

app.use(rateLimiter);


/*
 * ============================================================
 * CORE
 * ============================================================
 */

const blockchain = new Blockchain();

const mempool = new Mempool(
    blockchain,
    blockchain.storage
);

const pool = new Pool(
    blockchain,
    {
        mempool,
        poolAddress: CONFIG.POOL_ADDRESS,
        poolFee: CONFIG.POOL_FEE,
        shareDifficulty: CONFIG.SHARE_DIFFICULTY
    }
);

const p2p = new P2P(
    blockchain,
    {
        port: CONFIG.P2P_PORT,
        peers: CONFIG.PEERS,
        mempool
    }
);

const soloTracker = new SoloTracker();


/*
 * ============================================================
 * P2P START
 * ============================================================
 */

p2p.start();


/*
 * ============================================================
 * SSE — LIVE BITBUDCOIN
 * ============================================================
 */

const sseClients = new Set();


function getLiveState() {

    const info =
        blockchain.getInfo();

    const poolStatus =
        pool.getStatus();

    const poolMiners =
        Object.entries(
            poolStatus.sharesThisRound || {}
        ).map(([address, shares]) => ({
            minerAddress: address,
            shares,
            source: "pool"
        }));

    const soloMiners =
        soloTracker
            .getActiveMiners()
            .map((m) => ({
                ...m,
                source: "solo"
            }));

    return {
        ...info,

        pool: {
            poolAddress:
                poolStatus.poolAddress,

            poolFee:
                poolStatus.poolFee,

            shareDifficulty:
                poolStatus.shareDifficulty,

            totalSharesThisRound:
                poolStatus.totalSharesThisRound
        },

        activeMiners: [
            ...poolMiners,
            ...soloMiners
        ],

        soloHashrate:
            soloTracker.getTotalHashrate(),

        p2p:
            p2p.getStatus(),

        updatedAt:
            Date.now()
    };
}


function sendSSE(eventName, data) {

    const message =
        `event: ${eventName}\n` +
        `data: ${JSON.stringify(data)}\n\n`;

    for (const res of sseClients) {

        try {
            res.write(message);
        } catch (err) {
            sseClients.delete(res);
        }
    }
}


app.get("/events", (req, res) => {

    res.setHeader(
        "Content-Type",
        "text/event-stream"
    );

    res.setHeader(
        "Cache-Control",
        "no-cache, no-store, must-revalidate"
    );

    res.setHeader(
        "Connection",
        "keep-alive"
    );

    res.setHeader(
        "X-Accel-Buffering",
        "no"
    );

    if (res.flushHeaders) {
        res.flushHeaders();
    }

    sseClients.add(res);

    try {

        res.write(
            `event: state\n` +
            `data: ${JSON.stringify(getLiveState())}\n\n`
        );

    } catch (err) {

        sseClients.delete(res);
        return;
    }

    const heartbeat =
        setInterval(() => {

            try {

                res.write(
                    `: heartbeat ${Date.now()}\n\n`
                );

            } catch (err) {

                clearInterval(heartbeat);
                sseClients.delete(res);
            }

        }, 15000);

    heartbeat.unref?.();

    req.on("close", () => {

        clearInterval(heartbeat);
        sseClients.delete(res);
    });
});


const sseInterval =
    setInterval(() => {

        if (sseClients.size === 0) {
            return;
        }

        sendSSE(
            "state",
            getLiveState()
        );

    }, 1000);

sseInterval.unref?.();


/*
 * ============================================================
 * INFO / BLOCKCHAIN
 * ============================================================
 */

app.get("/info", (req, res) => {

    res.json(
        blockchain.getInfo()
    );
});


app.get("/blocks", (req, res) => {

    let limit =
        Number(req.query.limit);

    if (!Number.isFinite(limit) || limit <= 0) {
        limit = 20;
    }

    limit =
        Math.min(
            Math.floor(limit),
            100
        );

    let before = null;

    if (req.query.before !== undefined) {

        const parsed =
            Number(req.query.before);

        if (
            Number.isInteger(parsed) &&
            parsed >= 0
        ) {
            before = parsed;
        }
    }

    res.json(
        blockchain.getRecentBlocks(
            limit,
            before
        )
    );
});


app.get("/blocks/:height", (req, res) => {

    const height =
        Number(req.params.height);

    if (
        !Number.isInteger(height) ||
        height < 0
    ) {
        return res.status(400).json({
            error: "Nieprawidłowa wysokość bloku"
        });
    }

    const block =
        blockchain
            .getChain()
            .find(
                (b) => b.height === height
            );

    if (!block) {

        return res.status(404).json({
            error: "Blok nie znaleziony"
        });
    }

    res.json(block);
});


/*
 * ============================================================
 * BALANCE
 * ============================================================
 */

app.get("/balance/:address", (req, res) => {

    const address =
        req.params.address;

    const confirmed =
        blockchain.getBalance(address);

    const pending =
        mempool.getPendingDelta
            ? mempool.getPendingDelta(address)
            : 0;

    res.json({
        address,
        balance: confirmed,
        pendingAwareBalance:
            confirmed + pending
    });
});


/*
 * ============================================================
 * NORMAL TRANSACTIONS
 * ============================================================
 */

app.post(
    "/transactions/send",
    strictLimiter,
    (req, res) => {

        const result =
            mempool.addTransaction(
                req.body
            );

        if (!result.accepted) {

            return res
                .status(400)
                .json(result);
        }

        res.json(result);
    }
);


/*
 * ============================================================
 * POOL STATUS
 * ============================================================
 */

app.get("/pool/status", (req, res) => {

    const status =
        pool.getStatus();

    const poolMiners =
        Object.entries(
            status.sharesThisRound || {}
        ).map(([address, shares]) => ({
            minerAddress: address,
            shares,
            source: "pool"
        }));

    const soloMiners =
        soloTracker
            .getActiveMiners()
            .map((m) => ({
                ...m,
                source: "solo"
            }));

    res.json({

        ...status,

        activeMiners: [
            ...poolMiners,
            ...soloMiners
        ],

        soloHashrate:
            soloTracker.getTotalHashrate()
    });
});


/*
 * ============================================================
 * NETWORK MINERS
 * ============================================================
 */

app.get("/network/miners", (req, res) => {

    const poolMiners =
        blockchain
            .storage
            .getKnownPoolMiners()
            .map((m) => ({
                address:
                    m.minerAddress,

                source:
                    "pool",

                totalEarned:
                    m.totalCredits,

                lastBlockHeight:
                    m.lastBlockHeight,

                roundsParticipated:
                    m.roundsParticipated
            }));

    const soloMiners =
        blockchain
            .getSoloMiners()
            .map((m) => ({
                address:
                    m.address,

                source:
                    "solo",

                totalEarned:
                    m.totalEarned,

                lastBlockHeight:
                    m.lastBlockHeight,

                blocksFound:
                    m.blocksFound
            }));

    const all = [
        ...poolMiners,
        ...soloMiners
    ].sort(
        (a, b) =>
            b.lastBlockHeight -
            a.lastBlockHeight
    );

    res.json(all);
});


/*
 * ============================================================
 * NETWORK ADDRESSES
 * ============================================================
 */

app.get("/network/addresses", (req, res) => {

    res.json(
        blockchain.getAddressStats()
    );
});


app.get("/stats/new-addresses", (req, res) => {

    let days =
        Number(req.query.days);

    if (!Number.isFinite(days) || days <= 0) {
        days = 30;
    }

    days =
        Math.min(
            Math.floor(days),
            90
        );

    res.json(
        blockchain
            .storage
            .getNewAddressesPerDay(days)
    );
});


app.get("/stats/active-addresses", (req, res) => {

    res.json(
        blockchain
            .storage
            .getActiveAddresses24h()
    );
});


/*
 * ============================================================
 * PEERS
 * ============================================================
 */

app.get("/peers", (req, res) => {

    res.json(
        p2p.getStatus()
    );
});


/*
 * ============================================================
 * JEDEN SPÓJNY SNAPSHOT
 * ============================================================
 */

app.get("/state", (req, res) => {

    res.json(
        getLiveState()
    );
});


/*
 * ============================================================
 * ADMIN — PEERS CONNECT
 * ============================================================
 */

app.post(
    "/peers/connect",
    strictLimiter,
    (req, res) => {

        const {
            address,
            secret
        } = req.body || {};

        if (
            secret !==
            bridgeTags.ADMIN_SECRET
        ) {
            return res.status(403).json({
                error: "Zły sekret"
            });
        }

        if (
            !address ||
            typeof address !== "string" ||
            !address.includes(":")
        ) {
            return res.status(400).json({
                error:
                    "Nieprawidłowy adres - oczekiwano formatu host:port"
            });
        }

        p2p.connectToPeer(address);

        res.json({
            ok: true,

            message:
                `Próba połączenia z ${address} rozpoczęta`
        });
    }
);


/*
 * ============================================================
 * BRIDGE ANNOTATIONS
 * ============================================================
 */

app.get(
    "/bridge/annotations",
    (req, res) => {

        res.json(
            bridgeTags.getAll()
        );
    }
);


app.post(
    "/bridge/annotations",
    strictLimiter,
    (req, res) => {

        const {
            secret,
            signature,
            blockHash,
            to,
            amount,
            chain,
            note
        } = req.body || {};

        if (
            secret !==
            bridgeTags.ADMIN_SECRET
        ) {
            return res.status(403).json({
                error: "Zły sekret"
            });
        }

        try {

            const tag =
                bridgeTags.addTag({
                    signature,
                    blockHash,
                    to,
                    amount,
                    chain,
                    note
                });

            res.json({
                ok: true,
                tag
            });

        } catch (err) {

            res.status(400).json({
                error: err.message
            });
        }
    }
);


/*
 * ============================================================
 * SWAP OFFERS
 * ============================================================
 */

app.get(
    "/swap/offers",
    (req, res) => {

        res.json(
            swapOffers.getAll()
        );
    }
);


app.get(
    "/swap/offers/:id",
    (req, res) => {

        const offer =
            swapOffers.getOffer(
                req.params.id
            );

        if (!offer) {

            return res.status(404).json({
                error:
                    "Oferta nie znaleziona"
            });
        }

        res.json(offer);
    }
);


app.post(
    "/swap/offers",
    strictLimiter,
    (req, res) => {

        const {
            chain,
            bbcAmount,
            expectedAmount,
            timeoutHours,
            note,
            targetSellerAddress
        } = req.body || {};

        try {

            const offer =
                swapOffers.createOffer({
                    chain,
                    bbcAmount,
                    expectedAmount,
                    timeoutHours,
                    note,
                    targetSellerAddress
                });

            res.json({
                ok: true,
                offer
            });

        } catch (err) {

            res.status(400).json({
                error: err.message
            });
        }
    }
);


app.post(
    "/swap/offers/:id/accept",
    strictLimiter,
    (req, res) => {

        const offer =
            swapOffers.getOffer(
                req.params.id
            );

        if (!offer) {

            return res.status(404).json({
                error:
                    "Oferta nie znaleziona"
            });
        }

        if (
            !verifyAcceptOfferSignature(
                req.body,
                offer.targetSellerAddress
            )
        ) {

            return res.status(403).json({
                error:
                    "Nieprawidłowy podpis - tylko właściciel adresu docelowego może zaakceptować tę ofertę"
            });
        }

        try {

            const updated =
                swapOffers.acceptOffer(
                    req.params.id,
                    {
                        sellerPubKeyHash:
                            req.body.sellerPubKeyHash,

                        sellerBbcAddress:
                            offer.targetSellerAddress
                    }
                );

            res.json({
                ok: true,
                offer: updated
            });

        } catch (err) {

            res.status(400).json({
                error: err.message
            });
        }
    }
);


app.post(
    "/swap/offers/:id/reject",
    strictLimiter,
    (req, res) => {

        const offer =
            swapOffers.getOffer(
                req.params.id
            );

        if (!offer) {

            return res.status(404).json({
                error:
                    "Oferta nie znaleziona"
            });
        }

        if (
            !verifyRejectOfferSignature(
                req.body,
                offer.targetSellerAddress
            )
        ) {

            return res.status(403).json({
                error:
                    "Nieprawidłowy podpis - tylko właściciel adresu docelowego może odrzucić tę ofertę"
            });
        }

        try {

            const updated =
                swapOffers.rejectOffer(
                    req.params.id,
                    offer.targetSellerAddress
                );

            res.json({
                ok: true,
                offer: updated
            });

        } catch (err) {

            res.status(400).json({
                error: err.message
            });
        }
    }
);


/*
 * ============================================================
 * ADDRESS TRANSACTIONS
 * ============================================================
 */

app.get(
    "/transactions/address/:address",
    (req, res) => {

        let limit =
            Number(req.query.limit);

        if (
            !Number.isFinite(limit) ||
            limit <= 0
        ) {
            limit = 50;
        }

        limit =
            Math.min(
                Math.floor(limit),
                200
            );

        res.json(
            blockchain
                .getTransactionsForAddress(
                    req.params.address,
                    limit
                )
        );
    }
);


/*
 * ============================================================
 * HTLC
 * ============================================================
 */

app.post(
    "/htlc/submit",
    strictLimiter,
    (req, res) => {

        const tx =
            req.body;

        if (
            !tx ||
            !tx.type
        ) {
            return res.status(400).json({
                error:
                    "Brak typu transakcji"
            });
        }

        if (
            tx.type ===
            "HTLC_CREATE"
        ) {

            if (
                typeof tx.amount !== "number" ||
                !Number.isFinite(tx.amount) ||
                !(tx.amount > 0)
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidłowa kwota"
                });
            }

            if (
                !verifyHtlcCreateSignature(
                    tx
                )
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidłowy podpis - transakcja odrzucona"
                });
            }

            if (
                blockchain.findHTLC(
                    tx.htlcId
                )
            ) {

                return res.status(400).json({
                    error:
                        "HTLC o tym ID już istnieje"
                });
            }

            const fee =
                typeof tx.fee === "number" &&
                Number.isFinite(tx.fee)
                    ? tx.fee
                    : 0;

            const available =
                mempool.getPendingAwareBalance(
                    tx.from
                );

            if (
                available <
                tx.amount + fee
            ) {

                return res.status(400).json({
                    error:
                        `Niewystarczające saldo (dostępne: ${available})`
                });
            }

            const result =
                mempool.addHtlcTransaction(
                    tx
                );

            if (
                result &&
                result.accepted === false
            ) {
                return res
                    .status(400)
                    .json(result);
            }

            return res.json({
                accepted: true
            });
        }


        if (
            tx.type ===
            "HTLC_CLAIM"
        ) {

            if (
                !verifyHtlcClaimSignature(
                    tx
                )
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidłowy podpis - transakcja odrzucona"
                });
            }

            const validation =
                blockchain.validateHTLCClaim({
                    htlcId:
                        tx.htlcId,

                    secret:
                        tx.secret,

                    claimant:
                        tx.claimant
                });

            if (
                !validation.valid
            ) {

                return res.status(400).json({
                    error:
                        validation.reason
                });
            }

            const result =
                mempool.addHtlcTransaction({
                    ...tx,

                    amount:
                        validation.amount,

                    to:
                        validation.to
                });

            if (
                result &&
                result.accepted === false
            ) {
                return res
                    .status(400)
                    .json(result);
            }

            return res.json({
                accepted: true
            });
        }


        if (
            tx.type ===
            "HTLC_REFUND"
        ) {

            if (
                !verifyHtlcRefundSignature(
                    tx
                )
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidłowy podpis - transakcja odrzucona"
                });
            }

            const validation =
                blockchain.validateHTLCRefund({
                    htlcId:
                        tx.htlcId,

                    refundee:
                        tx.refundee
                });

            if (
                !validation.valid
            ) {

                return res.status(400).json({
                    error:
                        validation.reason
                });
            }

            const result =
                mempool.addHtlcTransaction({
                    ...tx,

                    amount:
                        validation.amount,

                    to:
                        validation.to
                });

            if (
                result &&
                result.accepted === false
            ) {
                return res
                    .status(400)
                    .json(result);
            }

            return res.json({
                accepted: true
            });
        }


        return res.status(400).json({
            error:
                `Nieznany typ transakcji "${tx.type}"`
        });
    }
);


app.get(
    "/htlc/:id",
    (req, res) => {

        const htlc =
            blockchain.findHTLC(
                req.params.id
            );

        if (!htlc) {

            return res.status(404).json({
                error:
                    "HTLC nie znaleziony"
            });
        }

        res.json(htlc);
    }
);


/*
 * ============================================================
 * POOL WORK
 * ============================================================
 */

app.get(
    "/pool/work",
    (req, res) => {

        const minerAddress =
            req.query.minerAddress;

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        res.json(
            pool.getWork(
                minerAddress
            )
        );
    }
);


/*
 * ============================================================
 * POOL SHARE SUBMISSION
 * ============================================================
 */

app.post(
    "/pool/submit",
    (req, res) => {

        const minerAddress =
            req.body &&
            req.body.minerAddress;

        const candidate =
            req.body &&
            req.body.candidate;

        if (
            typeof minerAddress !== "string" ||
            !minerAddress
        ) {

            return res.status(400).json({
                error:
                    "Brak adresu minera"
            });
        }

        if (
            !candidate ||
            typeof candidate !== "object"
        ) {

            return res.status(400).json({
                error:
                    "Brak candidate"
            });
        }

        const result =
            pool.submitShare(
                minerAddress,
                candidate
            );

        if (!result.accepted) {

            return res
                .status(400)
                .json(result);
        }

        if (
            result.blockFound &&
            result.block
        ) {

            p2p.broadcastNewBlock(
                result.block
            );
        }

        res.json(result);
    }
);


/*
 * ============================================================
 * SOLO WORK
 * ============================================================
 */

app.get(
    "/solo/work",
    (req, res) => {

        const minerAddress =
            req.query.minerAddress;

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        const latest =
            blockchain.getLatestBlock();

        const pendingTxs =
            mempool.selectForBlock();

        const difficulty =
            blockchain.difficulty;

        res.json({

            height:
                latest.height + 1,

            previousHash:
                latest.hash,

            timestamp:
                Date.now(),

            transactions:
                blockchain.buildBlockTransactions(
                    minerAddress,
                    pendingTxs
                ),

            difficulty,

            blockTarget:
                difficultyToTargetHex(
                    difficulty
                )
        });
    }
);


/*
 * ============================================================
 * SOLO BLOCK SUBMISSION
 * ============================================================
 */

app.post(
    "/solo/submit",
    (req, res) => {

        const {
            candidate
        } = req.body || {};

        if (
            !candidate ||
            typeof candidate !== "object"
        ) {

            return res.status(400).json({
                error:
                    "Brak candidate"
            });
        }

        const result =
            blockchain.receiveBlock(
                candidate
            );

        if (
            !result.accepted
        ) {

            return res
                .status(400)
                .json(result);
        }

        mempool.pruneConfirmed(
            result.block
        );

        p2p.broadcastNewBlock(
            result.block
        );

        res.json({

            status:
                "mined",

            blockHeight:
                result.block.height,

            hash:
                result.block.hash,

            reward:
                result.block
                    .transactions[0]
                    .amount
        });
    }
);


/*
 * ============================================================
 * SOLO HEARTBEAT
 * ============================================================
 */

app.post(
    "/solo/heartbeat",
    (req, res) => {

        const {
            minerAddress,
            attempts,
            intervalSeconds
        } = req.body || {};

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        soloTracker.heartbeat(
            minerAddress,
            attempts,
            intervalSeconds
        );

        res.json({
            ok: true
        });
    }
);


/*
 * ============================================================
 * LEGACY MINE START
 * ============================================================
 */

app.post(
    "/mine/start",
    strictLimiter,
    (req, res) => {

        res.status(410).json({
            error:
                "Solo mining wyłączone przy tej trudności - użyj kopania przez pulę lub /solo/work (miner.html)"
        });
    }
);


/*
 * ============================================================
 * MINER MODELS
 * ============================================================
 */

app.get(
    "/miners/models",
    (req, res) => {

        res.json([]);
    }
);


/*
 * ============================================================
 * 404
 * ============================================================
 */

app.use(
    (req, res) => {

        res.status(404).json({
            error:
                "Nieznany endpoint"
        });
    }
);


/*
 * ============================================================
 * GLOBAL ERROR HANDLER
 * ============================================================
 */

app.use(
    (err, req, res, next) => {

        console.error(
            "Nieobsłużony błąd:",
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({
            error:
                "Wewnętrzny błąd serwera"
        });
    }
);


/*
 * ============================================================
 * API START
 * ============================================================
 */

const server =
    app.listen(
        CONFIG.API_PORT,
        "127.0.0.1",
        () => {

            console.log(
                `BitBudCoin API nasłuchuje na porcie ${CONFIG.API_PORT}`
            );

            console.log(
                `P2P: ${CONFIG.P2P_PORT}`
            );

            console.log(
                `Sieć: ${CONFIG.NETWORK_NAME}`
            );

            console.log(
                `Symbol: ${CONFIG.SYMBOL}`
            );

            console.log(
                `ASERT activation: ${CONFIG.ASERT_ACTIVATION_HEIGHT}`
            );

            console.log(
                `ASERT halflife: ${CONFIG.ASERT_HALFLIFE_SECONDS}s`
            );
        }
    );


/*
 * ============================================================
 * GRACEFUL SHUTDOWN
 * ============================================================
 */

let shuttingDown = false;


function shutdown(signal) {

    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `Otrzymano ${signal} - zamykanie BitBudCoin...`
    );

    clearInterval(
        sseInterval
    );

    for (const res of sseClients) {

        try {
            res.end();
        } catch (err) {}
    }

    sseClients.clear();

    try {
        p2p.close();
    } catch (err) {
        console.error(
            "Błąd zamykania P2P:",
            err.message
        );
    }

    try {
        blockchain.close();
    } catch (err) {
        console.error(
            "Błąd zamykania blockchain:",
            err.message
        );
    }

    server.close(() => {

        console.log(
            "BitBudCoin API zamknięte."
        );

        process.exit(0);
    });

    setTimeout(() => {

        console.error(
            "Wymuszone zamknięcie serwera."
        );

        process.exit(1);

    }, 10000).unref();
}


process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);


/*
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
    app,
    server,
    blockchain,
    mempool,
    pool,
    p2p
};