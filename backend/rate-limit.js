// Prosty rate-limiter per-IP (okno czasowe + licznik), bez zależności npm.
//
// WAŻNE: jeśli serwer stoi za reverse proxy (Caddy/nginx - patrz Caddyfile),
// Express musi mieć `app.set("trust proxy", 1)`, inaczej req.ip to zawsze
// adres proxy (ten sam dla wszystkich!) i limit dotyczy WSZYSTKICH razem,
// nie każdego klienta z osobna.

function createRateLimiter({ windowMs, max, name }) {
    const hits = new Map(); // ip -> { count, resetAt }

    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of hits) {
            if (now > entry.resetAt) hits.delete(ip);
        }
    }, Math.max(windowMs, 30000));
    cleanupInterval.unref();

    return function rateLimiter(req, res, next) {
        const ip = req.ip || req.socket?.remoteAddress || "unknown";
        const now = Date.now();

        let entry = hits.get(ip);
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(ip, entry);
        }
        entry.count++;

        if (entry.count > max) {
            const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
            res.set("Retry-After", String(retryAfterSec));
            return res.status(429).json({
                error: `Za dużo żądań${name ? ` do ${name}` : ""}, spróbuj za ${retryAfterSec}s`
            });
        }

        next();
    };
}

module.exports = { createRateLimiter };
