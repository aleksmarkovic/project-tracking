// When Claude runs by itself: the auto-update (scripts/auto-update.js), PR reviews (lib/review.js) and
// daily statuses (lib/daily.js). All three use the same working window, and each has its own interval:
// a slot starts every `every` minutes from 09:00, the last one at 19:00. A slot missed while the Mac
// slept runs on wake if it's still within the slot (at most its first hour).
const WINDOW = {
  workDays: [1, 2, 3, 4, 5], // Monday to Friday
  first: 9 * 60, // 09:00, in minutes after midnight
  last: 19 * 60, // 19:00, the last slot
};

// Minutes between slots.
export const EVERY = {
  update: 30, // auto-update: ticket sync and work log
  reviews: 30, // PR reviews (each head commit is reviewed once, so a slot with nothing new costs nothing)
  daily: 120, // daily status
};

// The start of the slot `date` falls in, or null outside every slot.
export function slotStart(date, every) {
  if (!WINDOW.workDays.includes(date.getDay())) return null;
  const minute = date.getHours() * 60 + date.getMinutes();
  if (minute < WINDOW.first) return null;
  const start = WINDOW.first + Math.floor((minute - WINDOW.first) / every) * every;
  if (start > WINDOW.last || minute >= start + Math.min(every, 60)) return null;
  const at = new Date(date);
  at.setHours(Math.floor(start / 60), start % 60, 0, 0);
  return at;
}

// The start of the next slot after `date`, for the page.
export function nextSlot(every, date = new Date()) {
  const at = new Date(date);
  at.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i += 1) {
    at.setMinutes(at.getMinutes() + 1);
    if (slotStart(at, every)?.getTime() === at.getTime()) return at;
  }
  return null;
}

// Calls `run` once at the start of each slot, checking every minute. Called once the server is up.
export function everySlot(every, run) {
  let lastSlot = null;
  const tick = () => {
    const slot = slotStart(new Date(), every)?.getTime() ?? null;
    if (slot === null || slot === lastSlot) return;
    lastSlot = slot;
    run();
  };
  tick();
  setInterval(tick, 60_000).unref();
}
