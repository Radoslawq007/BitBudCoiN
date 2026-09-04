// Śledzi aktywnych solo-górników na podstawie heartbeatów zgłaszanych przez
// przeglądarkę (POST /solo/heartbeat) - żadnego liczenia po stronie serwera,
// tylko "kto ostatnio zgłosił się że liczy, i w jakim tempie". Wpis znika z
// listy aktywnych po ACTIVE_WINDOW_SECONDS bez świeżego heartbeatu.
const ACTIVE_WINDOW_SECONDS = 300; // 5 minut - ten sam rząd wielkości co pula

// BEZPIECZEŃSTWO/STABILNOŚĆ (05.08.2026): `Number(intervalSeconds) || 1`
// łapało tylko 0/undefined/NaN - bardzo małą, ale niezerową wartość
// (np. 0.01s, realny bug po stronie przeglądarki albo celowe zaniżenie)
// przepuszczało bez zmian, więc attempts/interval potrafiło wywindować
// hashrate o rzędy wielkości (stąd fałszywe 1.52 GH/s z przeglądarki).
// Math.max wymusza sensowne minimum niezależnie od tego, co przyjdzie.
const MIN_INTERVAL_SECONDS = 1;

// NAPRAWA (dzisiaj, PILNA): this.miners nie mial gornego limitu rozmiaru -
// tylko czyszczenie czasowe (5 min) przy okazji getActiveMiners(). Kazdy
// heartbeat z NOWYM (byle poprawnym formatem, nie realnym) adresem tworzy
// nowy wpis. /solo/heartbeat nie mial zadnego rate-limitera - realistycznie
// nieograniczony wzrost mapy w pamieci, dokladnie ta kategoria problemu,
// ktora juz raz spowodowala OOM (patrz komentarz przy BROADCAST_THROTTLE_MS
// w server.js). Twardy sufit tutaj, jako druga warstwa niezaleznie od
// dzisiejszego dodania strictLimiter na sam endpoint w server.js.
const MAX_TRACKED_MINERS = 2000;

class SoloTracker {
    constructor() {
        this.miners = new Map(); // minerAddress -> { hashrate, lastSeen }
    }

    heartbeat(minerAddress, attempts, intervalSeconds) {
        if (
            !this.miners.has(minerAddress) &&
            this.miners.size >= MAX_TRACKED_MINERS
        ) {
            // Juz znany adres zawsze moze zaktualizowac swoj heartbeat -
            // tylko NOWE adresy sa odrzucane po osiagnieciu sufitu.
            return;
        }
        const validAttempts = Math.max(0, Number(attempts) || 0);
        const validInterval = Math.max(MIN_INTERVAL_SECONDS, Number(intervalSeconds) || MIN_INTERVAL_SECONDS);
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
