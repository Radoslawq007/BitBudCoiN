// =====================================================
// BitBudCoin Core vMax
// server.js
// =====================================================

const express = require("express");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const CONFIG = require("./config");

// CORE
const Blockchain = require("./core/bbcblockchain");
const Transaction = require("./core/transaction");
const Mempool = require("./core/mempool");
const Wallet = require("./core/wallet");

// =====================================================
// INIT
// =====================================================

const app = express();
app.use(bodyParser.json());

const blockchain = new Blockchain();
const mempool = new Mempool(blockchain);

const sockets = [];

// =====================================================
// P2P
// =====================================================

const MESSAGE_TYPES = {
    CHAIN: "CHAIN",
    TRANSACTION: "TRANSACTION",
    NEW_BLOCK: "NEW_BLOCK",
    PEERS: "PEERS"
};

const initP2PServer = () => {
    const server = new WebSocket.Server({ port: CONFIG.P2P_PORT });

    server.on("connection", (ws) => {
        console.log("[P2P] New peer connected");
        initConnection(ws);
    });

    console.log(`[P2P] Listening on port ${CONFIG.P2P_PORT}`);
};

const initConnection = (ws) => {
    sockets.push(ws);

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (e) {
            console.error("[P2P] Invalid message", e);
        }
    });

    ws.on("close", () => console.log("[P2P] Peer disconnected"));
    ws.on("error", (err) => console.log("[P2P] Peer error", err));

    send(ws, {
        type: MESSAGE_TYPES.CHAIN,
        chain: blockchain.chain
    });
};

const send = (ws, msg) => ws.send(JSON.stringify(msg));
const broadcast = (msg) => sockets.forEach((socket) => send(socket, msg));

const handleMessage = (ws, data) => {
    switch (data.type) {
        case MESSAGE_TYPES.CHAIN:
            blockchain.replaceChain(data.chain);
            break;

        case MESSAGE_TYPES.TRANSACTION:
            try {
                const tx = new Transaction(
                    data.transaction.from,
                    data.transaction.to,
                    data.transaction.amount,
                    data.transaction.fee,
                    data.transaction.fromPublicKey,
                    data.transaction.signature
                );

                mempool.addTransaction(tx);
            } catch (e) {
                console.log("[P2P] Invalid transaction:", e.message);
            }
            break;

        case MESSAGE_TYPES.NEW_BLOCK:
            blockchain.addBlockFromNetwork(data.block);
            break;
    }
};

// =====================================================
// API
// =====================================================

// INFO
app.get("/info", (req, res) => {
    res.json({
        network: CONFIG.NETWORK_NAME,
        symbol: CONFIG.SYMBOL,
        version: CONFIG.VERSION,
        chainId: CONFIG.CHAIN_ID,
        height: blockchain.getHeight(),
        latestBlock: blockchain.getLatestBlock()
    });
});

// CHAIN
app.get("/chain", (req, res) => res.json(blockchain.chain));

// BLOCK
app.get("/block/:id", (req, res) => {
    const block = blockchain.getBlock(req.params.id);
    if (!block) return res.status(404).json({ error: "Block not found" });
    res.json(block);
});

// BALANCE
app.get("/balance/:address", (req, res) => {
    const balance = blockchain.getBalance(req.params.address);
    res.json({ address: req.params.address, balance });
});

// MEMPOOL
app.get("/mempool", (req, res) => res.json(mempool.transactions));

// ADD SIGNED TRANSACTION
app.post("/transaction", (req, res) => {
    try {
        const {
            from,
            to,
            amount,
            fee,
            fromPublicKey,
            signature
        } = req.body;

        const tx = new Transaction(
            from,
            to,
            amount,
            fee,
            fromPublicKey,
            signature
        );

        mempool.addTransaction(tx);

        broadcast({ type: MESSAGE_TYPES.TRANSACTION, transaction: tx });

        res.json({ message: "Transaction added to mempool", tx });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// MINE BLOCK
app.post("/mine", (req, res) => {
    try {
        const block = blockchain.mineBlock(mempool.transactions);

        mempool.clear();

        broadcast({ type: MESSAGE_TYPES.NEW_BLOCK, block });

        res.json({ message: "Block mined", block });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ADD PEER
app.post("/peer", (req, res) => {
    const { peer } = req.body;

    if (!peer) return res.status(400).json({ error: "Peer URL required" });

    const ws = new WebSocket(peer);

    ws.on("open", () => {
        initConnection(ws);
        res.json({ message: "Peer connected", peer });
    });

    ws.on("error", (err) => {
        res.status(500).json({ error: "Failed to connect peer", details: err.message });
    });
});

// =====================================================
// START
// =====================================================

app.listen(CONFIG.API_PORT, () => {
    console.log(`[API] BitBudCoin running on port ${CONFIG.API_PORT}`);
});

initP2PServer();