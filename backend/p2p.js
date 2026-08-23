"use strict";

const net = require("net");
const CONFIG = require("./config");

/*
 * BitBudCoin vMax P2P
 *
 * ZASADY:
 * 1. P2P NIE jest źródłem prawdy dla trudności.
 * 2. Każdy blok trafia do Blockchain.receiveBlock(),
 *    gdzie lokalny consensus decyduje, czy blok jest poprawny.
 * 3. Synchronizacja całego łańcucha trafia do replaceChain(),
 *    które musi zweryfikować kandydacki łańcuch lokalnie.
 * 4. Peer nie może wymusić własnej trudności na naszym węźle.
 * 5. HELLO sprawdza genesis + chainId + symbol + network.
 * 6. CHAIN_CHUNK ma limity rozmiaru, liczby paczek i liczby bloków.
 * 7. Jeden peer nie może utrzymywać wielu równoległych synchronizacji.
 * 8. Powtarzające się bloki nie są ponownie przetwarzane.
 *
 * ASERT:
 * Po aktywacji vMax trudność jest wyliczana deterministycznie
 * przez warstwę blockchain. P2P nie wykonuje własnego ASERT.
 */

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const SEEN_HASHES_CAP = 10000;

const RECONNECT_DELAY_MS = 5000;

const CHAIN_CHUNK_SIZE = 2000;
const MAX_CHAIN_CHUNKS = 5000;
const MAX_CHAIN_BLOCKS = CHAIN_CHUNK_SIZE * MAX_CHAIN_CHUNKS;

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const MAX_BLOCKS_PER_NEW_CHAIN_MESSAGE = MAX_CHAIN_BLOCKS;

const HANDSHAKE_TIMEOUT_MS = 15000;

const CHAIN_SYNC_TIMEOUT_MS = 120000;

// NAPRAWA (dzisiaj): minimalna przewaga wysokosci zanim zolamy pelny
// resync calego lancucha. Normalna propagacja miedzy zywymi, polaczonymi
// wezlami to roznica rzedu pojedynczych blokow - nie powinna nigdy
// wywolywac pelnego GET_CHAIN. 25 to margines bezpieczny na chwilowe
// opoznienia sieciowe, ale wciaz reaguje na realna, dluzsza przerwe.
const CHAIN_SYNC_MIN_LEAD = 25;

const MAX_PEERS = 64;

const PROTOCOL_VERSION = "vMax-1";

class P2PNode {
    constructor(blockchain, { port, peers, mempool } = {}) {
        this.blockchain = blockchain;

        this.mempool = mempool ?? null;

        this.port = port ?? CONFIG.P2P_PORT;

        this.initialPeers = Array.isArray(peers)
            ? peers
            : (CONFIG.PEERS ?? []);

        this.sockets = new Map();

        this.configuredPeers = new Set();

        this.reconnectTimers = new Map();

        this.seenBlockHashes = new Set();

        this.chainSyncBuffers = new Map();

        this.handshakes = new Map();

        this.server = null;

        this.closed = false;
    }

    start() {
        if (this.server) return;

        this.closed = false;

        this.server = net.createServer((socket) => {
            const remoteAddr =
                `${socket.remoteAddress}:${socket.remotePort}`;

            this._handleConnection(socket, remoteAddr);
        });

        this.server.on("error", (err) => {
            console.error(
                "Blad serwera P2P: " + err.message
            );
        });

        this.server.listen(this.port, () => {
            console.log(
                "Wezel P2P nasluchuje na porcie " + this.port
            );
        });

        for (const addr of this.initialPeers) {
            this.connectToPeer(addr);
        }
    }

    connectToPeer(address) {
        if (this.closed) return;

        if (!this._isValidPeerAddress(address)) {
            console.warn(
                "Odrzucono nieprawidlowy adres peera: " + address
            );
            return;
        }

        if (this.sockets.has(address)) return;

        if (
            this.configuredPeers.size >= MAX_PEERS &&
            !this.configuredPeers.has(address)
        ) {
            console.warn(
                "Osiagnieto limit peerow - pomijam " + address
            );
            return;
        }

        this.configuredPeers.add(address);

        const separator = address.lastIndexOf(":");

        const host = address.slice(0, separator);

        const portStr = address.slice(separator + 1);

        const port = Number(portStr);

        const socket = net.connect(port, host);

        socket.setTimeout(HANDSHAKE_TIMEOUT_MS);

        socket.on("connect", () => {
            socket.setTimeout(0);

            console.log(
                "Polaczono z peerem " + address
            );

            this._clearReconnect(address);

            this._handleConnection(socket, address);
        });

        socket.on("timeout", () => {
            console.warn(
                "Timeout handshake P2P z " + address
            );

            socket.destroy();
        });

        socket.on("error", (err) => {
            console.warn(
                "Problem z polaczeniem do " +
                address +
                ": " +
                err.message
            );
        });

        socket.on("close", () => {
            this._removeSocket(address, socket);

            if (!this.closed) {
                this._scheduleReconnect(address);
            }
        });
    }

    _isValidPeerAddress(address) {
        if (typeof address !== "string") return false;

        const separator = address.lastIndexOf(":");

        if (separator <= 0) return false;

        const host = address.slice(0, separator).trim();

        const port = Number(
            address.slice(separator + 1)
        );

        if (!host) return false;

        if (!Number.isInteger(port)) return false;

        if (port < 1 || port > 65535) return false;

        return true;
    }

    _scheduleReconnect(address) {
        if (this.closed) return;

        if (this.reconnectTimers.has(address)) return;

        const timer = setTimeout(() => {
            this.reconnectTimers.delete(address);

            if (!this.closed) {
                this.connectToPeer(address);
            }
        }, RECONNECT_DELAY_MS);

        timer.unref();

        this.reconnectTimers.set(address, timer);
    }

    _clearReconnect(address) {
        const timer =
            this.reconnectTimers.get(address);

        if (timer) {
            clearTimeout(timer);

            this.reconnectTimers.delete(address);
        }
    }

    _removeSocket(address, socket) {
        const existing =
            this.sockets.get(address);

        if (!existing || existing === socket) {
            this.sockets.delete(address);
        }

        this.handshakes.delete(address);

        this._clearChainSync(address);
    }

    _handleConnection(socket, remoteAddr) {
        if (this.closed) {
            socket.destroy();
            return;
        }

        /*
         * Jeżeli ten sam adres ma już aktywne połączenie,
         * zachowujemy pierwsze połączenie.
         */
        if (this.sockets.has(remoteAddr)) {
            try {
                socket.destroy();
            } catch (err) {}

            return;
        }

        this.sockets.set(remoteAddr, socket);

        this.handshakes.set(remoteAddr, {
            received: false,
            sent: false,
            established: false,
            startedAt: Date.now()
        });

        let buffer = "";

        this._sendHello(socket, remoteAddr);

        socket.on("data", (chunk) => {
            if (!Buffer.isBuffer(chunk)) {
                chunk = Buffer.from(chunk);
            }

            /*
             * Limitujemy rzeczywisty rozmiar danych, a nie tylko
             * liczbę znaków JS.
             */
            if (
                Buffer.byteLength(buffer, "utf8") +
                chunk.length >
                MAX_BUFFER_BYTES
            ) {
                console.warn(
                    "Peer " +
                    remoteAddr +
                    " przekroczyl limit bufora - rozlaczam"
                );

                socket.destroy();

                return;
            }

            buffer += chunk.toString("utf8");

            let idx;

            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx);

                buffer = buffer.slice(idx + 1);

                if (!line.trim()) continue;

                if (
                    Buffer.byteLength(line, "utf8") >
                    MAX_MESSAGE_BYTES
                ) {
                    console.warn(
                        "Peer " +
                        remoteAddr +
                        " wyslal zbyt duza wiadomosc - rozlaczam"
                    );

                    socket.destroy();

                    return;
                }

                this._handleMessage(
                    socket,
                    remoteAddr,
                    line
                );

                if (socket.destroyed) return;
            }
        });

        socket.on("close", () => {
            this._removeSocket(
                remoteAddr,
                socket
            );

            console.log(
                "Peer " +
                remoteAddr +
                " rozlaczony"
            );
        });

        socket.on("error", () => {});
    }

    _sendHello(socket, remoteAddr) {
        const handshake =
            this.handshakes.get(remoteAddr);

        if (handshake) {
            handshake.sent = true;
        }

        this._send(
            socket,
            this._helloMessage()
        );
    }

    _helloMessage() {
        const latest =
            this.blockchain.getLatestBlock();

        const genesis =
            this.blockchain.chain[0];

        return {
            type: "HELLO",

            protocol: PROTOCOL_VERSION,

            network:
                CONFIG.NETWORK_NAME,

            symbol:
                CONFIG.SYMBOL,

            chainId:
                CONFIG.CHAIN_ID,

            version:
                CONFIG.VERSION,

            height:
                latest.height,

            latestHash:
                latest.hash,

            genesisHash:
                genesis.hash,

            asertActivationHeight:
                CONFIG.ASERT_ACTIVATION_HEIGHT,

            asertHalflifeSeconds:
                CONFIG.ASERT_HALFLIFE_SECONDS
        };
    }

    _serializeBlock(block) {
        return {
            height: block.height,

            timestamp: block.timestamp,

            previousHash:
                block.previousHash,

            hash:
                block.hash,

            nonce:
                block.nonce,

            /*
             * To jest dane historyczne bloku.
             * P2P NIE traktuje tego jako autorytetu.
             * receiveBlock()/replaceChain() muszą zweryfikować
             * consensus lokalnie.
             */
            difficulty:
                block.difficulty,

            transactions:
                block.transactions
        };
    }

    _send(socket, message) {
        if (!socket || socket.destroyed) return false;

        let line;

        try {
            line =
                JSON.stringify(message) +
                "\n";
        } catch (err) {
            return false;
        }

        if (
            Buffer.byteLength(line, "utf8") >
            MAX_MESSAGE_BYTES
        ) {
            console.warn(
                "Proba wyslania zbyt duzej wiadomosci P2P"
            );

            return false;
        }

        try {
            socket.write(line);

            return true;
        } catch (err) {
            return false;
        }
    }

    broadcast(message, excludeAddr = null) {
        let line;

        try {
            line =
                JSON.stringify(message) +
                "\n";
        } catch (err) {
            return;
        }

        if (
            Buffer.byteLength(line, "utf8") >
            MAX_MESSAGE_BYTES
        ) {
            console.warn(
                "Broadcast zbyt duzy - pomijam"
            );

            return;
        }

        for (const [addr, socket] of this.sockets) {
            if (addr === excludeAddr) continue;

            if (socket.destroyed) continue;

            try {
                socket.write(line);
            } catch (err) {
                try {
                    socket.destroy();
                } catch (destroyErr) {}
            }
        }
    }

    broadcastNewBlock(block) {
        if (!block || !block.hash) return;

        const serialized =
            this._serializeBlock(block);

        this._rememberHash(
            serialized.hash
        );

        this.broadcast({
            type: "NEW_BLOCK",
            block: serialized
        });
    }

    _rememberHash(hash) {
        if (
            typeof hash !== "string" ||
            !hash
        ) {
            return;
        }

        /*
         * Nie pozwalamy Set rosnac bez konca.
         */
        if (
            this.seenBlockHashes.size >=
            SEEN_HASHES_CAP
        ) {
            /*
             * Zachowujemy ostatnia czesc zamiast
             * czyscic calosc naraz.
             */
            const keep =
                Math.floor(SEEN_HASHES_CAP / 2);

            const recent =
                Array.from(
                    this.seenBlockHashes
                ).slice(-keep);

            this.seenBlockHashes =
                new Set(recent);
        }

        this.seenBlockHashes.add(hash);
    }

    _sendChainChunked(socket) {
        if (!socket || socket.destroyed) return;

        const chain =
            this.blockchain.getChain();

        if (!Array.isArray(chain)) return;

        if (chain.length > MAX_CHAIN_BLOCKS) {
            console.warn(
                "Lancuch przekracza limit CHAIN - nie wysylam"
            );

            return;
        }

        const allBlocks =
            chain.map((block) =>
                this._serializeBlock(block)
            );

        const totalChunks =
            Math.max(
                1,
                Math.ceil(
                    allBlocks.length /
                    CHAIN_CHUNK_SIZE
                )
            );

        if (totalChunks > MAX_CHAIN_CHUNKS) {
            console.warn(
                "Za duzo paczek CHAIN - anulowano"
            );

            return;
        }

        for (
            let i = 0;
            i < totalChunks;
            i++
        ) {
            const blocks =
                allBlocks.slice(
                    i * CHAIN_CHUNK_SIZE,
                    (i + 1) *
                    CHAIN_CHUNK_SIZE
                );

            this._send(
                socket,
                {
                    type: "CHAIN_CHUNK",

                    chunkIndex: i,

                    totalChunks,

                    blocks
                }
            );
        }
    }

    _handleChainChunk(
        remoteAddr,
        message
    ) {
        const {
            chunkIndex,
            totalChunks,
            blocks
        } = message;

        if (
            !Number.isInteger(chunkIndex) ||
            !Number.isInteger(totalChunks) ||
            totalChunks < 1 ||
            totalChunks > MAX_CHAIN_CHUNKS ||
            chunkIndex < 0 ||
            chunkIndex >= totalChunks ||
            !Array.isArray(blocks)
        ) {
            console.warn(
                "Nieprawidlowy CHAIN_CHUNK od " +
                remoteAddr +
                " - ignoruje"
            );

            return;
        }

        /*
         * Maksymalnie CHAIN_CHUNK_SIZE blokow w jednej paczce.
         */
        if (
            blocks.length >
            CHAIN_CHUNK_SIZE
        ) {
            console.warn(
                "CHAIN_CHUNK od " +
                remoteAddr +
                " ma za duzo blokow"
            );

            return;
        }

        let buf =
            this.chainSyncBuffers.get(
                remoteAddr
            );

        if (
            buf &&
            buf.totalChunks !== totalChunks
        ) {
            /*
             * Peer rozpoczal nowa synchronizacje.
             */
            this._clearChainSync(
                remoteAddr
            );

            buf = null;
        }

        if (!buf) {
            buf = {
                totalChunks,

                chunks:
                    new Array(
                        totalChunks
                    ).fill(null),

                startedAt:
                    Date.now(),

                totalBlocks: 0
            };

            this.chainSyncBuffers.set(
                remoteAddr,
                buf
            );
        }

        /*
         * Duplikat tej samej paczki nie moze
         * sztucznie zwiekszac totalBlocks.
         */
        if (
            buf.chunks[chunkIndex] !== null
        ) {
            return;
        }

        buf.chunks[chunkIndex] = blocks;

        buf.totalBlocks +=
            blocks.length;

        if (
            buf.totalBlocks >
            MAX_CHAIN_BLOCKS
        ) {
            console.warn(
                "CHAIN od " +
                remoteAddr +
                " przekracza maksymalny rozmiar"
            );

            this._clearChainSync(
                remoteAddr
            );

            return;
        }

        if (
            buf.chunks.every(
                (chunk) =>
                    chunk !== null
            )
        ) {
            this.chainSyncBuffers.delete(
                remoteAddr
            );

            const candidateChain =
                buf.chunks.flat();

            this._applyCandidateChain(
                remoteAddr,
                candidateChain,
                totalChunks
            );
        }
    }

    _clearChainSync(remoteAddr) {
        const buf =
            this.chainSyncBuffers.get(
                remoteAddr
            );

        if (buf && buf.timer) {
            clearTimeout(buf.timer);
        }

        this.chainSyncBuffers.delete(
            remoteAddr
        );
    }

    _applyCandidateChain(
        remoteAddr,
        chain,
        chunkCount
    ) {
        if (!Array.isArray(chain)) {
            console.log(
                "Odrzucono lancuch od " +
                remoteAddr +
                ": nieprawidlowa tablica"
            );

            return;
        }

        if (
            chain.length < 1 ||
            chain.length >
            MAX_CHAIN_BLOCKS
        ) {
            console.log(
                "Odrzucono lancuch od " +
                remoteAddr +
                ": nieprawidlowa dlugosc"
            );

            return;
        }

        /*
         * KLUCZOWE:
         *
         * Nie liczymy tutaj trudnosci.
         *
         * replaceChain() jest warstwa consensus.
         * To blockchain ma zdecydowac, czy kandydacki lancuch
         * rzeczywiscie jest poprawny dla vMax.
         */
        const result =
            this.blockchain.replaceChain(
                chain
            );

        if (result.accepted) {
            const via =
                chunkCount
                    ? " (" +
                      chunkCount +
                      " paczek)"
                    : "";

            console.log(
                "Przyjeto dluzszy lancuch od " +
                remoteAddr +
                via +
                " - nowa wysokosc " +
                result.height
            );

            if (this.mempool) {
                try {
                    this.mempool.revalidateAll();
                } catch (err) {
                    console.warn(
                        "Blad rewalidacji mempoola: " +
                        err.message
                    );
                }
            }

            /*
             * Po przyjeciu nowego lancucha informujemy peerow
             * o naszym aktualnym tipie.
             */
            this.broadcast(
                this._helloMessage(),
                remoteAddr
            );
        } else {
            console.log(
                "Odrzucono lancuch od " +
                remoteAddr +
                ": " +
                result.reason
            );
        }
    }

    _handleMessage(
        socket,
        remoteAddr,
        line
    ) {
        let message;

        try {
            message =
                JSON.parse(line);
        } catch (err) {
            console.warn(
                "Nieprawidlowy JSON od " +
                remoteAddr
            );

            return;
        }

        if (
            !message ||
            typeof message !== "object" ||
            Array.isArray(message)
        ) {
            console.warn(
                "Nieprawidlowa wiadomosc od " +
                remoteAddr
            );

            return;
        }

        try {
            this._dispatch(
                socket,
                remoteAddr,
                message
            );
        } catch (err) {
            console.warn(
                "Blad przetwarzania wiadomosci od " +
                remoteAddr +
                ": " +
                err.message
            );
        }
    }

    _validateHello(message) {
        if (
            message.network &&
            message.network !==
            CONFIG.NETWORK_NAME
        ) {
            return {
                valid: false,
                reason:
                    "inna siec"
            };
        }

        if (
            message.symbol &&
            message.symbol !==
            CONFIG.SYMBOL
        ) {
            return {
                valid: false,
                reason:
                    "inny symbol"
            };
        }

        if (
            message.chainId !== undefined &&
            message.chainId !==
            CONFIG.CHAIN_ID
        ) {
            return {
                valid: false,
                reason:
                    "inny chainId"
            };
        }

        const ourGenesis =
            this.blockchain.chain[0].hash;

        if (
            message.genesisHash &&
            message.genesisHash !==
            ourGenesis
        ) {
            return {
                valid: false,
                reason:
                    "inny genesis"
            };
        }

        /*
         * Po aktywacji vMax wszystkie wezly musza miec
         * identyczny punkt aktywacji i half-life.
         */
        if (
            CONFIG.ASERT_ACTIVATION_HEIGHT !==
            undefined &&
            message.asertActivationHeight !==
            undefined &&
            Number(
                message.asertActivationHeight
            ) !==
            Number(
                CONFIG.ASERT_ACTIVATION_HEIGHT
            )
        ) {
            return {
                valid: false,
                reason:
                    "niezgodna aktywacja ASERT"
            };
        }

        if (
            CONFIG.ASERT_HALFLIFE_SECONDS !==
            undefined &&
            message.asertHalflifeSeconds !==
            undefined &&
            Number(
                message.asertHalflifeSeconds
            ) !==
            Number(
                CONFIG.ASERT_HALFLIFE_SECONDS
            )
        ) {
            return {
                valid: false,
                reason:
                    "niezgodny ASERT halflife"
            };
        }

        return {
            valid: true
        };
    }

    _markHandshakeReceived(
        remoteAddr
    ) {
        let state =
            this.handshakes.get(
                remoteAddr
            );

        if (!state) {
            state = {
                received: false,
                sent: false,
                established: false,
                startedAt: Date.now()
            };

            this.handshakes.set(
                remoteAddr,
                state
            );
        }

        state.received = true;

        state.established =
            state.sent &&
            state.received;

        return state;
    }

    _dispatch(
        socket,
        remoteAddr,
        message
    ) {
        switch (message.type) {
            case "HELLO": {
                const validation =
                    this._validateHello(
                        message
                    );

                if (!validation.valid) {
                    console.warn(
                        remoteAddr +
                        " odrzucony HELLO: " +
                        validation.reason
                    );

                    socket.destroy();

                    return;
                }

                const state =
                    this._markHandshakeReceived(
                        remoteAddr
                    );

                /*
                 * Nie podejmujemy synchronizacji dopóki
                 * handshake nie jest kompletny.
                 */
                if (!state.established) {
                    return;
                }

                const ourHeight =
                    this.blockchain
                        .getLatestBlock()
                        .height;

                // NAPRAWA (dzisiaj): "message.height > ourHeight" (kazda
                // roznica, choc o 1 blok) wyzwalalo pelny GET_CHAIN -
                // caly lancuch od peera, zwalidowany od zera przez
                // replaceChain() (SHA256+JSON.stringify per blok +
                // ASERT dla calego zakresu). To dotyczylo KAZDEGO
                // polaczenia - wychodzacego (CONFIG.PEERS) I
                // PRZYCHODZACEGO (net.createServer, _handleConnection) -
                // wyczyszczenie CONFIG.PEERS blokowalo tylko wychodzace,
                // przychodzace (np. drugi wezel znajomego) szly ta sama
                // sciezka bez zadnego ograniczenia. Prog: realna luka
                // (np. po dluzszej przerwie), nie normalne opoznienie
                // propagacji miedzy dwoma zywymi, polaczonymi wezlami.
                if (
                    typeof message.height ===
                        "number" &&
                    Number.isSafeInteger(
                        message.height
                    ) &&
                    message.height >
                        ourHeight + CHAIN_SYNC_MIN_LEAD
                ) {
                    /*
                     * Nowa synchronizacja zastępuje starą.
                     */
                    this._clearChainSync(
                        remoteAddr
                    );

                    this._send(
                        socket,
                        {
                            type:
                                "GET_CHAIN"
                        }
                    );
                }

                /*
                 * Jeżeli peer jest niżej, nie wysyłamy mu
                 * automatycznie całego chaina. NEW_BLOCK/HELLO
                 * wystarczy do rozpoczęcia normalnej synchronizacji
                 * po jego stronie.
                 */
                break;
            }

            case "GET_CHAIN": {
                /*
                 * Wysyłamy pełny chain tylko po poprawnym
                 * połączeniu logicznym.
                 */
                const state =
                    this.handshakes.get(
                        remoteAddr
                    );

                if (
                    !state ||
                    !state.established
                ) {
                    console.warn(
                        "GET_CHAIN przed HELLO od " +
                        remoteAddr
                    );

                    return;
                }

                this._sendChainChunked(
                    socket
                );

                break;
            }

            case "CHAIN": {
                const state =
                    this.handshakes.get(
                        remoteAddr
                    );

                if (
                    !state ||
                    !state.established
                ) {
                    return;
                }

                if (
                    !Array.isArray(
                        message.chain
                    )
                ) {
                    return;
                }

                if (
                    message.chain.length >
                    MAX_CHAIN_BLOCKS
                ) {
                    return;
                }

                this._applyCandidateChain(
                    remoteAddr,
                    message.chain,
                    null
                );

                break;
            }

            case "CHAIN_CHUNK": {
                const state =
                    this.handshakes.get(
                        remoteAddr
                    );

                if (
                    !state ||
                    !state.established
                ) {
                    return;
                }

                this._handleChainChunk(
                    remoteAddr,
                    message
                );

                break;
            }

            case "NEW_BLOCK": {
                const state =
                    this.handshakes.get(
                        remoteAddr
                    );

                if (
                    !state ||
                    !state.established
                ) {
                    return;
                }

                const b =
                    message.block;

                if (
                    !b ||
                    typeof b !== "object" ||
                    !b.hash
                ) {
                    return;
                }

                if (
                    typeof b.hash !==
                    "string"
                ) {
                    return;
                }

                if (
                    this.seenBlockHashes.has(
                        b.hash
                    )
                ) {
                    return;
                }

                this._rememberHash(
                    b.hash
                );

                const ourLatest =
                    this.blockchain
                        .getLatestBlock();

                const ourHeight =
                    ourLatest.height;

                /*
                 * NORMALNA SCIEZKA:
                 * blok jest dokładnie następnym blokiem.
                 *
                 * receiveBlock() jest jedynym miejscem,
                 * które ma rozstrzygać consensus.
                 */
                if (
                    b.height ===
                    ourHeight + 1
                ) {
                    const result =
                        this.blockchain
                            .receiveBlock(b);

                    if (result.accepted) {
                        console.log(
                            "Przyjeto nowy blok #" +
                            b.height +
                            " od " +
                            remoteAddr
                        );

                        if (
                            this.mempool &&
                            typeof this
                                .mempool
                                .pruneConfirmed ===
                                "function"
                        ) {
                            try {
                                this.mempool
                                    .pruneConfirmed(
                                        result.block
                                    );
                            } catch (err) {
                                console.warn(
                                    "Blad pruneConfirmed: " +
                                    err.message
                                );
                            }
                        }

                        this.broadcast(
                            {
                                type:
                                    "NEW_BLOCK",
                                block:
                                    this._serializeBlock(
                                        result.block
                                    )
                            },
                            remoteAddr
                        );
                    } else {
                        console.log(
                            "Odrzucono blok #" +
                            b.height +
                            " od " +
                            remoteAddr +
                            ": " +
                            result.reason
                        );
                    }

                    break;
                }

                /*
                 * Peer jest przed nami.
                 */
                if (
                    b.height >
                    ourHeight + 1
                ) {
                    console.log(
                        remoteAddr +
                        " jest do przodu (#" +
                        b.height +
                        ", my #" +
                        ourHeight +
                        ") - prosze o caly lancuch"
                    );

                    this._clearChainSync(
                        remoteAddr
                    );

                    this._send(
                        socket,
                        {
                            type:
                                "GET_CHAIN"
                        }
                    );

                    break;
                }

                /*
                 * Peer wyslal stary blok.
                 * Nie robimy reorgu na podstawie pojedynczego
                 * starego NEW_BLOCK.
                 */
                if (
                    b.height <=
                    ourHeight
                ) {
                    return;
                }

                break;
            }

            default: {
                console.warn(
                    "Nieznany typ wiadomosci od " +
                    remoteAddr +
                    ": " +
                    message.type
                );
            }
        }
    }

    getStatus() {
        const syncs = {};

        for (
            const [
                addr,
                buf
            ] of this.chainSyncBuffers
        ) {
            syncs[addr] = {
                totalChunks:
                    buf.totalChunks,

                receivedChunks:
                    buf.chunks.filter(
                        (c) => c !== null
                    ).length,

                totalBlocks:
                    buf.totalBlocks,

                startedAt:
                    buf.startedAt
            };
        }

        return {
            port:
                this.port,

            protocol:
                PROTOCOL_VERSION,

            connected:
                Array.from(
                    this.sockets.keys()
                ),

            configured:
                Array.from(
                    this.configuredPeers
                ),

            reconnecting:
                Array.from(
                    this.reconnectTimers.keys()
                ),

            handshakes:
                Array.from(
                    this.handshakes.entries()
                ).map(
                    ([address, state]) => ({
                        address,
                        established:
                            state.established,
                        received:
                            state.received,
                        sent:
                            state.sent
                    })
                ),

            chainSyncs:
                syncs
        };
    }

    close() {
        this.closed = true;

        for (
            const timer of
            this.reconnectTimers.values()
        ) {
            clearTimeout(timer);
        }

        this.reconnectTimers.clear();

        for (
            const address of
            this.chainSyncBuffers.keys()
        ) {
            this._clearChainSync(
                address
            );
        }

        for (
            const socket of
            this.sockets.values()
        ) {
            try {
                socket.destroy();
            } catch (err) {}
        }

        this.sockets.clear();

        this.handshakes.clear();

        this.chainSyncBuffers.clear();

        if (this.server) {
            try {
                this.server.close();
            } catch (err) {}

            this.server = null;
        }
    }
}

module.exports = P2PNode;