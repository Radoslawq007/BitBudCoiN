const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const CONFIG = require("./config");
const Storage = require("./storage");
const { asertNextDifficulty } = require("./asert-difficulty");
const MAX_TARGET = (1n << 256n) - 1n;
const GENESIS_TIMESTAMP = Date.UTC(2026, 0, 1);
// Oplata protokolu - usztywniona w kodzie, nie w configu (patrz poprzednia
// zmiana). Bez ruszania tego dzisiaj.
const PROJECT_FEE_PERCENT = 0.005;
function difficultyToTargetHex(difficulty) {
    const safe = BigInt(Math.max(1, Math.round(difficulty)));
    return (MAX_TARGET / safe).toString(16).padStart(64, "0");
}
function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
    return crypto.createHash("sha256")
        .update(height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce)
        .digest("hex");
}
function sha256Hex(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}
class Block {
    constructor({ height, timestamp, previousHash, transactions, difficulty, nonce = 0 }) {
        Object.assign(this, { height, timestamp, previousHash, transactions, difficulty, nonce });
        this.hash = this.calculateHash();
    }
    calculateHash() { return computeBlockHash(this); }
    mine(targetHex) {
        while (this.hash > targetHex) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        return this.hash;
    }
}
function emergencyStatePath() {
    return path.join(path.dirname(CONFIG.DATABASE), ".difficulty-emergency-state.json");
}
function loadEmergencyDifficultyState() {
    try {
        const raw = fs.readFileSync(emergencyStatePath(), "utf8");
        const state = JSON.parse(raw);
        if (typeof state.difficulty === "number" && state.difficulty > 0) return state;
    } catch (e) { }
    return null;
}
function saveEmergencyDifficultyState(difficulty, height) {
    try {
        fs.writeFileSync(emergencyStatePath(), JSON.stringify({ difficulty, height, savedAt: Date.now() }));
    } catch (e) {
        console.error("Nie udalo sie zapisac stanu awaryjnej trudnosci: " + e.message);
    }
}
function isProjectFeeActive(height) {
    return !!(CONFIG.PROJECT_FEE_ADDRESS &&
        CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT !== undefined &&
        height >= CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT);
}
// vMax (dodane): identycznie jak isProjectFeeActive powyzej, ten sam
// sprawdzony wzorzec z tego samego pliku, nie nowy mechanizm.
// ANCHOR_HEIGHT (blok tuz PRZED aktywacja, ostatni pod starymi zasadami) =
// ASERT_ACTIVATION_HEIGHT - 1. To ten blok jest kotwica ASERT, nie sam
// blok aktywacyjny - jego trudnosc wychodzi Z kotwicy, wiec nie moze nia byc.
function isAsertActive(height) {
    return !!(CONFIG.ASERT_ACTIVATION_HEIGHT !== undefined && height >= CONFIG.ASERT_ACTIVATION_HEIGHT);
}
class Blockchain {
    constructor() {
        this.storage = new Storage(CONFIG.DATABASE);
        // BEZPIECZENSTWO (31.07.2026, zaktualizowane 05.08.2026 przy dodaniu
        // retargetingu): trudnosc NIGDY nie jest wczytywana z zapisanych
        // blokow ani od tego, kto zglasza blok - to pole moze byc
        // sfalszowane (patrz poprawka w receiveBlock() nizej - realny
        // incydent, nie teoria: ktos zglaszal bloki z zanizona trudnoscia,
        // ~550x szybciej niz powinno wychodzic). Start ZAWSZE z tej samej
        // stalej co przy genesis. this.difficulty MOZE sie teraz zmieniac w
        // czasie dzialania przez retargetIfDue() nizej - ale WYLACZNIE
        // liczac z historii WLASNEGO, juz zweryfikowanego lancucha, nigdy z
        // danych przyslanych z zewnatrz.
        this.difficulty = Math.pow(16, CONFIG.DIFFICULTY);
        this._asertAnchor = null; // vMax: cache kotwicy ASERT, patrz _getAsertAnchor()
        if (this.storage.hasBlocks()) {
            this.chain = this.storage.loadChain();
            this._warnIfChainHasGaps();
            this._recomputeDifficultyFromHistory();
            // vMax: stan awaryjny (EDA/reczna korekta) nalezy WYLACZNIE do starego,
            // windowowego systemu. Po aktywacji ASERT ufamy TYLKO swiezo policzonej
            // wartosci z _recomputeDifficultyFromHistory() - wczytanie starego pliku
            // awaryjnego nadpisaloby poprawny wynik ASERT nieaktualna liczba.
            // NAPRAWA STRUKTURALNA (teraz): usunieto warunek "to samo okno".
            // Zalozenie ze "nowe okno = swiezy retargetIfDue juz to ogarnal"
            // bylo BLEDNE - retargetIfDue() do tej pory NIC nie zapisywalo do
            // pliku, wiec po przejsciu do nowego okna kod ufal
            // _recomputeDifficultyFromHistory() (odtwarza WSZYSTKIE okna od
            // stalej bazowej, bez wiedzy o EDA/recznych korektach po drodze -
            // stad kosmiczne liczby, powtarzajace sie za kazdym razem gdy
            // restart trafial akurat po przekroczeniu okna). Teraz
            // retargetIfDue() (nizej) ZAWSZE zapisuje swiezy wynik - zapisany
            // stan jest wiec zawsze aktualny, ufamy mu zawsze, niezaleznie
            // od okna.
            if (!isAsertActive(this.getLatestBlock().height + 1)) {
                const emergencyState = loadEmergencyDifficultyState();
                if (emergencyState) {
                    console.error("Uzywam zapisanego stanu trudnosci (" + emergencyState.difficulty + ") zamiast przeliczonej z historii (" + this.difficulty + ").");
                    this.difficulty = emergencyState.difficulty;
                }
            }
        } else {
            const transactions = CONFIG.GENESIS_TRANSACTIONS.map((tx) => ({
                from: CONFIG.GENESIS_ADDRESS, to: tx.to, amount: tx.amount, type: "genesis"
            }));
            const genesis = new Block({
                height: 0, timestamp: GENESIS_TIMESTAMP, previousHash: "0".repeat(64),
                transactions, difficulty: this.difficulty
            });
            this.chain = [genesis];
            this.storage.saveBlock(genesis);
        }
        this._rebuildIndexes();
    }
    getLatestBlock() { return this.chain[this.chain.length - 1]; }
    getRewardForHeight(height) {
        return CONFIG.BLOCK_REWARD / Math.pow(2, Math.floor(height / CONFIG.HALVING_INTERVAL));
    }
    // Buduje liste transakcji do nowego bloku. HTLC_CREATE/CLAIM/REFUND
    // ZACHOWUJA swoj prawdziwy typ i pola (poprzednio WSZYSTKO trafialo jako
    // "transfer", gubiac htlcId/hashLock/claimant/itd. - to byla realna luka,
    // przez ktora /htlc/submit nie mialby jak w ogole zadzialac, nawet gdyby
    // istnial).
    buildBlockTransactions(rewardRecipient, pendingTransactions = []) {
        const height = this.getLatestBlock().height + 1;
        const reward = this.getRewardForHeight(height);
        const transactions = [{ from: null, to: rewardRecipient, amount: reward, type: "coinbase" }];
        const feeActive = isProjectFeeActive(height);
        let totalMinerFees = 0;
        let totalProtocolCut = 0;
        for (const tx of pendingTransactions) {
            if (tx.type === "HTLC_CREATE") {
                transactions.push({
                    htlcId: tx.htlcId, from: tx.from, to: tx.claimant, amount: tx.amount, fee: tx.fee,
                    hashLock: tx.hashLock, timeoutHeight: tx.timeoutHeight,
                    claimant: tx.claimant, refundee: tx.refundee,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature,
                    type: "HTLC_CREATE"
                });
                totalMinerFees += (tx.fee || 0);
                if (feeActive) totalProtocolCut += tx.amount * PROJECT_FEE_PERCENT;
            } else if (tx.type === "HTLC_CLAIM") {
                // tx.to/tx.amount dopisane PRZEZ server.js z wyniku
                // validateHTLCClaim() PRZED trafieniem do mempoola - sam
                // podpisany payload (z portfela) tego nie zawiera.
                transactions.push({
                    htlcId: tx.htlcId, claimant: tx.claimant, secret: tx.secret,
                    to: tx.to, amount: tx.amount,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature,
                    type: "HTLC_CLAIM"
                });
            } else if (tx.type === "HTLC_REFUND") {
                transactions.push({
                    htlcId: tx.htlcId, refundee: tx.refundee,
                    to: tx.to, amount: tx.amount,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature,
                    type: "HTLC_REFUND"
                });
            } else {
                transactions.push({
                    from: tx.from, to: tx.to, amount: tx.amount, fee: tx.fee,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature, type: "transfer"
                });
                totalMinerFees += (tx.fee || 0);
                if (feeActive) totalProtocolCut += tx.amount * PROJECT_FEE_PERCENT;
            }
        }
        if (totalMinerFees > 0 && CONFIG.PROJECT_FEE_ADDRESS) {
            transactions.push({ from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: totalMinerFees, type: "fee" });
        }
        if (totalProtocolCut > 0) {
            transactions.push({ from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: totalProtocolCut, type: "protocol_fee" });
        }
        return transactions;
    }
    receiveBlock(candidate) {
        const latest = this.getLatestBlock();
        if (candidate.height !== latest.height + 1) return { accepted: false, reason: "wysokosc nie pasuje" };
        if (candidate.previousHash !== latest.hash) return { accepted: false, reason: "previousHash nie pasuje" };
        if (computeBlockHash(candidate) !== candidate.hash) return { accepted: false, reason: "hash sie nie zgadza" };
        // BEZPIECZENSTWO (31.07.2026): candidate.difficulty pochodzi od tego,
        // kto ZGLASZA blok - bez tego sprawdzenia dalo sie wpisac dowolnie
        // niska wartosc, robiac prog trudnosci absurdalnie latwym, mimo ze
        // /info dalej pokazywaloby prawdziwa, wysoka trudnosc sieci. Realny
        // incydent 31.07.2026 (~550x przyspieszenie kopania), nie teoria.
        if (candidate.difficulty !== this.difficulty) {
            return { accepted: false, reason: `nieprawidlowa trudnosc (oczekiwano ${this.difficulty}, otrzymano ${candidate.difficulty})` };
        }
        if (candidate.hash > difficultyToTargetHex(candidate.difficulty)) return { accepted: false, reason: "nie spelnia trudnosci" };
        // BEZPIECZENSTWO (06.08.2026): blok nigdy nie byl sprawdzany pod katem
        // PODWOJNEGO rozwiazania tego samego HTLC. Jesli dwa zgloszenia
        // HTLC_CLAIM dla tego samego htlcId trafily do mempoola (np. klient
        // wyslal drugi raz po braku odpowiedzi), oba mogly wejsc do bloku i
        // OBA zostac wyplacone - realny incydent, nie teoria (BbC wyslane
        // dwa razy za jeden swap). Sprawdza: czy HTLC istnieje, czy nie jest
        // juz rozwiazany we wczesniejszej historii, i czy nie powtarza sie
        // wewnatrz TEGO SAMEGO bloku.
        const seenHtlcResolutions = new Set();
        for (const tx of candidate.transactions) {
            if (tx.type === "HTLC_CLAIM" || tx.type === "HTLC_REFUND") {
                const existing = this.findHTLC(tx.htlcId);
                if (!existing) return { accepted: false, reason: `${tx.type} dla nieistniejacego HTLC ${tx.htlcId}` };
                if (existing.status !== "locked") return { accepted: false, reason: `HTLC ${tx.htlcId} juz ma status "${existing.status}" - podwojne rozwiazanie odrzucone` };
                if (seenHtlcResolutions.has(tx.htlcId)) return { accepted: false, reason: `blok zawiera dwa rozwiazania tego samego HTLC ${tx.htlcId} naraz` };
                seenHtlcResolutions.add(tx.htlcId);
            }
        }
        // SPOJNOSC (05.08.2026): zapis do bazy MUSI sie udac PRZED dodaniem
        // bloku do this.chain. Wczesniej push() szedl PIERWSZY - jesli
        // saveBlock() rzucil (np. transakcja z to_address=null lamiaca
        // NOT NULL w SQLite), blok zostawal w pamieci jako "widmo", ktorego
        // baza nigdy nie miala. Po restarcie loadChain() czyta czysta baze
        // bez tego wpisu - to byla realna przyczyna dziury w lancuchu
        // (bloki 3497 i 3614 zniknely dokladnie tak, bez zadnego bledu w
        // logach, bo wyjatek nigdy nie docieral do nikogo, kto by go
        // zauwazyl).
        try {
            this.storage.saveBlock(candidate);
        } catch (err) {
            return { accepted: false, reason: "blad zapisu do bazy: " + err.message };
        }
        this.chain.push(candidate);
        this._applyBlockToIndexes(candidate);
        // vMax: od aktywacji, ASERT liczy trudnosc dla NASTEPNEGO bloku wprost
        // z kotwicy - stary retargetIfDue() zostaje calkowicie nietkniety i
        // dziala jak zawsze dla wszystkiego PRZED aktywacja.
        if (isAsertActive(candidate.height + 1)) {
            this._applyAsertDifficulty(candidate);
        } else {
            this.retargetIfDue(candidate);
        }
        return { accepted: true, block: candidate };
    }
    // Wywolywane PO udanym zapisaniu kazdego bloku. Jesli wlasnie przyjety
    // blok konczy okno przeliczania (jego wysokosc jest wielokrotnoscia
    // CONFIG.DIFFICULTY_ADJUSTMENT), porownuje jak dlugo NAPRAWDE zajelo
    // wykopanie tych blokow wzgledem tego, ile powinno zajac (przy
    // CONFIG.TARGET_BLOCK_TIME_MS) i proporcjonalnie dostosowuje
    // this.difficulty dla WSZYSTKICH kolejnych blokow. Zmiana ograniczona do
    // max 4x w gore i max 4x w dol na jedno okno, zeby jeden dziwny odczyt
    // zegara albo chwilowy skok hashrate'u nie wywrocil trudnosci do zera
    // albo w kosmos. Blok #0 (genesis) nigdy nie wyzwala przeliczenia - nie
    // ma go z czym porownac.
    // vMax: od aktywacji ASERT ta funkcja juz nigdy nie jest wolana (patrz
    // receiveBlock() i _recomputeDifficultyFromHistory()) - zostaje w
    // calosci nietknieta jako dokladny zapis, jak dzialal stary system dla
    // wszystkiego przed #75000.
    retargetIfDue(justAccepted) {
        const interval = CONFIG.DIFFICULTY_ADJUSTMENT;
        if (justAccepted.height === 0 || justAccepted.height % interval !== 0) return;

        const windowStart = this.chain.find((b) => b.height === justAccepted.height - interval);
        if (!windowStart) return; // za malo historii (np. swiezo zsynchronizowany wezel)

        const actualMs = Math.max(1, justAccepted.timestamp - windowStart.timestamp);
        const expectedMs = interval * CONFIG.TARGET_BLOCK_TIME_MS;

        let ratio = expectedMs / actualMs;
        ratio = Math.max(0.25, Math.min(4, ratio));

        this.difficulty = Math.max(1, this.difficulty * ratio);
        // NAPRAWA STRUKTURALNA (teraz): zapisz KAZDY normalny retarget, nie
        // tylko EDA/reczne korekty. To jest ta brakujaca czesc - bez tego
        // zapisany stan starzeje sie z kazdym oknem, a po restarcie kod nie
        // mial nic swiezego do czego wrocic poza zepsutym przeliczeniem od
        // stalej bazowej.
        saveEmergencyDifficultyState(this.difficulty, justAccepted.height);
    }
    // vMax (dodane): kotwica ASERT = blok ASERT_ACTIVATION_HEIGHT - 1, jego
    // RODZIC dostarcza t_ref (patrz specyfikacja aserti3-2d - "parent bloku
    // kotwicy", nie sama kotwica). Cachowane raz - po znalezieniu kotwica
    // sie nie zmienia nigdy wiecej, wiec liczenie tego przy kazdym bloku
    // byloby zbedna praca.
    _getAsertAnchor() {
        if (this._asertAnchor) return this._asertAnchor;
        const anchorHeight = CONFIG.ASERT_ACTIVATION_HEIGHT - 1;
        const anchorBlock = this.chain[anchorHeight];
        const anchorParentBlock = this.chain[anchorHeight - 1];
        if (!anchorBlock || !anchorParentBlock || anchorBlock.height !== anchorHeight) return null;
        this._asertAnchor = {
            anchorHeight: BigInt(anchorHeight),
            // Timestampy w bbcblockchain.js sa w MILISEKUNDACH (patrz
            // maybeEmergencyAdjust nizej, Date.now() bez konwersji) -
            // specyfikacja ASERT liczy w sekundach, konwersja tutaj, na
            // granicy integracji, nie wewnatrz samego modulu ASERT.
            anchorParentTime: BigInt(Math.floor(anchorParentBlock.timestamp / 1000)),
            anchorDifficulty: BigInt(Math.max(1, Math.round(anchorBlock.difficulty))),
        };
        return this._asertAnchor;
    }
    // vMax (dodane): liczy trudnosc DLA NASTEPNEGO bloku wprost z kotwicy,
    // na podstawie wysokosci/czasu bloku, ktory WLASNIE zostal przyjety.
    // Number(nextDifficulty) - bezpieczne przy realnych wartosciach
    // trudnosci (obecnie rzedu dziesiatek milionow, daleko od granicy
    // precyzji Number ~9e15) - gdyby trudnosc kiedys urosla o rzedy
    // wielkosci wiecej, warto to zrewidowac.
    _applyAsertDifficulty(latestBlock) {
        const anchor = this._getAsertAnchor();
        if (!anchor) {
            console.error("ASERT aktywny (wysokosc " + latestBlock.height + ") ale kotwica nieznaleziona w lancuchu - to nie powinno sie zdarzyc. Trudnosc zostaje bez zmian.");
            return;
        }
        const nextDifficulty = asertNextDifficulty({
            anchorHeight: anchor.anchorHeight,
            anchorParentTime: anchor.anchorParentTime,
            anchorDifficulty: anchor.anchorDifficulty,
            evalHeight: BigInt(latestBlock.height),
            evalTime: BigInt(Math.floor(latestBlock.timestamp / 1000)),
            idealBlockTime: BigInt(CONFIG.BLOCK_TIME),
            halflife: BigInt(CONFIG.ASERT_HALFLIFE_SECONDS),
            maxTarget: MAX_TARGET,
        });
        this.difficulty = Number(nextDifficulty);
    }
    // Wywolywane RAZ przy starcie, zaraz po loadChain(). this.difficulty
    // zaczyna zawsze od tej samej stalej bazowej (patrz konstruktor) - bez
    // tego kroku wezel po restarcie mialby INNA lokalna trudnosc niz wezel,
    // ktory dzialal bez przerwy, mimo identycznego lancucha. Dwa wezly z
    // rozna lokalna trudnoscia odrzucaja nawzajem swoje bloki jako
    // "nieprawidlowa trudnosc" - to realne ryzyko forka miedzy
    // 141.147.98.57 a wezlem kolegi po restarcie, nie tylko czystosc kodu.
    // Rozwiazanie: przewinac wszystkie okna retargetingu, ktore juz minely
    // w zaladowanej historii, dokladnie tak samo jak dzialyby sie na zywo.
    // vMax: po aktywacji ASERT ten "replay" to JEDNO wyliczenie wprost z
    // kotwicy do czubka lancucha - to jest dokladnie ta wlasciwosc ASERT,
    // ktora usuwa dzisiejszego glownego wroga (powtarzajace sie przy
    // kazdym restarcie przeliczanie od zera) na zawsze, zamiast tylko go
    // zaslaniac.
    _recomputeDifficultyFromHistory() {
        const interval = CONFIG.DIFFICULTY_ADJUSTMENT;
        const latestHeight = this.getLatestBlock().height;
        const activationHeight = CONFIG.ASERT_ACTIVATION_HEIGHT;
        const anchorHeight = activationHeight !== undefined ? activationHeight - 1 : undefined;
        const preAsertCeiling = (anchorHeight !== undefined && anchorHeight < latestHeight) ? anchorHeight : latestHeight;
        for (let h = interval; h <= preAsertCeiling; h += interval) {
            const block = this.chain.find((b) => b.height === h);
            if (block) this.retargetIfDue(block);
        }
        if (anchorHeight !== undefined && latestHeight >= anchorHeight) {
            this._applyAsertDifficulty(this.getLatestBlock());
        }
    }
    // Wywolywane RAZ przy starcie. NIE naprawia dziur (to wymaga recznego
    // odzyskania brakujacych blokow, np. z nocnego backupu) - tylko krzyczy
    // o nich glosno w logach, zamiast pozwolic im siedziec niezauwazone
    // miesiacami tak jak bloki 3497 i 3614.
    _warnIfChainHasGaps() {
        for (let i = 1; i < this.chain.length; i++) {
            const expected = this.chain[i - 1].height + 1;
            if (this.chain[i].height !== expected) {
                const missingEnd = this.chain[i].height - 1;
                const label = expected === missingEnd ? `${expected}` : `${expected}-${missingEnd}`;
                console.error(`  DZIURA W LANCUCHU: brakuje bloku/blokow ${label} (baza przeskakuje z wysokosci ${this.chain[i - 1].height} na ${this.chain[i].height})`);
            }
        }
    }
    // SYNCHRONIZACJA NOWEGO WEZLA (06.08.2026): wolane przez p2p.js po
    // otrzymaniu pelnego lancucha od peera (wiadomosc CHAIN). Ta metoda
    // wczesniej NIE ISTNIALA WCALE, mimo ze p2p.js jej uzywal - kazda proba
    // synchronizacji nowego wezla konczyla sie cichym wyjatkiem zlapanym w
    // p2p.js (tylko ostrzezenie w logu), bez faktycznego pobrania historii.
    //
    // Sprawdza: spojnosc hashy/wysokosci przez caly kandydacki lancuch,
    // ze kazdy hash faktycznie odpowiada tresci bloku (computeBlockHash),
    // i ze kazdy hash bije cel wyliczony z WLASNEGO zadeklarowanego
    // difficulty tego bloku (prawdziwy PoW, nie wymyslona liczba).
    //
    // UCZCIWIE O GRANICY TEGO MECHANIZMU: NIE odtwarza pelnej historii
    // retargetingu blok-po-bloku zeby zweryfikowac, ze same wartosci
    // difficulty byly uczciwie wyliczone (tak jak _recomputeDifficultyFromHistory
    // robi to dla WLASNEGO lancucha) - odkad istnieje maybeEmergencyAdjust(),
    // ktore reaguje na realny uplyw czasu (Date.now()), a nie tylko na
    // wysokosc bloku, dokladne odtworzenie "ile ciec EDA naprawde zaszlo
    // miedzy blokiem A i B" nie jest w pelni odtwarzalne z samych
    // timestampow w danych. To oznacza: ta metoda ufa zapisanym wartosciom
    // difficulty jako faktowi historycznemu (jak w prawdziwym Bitcoinie
    // ufa sie skumulowanej pracy), nie weryfikuje ich w 100% niezaleznie.
    // Dla kilku znanych, zaufanych wezlow (jak dzisiaj) to rozsadny
    // kompromis - dla w pelni obcych/wrogich peerow wymagaloby to dalszej
    // pracy.
    replaceChain(candidateChain) {
        if (!Array.isArray(candidateChain) || candidateChain.length === 0) {
            return { accepted: false, reason: "pusty lub nieprawidlowy lancuch" };
        }
        if (candidateChain[0].hash !== this.chain[0].hash) {
            return { accepted: false, reason: "inny genesis - inna siec" };
        }
        if (candidateChain.length <= this.chain.length) {
            return { accepted: false, reason: `krotszy lub rowny (${candidateChain.length} <= ${this.chain.length}) - odrzucony, nie ma powodu podmieniac` };
        }
        for (let i = 0; i < candidateChain.length; i++) {
            const block = candidateChain[i];
            if (block.height !== i) {
                return { accepted: false, reason: `blok #${i}: wysokosc ${block.height} nie pasuje do pozycji` };
            }
            if (i > 0 && block.previousHash !== candidateChain[i - 1].hash) {
                return { accepted: false, reason: `blok #${i}: previousHash nie pasuje do bloku #${i - 1}` };
            }
            if (computeBlockHash(block) !== block.hash) {
                return { accepted: false, reason: `blok #${i}: hash nie zgadza sie z trescia` };
            }
            if (i > 0 && block.hash > difficultyToTargetHex(block.difficulty)) {
                return { accepted: false, reason: `blok #${i}: nie spelnia wlasnej deklarowanej trudnosci (brak realnego PoW)` };
            }
        }
        try {
            this.storage.replaceAllBlocks(candidateChain);
        } catch (err) {
            return { accepted: false, reason: "blad zapisu do bazy: " + err.message };
        }
        this.chain = candidateChain;
        this._warnIfChainHasGaps();
        this._rebuildIndexes();
        this.difficulty = Math.pow(16, CONFIG.DIFFICULTY);
        this._asertAnchor = null; // vMax: nowy lancuch moze miec inna kotwice - nie ufaj staremu cache
        this._recomputeDifficultyFromHistory();
        return { accepted: true, height: this.getLatestBlock().height };
    }
    getChain() { return this.chain; }
    getRecentBlocks(limit = 20, beforeHeight = null) {
        let blocks = this.chain.slice().reverse();
        if (beforeHeight !== null) blocks = blocks.filter((b) => b.height < beforeHeight);
        return blocks.slice(0, limit);
    }
    // ============ HTLC (Hash Time-Locked Contracts) ============
    findHTLC(htlcId) {
        let created = null;
        let resolvedStatus = null;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.type === "HTLC_CREATE" && tx.htlcId === htlcId) {
                    created = { ...tx, createdAtHeight: block.height };
                }
                if (tx.type === "HTLC_CLAIM" && tx.htlcId === htlcId) resolvedStatus = "claimed";
                if (tx.type === "HTLC_REFUND" && tx.htlcId === htlcId) resolvedStatus = "refunded";
            }
        }
        if (!created) return null;
        return { ...created, status: resolvedStatus || "locked" };
    }
    validateHTLCClaim({ htlcId, secret, claimant }) {
        const htlc = this.findHTLC(htlcId);
        if (!htlc) return { valid: false, reason: "HTLC nie istnieje" };
        if (htlc.status !== "locked") return { valid: false, reason: `HTLC ma status "${htlc.status}", nie mozna odebrac` };
        if (claimant !== htlc.claimant) return { valid: false, reason: "tylko wyznaczony odbiorca moze odebrac" };
        const nextHeight = this.getLatestBlock().height + 1;
        if (nextHeight >= htlc.timeoutHeight) return { valid: false, reason: "termin juz minal, odbior niemozliwy - tylko zwrot" };
        if (sha256Hex(secret) !== htlc.hashLock) return { valid: false, reason: "zly sekret - hash sie nie zgadza" };
        return { valid: true, amount: htlc.amount, to: htlc.claimant };
    }
    validateHTLCRefund({ htlcId, refundee }) {
        const htlc = this.findHTLC(htlcId);
        if (!htlc) return { valid: false, reason: "HTLC nie istnieje" };
        if (htlc.status !== "locked") return { valid: false, reason: `HTLC ma status "${htlc.status}", nie mozna zwrocic` };
        if (refundee !== htlc.refundee) return { valid: false, reason: "tylko oryginalny nadawca moze dostac zwrot" };
        const nextHeight = this.getLatestBlock().height + 1;
        if (nextHeight < htlc.timeoutHeight) return { valid: false, reason: `termin jeszcze nie minal (blok ${nextHeight} < ${htlc.timeoutHeight})` };
        return { valid: true, amount: htlc.amount, to: htlc.refundee };
    }
    // INDEKSY WYDAJNOSCIOWE (10.08.2026): getBalance/getAddressStats/
    // getTransactionsForAddress kiedys skanowaly CALY lancuch (63000+
    // blokow) przy KAZDYM wywolaniu - kazde sprawdzenie salda, kazde
    // odswiezenie explorera. To nie jest problem "za duzo ludzi na raz",
    // to problem ktory sam z siebie pogarsza sie z czasem, bo lancuch
    // tylko rosnie. Rozwiazanie: te same wyliczenia co wczesniej, ale
    // zaaplikowane RAZ na blok (przy jego przyjeciu), trzymane w Map,
    // zamiast przeliczane od zera za kazdym zapytaniem. Wyniki musza
    // wychodzic IDENTYCZNIE jak stara wersja - to weryfikowane osobnym
    // testem roznicowym (stara vs nowa implementacja, wiele losowych
    // scenariuszy), nie tylko na oko.
    _rebuildIndexes() {
        this.balances = new Map();
        this.firstSeenHeight = new Map();
        this.addressTransactions = new Map();
        // vMax (dodane): circulatingSupply liczone przyrostowo jak reszta
        // indeksow ponizej - getInfo() wczesniej skanowalo CALY lancuch przy
        // KAZDYM wywolaniu (jedyna metoda, ktorej nie dotknal wczesniejszy
        // refaktor wydajnosci 10.08.2026). Ta sama logika co bylo w getInfo,
        // przeniesiona tutaj i liczona raz na blok zamiast raz na zapytanie.
        this.circulatingSupply = 0;
        for (const block of this.chain) this._applyBlockToIndexes(block);
    }
    _addBalance(address, delta) {
        this.balances.set(address, (this.balances.get(address) || 0) + delta);
    }
    _touchFirstSeen(address, height) {
        if (!this.firstSeenHeight.has(address)) this.firstSeenHeight.set(address, height);
    }
    _applyBlockToIndexes(block) {
        const feeActive = isProjectFeeActive(block.height);
        for (const tx of block.transactions) {
            // vMax (dodane): patrz komentarz w _rebuildIndexes() wyzej.
            if (tx.type === "coinbase" || tx.type === "genesis") {
                this.circulatingSupply += tx.amount;
            }
            const involved = new Set([tx.to, tx.from].filter(Boolean));
            for (const addr of involved) {
                if (!this.addressTransactions.has(addr)) this.addressTransactions.set(addr, []);
                this.addressTransactions.get(addr).push({ ...tx, blockHeight: block.height });
            }
            if (tx.type === "transfer" && tx.to) {
                this._touchFirstSeen(tx.to, block.height);
                const credited = feeActive ? tx.amount * (1 - PROJECT_FEE_PERCENT) : tx.amount;
                this._addBalance(tx.to, credited);
            } else if (tx.type === "HTLC_CLAIM" && tx.to) {
                this._touchFirstSeen(tx.to, block.height);
                this._addBalance(tx.to, tx.amount);
            } else if (tx.type === "HTLC_REFUND" && tx.to) {
                this._touchFirstSeen(tx.to, block.height);
                this._addBalance(tx.to, tx.amount);
            } else if (tx.to && tx.type !== "HTLC_CREATE") {
                this._touchFirstSeen(tx.to, block.height);
                this._addBalance(tx.to, tx.amount);
            }
            if (tx.type === "transfer" && tx.from) {
                this._touchFirstSeen(tx.from, block.height);
                this._addBalance(tx.from, -(tx.amount + (tx.fee || 0)));
            } else if (tx.type === "HTLC_CREATE" && tx.from) {
                this._touchFirstSeen(tx.from, block.height);
                this._addBalance(tx.from, -(tx.amount + (tx.fee || 0)));
            }
        }
    }
    getBalance(address) {
        return this.balances.get(address) || 0;
    }
    getSoloMiners() {
        const seen = new Map();
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.type === "coinbase" && tx.to !== CONFIG.POOL_ADDRESS) {
                    const existing = seen.get(tx.to) || { address: tx.to, totalEarned: 0, blocksFound: 0, lastBlockHeight: 0 };
                    existing.totalEarned += tx.amount;
                    existing.blocksFound += 1;
                    existing.lastBlockHeight = Math.max(existing.lastBlockHeight, block.height);
                    seen.set(tx.to, existing);
                }
            }
        }
        return Array.from(seen.values()).sort((a, b) => b.lastBlockHeight - a.lastBlockHeight);
    }
    getAddressStats(whaleLimit = 10, newestLimit = 10) {
        const addresses = Array.from(this.balances.keys());
        const whales = addresses
            .map((address) => ({ address, balance: this.balances.get(address) }))
            .sort((a, b) => b.balance - a.balance)
            .slice(0, whaleLimit);
        const newest = Array.from(this.firstSeenHeight.entries())
            .map(([address, firstSeenHeight]) => ({ address, firstSeenHeight }))
            .sort((a, b) => b.firstSeenHeight - a.firstSeenHeight)
            .slice(0, newestLimit);
        return { totalAddresses: addresses.length, whales, newest };
    }
    saveCredit(credit) {
        this.storage.saveCredit(credit);
    }
    // NAPRAWA OOM: adres puli pojawia sie jako `to` w coinbase niemal
    // KAZDEGO bloku wykopanego przez pule - przy 75000+ blokach to tablica
    // rzedu dziesiatek tysiecy wpisow. Zwracanie jej w calosci przez
    // /transactions/address/:address (bez zadnego limitu) i JSON.stringify
    // takiej tablicy to bardzo prawdopodobna PRAWDZIWA przyczyna awarii
    // "JavaScript heap out of memory" - zaobserwowanej w logach, nie teoria.
    // Domyslny limit 200 dopasowany do tego samego wzorca co juz istnieje
    // w /blocks (Math.min(...,100)) w server.js.
    getTransactionsForAddress(address, limit = 200) {
        const all = this.addressTransactions.get(address) || [];
        const requested = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
        const safeLimit = Math.min(requested, all.length);
        const result = new Array(safeLimit);
        for (let i = 0; i < safeLimit; i++) result[i] = all[all.length - 1 - i];
        return result;
    }
    // AWARYJNE OBNIZENIE TRUDNOSCI (06.08.2026): retargetIfDue() dziala
    // TYLKO gdy okno CONFIG.DIFFICULTY_ADJUSTMENT blokow sie domknie - a
    // jesli trudnosc kiedykolwiek stanie sie nieosiagalna dla realnego
    // hashrate, okno NIGDY sie nie domyka (bloki po prostu nie powstaja),
    // wiec normalny retarget nigdy nie dostaje szansy zadzialac. Siec
    // utyka trwale. Dokladnie to sie stalo 06.08.2026: przy retargetingu
    // liczonym z historii chaotycznej sesji (bloki co sekunde) trudnosc
    // wyszla rzedu 4e20 - przy realnym hashrate koparek przegladarkowych
    // to postawilo blok #47285 na wiele godzin bez szans na znalezienie.
    // Ta metoda dziala NIEZALEZNIE od okna, na podstawie samego uplywu
    // czasu od ostatniego bloku: jesli minelo znacznie dluzej niz
    // oczekiwano (15x), tnie trudnosc, mocniej im dluzej czekamy (max
    // /1024 na jedno zadzialanie), z odstepem miedzy kolejnymi ciciami
    // zeby dac kazdemu nowemu poziomowi realna szanse. Gdy tylko jakis
    // blok zostanie znaleziony, ten mechanizm sam sie wylacza (licznik
    // czasu resetuje sie do swiezego bloku) i oddaje kontrole normalnemu
    // retargetIfDue().
    // RECZNA KOREKTA (10.08.2026): narzedzie na wypadek gdy EDA sluszne obetnie
    // trudnosc podczas realnego przestoju, ale zostawi ja duzo za nisko wzgledem
    // faktycznego hashrate po powrocie serwera - normalny retargetIfDue naprawia
    // to tylko w tempie max 4x na okno (2028 blokow), co przy duzym rozjezdzie
    // mogloby trwac tysiace blokow. Uzywa DOKLADNIE tego samego mechanizmu
    // zapisu co EDA (saveEmergencyDifficultyState) - wiec przetrwa restart tak
    // samo niezawodnie, bez osobnej sciezki kodu do utrzymania.
    // vMax: OBIE metody nizej (setDifficultyManually, maybeEmergencyAdjust)
    // sa zablokowane po aktywacji ASERT. ASERT z definicji nigdy sie nie
    // zaciska (patrz uzasadnienie w specyfikacji aserti3-2d), wiec mechanizm
    // po ktory ta para istnieje przestaje byc potrzebny - a reczna albo
    // czasowa (Date.now(), NIE deterministyczna miedzy wezlami) zmiana
    // this.difficulty w trakcie dzialania ASERT rozjechalaby wezly
    // natychmiast przy nastepnym bloku.
    setDifficultyManually(newDifficulty) {
        if (isAsertActive(this.getLatestBlock().height + 1)) {
            throw new Error("Reczna zmiana trudnosci zablokowana - ASERT aktywny od bloku " + CONFIG.ASERT_ACTIVATION_HEIGHT + ". Wymagalaby identycznej zmiany na wszystkich wezlach naraz, inaczej natychmiastowy fork.");
        }
        if (typeof newDifficulty !== "number" || !Number.isFinite(newDifficulty) || !(newDifficulty > 0)) {
            throw new Error("Nieprawidlowa wartosc trudnosci - musi byc liczba dodatnia");
        }
        const old = this.difficulty;
        this.difficulty = newDifficulty;
        saveEmergencyDifficultyState(newDifficulty, this.getLatestBlock().height);
        console.error("RECZNA KOREKTA TRUDNOSCI: " + old + " -> " + newDifficulty);
        return { old, new: newDifficulty };
    }

    maybeEmergencyAdjust() {
        const latest = this.getLatestBlock();
        if (latest.height === 0) return;
        if (isAsertActive(latest.height + 1)) return; // vMax: patrz komentarz nad setDifficultyManually
        const msSinceLastBlock = Date.now() - latest.timestamp;
        const target = CONFIG.TARGET_BLOCK_TIME_MS;
        if (msSinceLastBlock < target * 15) return;
        const cooldownMs = target * 3;
        if (this._lastEmergencyAdjustAt && Date.now() - this._lastEmergencyAdjustAt < cooldownMs) return;
        const overshoot = msSinceLastBlock / target;
        const cuts = Math.min(10, Math.max(1, Math.floor(Math.log2(overshoot))));
        const divisor = Math.pow(2, cuts);
        const old = this.difficulty;
        this.difficulty = Math.max(1, this.difficulty / divisor);
        this._lastEmergencyAdjustAt = Date.now();
        saveEmergencyDifficultyState(this.difficulty, latest.height);
        console.error("AWARYJNE OBNIZENIE TRUDNOSCI: " + Math.round(msSinceLastBlock / 60000) + "min bez bloku (oczekiwano " + Math.round(target / 60000) + "min) - dzielone przez " + divisor + ": " + old + " -> " + this.difficulty);
    }
    getInfo() {
        this.maybeEmergencyAdjust();
        const latest = this.getLatestBlock();
        const height = latest.height;
        return {
            network: CONFIG.NETWORK_NAME, symbol: CONFIG.SYMBOL, version: CONFIG.VERSION,
            chainId: CONFIG.CHAIN_ID, height, latestHash: latest.hash,
            difficulty: Math.round(this.difficulty),
            difficultyLeadingZerosApprox: Math.floor(Math.log(this.difficulty) / Math.log(16)),
            totalBlocks: this.chain.length, currentBlockReward: this.getRewardForHeight(height + 1),
            circulatingSupply: this.circulatingSupply, maxSupply: CONFIG.MAX_SUPPLY, premine: CONFIG.PREMINE,
            blocksUntilHalving: CONFIG.HALVING_INTERVAL - (height % CONFIG.HALVING_INTERVAL),
            blocksUntilRetarget: CONFIG.DIFFICULTY_ADJUSTMENT - (height % CONFIG.DIFFICULTY_ADJUSTMENT),
            isValid: true
        };
    }
    close() { this.storage.close(); }
}
module.exports = Blockchain;
module.exports.difficultyToTargetHex = difficultyToTargetHex;
module.exports.computeBlockHash = computeBlockHash;
module.exports.sha256Hex = sha256Hex;
module.exports.isAsertActive = isAsertActive;
