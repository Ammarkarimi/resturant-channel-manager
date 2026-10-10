// Date helpers. All dates are plain "YYYY-MM-DD" strings handled in UTC so a
// stay date never shifts because of the server's time zone.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Inclusive range [start, end].
function eachDate(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

// 0 = Sunday ... 6 = Saturday
function weekday(s) {
  return new Date(`${s}T00:00:00Z`).getUTCDay();
}

module.exports = { isValidDate, addDays, today, eachDate, weekday };
