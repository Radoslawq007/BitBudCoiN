const net = require("net");
const CONFIG = require("./config");

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SEEN_HASHES_CAP = 5000;
const RECONNECT_DELAY_MS = 5000;
const CHAIN_CHUNK_SIZE = 2000;
const MAX_CHAIN_CHUNKS = 5000;

class P2PNode {
    constructor(blockchain, { port, peers, mempool } = {}) {
        this.blockchain = blockchain;
        this.mempool = mempool ?? null;
        this.port = port ?? CONFIG.P2P_PORT;
        this.initialPeers = peers ?? CONFIG.PEERS ?? [];
        this.sockets = new Map();
        this.configuredPeers = new Set();
        this.reconnectTimers = new Map();
        this.seenBlockHashes = new Set();
        this.chainSyncBuffers = new Map();
        this.server = null;
        this.closed = false;
    }

    start() {
        this.server = net.createServer((socket) => {
            const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
            this._handleConnection(socket, remoteAddr);
        });
        this.server.on("error", (err) => {
            console.error("Blad serwera P2P: " + err.message);
        });
        this.server.listen(this.port, () => {
            console.log("Wezel P2P nasluchuje na porcie " + this.port);
        });
        for (const addr of this.initialPeers) {
            this.connectToPeer(addr);
        }
    }

    connectToPeer(address) {
        if (this.closed || this.sockets.has(address)) return;
        this.configuredPeers.add(address);
        const [host, portStr] = address.split(":");
        const socket = net.connect(Number(portStr), host);
        socket.on("connect", () => {
            console.log("Polaczono z peerem " + address);
            this._clearReconnect(address);
            this._handleConnection(socket, address);
        });
        socket.on("error", (err) => {
            console.warn("Problem z polaczeniem do " + address + ": " + err.message);
        });
        socket.on("close", () => {
            this.sockets.delete(address);
            if (!this.closed) this._scheduleReconnect(address);
        });
    }

    _scheduleReconnect(address) {
        if (this.reconnectTimers.has(address)) return;
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(address);
            this.connectToPeer(address);
        }, RECONNECT_DELAY_MS);
        timer.unref();
        this.reconnectTimers.set(address, timer);
    }

    _clearReconnect(address) {
        const timer = this.reconnectTimers.get(address);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(address);
        }
    }

    _handleConnection(socket, remoteAddr) {
        this.sockets.set(remoteAddr, socket);
        let buffer = "";
        this._send(socket, this._helloMessage());
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            if (buffer.length > MAX_BUFFER_BYTES) {
                console.warn("Peer " + remoteAddr + " przekroczyl limit bufora - rozlaczam");
                socket.destroy();
                return;
            }
            let idx;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (line.trim()) this._handleMessage(socket, remoteAddr, line);
            }
        });
        socket.on("close", () => {
            this.sockets.delete(remoteAddr);
            this.chainSyncBuffers.delete(remoteAddr);
            console.log("Peer " + remoteAddr + " rozlaczony");
        });
        socket.on("error", () => {});
    }

    _helloMessage() {
        const latest = this.blockchain.getLatestBlock();
        return {
            type: "HELLO",
            height: latest.height,
            latestHash: latest.hash,
            genesisHash: this.blockchain.chain[0].hash
        };
    }

    _serializeBlock(block) {
        return {
            height: block.height,
            timestamp: block.timestamp,
            previousHash: block.previousHash,
            hash: block.hash,
            nonce: block.nonce,
            difficulty: block.difficulty,
            transactions: block.transactions
        };
    }

    _send(socket, message) {
        try {
            socket.write(JSON.stringify(message) + "\n");
        } catch (err) {}
    }

    broadcast(message, excludeAddr = null) {
        const line = JSON.stringify(message) + "\n";
        for (const [addr, socket] of this.sockets) {
            if (addr === excludeAddr) continue;
            try {
                socket.write(line);
            } catch (err) {}
        }
    }

    broadcastNewBlock(block) {
        const serialized = this._serializeBlock(block);
        this._rememberHash(serialized.hash);
        this.broadcast({ type: "NEW_BLOCK", block: serialized });
    }

    _rememberHash(hash) {
        if (this.seenBlockHashes.size > SEEN_HASHES_CAP) this.seenBlockHashes.clear();
        this.seenBlockHashes.add(hash);
    }

    _sendChainChunked(socket) {
        const allBlocks = this.blockchain.getChain().map((b) => this._serializeBlock(b));
        const totalChunks = Math.max(1, Math.ceil(allBlocks.length / CHAIN_CHUNK_SIZE));
        for (let i = 0; i < totalChunks; i++) {
            const blocks = allBlocks.slice(i * CHAIN_CHUNK_SIZE, (i + 1) * CHAIN_CHUNK_SIZE);
            this._send(socket, { type: "CHAIN_CHUNK", chunkIndex: i, totalChunks, blocks });
        }
    }

    _handleChainChunk(remoteAddr, message) {
        const { chunkIndex, totalChunks, blocks } = message;
        if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) ||
            totalChunks < 1 || totalChunks > MAX_CHAIN_CHUNKS ||
            chunkIndex < 0 || chunkIndex >= totalChunks || !Array.isArray(blocks)) {
            console.warn("Nieprawidlowy CHAIN_CHUNK od " + remoteAddr + " - ignoruje");
            return;
        }
        let buf = this.chainSyncBuffers.get(remoteAddr);
        if (!buf || buf.totalChunks !== totalChunks) {
            buf = { totalChunks, chunks: new Array(totalChunks).fill(null) };
            this.chainSyncBuffers.set(remoteAddr, buf);
        }
        buf.chunks[chunkIndex] = blocks;
        if (buf.chunks.every((c) => c !== null)) {
            this.chainSyncBuffers.delete(remoteAddr);
            this._applyCandidateChain(remoteAddr, buf.chunks.flat(), totalChunks);
        }
    }

    _applyCandidateChain(remoteAddr, chain, chunkCount) {
        const result = this.blockchain.replaceChain(chain);
        if (result.accepted) {
            const via = chunkCount ? " (" + chunkCount + " paczek)" : "";
            console.log("Przyjeto dluzszy lancuch od " + remoteAddr + via + " - nowa wysokosc " + result.height);
            if (this.mempool) this.mempool.revalidateAll();
        } else {
            console.log("Odrzucono lancuch od " + remoteAddr + ": " + result.reason);
        }
    }

    _handleMessage(socket, remoteAddr, line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (err) {
            console.warn("Nieprawidlowy JSON od " + remoteAddr);
            return;
        }
        try {
            this._dispatch(socket, remoteAddr, message);
        } catch (err) {
            console.warn("Blad przetwarzania wiadomosci od " + remoteAddr + ": " + err.message);
        }
    }

    _dispatch(socket, remoteAddr, message) {
        switch (message.type) {
            case "HELLO": {
                const ourGenesis = this.blockchain.chain[0].hash;
                if (message.genesisHash && message.genesisHash !== ourGenesis) {
                    console.warn(remoteAddr + " ma inny genesis (inna siec) - ignoruje");
                    return;
                }
                const ourHeight = this.blockchain.getLatestBlock().height;
                if (typeof message.height === "number" && message.height > ourHeight) {
                    this._send(socket, { type: "GET_CHAIN" });
                }
                break;
            }
            case "GET_CHAIN": {
                this._sendChainChunked(socket);
                break;
            }
            case "CHAIN": {
                this._applyCandidateChain(remoteAddr, message.chain, null);
                break;
            }
            case "CHAIN_CHUNK": {
                this._handleChainChunk(remoteAddr, message);
                break;
            }
            case "NEW_BLOCK": {
                const b = message.block;
                if (!b || !b.hash || this.seenBlockHashes.has(b.hash)) return;
                this._rememberHash(b.hash);
                const ourHeight = this.blockchain.getLatestBlock().height;
                if (b.height === ourHeight + 1) {
                    const result = this.blockchain.receiveBlock(b);
                    if (result.accepted) {
                        console.log("Przyjeto nowy blok #" + b.height + " od " + remoteAddr);
                        if (this.mempool) this.mempool.pruneConfirmed(result.block);
                        this.broadcast({ type: "NEW_BLOCK", block: b }, remoteAddr);
                    } else {
                        console.log("Odrzucono blok #" + b.height + " od " + remoteAddr + ": " + result.reason);
                    }
                } else if (b.height > ourHeight + 1) {
                    console.log(remoteAddr + " jest do przodu (#" + b.height + ", my #" + ourHeight + ") - prosze o caly lancuch");
                    this._send(socket, { type: "GET_CHAIN" });
                }
                break;
            }
            default:
                console.warn("Nieznany typ wiadomosci od " + remoteAddr + ": " + message.type);
        }
    }

    getStatus() {
        return {
            port: this.port,
            connected: Array.from(this.sockets.keys()),
            configured: Array.from(this.configuredPeers),
            reconnecting: Array.from(this.reconnectTimers.keys())
        };
    }

    close() {
        this.closed = true;
        for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
        this.reconnectTimers.clear();
        for (const socket of this.sockets.values()) socket.destroy();
        this.sockets.clear();
        this.chainSyncBuffers.clear();
        if (this.server) this.server.close();
    }
}

module.exports = P2PNode;