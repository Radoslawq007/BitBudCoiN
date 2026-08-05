// Śledzi aktywnych solo-górników na podstawie heartbeatów zgłaszanych przez
// przeglądarkę (POST /solo/heartbeat) - żadnego liczenia po stronie serwera,
// tylko "kto ostatnio zgłosił się że liczy, i w jakim tempie". Wpis znika z
// listy aktywnych po ACTIVE_WINDOW_SECONDS bez świeżego heartbeatu.
const ACTIVE_WINDOW_SECONDS = 300; // 5 minut - ten sam rząd wielkości co pula

// Minimalny sensowny interwał między heartbeatami. Poniżej tego serwer NIE
// UFA zgłoszeniu - dzielenie liczby prób przez bardzo mały (ale niezerowy,
// więc "|| 1" tego nie złapie) czas daje absurdalnie zawyżony hashrate.
// Prawdziwe heartbeaty to z natury okresowe zgłoszenia co kilka sekund, nie
// ułamki sekundy.
const MIN_INTERVAL_SECONDS = 1;

class SoloTracker {
    constructor() {
        this.miners = new Map(); // minerAddress -> { hashrate, lastSeen }
    }

    heartbeat(minerAddress, attempts, intervalSeconds) {
        const validAttempts = Number(attempts) || 0;
        const validInterval = Number(intervalSeconds) || 1;

        // Zbyt mały interwał = nie ufamy temu zgłoszeniu w ogóle - ciche
        // pominięcie (nie błąd, żeby nie psuć działania miernika przy
        // drobnym zacięciu przeglądarki), zamiast dzielić przez ułamek
        // sekundy i pokazywać fikcyjne GH/s.
        if (validInterval < MIN_INTERVAL_SECONDS) return;

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
