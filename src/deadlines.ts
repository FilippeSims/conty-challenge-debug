const civilDayFormatter = new Intl.DateTimeFormat("en", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function approvedCivilDay(approvedAt: string): string {
  const { year, month, day } = Object.fromEntries(
    civilDayFormatter.formatToParts(new Date(approvedAt)).map(({ type, value }) => [type, value]),
  );
  return `${year}-${month}-${day}`;
}

export function isPastDeadline(approvedAt: string, deadlineDate: string): boolean {
  return approvedCivilDay(approvedAt) > deadlineDate;
}
