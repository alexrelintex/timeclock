/**
 * Paycor punchDateTime is EMPLOYEE-LOCAL wall time, format YYYY-MM-DDTHH:MM:SS,
 * no offset (verified against the EmployeePunch schema). Core stores UTC;
 * this converts at the adapter boundary using the agent's IANA timezone.
 * Uses Intl (built-in) — no date library dependency.
 */

export function toEmployeeLocalDateTime(utc: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(utc).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  // en-CA gives YYYY-MM-DD ordering; hour '24' can appear for midnight in some ICU versions.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
}
