/**
 * Map an agent output language (for example `Chinese` or `Deutsch`) onto a
 * Factorio locale identifier. Factorio's `config.ini` uses the `[general]
 * locale=` key; unknown languages fall back to English, and already-locale-like
 * values (for example `zh-CN`) pass through.
 */
const LOCALE_BY_LANGUAGE: Array<[RegExp, string]> = [
  [/^(zh-tw|traditional|繁體|繁体)/i, "zh-TW"],
  [/^(zh|chinese|中文|简体|simplified)/i, "zh-CN"],
  [/^(en|english|英文)/i, "en"],
  [/^(de|german|deutsch)/i, "de"],
  [/^(fr|french|français|francais)/i, "fr"],
  [/^(es|spanish|español|espanol)/i, "es-ES"],
  [/^(pt|portuguese|português|portugues)/i, "pt-BR"],
  [/^(ru|russian|русский)/i, "ru"],
  [/^(ja|japanese|日本語)/i, "ja"],
  [/^(ko|korean|한국어)/i, "ko"],
  [/^(pl|polish|polski)/i, "pl"],
  [/^(it|italian|italiano)/i, "it"],
  [/^(nl|dutch|nederlands)/i, "nl"],
  [/^(cs|czech|čeština| cestina)/i, "cs"],
  [/^(hu|hungarian|magyar)/i, "hu"],
  [/^(sv|swedish|svenska)/i, "sv-SE"],
  [/^(tr|turkish|türkçe|turkce)/i, "tr"],
  [/^(uk|ukrainian|українська)/i, "uk"],
  [/^(vi|vietnamese|tiếng việt)/i, "vi"],
  [/^(id|indonesian|bahasa)/i, "id"],
];

/** Factorio locale for a run language; `en` when unknown/empty. */
export function factorioLocale(language?: string): string {
  const value = String(language ?? "").trim();
  if (!value) return "en";
  for (const [pattern, locale] of LOCALE_BY_LANGUAGE) {
    if (pattern.test(value)) return locale;
  }
  // Accept explicit locale identifiers such as `zh-CN` or `es-ES`.
  const explicit = value.match(/^([a-z]{2}(?:-[A-Z]{2})?)$/);
  return explicit ? explicit[1] : "en";
}

/** True when the value is safe to interpolate into config.ini. */
export function isSafeLocale(locale: string): boolean {
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale);
}
