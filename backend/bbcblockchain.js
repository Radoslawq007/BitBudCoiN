"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CONFIG = require("./config");
const Storage = require("./storage");

const {
    asertNextDifficulty
} = require("./asert-difficulty");


const MAX_TARGET =
    (1n << 256n) - 1n;

const GENESIS_TIMESTAMP =
    Date.UTC(2026, 0, 1);

const PROJECT_FEE_PERCENT =
    0.005;


function difficultyToTargetHex(difficulty) {

    const safe =
        BigInt(
            Math.max(
                1,
                Math.round(
                    Number(difficulty)
                )
            )
        );

    return (
        MAX_TARGET / safe
    )
        .toString(16)
        .padStart(64, "0");
}


function computeBlockHash({
    height,
    previousHash,
    timestamp,
    transactions,
    difficulty,
    nonce
}) {

    return crypto
        .createHash("sha256")
        .update(
            height +
            previousHash +
            timestamp +
            JSON.stringify(
                transactions
            ) +
            difficulty +
            nonce
        )
        .digest("hex");
}


function sha256Hex(input) {

    return crypto
        .createHash("sha256")
        .update(input)
        .digest("hex");
}


class Block {

    constructor({
        height,
        timestamp,
        previousHash,
        transactions,
        difficulty,
        nonce = 0
    }) {

        Object.assign(
            this,
            {
                height,
                timestamp,
                previousHash,
                transactions,
                difficulty,
                nonce
            }
        );

        this.hash =
            this.calculateHash();
    }


    calculateHash() {

        return computeBlockHash(
            this
        );
    }


    mine(targetHex) {

        while (
            this.hash >
            targetHex
        ) {

            this.nonce++;

            this.hash =
                this.calculateHash();
        }

        return this.hash;
    }
}


function emergencyStatePath() {

    return path.join(
        path.dirname(
            CONFIG.DATABASE
        ),
        ".difficulty-emergency-state.json"
    );
}


function loadEmergencyDifficultyState() {

    try {

        const raw =
            fs.readFileSync(
                emergencyStatePath(),
                "utf8"
            );

        const state =
            JSON.parse(raw);

        if (
            typeof state.difficulty ===
                "number" &&
            state.difficulty > 0
        ) {
            return state;
        }

    } catch (e) {}

    return null;
}


function saveEmergencyDifficultyState(
    difficulty,
    height
) {

    try {

        fs.writeFileSync(
            emergencyStatePath(),
            JSON.stringify({
                difficulty,
                height,
                savedAt:
                    Date.now()
            })
        );

    } catch (e) {

        console.error(
            "Nie udalo sie zapisac stanu awaryjnej trudnosci: " +
            e.message
        );
    }
}


function isProjectFeeActive(height) {

    return !!(
        CONFIG.PROJECT_FEE_ADDRESS &&
        CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT !==
            undefined &&
        height >=
            CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT
    );
}


function isAsertActive(height) {

    return !!(
        CONFIG.ASERT_ENABLED === true &&
        CONFIG.ASERT_ACTIVATION_HEIGHT !==
            undefined &&
        height >=
            CONFIG.ASERT_ACTIVATION_HEIGHT
    );
}


class Blockchain {

    constructor() {

        this.storage =
            new Storage(
                CONFIG.DATABASE
            );

        this.difficulty =
            Math.pow(
                16,
                CONFIG.DIFFICULTY
            );

        this._asertAnchor =
            null;

        if (
            this.storage.hasBlocks()
        ) {

            this.chain =
                this.storage.loadChain();

            this._warnIfChainHasGaps();

            // NAPRAWA (2026-08-24, PILNA - blad zlapany tej samej nocy):
            // _recomputeDifficultyFromHistory() wola retargetIfDue(),
            // ktore uzywa this.blockByHeight - ale ten indeks powstaje
            // WYLACZNIE w _rebuildIndexes(). Musi byc wywolane PRZED
            // _recomputeDifficultyFromHistory(), inaczej
            // "Cannot read properties of undefined (reading 'get')"
            // przy kazdym starcie z istniejacym lancuchem.
            this._rebuildIndexes();

            this._recomputeDifficultyFromHistory();

            if (
                !isAsertActive(
                    this.getLatestBlock()
                        .height + 1
                )
            ) {

                const emergencyState =
                    loadEmergencyDifficultyState();

                if (
                    emergencyState
                ) {

                    this.difficulty =
                        emergencyState.difficulty;
                }
            }

        } else {

            const transactions =
                CONFIG.GENESIS_TRANSACTIONS
                    .map(
                        tx => ({
                            from:
                                CONFIG.GENESIS_ADDRESS,

                            to:
                                tx.to,

                            amount:
                                tx.amount,

                            type:
                                "genesis"
                        })
                    );

            const genesis =
                new Block({
                    height: 0,

                    timestamp:
                        GENESIS_TIMESTAMP,

                    previousHash:
                        "0".repeat(64),

                    transactions,

                    difficulty:
                        this.difficulty
                });

            this.chain = [
                genesis
            ];

            this.storage.saveBlock(
                genesis
            );

            this._rebuildIndexes();
        }
    }


    getLatestBlock() {

        return this.chain[
            this.chain.length - 1
        ];
    }


    // NAPRAWA (2026-08-28, PILNA): this.difficulty byla zwyklym polem -
    // ustawiana RAZ, w chwili przyjecia bloku, przy uzyciu znacznika
    // czasu TEGO WLASNIE bloku jako "evalTime" dla ASERT. Miedzy blokami
    // nic tego nie przeliczalo, nawet gdy mijaly godziny bez nowego
    // bloku - formula ASERT nigdy nie "widziala" uplywu realnego czasu,
    // tylko powtarzala to samo pytanie o przeszlosc. Skutek zaobserwowany
    // na produkcji: blok #100880 padl przy bardzo duzej mocy (~1.6 GH/s
    // solo), trudnosc ustawila sie pod TA moc i zamarzla tam - 8+ godzin
    // pozniej, przy mocy pojedynczych-kilkuset kH/s w puli, cel wciaz byl
    // ten sam, praktycznie nieosiagalny. Restart NIE naprawial tego -
    // liczony ta sama, zamrozona metoda.
    //
    // Naprawa: this.difficulty jest teraz akcesorem (get/set), nie
    // zwyklym polem. Gdy vMax aktywny - KAZDY odczyt liczy swiezo, na
    // podstawie Date.now(), nie zapisanej przeszlosci - dokladnie tak
    // jak ASERT ma dzialac z definicji (deterministyczny, ciagle
    // obliczalny z kotwicy + biezacego czasu, bez cache'owania).
    // Zweryfikowane matematycznie: symulacja 8h przerwy przy
    // halflife=3600s daje spadek dokladnie 256x = 2^8 - zgodne co do
    // bita z oczekiwana formula.
    //
    // Kazde dotychczasowe "this.difficulty = X" w tym pliku (konstruktor,
    // retargetIfDue, replaceChain, setDifficultyManually,
    // maybeEmergencyAdjust) dziala bez zmian - trafia do setera, ktory
    // zapisuje do this._legacyDifficulty. Dla legacy DAA (przed vMax) to
    // dokladnie to samo zachowanie co wczesniej. Po aktywacji vMax getter
    // ignoruje ten backing field calkowicie - liczy zawsze na zywo.
    get difficulty() {

        if (
            isAsertActive(
                this.getLatestBlock().height + 1
            )
        ) {

            try {

                return this._calculateAsertDifficulty({

                    height:
                        this.getLatestBlock().height,

                    timestamp:
                        Date.now()
                });

            } catch (err) {

                console.error(
                    "vMax zywa trudnosc - blad, uzywam ostatniej znanej wartosci: " +
                    err.message
                );

                return this._legacyDifficulty;
            }
        }

        return this._legacyDifficulty;
    }


    set difficulty(value) {

        this._legacyDifficulty =
            value;
    }


    getRewardForHeight(height) {

        return (
            CONFIG.BLOCK_REWARD /
            Math.pow(
                2,
                Math.floor(
                    height /
                    CONFIG.HALVING_INTERVAL
                )
            )
        );
    }


    _getAsertAnchor() {

        if (
            this._asertAnchor
        ) {
            return this._asertAnchor;
        }

        const anchorHeight =
            CONFIG.ASERT_ANCHOR_HEIGHT;

        // NAPRAWA (dzisiaj, PILNA): PRZED - this.chain[anchorHeight]
        // zakladalo ze POZYCJA w tablicy = WYSOKOSC bloku. Falszywe
        // zalozenie - cala ta noc udowodnila dziesiatki dziur w
        // historii lancucha (_warnIfChainHasGaps). Odczyt po WYSOKOSCI
        // (blockByHeight), nie po pozycji.
        const anchorBlock =
            this.blockByHeight.get(
                anchorHeight
            );

        const anchorParent =
            this.blockByHeight.get(
                anchorHeight - 1
            );

        if (
            !anchorBlock ||
            !anchorParent ||
            anchorBlock.height !==
                anchorHeight
        ) {
            return null;
        }

        this._asertAnchor = {

            anchorHeight:
                BigInt(
                    anchorHeight
                ),

            anchorParentTime:
                BigInt(
                    Math.floor(
                        anchorParent.timestamp /
                        1000
                    )
                ),

            anchorDifficulty:
                BigInt(
                    Math.max(
                        1,
                        Math.round(
                            anchorBlock.difficulty
                        )
                    )
                )
        };

        return this._asertAnchor;
    }


    _calculateAsertDifficulty(
        evaluationBlock
    ) {

        const anchor =
            this._getAsertAnchor();

        if (!anchor) {

            throw new Error(
                "vMax: brak bloku kotwicznego #" +
                CONFIG.ASERT_ANCHOR_HEIGHT
            );
        }

        // NAPRAWA (2026-08-24): asertNextDifficulty() (asert-difficulty.js)
        // zwraca BigInt CELOWO - cala matematyka ASERT jest na BigInt,
        // zeby kazdy node liczyl identyczny wynik co do bita. Ale
        // this.difficulty, block.difficulty (kolumna REAL w SQLite) i
        // kazde miejsce ktore ich uzywa (Math.round, JSON.stringify,
        // porownania z candidate.difficulty) oczekuja Number. Ten BigInt
        // nigdy nie byl konwertowany z powrotem - wchodzil surowy do
        // this.difficulty w receiveBlock() i _recomputeDifficultyFromHistory()
        // w chwili gdy blok #99999 (kotwica) zostal przyjety. Stad trzy
        // rozne stack trace'y (pool.js:87 Math.round, bbcblockchain.js
        // getInfo Math.round, server.js JSON.stringify w getWork) - jedno
        // zrodlo, ta granica. Konwersja TUTAJ naprawia wszystkie 4
        // wywolania tej funkcji naraz (_expectedDifficultyForBlock,
        // receiveBlock walidacja, receiveBlock przypisanie this.difficulty,
        // _recomputeDifficultyFromHistory).
        const rawDifficulty =
            asertNextDifficulty({

                anchorHeight:
                    anchor.anchorHeight,

                anchorParentTime:
                    anchor.anchorParentTime,

                anchorDifficulty:
                    anchor.anchorDifficulty,

                evalHeight:
                    BigInt(
                        evaluationBlock.height
                    ),

                evalTime:
                    BigInt(
                        Math.floor(
                            evaluationBlock.timestamp /
                            1000
                        )
                    ),

                idealBlockTime:
                    BigInt(
                        CONFIG
                            .ASERT_IDEAL_BLOCK_TIME_SECONDS
                    ),

                halflife:
                    BigInt(
                        CONFIG
                            .ASERT_HALFLIFE_SECONDS
                    ),

                maxTarget:
                    MAX_TARGET
            });

        return Number(
            rawDifficulty
        );
    }


    _expectedDifficultyForBlock(
        height
    ) {

        if (
            !isAsertActive(
                height
            )
        ) {
            return null;
        }

        // NAPRAWA (dzisiaj, PILNA): ten sam blad co w _getAsertAnchor() -
        // indeksowanie tablicy zamiast odczytu po wysokosci.
        const evaluationBlock =
            this.blockByHeight.get(
                height - 1
            );

        if (!evaluationBlock) {
            return null;
        }

        return this._calculateAsertDifficulty(
            evaluationBlock
        );
    }


    buildBlockTransactions(
        rewardRecipient,
        pendingTransactions = []
    ) {

        const height =
            this.getLatestBlock()
                .height + 1;

        const reward =
            this.getRewardForHeight(
                height
            );

        const transactions = [
            {
                from: null,
                to: rewardRecipient,
                amount: reward,
                type: "coinbase"
            }
        ];

        const feeActive =
            isProjectFeeActive(
                height
            );

        let totalMinerFees = 0;
        let totalProtocolCut = 0;

        for (
            const tx of
            pendingTransactions
        ) {

            if (
                tx.type ===
                "HTLC_CREATE"
            ) {

                transactions.push({

                    htlcId:
                        tx.htlcId,

                    from:
                        tx.from,

                    to:
                        tx.claimant,

                    amount:
                        tx.amount,

                    fee:
                        tx.fee,

                    hashLock:
                        tx.hashLock,

                    timeoutHeight:
                        tx.timeoutHeight,

                    claimant:
                        tx.claimant,

                    refundee:
                        tx.refundee,

                    timestamp:
                        tx.timestamp,

                    publicKey:
                        tx.publicKey,

                    signature:
                        tx.signature,

                    type:
                        "HTLC_CREATE"
                });

                totalMinerFees +=
                    tx.fee || 0;

                if (feeActive) {

                    totalProtocolCut +=
                        tx.amount *
                        PROJECT_FEE_PERCENT;
                }

            } else if (
                tx.type ===
                "HTLC_CLAIM"
            ) {

                transactions.push({

                    htlcId:
                        tx.htlcId,

                    claimant:
                        tx.claimant,

                    secret:
                        tx.secret,

                    to:
                        tx.to,

                    amount:
                        tx.amount,

                    timestamp:
                        tx.timestamp,

                    publicKey:
                        tx.publicKey,

                    signature:
                        tx.signature,

                    type:
                        "HTLC_CLAIM"
                });

            } else if (
                tx.type ===
                "HTLC_REFUND"
            ) {

                transactions.push({

                    htlcId:
                        tx.htlcId,

                    refundee:
                        tx.refundee,

                    to:
                        tx.to,

                    amount:
                        tx.amount,

                    timestamp:
                        tx.timestamp,

                    publicKey:
                        tx.publicKey,

                    signature:
                        tx.signature,

                    type:
                        "HTLC_REFUND"
                });

            } else {

                transactions.push({

                    from:
                        tx.from,

                    to:
                        tx.to,

                    amount:
                        tx.amount,

                    fee:
                        tx.fee,

                    timestamp:
                        tx.timestamp,

                    publicKey:
                        tx.publicKey,

                    signature:
                        tx.signature,

                    type:
                        "transfer"
                });

                totalMinerFees +=
                    tx.fee || 0;

                if (feeActive) {

                    totalProtocolCut +=
                        tx.amount *
                        PROJECT_FEE_PERCENT;
                }
            }
        }

        if (
            totalMinerFees > 0 &&
            CONFIG.PROJECT_FEE_ADDRESS
        ) {

            transactions.push({

                from: null,

                to:
                    CONFIG.PROJECT_FEE_ADDRESS,

                amount:
                    totalMinerFees,

                type:
                    "fee"
            });
        }

        if (
            totalProtocolCut > 0
        ) {

            transactions.push({

                from: null,

                to:
                    CONFIG.PROJECT_FEE_ADDRESS,

                amount:
                    totalProtocolCut,

                type:
                    "protocol_fee"
            });
        }

        return transactions;
    }


    receiveBlock(candidate) {

        const latest =
            this.getLatestBlock();

        if (
            candidate.height !==
            latest.height + 1
        ) {

            return {
                accepted: false,
                reason:
                    "wysokosc nie pasuje"
            };
        }

        if (
            candidate.previousHash !==
            latest.hash
        ) {

            return {
                accepted: false,
                reason:
                    "previousHash nie pasuje"
            };
        }

        if (
            computeBlockHash(
                candidate
            ) !==
            candidate.hash
        ) {

            return {
                accepted: false,
                reason:
                    "hash sie nie zgadza"
            };
        }


        // NAPRAWA (dzisiaj, PILNA): fix w server.js (ADDRESS_FORMAT na
        // /pool/work, /pool/submit, /solo/work, /solo/heartbeat) chronil
        // tylko ZAPYTANIE o prace - miner mial dostac szablon z juz
        // poprawnym adresem, ale receiveBlock() TUTAJ, ktora faktycznie
        // przyjmuje gotowy blok (i z API, i z P2P od innych wezlow), w
        // ogole nie sprawdzala co naprawde ladowalo sie do coinbase przy
        // submicie. Nic nie stalo na przeszkodzie, zeby zly klient (albo
        // zepsuty miner-client) wyslal dowolny tekst jako odbiorce
        // nagrody - dokladnie ten scenariusz ("smieci na stale w
        // coinbase w prawdziwym bloku"), tylko o warstwe glebiej.
        for (
            const tx of
            candidate.transactions
        ) {

            if (
                tx.type ===
                "coinbase"
            ) {

                if (
                    typeof tx.to !==
                        "string" ||
                    !/^BbC[0-9a-fA-F]{40}$/.test(
                        tx.to
                    )
                ) {

                    return {
                        accepted: false,
                        reason:
                            "nieprawidlowy format adresu w coinbase"
                    };
                }
            }
        }


        // NAPRAWA (dzisiaj, PILNA): poprawka z 2026-08-28 (porownanie z
        // zywym this.difficulty) zamienila jeden problem na drugi. this.difficulty
        // liczy sie na Date.now() W MOMENCIE ODCZYTU - miedzy /pool/work
        // (ktore TEZ czyta je na zywo, w chwili wydania pracy) a odeslaniem
        // znalezionego bloku mija realny czas liczenia hashy, a ASERT jest
        // ciagly w czasie. "Teraz" przy walidacji to juz INNA wartosc niz
        // "teraz" przy wydaniu pracy. Na produkcji: kilkanascie kolejnych
        // odrzucen na tej samej wysokosci, za kazdym razem z inna
        // "oczekiwana" trudnoscia, malejaca w miare uplywu czasu (dokladnie
        // to co przewiduje ten mechanizm gdy blok nie ląduje).
        //
        // Naprawa: licz oczekiwana trudnosc dla WLASNEGO znacznika czasu
        // kandydata (candidate.timestamp) - tego samego pola, ktore
        // dostal w tresci pracy i ktorego nie mogl zmienic bez zepsucia
        // hasha (juz zweryfikowanego wyzej). To NIE jest powrot do
        // zamrozonej trudnosci sprzed 2026-08-28 - kazde wywolanie nadal
        // liczy swiezo, tylko dla WLASCIWEGO momentu w czasie zamiast
        // ciagle przesuwajacego sie "teraz". Dla legacy (nie-vMax) bez
        // zmian - this.difficulty tam to zwykle pole, nie zywy zegar.
        //
        // Domkniete jednoczesnie: candidate.timestamp nie mial ZADNEGO
        // ograniczenia sensownosci nigdzie w tej funkcji. Bez gornej
        // granicy w przyszlosc powyzsza zmiana otwiera realny wektor -
        // gornik moglby zadeklarowac dowolnie odlegly czas w przyszlosci,
        // zeby ASERT "zobaczyl" wiecej uplynionego czasu i policzyl
        // sztucznie nizsza trudnosc. Dwa warunki ponizej to zamykaja -
        // analogiczne do standardowego "max N w przyszlosc" z innych
        // lancuchow PoW. Dolna granica: musi byc pozniejszy niz poprzedni
        // blok (monotonicznosc) - bez gornego ograniczenia "jak bardzo w
        // przeszlosc", bo przeliczenie ASERT dla dowolnego momentu w
        // przeszlosci jest samo-spojne niezaleznie od tego jak stare.

        if (
            candidate.timestamp <=
            latest.timestamp
        ) {

            return {
                accepted: false,
                reason:
                    "znacznik czasu bloku nie jest pozniejszy niz poprzedni blok"
            };
        }

        const MAX_FUTURE_DRIFT_MS =
            10000;

        if (
            candidate.timestamp >
            Date.now() +
                MAX_FUTURE_DRIFT_MS
        ) {

            return {
                accepted: false,
                reason:
                    "znacznik czasu bloku jest zbyt daleko w przyszlosci"
            };
        }

        let expectedDifficulty;

        try {

            expectedDifficulty =
                isAsertActive(
                    candidate.height
                )
                    ? this._calculateAsertDifficulty({

                          height:
                              latest.height,

                          timestamp:
                              candidate.timestamp
                      })
                    : this.difficulty;

        } catch (err) {

            return {
                accepted: false,
                reason:
                    "nie udalo sie policzyc oczekiwanej trudnosci: " +
                    err.message
            };
        }

        if (
            candidate.difficulty !==
            expectedDifficulty
        ) {

            console.error(
                "DIAG-TRUDNOSC " +
                JSON.stringify({
                    candidateHeight: candidate.height,
                    candidateTimestamp: candidate.timestamp,
                    candidateDifficulty: candidate.difficulty,
                    latestHeight: latest.height,
                    latestTimestamp: latest.timestamp,
                    expectedDifficulty: expectedDifficulty,
                    nowAtValidation: Date.now(),
                    gapCandidateVsLatestMs: candidate.timestamp - latest.timestamp,
                    gapNowVsCandidateMs: Date.now() - candidate.timestamp
                })
            );

            return {
                accepted: false,
                reason:
                    `nieprawidlowa trudnosc ` +
                    `(oczekiwano ${expectedDifficulty} dla czasu bloku, ` +
                    `otrzymano ${candidate.difficulty})`
            };
        }


        if (
            candidate.hash >
            difficultyToTargetHex(
                candidate.difficulty
            )
        ) {

            return {
                accepted: false,
                reason:
                    "nie spelnia trudnosci"
            };
        }


        const seenHtlcResolutions =
            new Set();

        for (
            const tx of
            candidate.transactions
        ) {

            if (
                tx.type ===
                    "HTLC_CLAIM" ||
                tx.type ===
                    "HTLC_REFUND"
            ) {

                const existing =
                    this.findHTLC(
                        tx.htlcId
                    );

                if (!existing) {

                    return {
                        accepted: false,
                        reason:
                            `${tx.type} dla nieistniejacego HTLC ${tx.htlcId}`
                    };
                }

                if (
                    existing.status !==
                    "locked"
                ) {

                    return {
                        accepted: false,
                        reason:
                            `HTLC ${tx.htlcId} juz ma status "${existing.status}" - podwojne rozwiazanie odrzucone`
                    };
                }

                if (
                    seenHtlcResolutions.has(
                        tx.htlcId
                    )
                ) {

                    return {
                        accepted: false,
                        reason:
                            `blok zawiera dwa rozwiazania tego samego HTLC ${tx.htlcId}`
                    };
                }

                seenHtlcResolutions.add(
                    tx.htlcId
                );
            }
        }


        try {

            this.storage.saveBlock(
                candidate
            );

        } catch (err) {

            return {
                accepted: false,
                reason:
                    "blad zapisu do bazy: " +
                    err.message
            };
        }

        this.chain.push(
            candidate
        );

        this._applyBlockToIndexes(
            candidate
        );


        // NAPRAWA (2026-08-28): PRZED - tutaj jawnie przeliczano i
        // zapisywano this.difficulty po kazdym przyjetym bloku, tym
        // samym zamrozonym sposobem. TERAZ - dla vMax nic tu nie trzeba
        // robic, getter this.difficulty liczy zawsze na zywo przy kazdym
        // odczycie. Legacy DAA (przed aktywacja vMax) dziala bez zmian.
        if (
            !isAsertActive(
                candidate.height + 1
            )
        ) {

            this.retargetIfDue(
                candidate
            );
        }

        return {
            accepted: true,
            block:
                candidate
        };
    }


    retargetIfDue(
        justAccepted,
        persist = true
    ) {

        if (
            isAsertActive(
                justAccepted.height + 1
            )
        ) {
            return;
        }

        const interval =
            CONFIG.DIFFICULTY_ADJUSTMENT;

        if (
            justAccepted.height === 0 ||
            justAccepted.height %
                interval !== 0
        ) {
            return;
        }

        // NAPRAWA (dzisiaj): PRZED - this.chain.find(b => b.height === h)
        // tutaj, na ZYWEJ sciezce przyjmowania kazdego nowego bloku.
        // TERAZ - O(1) z trwalego indeksu blockByHeight.
        const windowStart =
            this.blockByHeight.get(
                justAccepted.height -
                interval
            );

        if (!windowStart) {
            return;
        }

        const actualMs =
            Math.max(
                1,
                justAccepted.timestamp -
                windowStart.timestamp
            );

        const expectedMs =
            interval *
            CONFIG.TARGET_BLOCK_TIME_MS;

        let ratio =
            expectedMs /
            actualMs;

        ratio =
            Math.max(
                0.25,
                Math.min(
                    4,
                    ratio
                )
            );

        this.difficulty =
            Math.max(
                1,
                this.difficulty *
                ratio
            );

        if (persist) {

            saveEmergencyDifficultyState(
                this.difficulty,
                justAccepted.height
            );
        }
    }


    _recomputeDifficultyFromHistory() {

        const latestHeight =
            this.getLatestBlock()
                .height;

        const activation =
            CONFIG.ASERT_ACTIVATION_HEIGHT;

        const anchorHeight =
            CONFIG.ASERT_ANCHOR_HEIGHT;

        const preAsertCeiling =
            Math.min(
                latestHeight,
                anchorHeight
            );

        const interval =
            CONFIG.DIFFICULTY_ADJUSTMENT;

        // NAPRAWA (dzisiaj): PRZED - this.chain.find(b => b.height === h)
        // wewnatrz tej petli robilo pelny liniowy skan calego this.chain
        // PRZY KAZDEJ iteracji petli. TERAZ - Map budowana raz, O(n).
        const blockByHeight =
            new Map(
                this.chain.map(
                    b => [b.height, b]
                )
            );

        for (
            let h = interval;
            h <= preAsertCeiling;
            h += interval
        ) {

            const block =
                blockByHeight.get(h);

            if (block) {

                this.retargetIfDue(
                    block,
                    false
                );
            }
        }

        // NAPRAWA (2026-08-28): PRZED - tutaj, na starcie procesu,
        // jawnie przeliczano this.difficulty tym samym, zamrozonym
        // sposobem (patrz komentarz przy getterze this.difficulty).
        // TERAZ - nic tu nie trzeba robic dla vMax, getter liczy zawsze
        // na zywo przy kazdym odczycie, restart nie jest wyjatkiem.
    }


    replaceChain(candidateChain) {

        if (
            !Array.isArray(
                candidateChain
            ) ||
            candidateChain.length === 0
        ) {

            return {
                accepted: false,
                reason:
                    "pusty lub nieprawidlowy lancuch"
            };
        }

        if (
            candidateChain[0].hash !==
            this.chain[0].hash
        ) {

            return {
                accepted: false,
                reason:
                    "inny genesis - inna siec"
            };
        }

        if (
            candidateChain.length <=
            this.chain.length
        ) {

            return {
                accepted: false,
                reason:
                    `krotszy lub rowny (${candidateChain.length} <= ${this.chain.length}) - odrzucony`
            };
        }

        for (
            let i = 0;
            i < candidateChain.length;
            i++
        ) {

            const block =
                candidateChain[i];

            if (
                block.height !== i
            ) {

                return {
                    accepted: false,
                    reason:
                        `blok #${i}: wysokosc ${block.height} nie pasuje do pozycji`
                };
            }

            if (
                i > 0 &&
                block.previousHash !==
                    candidateChain[
                        i - 1
                    ].hash
            ) {

                return {
                    accepted: false,
                    reason:
                        `blok #${i}: previousHash nie pasuje`
                };
            }

            if (
                computeBlockHash(
                    block
                ) !==
                block.hash
            ) {

                return {
                    accepted: false,
                    reason:
                        `blok #${i}: hash nie zgadza sie z trescia`
                };
            }

            if (
                i > 0 &&
                block.hash >
                    difficultyToTargetHex(
                        block.difficulty
                    )
            ) {

                return {
                    accepted: false,
                    reason:
                        `blok #${i}: brak poprawnego PoW`
                };
            }
        }


        if (
            candidateChain.length >
            CONFIG.ASERT_ANCHOR_HEIGHT
        ) {

            const anchor =
                candidateChain[
                    CONFIG.ASERT_ANCHOR_HEIGHT
                ];

            const anchorParent =
                candidateChain[
                    CONFIG.ASERT_ANCHOR_HEIGHT - 1
                ];

            if (
                !anchor ||
                !anchorParent
            ) {

                return {
                    accepted: false,
                    reason:
                        "vMax: brak kotwicy"
                };
            }

            for (
                let h =
                    CONFIG.ASERT_ACTIVATION_HEIGHT;

                h <
                    candidateChain.length;

                h++
            ) {

                const block =
                    candidateChain[h];

                const evalBlock =
                    candidateChain[
                        h - 1
                    ];

                // NAPRAWA (2026-08-24): asertNextDifficulty() zwraca
                // BigInt, block.difficulty jest Number (kolumna REAL).
                // W JS "Number !== BigInt" jest ZAWSZE true, niezaleznie
                // od wartosci - skutek: KAZDY blok po aktywacji ASERT w
                // dowolnym lancuchu od peera odrzucalby sam siebie tutaj,
                // zawsze. Jeszcze nieuruchomione (zaden blok >=100000 nie
                // istnieje w bazie), ale wybuchloby natychmiast po
                // pierwszym takim bloku od drugiego node'a - czyli zaraz
                // po wlaczeniu CONFIG.PEERS. Konwersja na Number przed
                // porownaniem, ten sam wzorzec co w _calculateAsertDifficulty().
                const expected =
                    Number(
                        asertNextDifficulty({

                            anchorHeight:
                                BigInt(
                                    CONFIG
                                        .ASERT_ANCHOR_HEIGHT
                                ),

                            anchorParentTime:
                                BigInt(
                                    Math.floor(
                                        anchorParent.timestamp /
                                        1000
                                    )
                                ),

                            anchorDifficulty:
                                BigInt(
                                    Math.max(
                                        1,
                                        Math.round(
                                            anchor.difficulty
                                        )
                                    )
                                ),

                            evalHeight:
                                BigInt(
                                    evalBlock.height
                                ),

                            evalTime:
                                BigInt(
                                    Math.floor(
                                        evalBlock.timestamp /
                                        1000
                                    )
                                ),

                            idealBlockTime:
                                BigInt(
                                    CONFIG
                                        .ASERT_IDEAL_BLOCK_TIME_SECONDS
                                ),

                            halflife:
                                BigInt(
                                    CONFIG
                                        .ASERT_HALFLIFE_SECONDS
                                ),

                            maxTarget:
                                MAX_TARGET
                        })
                    );

                if (
                    block.difficulty !==
                    expected
                ) {

                    return {
                        accepted: false,
                        reason:
                            `vMax: blok #${h} ma nieprawidlowa trudnosc (oczekiwano ${expected}, otrzymano ${block.difficulty})`
                    };
                }
            }
        }


        try {

            this.storage.replaceAllBlocks(
                candidateChain
            );

        } catch (err) {

            return {
                accepted: false,
                reason:
                    "blad zapisu do bazy: " +
                    err.message
            };
        }

        this.chain =
            candidateChain;

        this._warnIfChainHasGaps();

        this._asertAnchor =
            null;

        this.difficulty =
            Math.pow(
                16,
                CONFIG.DIFFICULTY
            );

        // NAPRAWA (dzisiaj, PILNA): ta sama kolejnosc co w konstruktorze -
        // _rebuildIndexes() musi byc PRZED _recomputeDifficultyFromHistory(),
        // bo retargetIfDue() potrzebuje this.blockByHeight.
        this._rebuildIndexes();

        this._recomputeDifficultyFromHistory();

        return {
            accepted: true,
            height:
                this.getLatestBlock()
                    .height
        };
    }


    getChain() {

        return this.chain;
    }


    getRecentBlocks(
        limit = 20,
        beforeHeight = null
    ) {

        let blocks =
            this.chain
                .slice()
                .reverse();

        if (
            beforeHeight !== null
        ) {

            blocks =
                blocks.filter(
                    b =>
                        b.height <
                        beforeHeight
                );
        }

        return blocks.slice(
            0,
            limit
        );
    }


    findHTLC(htlcId) {

        // NAPRAWA (dzisiaj): PRZED - podwojna petla po CALYM this.chain
        // i kazdej transakcji w kazdym bloku, PRZY KAZDYM wywolaniu.
        // TERAZ - odczyt z htlcIndex (Map), budowanego raz w
        // _rebuildIndexes() i aktualizowanego przyrostowo w
        // _applyBlockToIndexes(). Kontrakt zwracanej wartosci
        // identyczny co przed zmiana.
        const entry =
            this.htlcIndex.get(
                htlcId
            );

        if (
            !entry ||
            !entry.created
        ) {
            return null;
        }

        return {

            ...entry.created,

            status:
                entry.resolvedStatus ||
                "locked"
        };
    }


    validateHTLCClaim({
        htlcId,
        secret,
        claimant
    }) {

        const htlc =
            this.findHTLC(
                htlcId
            );

        if (!htlc) {

            return {
                valid: false,
                reason:
                    "HTLC nie istnieje"
            };
        }

        if (
            htlc.status !==
            "locked"
        ) {

            return {
                valid: false,
                reason:
                    `HTLC ma status "${htlc.status}", nie mozna odebrac`
            };
        }

        if (
            claimant !==
            htlc.claimant
        ) {

            return {
                valid: false,
                reason:
                    "tylko wyznaczony odbiorca moze odebrac"
            };
        }

        const nextHeight =
            this.getLatestBlock()
                .height + 1;

        if (
            nextHeight >=
            htlc.timeoutHeight
        ) {

            return {
                valid: false,
                reason:
                    "termin juz minal, odbior niemozliwy - tylko zwrot"
            };
        }

        if (
            sha256Hex(secret) !==
            htlc.hashLock
        ) {

            return {
                valid: false,
                reason:
                    "zly sekret - hash sie nie zgadza"
            };
        }

        return {
            valid: true,

            amount:
                htlc.amount,

            to:
                htlc.claimant
        };
    }


    validateHTLCRefund({
        htlcId,
        refundee
    }) {

        const htlc =
            this.findHTLC(
                htlcId
            );

        if (!htlc) {

            return {
                valid: false,
                reason:
                    "HTLC nie istnieje"
            };
        }

        if (
            htlc.status !==
            "locked"
        ) {

            return {
                valid: false,
                reason:
                    `HTLC ma status "${htlc.status}", nie mozna zwrocic`
            };
        }

        if (
            refundee !==
            htlc.refundee
        ) {

            return {
                valid: false,
                reason:
                    "tylko oryginalny nadawca moze dostac zwrot"
            };
        }

        const nextHeight =
            this.getLatestBlock()
                .height + 1;

        if (
            nextHeight <
            htlc.timeoutHeight
        ) {

            return {
                valid: false,
                reason:
                    `termin jeszcze nie minal (blok ${nextHeight} < ${htlc.timeoutHeight})`
            };
        }

        return {
            valid: true,

            amount:
                htlc.amount,

            to:
                htlc.refundee
        };
    }


    _rebuildIndexes() {

        this.balances =
            new Map();

        this.firstSeenHeight =
            new Map();

        this.addressTransactions =
            new Map();

        // NAPRAWA (dzisiaj): htlcId -> { created, resolvedStatus } -
        // ten sam wzorzec co balances/addressTransactions ponizej.
        this.htlcIndex =
            new Map();

        // NAPRAWA (dzisiaj, znaleziona w audycie "raz a porzadnie"):
        // TRZECIE miejsce w tym pliku z this.chain.find(b => b.height
        // === h) - wewnatrz retargetIfDue(), wolane z zywej sciezki
        // przyjmowania blokow. Ten sam wzorzec indeksu co ponizej.
        this.blockByHeight =
            new Map();

        this.circulatingSupply =
            0;

        for (
            const block of
            this.chain
        ) {

            this._applyBlockToIndexes(
                block
            );
        }
    }


    _addBalance(
        address,
        delta
    ) {

        this.balances.set(
            address,
            (
                this.balances.get(
                    address
                ) || 0
            ) + delta
        );
    }


    _touchFirstSeen(
        address,
        height
    ) {

        if (
            !this.firstSeenHeight.has(
                address
            )
        ) {

            this.firstSeenHeight.set(
                address,
                height
            );
        }
    }


    _applyBlockToIndexes(
        block
    ) {

        this.blockByHeight.set(
            block.height,
            block
        );

        const feeActive =
            isProjectFeeActive(
                block.height
            );

        for (
            const tx of
            block.transactions
        ) {

            if (
                tx.type ===
                    "HTLC_CREATE"
            ) {

                this.htlcIndex.set(
                    tx.htlcId,
                    {
                        created: {
                            ...tx,
                            createdAtHeight:
                                block.height
                        },
                        resolvedStatus:
                            null
                    }
                );

            } else if (
                tx.type ===
                    "HTLC_CLAIM" ||
                tx.type ===
                    "HTLC_REFUND"
            ) {

                const entry =
                    this.htlcIndex.get(
                        tx.htlcId
                    );

                if (entry) {

                    entry.resolvedStatus =
                        tx.type ===
                        "HTLC_CLAIM"
                            ? "claimed"
                            : "refunded";
                }
            }

            if (
                tx.type ===
                    "coinbase" ||
                tx.type ===
                    "genesis"
            ) {

                this.circulatingSupply +=
                    tx.amount;
            }

            const involved =
                new Set(
                    [
                        tx.to,
                        tx.from
                    ].filter(
                        Boolean
                    )
                );

            for (
                const addr of
                involved
            ) {

                if (
                    !this.addressTransactions.has(
                        addr
                    )
                ) {

                    this.addressTransactions.set(
                        addr,
                        []
                    );
                }

                this.addressTransactions
                    .get(addr)
                    .push({

                        ...tx,

                        blockHeight:
                            block.height
                    });
            }


            if (
                tx.type ===
                    "transfer" &&
                tx.to
            ) {

                this._touchFirstSeen(
                    tx.to,
                    block.height
                );

                const credited =
                    feeActive
                        ? tx.amount *
                          (
                              1 -
                              PROJECT_FEE_PERCENT
                          )
                        : tx.amount;

                this._addBalance(
                    tx.to,
                    credited
                );

            } else if (
                tx.type ===
                    "HTLC_CLAIM" &&
                tx.to
            ) {

                this._touchFirstSeen(
                    tx.to,
                    block.height
                );

                this._addBalance(
                    tx.to,
                    tx.amount
                );

            } else if (
                tx.type ===
                    "HTLC_REFUND" &&
                tx.to
            ) {

                this._touchFirstSeen(
                    tx.to,
                    block.height
                );

                this._addBalance(
                    tx.to,
                    tx.amount
                );

            } else if (
                tx.to &&
                tx.type !==
                    "HTLC_CREATE"
            ) {

                this._touchFirstSeen(
                    tx.to,
                    block.height
                );

                this._addBalance(
                    tx.to,
                    tx.amount
                );
            }


            if (
                tx.type ===
                    "transfer" &&
                tx.from
            ) {

                this._touchFirstSeen(
                    tx.from,
                    block.height
                );

                this._addBalance(
                    tx.from,
                    -(
                        tx.amount +
                        (
                            tx.fee || 0
                        )
                    )
                );

            } else if (
                tx.type ===
                    "HTLC_CREATE" &&
                tx.from
            ) {

                this._touchFirstSeen(
                    tx.from,
                    block.height
                );

                this._addBalance(
                    tx.from,
                    -(
                        tx.amount +
                        (
                            tx.fee || 0
                        )
                    )
                );
            }
        }
    }


    getBalance(address) {

        return (
            this.balances.get(
                address
            ) || 0
        );
    }


    getSoloMiners() {

        const seen =
            new Map();

        for (
            const block of
            this.chain
        ) {

            for (
                const tx of
                block.transactions
            ) {

                if (
                    tx.type ===
                        "coinbase" &&
                    tx.to !==
                        CONFIG.POOL_ADDRESS
                ) {

                    const existing =
                        seen.get(
                            tx.to
                        ) || {

                            address:
                                tx.to,

                            totalEarned:
                                0,

                            blocksFound:
                                0,

                            lastBlockHeight:
                                0
                        };

                    existing.totalEarned +=
                        tx.amount;

                    existing.blocksFound +=
                        1;

                    existing.lastBlockHeight =
                        Math.max(
                            existing.lastBlockHeight,
                            block.height
                        );

                    seen.set(
                        tx.to,
                        existing
                    );
                }
            }
        }

        return Array.from(
            seen.values()
        ).sort(
            (a, b) =>
                b.lastBlockHeight -
                a.lastBlockHeight
        );
    }


    getAddressStats(
        whaleLimit = 10,
        newestLimit = 10
    ) {

        const addresses =
            Array.from(
                this.balances.keys()
            );

        const whales =
            addresses
                .map(
                    address => ({
                        address,

                        balance:
                            this.balances.get(
                                address
                            )
                    })
                )
                .sort(
                    (a, b) =>
                        b.balance -
                        a.balance
                )
                .slice(
                    0,
                    whaleLimit
                );

        const newest =
            Array.from(
                this.firstSeenHeight.entries()
            )
                .map(
                    (
                        [
                            address,
                            firstSeenHeight
                        ]
                    ) => ({
                        address,
                        firstSeenHeight
                    })
                )
                .sort(
                    (a, b) =>
                        b.firstSeenHeight -
                        a.firstSeenHeight
                )
                .slice(
                    0,
                    newestLimit
                );

        return {

            totalAddresses:
                addresses.length,

            whales,

            newest
        };
    }


    saveCredit(credit) {

        this.storage.saveCredit(
            credit
        );
    }


    getTransactionsForAddress(
        address,
        limit = 200
    ) {

        const all =
            this.addressTransactions
                .get(address) || [];

        const requested =
            Number.isFinite(limit) &&
            limit > 0
                ? Math.floor(limit)
                : 200;

        const safeLimit =
            Math.min(
                requested,
                all.length
            );

        const result =
            new Array(
                safeLimit
            );

        for (
            let i = 0;
            i < safeLimit;
            i++
        ) {

            result[i] =
                all[
                    all.length -
                    1 -
                    i
                ];
        }

        return result;
    }


    setDifficultyManually(
        newDifficulty
    ) {

        if (
            isAsertActive(
                this.getLatestBlock()
                    .height + 1
            )
        ) {

            throw new Error(
                "vMax aktywny - reczna zmiana trudnosci jest zablokowana"
            );
        }

        if (
            typeof newDifficulty !==
                "number" ||
            !Number.isFinite(
                newDifficulty
            ) ||
            !(newDifficulty > 0)
        ) {

            throw new Error(
                "Nieprawidlowa wartosc trudnosci"
            );
        }

        const old =
            this.difficulty;

        this.difficulty =
            newDifficulty;

        saveEmergencyDifficultyState(
            newDifficulty,
            this.getLatestBlock()
                .height
        );

        console.error(
            "RECZNA KOREKTA TRUDNOSCI: " +
            old +
            " -> " +
            newDifficulty
        );

        return {
            old,

            new:
                newDifficulty
        };
    }


    maybeEmergencyAdjust() {

        const latest =
            this.getLatestBlock();

        if (
            latest.height === 0
        ) {
            return;
        }

        if (
            isAsertActive(
                latest.height + 1
            )
        ) {
            return;
        }

        const msSinceLastBlock =
            Date.now() -
            latest.timestamp;

        const target =
            CONFIG.TARGET_BLOCK_TIME_MS;

        if (
            msSinceLastBlock <
            target * 15
        ) {
            return;
        }

        const cooldownMs =
            target * 3;

        if (
            this._lastEmergencyAdjustAt &&
            Date.now() -
                this._lastEmergencyAdjustAt <
                cooldownMs
        ) {
            return;
        }

        const overshoot =
            msSinceLastBlock /
            target;

        const cuts =
            Math.min(
                10,
                Math.max(
                    1,
                    Math.floor(
                        Math.log2(
                            overshoot
                        )
                    )
                )
            );

        const divisor =
            Math.pow(
                2,
                cuts
            );

        const old =
            this.difficulty;

        this.difficulty =
            Math.max(
                1,
                this.difficulty /
                    divisor
            );

        this._lastEmergencyAdjustAt =
            Date.now();

        saveEmergencyDifficultyState(
            this.difficulty,
            latest.height
        );

        console.error(
            "AWARYJNE OBNIZENIE TRUDNOSCI: " +
            old +
            " -> " +
            this.difficulty
        );
    }


    getInfo() {

        this.maybeEmergencyAdjust();

        const latest =
            this.getLatestBlock();

        const height =
            latest.height;

        return {

            network:
                CONFIG.NETWORK_NAME,

            symbol:
                CONFIG.SYMBOL,

            version:
                CONFIG.VERSION,

            chainId:
                CONFIG.CHAIN_ID,

            height,

            latestHash:
                latest.hash,

            difficulty:
                Math.round(
                    this.difficulty
                ),

            difficultyLeadingZerosApprox:
                Math.floor(
                    Math.log(
                        this.difficulty
                    ) /
                    Math.log(16)
                ),

            totalBlocks:
                this.chain.length,

            currentBlockReward:
                this.getRewardForHeight(
                    height + 1
                ),

            circulatingSupply:
                this.circulatingSupply,

            maxSupply:
                CONFIG.MAX_SUPPLY,

            premine:
                CONFIG.PREMINE,

            blocksUntilHalving:
                CONFIG.HALVING_INTERVAL -
                (
                    height %
                    CONFIG.HALVING_INTERVAL
                ),

            blocksUntilRetarget:
                isAsertActive(
                    height + 1
                )
                    ? 0
                    : CONFIG
                          .DIFFICULTY_ADJUSTMENT -
                      (
                          height %
                          CONFIG
                              .DIFFICULTY_ADJUSTMENT
                      ),

            asertActive:
                isAsertActive(
                    height + 1
                ),

            asertMode:
                CONFIG.ASERT_MODE,

            asertActivationHeight:
                CONFIG.ASERT_ACTIVATION_HEIGHT,

            asertAnchorHeight:
                CONFIG.ASERT_ANCHOR_HEIGHT,

            asertIdealBlockTime:
                CONFIG
                    .ASERT_IDEAL_BLOCK_TIME_SECONDS,

            asertHalflife:
                CONFIG
                    .ASERT_HALFLIFE_SECONDS,

            isValid:
                true
        };
    }


    _warnIfChainHasGaps() {

        for (
            let i = 1;
            i < this.chain.length;
            i++
        ) {

            const expected =
                this.chain[
                    i - 1
                ].height + 1;

            if (
                this.chain[i].height !==
                expected
            ) {

                const missingEnd =
                    this.chain[i].height -
                    1;

                const label =
                    expected ===
                    missingEnd
                        ? `${expected}`
                        : `${expected}-${missingEnd}`;

                console.error(
                    `DZIURA W LANCUCHU: brakuje bloku/blokow ${label}`
                );
            }
        }
    }


    close() {

        this.storage.close();
    }
}


module.exports =
    Blockchain;

module.exports
    .difficultyToTargetHex =
    difficultyToTargetHex;

module.exports
    .computeBlockHash =
    computeBlockHash;

module.exports
    .sha256Hex =
    sha256Hex;

module.exports
    .isAsertActive =
    isAsertActive;
