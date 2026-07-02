// =====================================================
// BitBudCoin Backend - Finalna wersja
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

// ====================== PODSTAWOWE ======================

app.get("/info", (req, res) => {
    res.json(blockchain.getInfo());
});

app.get("/blocks", (req, res) => {
    res.json(blockchain.chain);
});

app.get("/latest", (req, res) => {
    res.json(blockchain.getLatestBlock());
});

// ====================== BALANCE ======================

app.get("/balance/:address", (req, res) => {
    const address = req.params.address;
    
    try {
        // Proste sprawdzenie salda z bazy
        const result = db.prepare("SELECT balance FROM balances WHERE address = ?").get(address);
        
        res.json({
            address: address,
            balance: result ? result.balance : 0.00
        });
    } catch (e) {
        res.json({
            address: address,
            balance: 0.00
        });
    }
});

// ====================== TRANSAKCJE ======================

app.post("/transaction", (req, res) => {
    try {
        const result = blockchain.addTransaction(req.body);
        res.json({ 
            status: "success", 
            message: "Transakcja dodana pomyślnie",
            txid: result.txid 
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ====================== KOPANIE ======================

app.get("/mine", async (req, res) => {
    const miner = req.query.miner || CONFIG.GENESIS_ADDRESS;
    try {
        const block = await blockchain.createNewBlock(miner);
        res.json({
            status: "success",
            message: "Block mined successfully",
            block: {
                height: block.height,
                hash: block.hash,
                miner: block.miner,
                reward: block.reward
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== KOPARKI vMax ======================

app.get("/miners/models", (req, res) => {
    res.json([
        {
            id: "vmax1