// =====================================================
// BitBudCoin Backend - Debug Version
// server.js
// =====================================================

const express = require("express");
const cors = require("cors");
const Blockchain = require("./bbcblockchain");
const CONFIG = require("./config");
const db = require("./database");

const app = express();
app.use(cors());
app.use(express.json());

const blockchain = new Blockchain();

// Debug log
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

// ====================== ENDPOINTY ======================

app.get("/info", (req, res) => res.json(blockchain.getInfo()));

app.get("/miners/models", (req, res) => {
    res.json([
        {id: "vmax1", name: "vMax 1", hashRate: 25},
        {id: "vmax2", name: "vMax 2 Turbo", hashRate: 65},
        {id: "vmax3", name: "vMax 3 Pro", hashRate: 120}
    ]);
});

app.post("/mine/start", async (req, res) => {
    console.log("Otrzymano żądanie kopania:", req.body);
    const { minerAddress, modelId } = req.body;
    
    if (!minerAddress) {
        return res.status(400).json({ error: "Brak adresu minera" });
    }

    try {
        const block = await blockchain.createNewBlock(minerAddress);
        res.json({
            status: "mined",
            blockHeight: block.height,
            hash: block.hash,
            reward: CONFIG.BLOCK_REWARD
        });
    } catch (e) {
        console.error("Błąd kopania:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get("/blocks", (req, res) => res.json(blockchain.chain));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Serwer działa na http://localhost:${PORT}`);
});