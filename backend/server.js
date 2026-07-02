const express = require("express");
const cors = require("cors");
const Blockchain = require("./bbcblockchain");

const app = express();
app.use(cors());
app.use(express.json());

const blockchain = new Blockchain();

// Endpointy
app.get("/info", (req, res) => {
    res.json(blockchain.getInfo());
});

app.get("/mine", async (req, res) => {
    const minerAddress = req.query.miner || CONFIG.GENESIS_ADDRESS;
    
    try {
        const newBlock = await blockchain.createNewBlock(minerAddress);
        res.json({
            status: "success",
            block: {
                height: newBlock.height,
                hash: newBlock.hash,
                miner: newBlock.miner,
                reward: newBlock.reward
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 BitBudCoin backend działa na porcie ${PORT}`);
});