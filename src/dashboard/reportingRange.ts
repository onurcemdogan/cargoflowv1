// Dashboard SATIŞ analitiği için saf raporlama günü helper'ı.
//
// Kanıtlanan kök neden (19.07.2026 mutabakatı): CargoFlow satış kartları
// makinenin yerel gününü, Durusoft raporları UTC gününü kullanıyordu;
// TSİ 00:00-02:59 siparişleri farklı günlere düşüyordu. Ürün kararı:
// satış analitiği Durusoft ile karşılaştırılabilirlik için UTC rapor
// günü kullanır. Sipariş saatlerinin KULLANICIYA GÖSTERİMİ, Siparişler
// ekranı tarih filtreleri ve operasyon sayaçları değişmez.
//
// Bu modül makinenin timezone'undan TAMAMEN bağımsızdır: yalnız UTC
// aritmetiği (Date.UTC / getUTC*) kullanır; setHours/getFullYear gibi
// yerel-TZ metotları YASAKTIR.

export type ReportingTimeZone = 'UTC' | 'Europe/Istanbul'

export type ReportingPeriodKey =
  | 'today'
  | 'yesterday'
  | 'last7Days'
  | 'last30Days'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom'

export interface ReportingRange {
  start: Date
  end: Date
}

export interface ReportingCustomRange {
  startDate?: string
  endDate?: string
}

// Bu turdaki varsayılan: Dashboard satış analitiği UTC rapor günü kullanır.
export const DASHBOARD_SALES_REPORTING_TIME_ZONE: ReportingTimeZone = 'UTC'

const DAY_MS = 86_400_000
// Türkiye 2016'dan beri sabit UTC+3'tedir (yaz saati uygulaması yok).
const ISTANBUL_OFFSET_MS = 3 * 3_600_000

function zoneOffsetMs(timeZone: ReportingTimeZone): number {
  return timeZone === 'Europe/Istanbul' ? ISTANBUL_OFFSET_MS : 0
}

interface ZoneDayParts {
  year: number
  month: number
  day: number
}

function zoneDayParts(now: Date, timeZone: ReportingTimeZone): ZoneDayParts {
  const shifted = new Date(now.getTime() + zoneOffsetMs(timeZone))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  }
}

// Bölgenin (yıl, ay, gün) gününün başlangıç ANI (UTC instant). Date.UTC
// taşmaları normalize eder (day 0 → önceki ayın son günü vb.).
function zonedDayStart(
  year: number,
  month: number,
  day: number,
  timeZone: ReportingTimeZone,
): Date {
  return new Date(Date.UTC(year, month, day) - zoneOffsetMs(timeZone))
}

function endOfDayFromStart(dayStart: Date, days = 1): Date {
  return new Date(dayStart.getTime() + days * DAY_MS - 1)
}

function parseCustomDate(
  value: string | undefined,
  fallback: ZoneDayParts,
): ZoneDayParts {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return fallback
  return {
    year: Number(match[1]),
    month: Number(match[2]) - 1,
    day: Number(match[3]),
  }
}

// "Bugün hangi TARİH?" seçimi (anchor) HER ZAMAN Europe/Istanbul
// takvimine göre yapılır — kullanıcı gece 00:00 TSİ'de yeni günü görür.
// Seçilen tarihin VERİ bucket'ı ise reportingTimeZone sınırlarıyla
// (varsayılan UTC, Durusoft mutabakatı) hesaplanır. Bu ayrım olmadan
// TSİ 00:00-03:00 arasında kartlar bir gün geride etiketleniyordu.
const REPORT_DAY_ANCHOR_TIME_ZONE: ReportingTimeZone = 'Europe/Istanbul'

export function resolveReportingRange(
  periodKey: ReportingPeriodKey,
  now: Date,
  reportingTimeZone: ReportingTimeZone,
  custom?: ReportingCustomRange,
): ReportingRange {
  const today = zoneDayParts(now, REPORT_DAY_ANCHOR_TIME_ZONE)
  const dayStart = (year: number, month: number, day: number) =>
    zonedDayStart(year, month, day, reportingTimeZone)
  const todayStart = dayStart(today.year, today.month, today.day)

  if (periodKey === 'today') {
    return { start: todayStart, end: endOfDayFromStart(todayStart) }
  }
  if (periodKey === 'yesterday') {
    const start = dayStart(today.year, today.month, today.day - 1)
    return { start, end: endOfDayFromStart(start) }
  }
  if (periodKey === 'last7Days') {
    return {
      start: dayStart(today.year, today.month, today.day - 6),
      end: endOfDayFromStart(todayStart),
    }
  }
  if (periodKey === 'last30Days') {
    return {
      start: dayStart(today.year, today.month, today.day - 29),
      end: endOfDayFromStart(todayStart),
    }
  }
  if (periodKey === 'thisMonth') {
    return {
      start: dayStart(today.year, today.month, 1),
      end: endOfDayFromStart(todayStart),
    }
  }
  if (periodKey === 'lastMonth') {
    const start = dayStart(today.year, today.month - 1, 1)
    const end = new Date(
      dayStart(today.year, today.month, 1).getTime() - 1,
    )
    return { start, end }
  }
  const startParts = parseCustomDate(custom?.startDate, today)
  const endParts = parseCustomDate(custom?.endDate, startParts)
  const startCandidate = dayStart(
    startParts.year,
    startParts.month,
    startParts.day,
  )
  const endCandidate = dayStart(endParts.year, endParts.month, endParts.day)
  const start = startCandidate <= endCandidate ? startCandidate : endCandidate
  const endDayStart =
    startCandidate <= endCandidate ? endCandidate : startCandidate
  return { start, end: endOfDayFromStart(endDayStart) }
}

// Satış kartları/grafiği için karşılaştırma dönemi (aynı zone kurallarıyla).
export function resolveReportingComparisonRange(
  periodKey: ReportingPeriodKey,
  period: ReportingRange,
  now: Date,
  reportingTimeZone: ReportingTimeZone,
): ReportingRange {
  const today = zoneDayParts(now, REPORT_DAY_ANCHOR_TIME_ZONE)
  const dayStart = (year: number, month: number, day: number) =>
    zonedDayStart(year, month, day, reportingTimeZone)

  if (periodKey === 'today' || periodKey === 'yesterday') {
    return {
      start: new Date(period.start.getTime() - DAY_MS),
      end: new Date(period.end.getTime() - DAY_MS),
    }
  }
  if (periodKey === 'thisMonth') {
    const spanDays = Math.max(
      1,
      Math.round((period.end.getTime() + 1 - period.start.getTime()) / DAY_MS),
    )
    const start = dayStart(today.year, today.month - 1, 1)
    return { start, end: endOfDayFromStart(start, spanDays) }
  }
  if (periodKey === 'lastMonth') {
    const start = dayStart(today.year, today.month - 2, 1)
    const end = new Date(
      dayStart(today.year, today.month - 1, 1).getTime() - 1,
    )
    return { start, end }
  }
  const spanMs = period.end.getTime() + 1 - period.start.getTime()
  return {
    start: new Date(period.start.getTime() - spanMs),
    end: new Date(period.end.getTime() - spanMs),
  }
}
