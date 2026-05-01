/**
 * Minimal cron parser & "next run" computer for automation schedules.
 *
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week.
 * Per-field syntax:
 *   *           any
 *   N           literal
 *   N-M         range
 *   N,M,...     list
 *   ../STEP     step
 *
 * Months are 1-12, day-of-week 0-6 (0 = Sunday). 7 is also accepted as Sunday.
 *
 * Timezone: nextRunAt is computed in the supplied IANA timezone, converted
 * back to UTC for storage. We use Intl.DateTimeFormat tricks rather than
 * adding a new dep — accuracy is "to the minute", which is fine for cron.
 */

function parseField(field, min, max) {
    const out = new Set();
    if (field === '*') {
        for (let i = min; i <= max; i++) out.add(i);
        return out;
    }
    for (const part of field.split(',')) {
        const m = part.match(/^([0-9]+|\*)(?:-([0-9]+))?(?:\/([0-9]+))?$/);
        if (!m) throw new Error(`Invalid cron field: ${part}`);
        const a = m[1] === '*' ? min : parseInt(m[1], 10);
        const b = m[2] !== undefined ? parseInt(m[2], 10) : (m[1] === '*' ? max : a);
        const step = m[3] !== undefined ? parseInt(m[3], 10) : 1;
        if (step < 1) throw new Error('Step must be >= 1');
        for (let v = a; v <= b; v += step) {
            if (v < min || v > max) continue;
            out.add(v);
        }
    }
    return out;
}

function parseCron(cron) {
    const f = cron.trim().split(/\s+/);
    if (f.length !== 5) throw new Error(`Cron must have 5 fields, got ${f.length}`);
    const [minute, hour, dom, month, dow] = f;
    const fields = {
        minute: parseField(minute, 0, 59),
        hour:   parseField(hour, 0, 23),
        dom:    parseField(dom, 1, 31),
        month:  parseField(month, 1, 12),
        dow:    parseField(dow, 0, 7),
    };
    if (fields.dow.has(7)) { fields.dow.delete(7); fields.dow.add(0); }
    return fields;
}

/**
 * Get the calendar parts (Y/M/D/h/m/dow) of a UTC timestamp viewed in `tz`.
 */
function partsInTz(ts, tz) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false, weekday: 'short',
    });
    const parts = fmt.formatToParts(new Date(ts));
    const o = {};
    for (const p of parts) o[p.type] = p.value;
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        year: parseInt(o.year, 10),
        month: parseInt(o.month, 10),
        day: parseInt(o.day, 10),
        hour: parseInt(o.hour === '24' ? '0' : o.hour, 10),
        minute: parseInt(o.minute, 10),
        dow: dowMap[o.weekday],
    };
}

/**
 * Convert a (year, month, day, hour, minute) wall-clock value in tz into
 * a UTC Date. We invert through UTC by binary-searching offsets — simple
 * and DST-safe to within ±60s, which we tolerate.
 */
function tzWallClockToUtc(year, month, day, hour, minute, tz) {
    // Initial guess: treat the wall time as UTC.
    let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    for (let i = 0; i < 4; i++) {
        const p = partsInTz(guess, tz);
        const wantTs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
        const gotTs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
        const drift = wantTs - gotTs;
        if (drift === 0) break;
        guess += drift;
    }
    return new Date(guess);
}

function matches(fields, parts) {
    return fields.minute.has(parts.minute) &&
        fields.hour.has(parts.hour) &&
        fields.month.has(parts.month) &&
        // POSIX-cron rule: if both dom and dow are restricted (not '*'),
        // either matching is sufficient. We can't easily detect '*' from
        // the Set, so we approximate: when both have <full size, OR.
        (fields.dom.size === 31 && fields.dow.size === 7
            ? fields.dom.has(parts.day) && fields.dow.has(parts.dow)
            : fields.dom.size === 31
                ? fields.dow.has(parts.dow)
                : fields.dow.size === 7
                    ? fields.dom.has(parts.day)
                    : (fields.dom.has(parts.day) || fields.dow.has(parts.dow)));
}

/**
 * Compute the next time after `fromTs` (epoch ms, default = now) when the
 * cron expression fires, returning an ISO string in UTC.
 *
 * Naive search: minute by minute, capped at 366 days lookahead. Plenty
 * fast for our scale (one call per automation per scheduling pass).
 */
function nextRunAt(cron, tz = 'Europe/Amsterdam', fromTs = Date.now()) {
    const fields = parseCron(cron);
    const limit = fromTs + 366 * 24 * 60 * 60 * 1000;
    // Round up to next whole minute in the target tz.
    let cursor = new Date(fromTs);
    cursor.setUTCSeconds(0, 0);
    cursor = new Date(cursor.getTime() + 60_000); // strictly after now
    while (cursor.getTime() < limit) {
        const parts = partsInTz(cursor.getTime(), tz);
        if (matches(fields, parts)) {
            const utc = tzWallClockToUtc(parts.year, parts.month, parts.day, parts.hour, parts.minute, tz);
            return utc.toISOString();
        }
        cursor = new Date(cursor.getTime() + 60_000);
    }
    return null;
}

module.exports = { parseCron, nextRunAt, partsInTz };
