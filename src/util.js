// Small shared helpers.

// SPAM PROTECTION
// Three layers, all tunable via the constants below.

function formatDuration(ms) {
    const totalMin = Math.max(1, Math.ceil(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const hPart = `${h} hour${h === 1 ? '' : 's'}`;
    const mPart = `${m} minute${m === 1 ? '' : 's'}`;
    if (!h) return mPart;
    if (!m) return hPart;
    return `${hPart} ${mPart}`;
}

module.exports = { formatDuration };
