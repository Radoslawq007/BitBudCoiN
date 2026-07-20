const HEARTBEAT_WINDOW_MS = 5 * 60 * 1000; // to samo okno co recentShares w pool.js, dla spójności

// Śledzi górników SOLO "na żywo" na podstawie heartbeatów, które solo-miner.js
// wysyła okresowo w trakcie liczenia hashy. Solo NIE wysyła "shares" jak pula -
// odzywa się do serwera tylko gdy znajdzie cały blok (rzadko), więc bez
// heartbeatu serwer nie ma żadnego sygnału, że ktoś w danej chwili w ogóle kopie.
class SoloTracker {
    constructor() {
        this.recentHeartbeats = []; // { minerAddress, hashrate, timestamp }
    }

    heartbeat(minerAddress, attempts, intervalSeconds) {
        const safeInterval = Math.max(1, Number(intervalSeconds) || 15);
        const hashrate = Math.max(0, Number(attempts) || 0) / safeInterval;
        this.recentHeartbeats.push({ minerAddress, hashrate, timestamp: Date.now() });
        this._prune();
    }

    _prune() {
        const cutoff = Date.now() - HEARTBEAT_WINDOW_MS;
        while (this.recentHeartbeats.length && this.recentHeartbeats[0].timestamp < cutoff) {
            this.recentHeartbeats.shift();
        }
    }

    // Ostatni heartbeat na adres w oknie - ma odzwierciedlać AKTUALNE tempo,
    // nie sumę wszystkich zgłoszeń z ostatnich 5 minut.
    getActiveMiners() {
        this._prune();
        const latestByMiner = new Map();
        for (const hb of this.recentHeartbeats) {
            latestByMiner.set(hb.minerAddress, hb.hashrate);
        }
        return Array.from(latestByMiner.entries())
            .map(([minerAddress, hashrate]) => ({ minerAddress, hashrate }))
            .sort((a, b) => b.hashrate - a.hashrate);
    }

    getTotalHashrate() {
        return this.getActiveMiners().reduce((sum, m) => sum + m.hashrate, 0);
    }
}

module.exports = SoloTracker;
