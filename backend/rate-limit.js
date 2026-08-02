function createLimiter({ windowMs, max, message }) {
    const hits = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of hits) {
            if (now >= entry.resetAt) hits.delete(ip);
        }
    }, windowMs).unref();
    return function limiter(req, res, next) {
        const ip = req.ip || (req.connection && req.connection.remoteAddress) || "unknown";
        const now = Date.now();
        let entry = hits.get(ip);
        if (!entry || now >= entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(ip, entry);
        }
        entry.count++;
        if (entry.count > max) {
            return res.status(429).json({ error: message || "Zbyt wiele zapytań, zwolnij." });
        }
        next();
    };
}
// Limity podniesione 31.07.2026 - przy zaledwie kilku nowych górnikach za
// jednym IP (operatorzy komórkowi często dzielą jeden widoczny adres IP
// między wielu użytkowników - CGNAT) stary limit 300/min już się wyczerpywał.
// Kopanie w przeglądarce samo w sobie generuje regularny ruch (fetch pracy +
// zgłaszanie shares co kilka-kilkanaście sekund na aktywnego górnika, plus
// odpytywanie statusu puli co 8s na każdą otwartą kartę) - limit musi rosnąć
// razem z liczbą ludzi, inaczej sukces (więcej górników) sam siebie blokuje.
const rateLimiter = createLimiter({ windowMs: 60 * 1000, max: 1000 });
const strictLimiter = createLimiter({ windowMs: 60 * 1000, max: 60 });
module.exports = { rateLimiter, strictLimiter };
