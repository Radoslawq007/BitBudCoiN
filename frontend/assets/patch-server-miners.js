const fs = require("fs");
let content = fs.readFileSync("server.js", "utf8");

const anchor = `app.get("/pool/status", (req, res) => res.json(pool.getStatus()));`;
const addition = `

app.get("/network/miners", (req, res) => {
    const poolMiners = blockchain.storage.getKnownPoolMiners().map((m) => ({
        address: m.minerAddress, source: "pool", totalEarned: m.totalCredits,
        lastBlockHeight: m.lastBlockHeight, roundsParticipated: m.roundsParticipated
    }));
    const soloMiners = blockchain.getSoloMiners().map((m) => ({
        address: m.address, source: "solo", totalEarned: m.totalEarned,
        lastBlockHeight: m.lastBlockHeight, blocksFound: m.blocksFound
    }));
    const all = [...poolMiners, ...soloMiners].sort((a, b) => b.lastBlockHeight - a.lastBlockHeight);
    res.json(all);
});`;

if (!content.includes(anchor)) {
    console.log("❌ Nie znalazłem punktu zaczepienia - nic nie zmieniłem. Wklej mi swój aktualny server.js.");
    process.exit(1);
}
content = content.replace(anchor, anchor + addition);
fs.writeFileSync("server.js", content);
console.log("✅ server.js zaktualizowany poprawnie.");
