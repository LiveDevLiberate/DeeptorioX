import { asRecord, asString } from "./validation.js";

/** Only classify agent error events, never arbitrary tool output or agent prose. */
export function quotaError(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record || !["error", "turn.failed"].includes(asString(record.type) ?? "")) return undefined;
  const error = asRecord(record.error) ?? record;
  const message = asString(error.message) ?? "";
  const codes = [error.code, error.type, error.codex_error_info, record.code, record.codex_error_info];
  if (
    codes.some(
      (code) =>
        typeof code === "string" &&
        /^(usage_limit_exceeded|usageLimitExceeded|UsageLimitReached|usage_limit_reached|quota_exceeded|insufficient_quota)$/i.test(
          code,
        ),
    ) ||
    /(?:you(?:'|’)?ve hit your usage limit|you have (?:hit|reached) your usage limit|usage limit (?:has been )?(?:reached|exceeded)|(?:five|5)[ -]hour.*(?:limit|quota).*(?:reached|exhausted)|quota (?:has been )?(?:exhausted|exceeded))/i.test(
      message,
    )
  ) {
    return message || "Codex account usage quota exhausted";
  }
}
