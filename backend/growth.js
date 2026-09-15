'use strict';

/*
 * BitBudCoiN Growth — rejestracja portfeli, referrale, statystyki.
 *
 * Cel:
 * - mierzalne pozyskiwanie minerów/użytkowników
 * - referral tracking
 * - publiczne statystyki
 * - kampanie bez manipulowania rynkiem
 * - brak custody
 * - brak sztucznego wolumenu
 *
 * POPRAWKA: pierwsza wersja wymagała ./database (better-sqlite3), którego
 * nie ma na serwerze — nic go tam nie wymaga, więc nigdy nie został
 * wdrożony. Prawdziwą warstwą bazy jest ./storage (node:sqlite), używana
 * przez bbcblockchain.js, payout.js i payout-watcher.js. Growth otwiera
 * WŁASNĄ instancję Storage na ten sam plik (CONFIG.DATABASE) — dokładnie
 * tak jak robi to payout-watcher.js jako osobny proces. WAL + busy_timeout
 * w Storage są tam właśnie po to, żeby to było bezpieczne.
 *
 * - montowane jako trasy w server.js — dziedziczy CORS, express.json,
 *   "trust proxy: loopback" i istniejący rate-limit.js
 * - rate limit na register/miner przez createLimiter z ./rate-limit
 *   (30/h per IP). To NIE jest dowód własności portfela, tylko podnosi
 *   próg dla najprostszego skryptowania. Prawdziwa ochrona = podpis
 *   wiadomości kluczem portfela przy rejestracji — nie dodane, bo nie
 *   wiadomo czy portfel w przeglądarce dziś umie podpisać dowolną
 *   wiadomość poza transakcją
 * - adres: CELOWO tylko mainnet (bez opcjonalnego "t") — /stats ma
 *   mierzyć prawdziwy wzrost, nie testnet
 */

const crypto = require('crypto');
const CONFIG = require('./config');
const Storage = require('./storage');

const { createLimiter } = require('./rate-limit');

const storage = new Storage(CONFIG.DATABASE);
const db = storage.db;

db.exec(`
CREATE TABLE IF NOT EXISTS growth_users (

    id TEXT PRIMARY KEY,
    wallet TEXT UNIQUE,
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    created_at INTEGER,
    miners INTEGER DEFAULT 0,
    referrals INTEGER DEFAULT 0

)
`);

db.exec(`
CREATE TABLE IF NOT EXISTS growth_referrals (

    id TEXT PRIMARY KEY,
    referrer TEXT,
    referred TEXT,
    created_at INTEGER

)
`);

db.exec(`
CREATE TABLE IF NOT EXISTS growth_events (

    id TEXT PRIMARY KEY,
    type TEXT,
    timestamp INTEGER,
    data TEXT

)
`);

function randomId(prefix) {
    return prefix + '_' + crypto.randomBytes(12).toString('hex');
}

function referralCode() {
    return crypto.randomBytes(5).toString('hex').toUpperCase();
}

function validAddress(wallet) {
    return (
        typeof wallet === 'string' &&
        /^BbC[0-9a-fA-F]{40}$/.test(wallet)
    );
}

function recordEvent(type, data) {
    db.prepare(
        `INSERT INTO growth_events (id, type, timestamp, data) VALUES (?, ?, ?, ?)`
    ).run(randomId('evt'), type, Date.now(), JSON.stringify(data || {}));
}

function findUserByWallet(wallet) {
    return db.prepare(
        `SELECT * FROM growth_users WHERE wallet = ?`
    ).get(wallet);
}

function findUserByReferral(code) {
    return db.prepare(
        `SELECT * FROM growth_users WHERE referral_code = ?`
    ).get(code);
}

function registerWallet(walletInput, referralInput) {
    const wallet = String(walletInput || '').trim();
    const referral = String(referralInput || '').trim().toUpperCase();

    if (!validAddress(wallet)) {
        return {
            status: 400,
            body: { ok: false, error: 'Nieprawidłowy adres BbC.' }
        };
    }

    const existing = findUserByWallet(wallet);

    if (existing) {
        return {
            status: 200,
            body: {
                ok: true,
                existing: true,
                user: {
                    id: existing.id,
                    referral_code: existing.referral_code
                }
            }
        };
    }

    const referrer = referral ? findUserByReferral(referral) : null;
    const id = randomId('usr');
    const code = referralCode();
    const now = Date.now();

    db.prepare(
        `INSERT INTO growth_users
            (id, wallet, referral_code, referred_by, created_at, miners, referrals)
         VALUES (?, ?, ?, ?, ?, 0, 0)`
    ).run(id, wallet, code, referrer ? referrer.id : null, now);

    if (referrer) {
        db.prepare(
            `UPDATE growth_users SET referrals = referrals + 1 WHERE id = ?`
        ).run(referrer.id);

        db.prepare(
            `INSERT INTO growth_referrals (id, referrer, referred, created_at)
             VALUES (?, ?, ?, ?)`
        ).run(randomId('ref'), referrer.id, id, now);
    }

    recordEvent('wallet_registered', {
        user_id: id,
        referral: referrer ? referrer.referral_code : null
    });

    return {
        status: 201,
        body: {
            ok: true,
            user: { id, referral_code: code }
        }
    };
}

function pingMiner(walletInput) {
    const wallet = String(walletInput || '').trim();

    if (!validAddress(wallet)) {
        return {
            status: 400,
            body: { ok: false, error: 'Nieprawidłowy adres BbC.' }
        };
    }

    const user = findUserByWallet(wallet);

    if (!user) {
        return {
            status: 404,
            body: { ok: false, error: 'Portfel nie jest zarejestrowany.' }
        };
    }

    db.prepare(
        `UPDATE growth_users SET miners = miners + 1 WHERE id = ?`
    ).run(user.id);

    recordEvent('miner_registered', { user_id: user.id, wallet });

    return {
        status: 201,
        body: { ok: true, miner_count: user.miners + 1 }
    };
}

function getStats() {
    const totals = db.prepare(
        `SELECT
            COUNT(*) AS users,
            COALESCE(SUM(miners), 0) AS miners,
            COALESCE(SUM(referrals), 0) AS referrals
         FROM growth_users`
    ).get();

    const events = db.prepare(
        `SELECT COUNT(*) AS n FROM growth_events`
    ).get();

    return {
        ok: true,
        project: 'BitBudCoiN',
        symbol: 'BbC',
        users: totals.users,
        miners: totals.miners,
        referrals: totals.referrals,
        events: events.n,
        generated_at: new Date().toISOString()
    };
}

function getReferralInfo(codeInput) {
    const code = String(codeInput || '').trim().toUpperCase();
    const user = findUserByReferral(code);

    if (!user) {
        return {
            status: 404,
            body: { ok: false, error: 'Nie znaleziono kodu referencyjnego.' }
        };
    }

    return {
        status: 200,
        body: {
            ok: true,
            referral_code: user.referral_code,
            referrals: user.referrals,
            miners: user.miners
        }
    };
}

const limiter = createLimiter({
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: 'Zbyt wiele żądań rejestracji/zgłoszeń, spróbuj później.'
});

module.exports = {
    registerWallet,
    pingMiner,
    getStats,
    getReferralInfo,
    validAddress,
    limiter
};
