const { DatabaseSync } = require("node:sqlite");

class Storage {
    constructor(dbPath) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA foreign_keys = ON");
        // DODANE: bez tego, gdy bitbudcoin i payout-watcher (DWA OSOBNE
        // procesy pm2, ten sam plik bazy) trafia sie na siebie w tej samej
        // milisekundzie, SQLite domyslnie (busy_timeout=0) NATYCHMIAST
        // rzuca "database is locked", zamiast poczekac az drugi proces
        // skonczy. Zweryfikowane osobnym testem (dwa prawdziwe procesy
        // node:sqlite na tym samym pliku): bez tej linii writer dostaje
        // blad po 0ms; z nia - czeka i konczy sukcesem. 5000 = czekaj do
        // 5 sekund zanim naprawde odda blad.
        this.db.exec("PRAGMA busy_timeout = 5000");
        this._initSchema();
    }

    _initSchema() {
        this.db.exec(`CREATE TABLE IF NOT EXISTS blocks (
            height INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL,
            previousHash TEXT NOT NULL, hash TEXT NOT NULL,
            nonce INTEGER NOT NULL, difficulty REAL NOT NULL
        )`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, blockHeight INTEGER NOT NULL,
            from_address TEXT, to_address TEXT NOT NULL, amount REAL NOT NULL,
            type TEXT NOT NULL, fee REAL, timestamp INTEGER, publicKey TEXT, signature TEXT,
            FOREIGN KEY (blockHeight) REFERENCES blocks(height)
        )`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS mempool (
            signature TEXT PRIMARY KEY, from_address TEXT, to_address TEXT,
            amount REAL, fee REAL, timestamp INTEGER, publicKey TEXT
        )`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS pool_credits (
            id INTEGER PRIMARY KEY AUTOINCREMENT, minerAddress TEXT NOT NULL,
            blockHeight INTEGER NOT NULL, shares INTEGER NOT NULL,
            amount REAL NOT NULL, timestamp INTEGER NOT NULL, paid INTEGER DEFAULT 0
        )`);
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(blockHeight)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_credits_miner ON pool_credits(minerAddress)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_credits_paid ON pool_credits(paid)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_address)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_address)");

        this._insertBlock = this.db.prepare("INSERT INTO blocks (height, timestamp, previousHash, hash, nonce, difficulty) VALUES (?, ?, ?, ?, ?, ?)");
        this._insertTx = this.db.prepare("INSERT INTO transactions (blockHeight, from_address, to_address, amount, type, fee, timestamp, publicKey, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        this._insertCredit = this.db.prepare("INSERT INTO pool_credits (minerAddress, blockHeight, shares, amount, timestamp) VALUES (?, ?, ?, ?, ?)");
    }

    hasBlocks() { return this.db.prepare("SELECT COUNT(*) AS n FROM blocks").get().n > 0; }

    saveBlock(block) {
        this.db.exec("BEGIN");
        try {
            this._insertBlock.run(block.height, block.timestamp, block.previousHash, block.hash, block.nonce, block.difficulty);
            for (const tx of block.transactions) {
                this._insertTx.run(block.height, tx.from ?? null, tx.to, tx.amount, tx.type, tx.fee ?? null, tx.timestamp ?? null, tx.publicKey ?? null, tx.signature ?? null);
            }
            this.db.exec("COMMIT");
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }

    loadChain() {
        const blockRows = this.db.prepare("SELECT * FROM blocks ORDER BY height ASC").all();
        const txStmt = this.db.prepare("SELECT * FROM transactions WHERE blockHeight = ? ORDER BY id ASC");
        return blockRows.map((row) => ({
            height: row.height, timestamp: row.timestamp, previousHash: row.previousHash,
            hash: row.hash, nonce: row.nonce, difficulty: row.difficulty,
            transactions: txStmt.all(row.height).map((tx) => ({
                from: tx.from_address, to: tx.to_address, amount: tx.amount, type: tx.type,
                fee: tx.fee ?? undefined, timestamp: tx.timestamp ?? undefined,
                publicKey: tx.publicKey ?? undefined, signature: tx.signature ?? undefined
            }))
        }));
    }

    loadMempool() {
        return this.db.prepare("SELECT * FROM mempool").all().map((tx) => ({
            from: tx.from_address, to: tx.to_address, amount: tx.amount,
            fee: tx.fee, timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature
        }));
    }
    saveMempoolTx(tx) {
        this.db.prepare("INSERT OR REPLACE INTO mempool (signature, from_address, to_address, amount, fee, timestamp, publicKey) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(tx.signature, tx.from, tx.to, tx.amount, tx.fee, tx.timestamp, tx.publicKey);
    }
    deleteMempoolTx(signature) { this.db.prepare("DELETE FROM mempool WHERE signature = ?").run(signature); }

    saveCredit(c) { this._insertCredit.run(c.minerAddress, c.blockHeight, c.shares, c.amount, c.timestamp); }

    getKnownPoolMiners() {
        return this.db.prepare(`SELECT minerAddress, SUM(amount) as totalCredits, MAX(blockHeight) as lastBlockHeight, COUNT(*) as roundsParticipated
                                  FROM pool_credits GROUP BY minerAddress ORDER BY lastBlockHeight DESC`).all();
    }

    // NAPRAWA RAM (dzisiaj): brak limitu tutaj byl bardzo prawdopodobna
    // prawdziwa przyczyna rosnacej pamieci payout-watchera. Po 29h+ zastoju
    // kazdy zaakceptowany share (setki tysiecy) zostawil niewyplacony wiersz
    // - SELECT * bez LIMIT wciagal WSZYSTKIE naraz do pamieci przy KAZDYM
    // cyklu sprawdzania (co 30s), budujac ogromne tablice creditIds. LIMIT +
    // ORDER BY id ASC (najstarsze pierwsze) sprawia, ze backlog czyści się
    // stopniowo, bezpiecznymi porcjami, zamiast próbować za jednym razem.
    //
    // maxRowAmount (opcjonalne, dzisiaj dodane): gdy podane, pomija
    // POJEDYNCZE wiersze z amount > maxRowAmount PRZED agregacja po adresie.
    // To filtr na poziomie wiersza, nie adresu - jeden adres moze miec
    // zmieszane wiersze prawdziwe i skorumpowane (z okresu gdy
    // blockchain.difficulty bylo przypiete do dna=1, effectiveMinerDiff
    // sprawial ze pojedynczy share liczyl sie jak caly blok, albo
    // wczesniej - zanim ta poprawka w ogole istniala - nawet wiecej).
    // Skorumpowane wiersze ZOSTAJA w bazie jako paid=0, nietkniete -
    // po prostu nigdy nie sa wybierane do wyplaty. Zadna decyzja o USUNIECIU
    // czy oznaczeniu ich nie jest tu podejmowana.
    getUnpaidCreditsSummary(maxRows = 5000, maxRowAmount = null) {
        const rows = maxRowAmount === null
            ? this.db.prepare("SELECT * FROM pool_credits WHERE paid = 0 ORDER BY id ASC LIMIT ?").all(maxRows)
            : this.db.prepare("SELECT * FROM pool_credits WHERE paid = 0 AND amount <= ? ORDER BY id ASC LIMIT ?").all(maxRowAmount, maxRows);
        const byAddress = new Map();
        for (const row of rows) {
            const entry = byAddress.get(row.minerAddress) || { minerAddress: row.minerAddress, total: 0, creditIds: [] };
            entry.total += row.amount;
            entry.creditIds.push(row.id);
            byAddress.set(row.minerAddress, entry);
        }
        return Array.from(byAddress.values());
    }
    markCreditsPaid(creditIds) {
        const stmt = this.db.prepare("UPDATE pool_credits SET paid = 1 WHERE id = ?");
        for (const id of creditIds) stmt.run(id);
    }

    _addressEventsCTE() {
        return `
            WITH address_events AS (
                SELECT t.to_address AS address, COALESCE(t.timestamp, b.timestamp) AS ts
                FROM transactions t JOIN blocks b ON t.blockHeight = b.height
                WHERE t.to_address IS NOT NULL
                UNION ALL
                SELECT t.from_address AS address, COALESCE(t.timestamp, b.timestamp) AS ts
                FROM transactions t JOIN blocks b ON t.blockHeight = b.height
                WHERE t.from_address IS NOT NULL
            )
        `;
    }

    getNewAddressesPerDay(days = 30) {
        const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
        return this.db.prepare(`
            ${this._addressEventsCTE()},
            first_seen AS (SELECT address, MIN(ts) AS first_ts FROM address_events GROUP BY address)
            SELECT date(first_ts / 1000, 'unixepoch') AS day, COUNT(*) AS newAddresses
            FROM first_seen
            WHERE first_ts >= ?
            GROUP BY day
            ORDER BY day DESC
        `).all(sinceMs);
    }

    getActiveAddresses24h(topLimit = 5) {
        const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
        const rows = this.db.prepare(`
            ${this._addressEventsCTE()}
            SELECT address, COUNT(*) AS events, MAX(ts) AS lastActive
            FROM address_events
            WHERE ts >= ?
            GROUP BY address
            ORDER BY events DESC
        `).all(sinceMs);
        return { totalActive: rows.length, top: rows.slice(0, topLimit) };
    }

    close() { this.db.close(); }
}

module.exports = Storage;
