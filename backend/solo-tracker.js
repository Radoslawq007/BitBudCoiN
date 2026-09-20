// Sledzi aktywnych solo-gorników na podstawie ZWERYFIKOWANYCH share'ow
// (patrz backend/server.js POST /solo/share), a nie samozglaszanych
// attempts/interval jak wczesniej. Kazdy zaliczony share to realny hash,
// ktory faktycznie spelnil shareTarget przeliczony PRZEZ SERWER - wiec
// hashrate liczony stad nie da sie sfalszowac samym POST-em bez realnej
// pracy, ani podszyciem sie pod cudzy adres z zawyzona liczba.
//
// NAPRAWA (20.09.2026): stary model heartbeatowy ufal polom
// attempts/intervalSeconds prosto z body zapytania - zero weryfikacji
// kryptograficznej. Ta sama klasa buga co kiedys dala falszywe 1.52 GH/s
// z przegladarki (za maly interval), tylko ze tutaj mogl to zrobic
// KAZDY jednym POST-em, bez zadnego realnego kopania. ADDRESS_FORMAT
// sprawdzal tylko KSZTALT adresu, nie wlasnosc - kazdy mogl podszyc sie
// pod cudzy adres.
//
// /solo/heartbeat zostaje (kompatybilnosc wstecz ze starszymi zakladkami
// w przegladarce, ktore jeszcze nie dostaly nowego kodu), ale teraz woła
// wylacznie touch() - aktualizuje "ostatnio widziany", BEZ zadnego wplywu
// na wyswietlany hashrate. Jedyna droga do hashrate > 0 to recordShare().

const ACTIVE_WINDOW_SECONDS = 300; // 5 minut - ten sam rzad wielkosci co pula

// NAPRAWA (05.08.2026, zachowana): twardy sufit rozmiaru mapy w pamieci,
// niezaleznie od strictLimiter na samym endpoincie - patrz komentarz przy
// BROADCAST_THROTTLE_MS w server.js po kontekst tej klasy problemu (OOM).
const MAX_TRACKED_MINERS = 2000;

// Ponizej ktorego realny share liczy sie w oknie - patrz komentarz przy
// getActiveMiners(): przy 1 share w oknie okno "od pierwszego share do
// teraz" bywa milisekundy, co daje absurdalny chwilowy skok hashrate.
// Wymog >=2 to tani, uczciwy sposob zeby nie pokazywac szumu jako liczby.
const MIN_SHARES_FOR_RATE = 2;

class SoloTracker {
    constructor() {
        // minerAddress -> { shareTimes: number[], shareDifficulty, lastSeen }
        this.miners = new Map();
    }

    // Wolane WYLACZNIE przez backend/server.js POST /solo/share, PO TYM
    // jak serwer sam przeliczyl i potwierdzil hash <= shareTarget (patrz
    // difficultyToTargetHex w bbcblockchain.js). shareDifficulty to
    // wartosc, ktora SERWER wlasnie uzyl do weryfikacji - nigdy cudza
    // deklaracja klienta.
    recordShare(minerAddress, shareDifficulty) {
        if (
            !this.miners.has(minerAddress) &&
            this.miners.size >= MAX_TRACKED_MINERS
        ) {
            return;
        }

        const now = Date.now();
        const cutoff = now - ACTIVE_WINDOW_SECONDS * 1000;

        const existing =
            this.miners.get(minerAddress) || {
                shareTimes: [],
                shareDifficulty,
                lastSeen: now
            };

        existing.shareTimes.push(now);
        existing.shareTimes =
            existing.shareTimes.filter((t) => t >= cutoff);
        existing.shareDifficulty = shareDifficulty;
        existing.lastSeen = now;

        this.miners.set(minerAddress, existing);
    }

    // Kompatybilnosc wsteczna ze starym /solo/heartbeat: aktualizuje
    // tylko "ostatnio widziany", zero wplywu na hashrate.
    touch(minerAddress) {
        if (
            !this.miners.has(minerAddress) &&
            this.miners.size >= MAX_TRACKED_MINERS
        ) {
            return;
        }

        const existing =
            this.miners.get(minerAddress) || {
                shareTimes: [],
                shareDifficulty: 0,
                lastSeen: Date.now()
            };

        existing.lastSeen = Date.now();
        this.miners.set(minerAddress, existing);
    }

    getActiveMiners() {
        const now = Date.now();
        const cutoff = now - ACTIVE_WINDOW_SECONDS * 1000;
        const active = [];

        for (const [minerAddress, data] of this.miners) {
            if (data.lastSeen < cutoff) {
                this.miners.delete(minerAddress);
                continue;
            }

            const recentShares =
                data.shareTimes.filter((t) => t >= cutoff);

            let hashrate = 0;

            if (recentShares.length >= MIN_SHARES_FOR_RATE) {
                // Okno liczone od NAJSTARSZEGO share'a w oknie do teraz,
                // nie od stalych 300s - zeby swiezo dolaczony gornik z
                // kilkoma share'ami w 10 sekund nie wygladal jak ktos
                // liczacy od 5 minut (co zanizyloby jego realny hashrate).
                const windowStart = recentShares[0];
                const windowSeconds =
                    Math.max(1, (now - windowStart) / 1000);

                // difficulty ~= oczekiwana liczba prob na 1 udany hash
                // (patrz difficultyToTargetHex: target = MAX_TARGET/difficulty),
                // wiec N share'ow o danej trudnosci w T sekund =>
                // szacowany hashrate = N * difficulty / T.
                hashrate =
                    (recentShares.length * data.shareDifficulty) /
                    windowSeconds;
            }

            active.push({
                minerAddress,
                hashrate,
                shareCount: recentShares.length
            });
        }

        return active;
    }

    getTotalHashrate() {
        return this.getActiveMiners()
            .reduce((sum, m) => sum + m.hashrate, 0);
    }
}

module.exports = SoloTracker;
