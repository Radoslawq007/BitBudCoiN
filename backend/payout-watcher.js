// Uruchom jako osobny proces pm2: pm2 start payout-watcher.js --name payout-watcher -- /home/ubuntu/secrets/pool-key.pem
// Sprawdza co CHECK_INTERVAL_MS, czy są nowe niewypłacone udziały - jeśli tak,
// od razu wywołuje payout.js. Klucz nadal ładowany tylko na chwilę, przy
// każdym wywołaniu payout.js osobno - nie siedzi stale w tym procesie.
const CONFIG = require("./config");
const Storage = require("./storage");
const { execFile } = require("child_process");
const path = require("path");

const POOL_KEY_PATH = process.argv[2];
if (!POOL_KEY_PATH) {
    console.error("Użycie: node payout-watcher.js <ścieżka_do_klucza.pem>");
    process.exit(1);
}

const SERVER_URL = process.env.PAYOUT_SERVER_URL || `http://localhost:${CONFIG.API_PORT}`;
const MIN_PAYOUT = process.env.MIN_PAYOUT || "0"; // "0" = płać zawsze, każdą kwotę

const CHECK_INTERVAL_MS = Number(process.env.WATCHER_INTERVAL_MS) || 5000;
let running = false;

function checkAndPayout() {
    if (running) return;
    let storage;
    try {
        storage = new Storage(CONFIG.DATABASE);
        const unpaid = storage.getUnpaidCreditsSummary();
        storage.close();
        if (unpaid.length === 0) return;

        console.log(`[${new Date().toISOString()}] Znaleziono ${unpaid.length} niewypłaconych adresów, uruchamiam payout...`);
        running = true;
        execFile("node", [path.join(__dirname, "payout.js"), POOL_KEY_PATH, SERVER_URL, MIN_PAYOUT], { cwd: __dirname }, (err, stdout, stderr) => {
            running = false;
            if (stdout && stdout.trim()) console.log(stdout.trim());
            if (stderr && stderr.trim()) console.error(`[${new Date().toISOString()}] STDERR payout.js:`, stderr.trim());
            if (err) console.error(`[${new Date().toISOString()}] Błąd auto-wypłaty:`, err.message);
        });
    } catch (e) {
        if (storage) storage.close();
        console.error("Błąd sprawdzania:", e.message);
    }
}

console.log(`Obserwator wypłat uruchomiony - sprawdza co ${CHECK_INTERVAL_MS / 1000}s, próg wypłaty: ${MIN_PAYOUT}`);
checkAndPayout();
setInterval(checkAndPayout, CHECK_INTERVAL_MS);