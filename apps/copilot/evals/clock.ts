/** Noon on `day` in `timezone`, as an instant. */
export function noonIn(day: string, timezone: string): Date {
  const guess = new Date(`${day}T12:00:00Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: timezone }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime()));
}
