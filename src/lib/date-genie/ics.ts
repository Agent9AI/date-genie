/** Calendar export: the evening leaves the page and lands in a real calendar. */
import { fmtTime, type Booking, type Plan } from "./engine";

const pad = (n: number) => String(n).padStart(2, "0");

/** Next occurrence of the given wall-clock time, as a floating local ICS stamp. */
function stamp(hhmm: string, dayOffset = 0): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h ?? 19, m ?? 0, 0, 0);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

const esc = (s: string) => s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");

export function planToIcs(plan: Plan, booking: Booking | null): string {
  const now = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const events = plan.legs
    .filter((l) => l.kind !== "parking")
    .map((leg, i) => {
      const line = booking?.lines.find((l) => l.label === leg.title);
      return [
        "BEGIN:VEVENT",
        `UID:${plan.id}-${i}@date-genie`,
        `DTSTAMP:${now}`,
        `DTSTART:${stamp(leg.start)}`,
        `DTEND:${stamp(leg.end)}`,
        `SUMMARY:${esc(`${leg.glyph} ${leg.title}`)}`,
        `LOCATION:${esc(leg.neighborhood + ", Arlington, VA")}`,
        `DESCRIPTION:${esc(
          [
            leg.subtitle,
            leg.detail,
            line ? `Confirmation ${line.confirmation}` : "",
            `Planned by Date Genie`,
          ]
            .filter(Boolean)
            .join("\n"),
        )}`,
        "END:VEVENT",
      ].join("\r\n");
    });

  const parking = plan.legs.find((l) => l.kind === "parking");
  if (parking) {
    events.unshift(
      [
        "BEGIN:VEVENT",
        `UID:${plan.id}-park@date-genie`,
        `DTSTAMP:${now}`,
        `DTSTART:${stamp(parking.start)}`,
        `DTEND:${stamp(parking.end)}`,
        `SUMMARY:${esc(`🅿️ Park at ${parking.title}`)}`,
        `DESCRIPTION:${esc(`${parking.subtitle}. Leave home in time to arrive by ${fmtTime(parking.start)}.`)}`,
        "END:VEVENT",
      ].join("\r\n"),
    );
  }

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Date Genie//WebMCP//EN",
    "CALSCALE:GREGORIAN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

export function downloadIcs(plan: Plan, booking: Booking | null) {
  const blob = new Blob([planToIcs(plan, booking)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `date-genie-${plan.dinner.restaurant.name.toLowerCase().replace(/\W+/g, "-")}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
