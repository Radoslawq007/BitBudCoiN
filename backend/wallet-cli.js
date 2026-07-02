// =====================================================
// BitBudCoin Wallet CLI
// wallet-cli.js
// =====================================================

const axios = require("axios");
const Wallet = require("./wallet");
const Transaction = require("./transaction");

const API = "http://localhost:5000"; // zmień na swój serwer

async function main() {
    const args = process.argv.slice(2);

    const cmd = args[0];

    if (cmd === "new") {
        const w = new Wallet();
        console.log("Address:", w.address);
        console.log("Private:", w.privateKey);
        console.log("Public:", w.publicKey);
        return;
    }

    if (cmd === "balance") {
        const address = args[1];
        const res = await axios.get(`${API}/balance/${address}`);
        console.log(res.data);
        return;
    }

    if (cmd === "send") {
        const privateKey = args[1];
        const to = args[2];
        const amount = Number(args[3]);
        const fee = Number(args[4]);

        const wallet = new Wallet(privateKey);

        const tx = Transaction.createSigned(wallet, to, amount, fee);

        const res = await axios.post(`${API}/transaction`, tx);

        console.log(res.data);
        return;
    }

    console.log("Commands:");
    console.log("  node wallet-cli.js new");
    console.log("  node wallet-cli.js balance <address>");
    console.log("  node wallet-cli.js send <privateKey> <to> <amount> <fee>");
}

main();