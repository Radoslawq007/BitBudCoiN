const fs = require("fs");
let content = fs.readFileSync("storage.js", "utf8");

const anchor = `    saveCredit(c) { this._insertCredit.run(c.minerAddress, c.blockHeight, c.shares, c.amount, c.timestamp); }`;
const addition = `
    getKnownPoolMiners() {
        return this.db.prepare(\`SELECT minerAddress, SUM(amount) as totalCredits, MAX(blockHeight) as lastBlockHeight, COUNT(*) as roundsParticipated
                                  FROM pool_credits GROUP BY minerAddress ORDER BY lastBlockHeight DESC\`).all();
    }`;

if (!content.includes(anchor)) {
    console.log("❌ Nie znalazłem punktu zaczepienia - nic nie zmieniłem. Wklej mi swój aktualny storage.js.");
    process.exit(1);
}
content = content.replace(anchor, anchor + addition);
fs.writeFileSync("storage.js", content);
console.log("✅ storage.js zaktualizowany poprawnie.");
