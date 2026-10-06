const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const parse = (date: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export function localDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow + 3);
  const year = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function weekDays(week: string): string[] {
  const [y, w] = week.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

export const weekOfDate = (date: string): string => isoWeek(parse(date));

export function shiftWeek(week: string, delta: number): string {
  const d = parse(weekDays(week)[0]);
  d.setDate(d.getDate() + 7 * delta);
  return isoWeek(d);
}

export const weekdayName = (date: string): string => DAY_NAMES[parse(date).getDay()];

export function weekWindow(week: string): { from: Date; to: Date } {
  const from = parse(weekDays(week)[0]);
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  return { from, to };
}

export function resolveWeek(arg: string | undefined, now: Date = new Date()): string {
  if (!arg || arg === 'this') return isoWeek(now);
  if (arg === 'last') return shiftWeek(isoWeek(now), -1);
  if (/^\d{4}-W\d{2}$/.test(arg)) return arg;
  throw new Error(`Unrecognised week "${arg}". Use this, last or YYYY-Www.`);
}

export const dayDistance = (a: string, b: string): number =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
