// Śledzi aktywnych solo-górników na podstawie heartbeatów zgłaszanych przez
// przeglądarkę (POST /solo/heartbeat) - żadnego liczenia po stronie serwera,
// tylko "kto ostatnio zgłosił się że liczy, i w jakim tempie". Wpis znika z
// listy aktywnych po ACTIVE_WINDOW_SECONDS bez świeżego heartbeatu.
const ACTIVE_WINDOW_SECONDS = 300; // 5 minut - ten sam rząd wielkości co pula

class SoloTracker {
    constructor() {
        this.miners = new Map(); // minerAddress -> { hashrate, lastSeen }
    }

    heartbeat(minerAddress, attempts, intervalSeconds) {
        const validAttempts = Number(attempts) || 0;
        const validInterval = Number(intervalSeconds) || 1;
        const hashrate = validAttempts / validInterval;
        this.miners.set(minerAddress, { hashrate, lastSeen: Date.now() });
    }

    getActiveMiners() {
        const cutoff = Date.now() - ACTIVE_WINDOW_SECONDS * 1000;
        const active = [];
        for (const [minerAddress, data] of this.miners) {
            if (data.lastSeen >= cutoff) {
                active.push({ minerAddress, hashrate: data.hashrate });
            } else {
                this.miners.delete(minerAddress);
            }
        }
        return active;
    }

    getTotalHashrate() {
        return this.getActiveMiners().reduce((sum, m) => sum + m.hashrate, 0);
    }
}

module.exports = SoloTracker;