// Backup bazy BitBudCoin - bezpieczny nawet gdy serwer aktywnie pisze (VACUUM INTO
// robi spójny snapshot, nie blokuje ani nie psuje trwającego zapisu - przetestowane).
//
// Użycie:  node backup.js [katalog_docelowy] [ile_kopii_zachować]
// Domyślnie: ./backups, 14 kopii
//
// Przykład crona (backup co godzinę, o pełnej godzinie):
//   0 * * * * cd /sciezka/do/projektu && node backup.js >> backup.log 2>&1

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const CONFIG = require("./config");

const BACKUP_DIR = process.argv[2] || "./backups";
const KEEP = Number(process.argv[3]) || 14;

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function runBackup() {
    if (!fs.existsSync(CONFIG.DATABASE)) {
        console.error(`❌ Nie znaleziono bazy "${CONFIG.DATABASE}" (uruchamiasz z właściwego katalogu?)`);
        process.exit(1);
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `bbc-${timestamp()}.db`);
    const destAbs = path.resolve(dest).replace(/'/g, "''");

    const db = new DatabaseSync(CONFIG.DATABASE);
    try {
        db.exec(`VACUUM INTO '${destAbs}'`);
    } finally {
        db.close();
    }

    const sizeKb = (fs.statSync(dest).size / 1024).toFixed(1);
    console.log(`✅ Backup zapisany: ${dest} (${sizeKb} KB)`);

    rotate();
}

function rotate() {
    const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith("bbc-") && f.endsWith(".db"))
        .map((f) => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);

    for (const f of files.slice(KEEP)) {
        fs.unlinkSync(path.join(BACKUP_DIR, f.name));
        console.log(`🗑️  Usunięto stary backup (limit ${KEEP}): ${f.name}`);
    }
}

runBackup();
