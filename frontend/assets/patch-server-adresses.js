const fs = require("fs");
let content = fs.readFileSync("server.js", "utf8");

const anchor = `app.get("/network/miners", (req, res) => {`;
const addition = `app.get("/network/addresses", (req, res) => {
    const all = blockchain.getAllKnownAddresses();
    const whales = [...all].sort((a, b) => b.balance - a.balance).slice(0, 10);
    const newest = [...all].sort((a, b) => b.firstSeenHeight - a.firstSeenHeight).slice(0, 10);
    res.json({ totalAddresses: all.length, whales, newest });
});

app.get("/network/miners", (req, res) => {`;

if (!content.includes(anchor)) {
    console.log("❌ Nie znalazłem punktu zaczepienia - nic nie zmieniłem. Wklej mi swój aktualny server.js.");
    process.exit(1);
}
content = content.replace(anchor, addition);
fs.writeFileSync("server.js", content);
console.log("✅ server.js zaktualizowany poprawnie.");
