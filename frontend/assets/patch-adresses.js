const fs = require("fs");
let content = fs.readFileSync("bbcblockchain.js", "utf8");

const anchor = `    getSoloMiners() {`;
const addition = `    getAllKnownAddresses() {
        const stats = new Map();
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.to) {
                    const entry = stats.get(tx.to) || { address: tx.to, firstSeenHeight: block.height, totalReceived: 0, totalSent: 0 };
                    entry.totalReceived += tx.amount;
                    if (block.height < entry.firstSeenHeight) entry.firstSeenHeight = block.height;
                    stats.set(tx.to, entry);
                }
                if (tx.from && tx.type === "transfer") {
                    const entry = stats.get(tx.from) || { address: tx.from, firstSeenHeight: block.height, totalReceived: 0, totalSent: 0 };
                    entry.totalSent += tx.amount + (tx.fee || 0);
                    if (block.height < entry.firstSeenHeight) entry.firstSeenHeight = block.height;
                    stats.set(tx.from, entry);
                }
            }
        }
        return Array.from(stats.values()).map((e) => ({ ...e, balance: e.totalReceived - e.totalSent }));
    }

    getSoloMiners() {`;

if (!content.includes(anchor)) {
    console.log("❌ Nie znalazłem punktu zaczepienia - nic nie zmieniłem. Wklej mi swój aktualny bbcblockchain.js.");
    process.exit(1);
}
content = content.replace(anchor, addition);
fs.writeFileSync("bbcblockchain.js", content);
console.log("✅ bbcblockchain.js zaktualizowany poprawnie.");
