/**
 * Client-side sensitive-data detection.
 *
 * Scans free-text user input for common PII/secret shapes (national IDs, card
 * numbers, OTPs, passwords, ...) so the caller can refuse to send it to an AI
 * model. Rules are intentionally modular (one entry per pattern) so new
 * categories can be added without touching the scanning logic, and findings
 * never carry the matched substring - only a rule id/category label - so a
 * caller cannot accidentally log or transmit the sensitive value itself.
 */

export type SensitiveDataFinding = {
  ruleId: string;
  category: string;
};

type Rule = {
  id: string;
  category: string;
  /** Enabled by default unless overridden via ScanOptions.disabledRuleIds. */
  enabledByDefault: boolean;
  test: (text: string) => boolean;
};

function regexRule(
  id: string,
  category: string,
  pattern: RegExp,
  enabledByDefault = true,
): Rule {
  return {
    id,
    category,
    enabledByDefault,
    test: (text: string) => pattern.test(text),
  };
}

/** Luhn checksum, used to confirm a digit run actually shapes like a real card number. */
function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

const CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

const cardNumberRule: Rule = {
  id: "card_number",
  category: "Credit or debit card number",
  enabledByDefault: true,
  test: (text: string) => {
    const candidates = text.match(CARD_CANDIDATE_PATTERN) ?? [];
    return candidates.some((candidate) => {
      const digits = candidate.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && passesLuhnCheck(digits);
    });
  },
};

/**
 * Default rule set. Keyword-anchored rules (CVV, OTP, DOB, ...) require a
 * nearby trigger word so short, ambiguous numbers on their own don't get
 * flagged - that keeps false positives low per the "avoid false positives"
 * requirement while still catching the sensitive value once it's actually
 * being shared.
 */
export const DEFAULT_RULES: Rule[] = [
  regexRule("nic_old", "National ID / NIC number", /\b\d{9}[VXvx]\b/),
  regexRule("nic_new", "National ID / NIC number", /\b\d{12}\b/),
  regexRule("passport_lk", "Passport number", /\b[NDnd]\d{7}\b/),
  regexRule(
    "passport_generic",
    "Passport number",
    /\bpassport\b\D{0,15}[A-Za-z0-9]{6,9}\b/i,
  ),
  regexRule(
    "driving_licence",
    "Driving licence number",
    /\bdriving licen[cs]e\b\D{0,15}[A-Za-z0-9-]{5,15}\b/i,
  ),
  cardNumberRule,
  regexRule("iban", "Bank account number", /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/),
  regexRule(
    "bank_account",
    "Bank account number",
    /\b(?:account (?:no\.?|number)|a\/c (?:no\.?|number)|acc(?:ount)? no\.?)\D{0,10}\d{6,18}\b/i,
  ),
  regexRule(
    "cvv_pin",
    "CVV or PIN code",
    /\b(?:cvv2?|cvc2?|security code|pin(?: code| number)?)\D{0,15}\d{3,6}\b/i,
  ),
  regexRule("ssn_us", "Social Security / Tax ID number", /\b\d{3}-\d{2}-\d{4}\b/),
  regexRule(
    "tin_generic",
    "Social Security / Tax ID number",
    /\b(?:tax id(?:entification)?(?: number)?|tin|social security(?: number)?|ssn)\D{0,15}\d{6,11}\b/i,
  ),
  regexRule(
    "date_of_birth",
    "Date of birth",
    /\b(?:date of birth|dob|born on|birth date)\D{0,10}\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}\b/i,
  ),
  regexRule(
    "phone_number",
    "Phone number",
    /\b\+?\d{1,3}?[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/,
    true,
  ),
  regexRule(
    "email_address",
    "Email address",
    /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/,
    // Off by default: many legitimate support requests share an email
    // address, and policy on whether that counts as sensitive varies by
    // deployment. Enable via ScanOptions.enableRuleIds when required.
    false,
  ),
  regexRule(
    "otp_code",
    "One-time password / verification code",
    /\b(?:otp|one[- ]time (?:password|code|pin)|verification code|auth(?:entication)? code|2fa code)\D{0,15}\d{4,8}\b/i,
  ),
  regexRule(
    "password",
    "Password or passphrase",
    /\b(?:password|passcode|passphrase|pwd)\s*(?:is|:|=)\s*\S{3,}/i,
  ),
];

export type ScanOptions = {
  /** Rule ids to force-enable even if they're off by default (e.g. "email_address"). */
  enableRuleIds?: string[];
  /** Rule ids to skip even if they're on by default. */
  disableRuleIds?: string[];
  rules?: Rule[];
};

export function scanForSensitiveData(
  text: string,
  options: ScanOptions = {},
): SensitiveDataFinding[] {
  if (!text || !text.trim()) {
    return [];
  }

  const rules = options.rules ?? DEFAULT_RULES;
  const enableSet = new Set(options.enableRuleIds ?? []);
  const disableSet = new Set(options.disableRuleIds ?? []);

  const findings: SensitiveDataFinding[] = [];
  for (const rule of rules) {
    if (disableSet.has(rule.id)) continue;
    const active = rule.enabledByDefault || enableSet.has(rule.id);
    if (!active) continue;
    if (rule.test(text)) {
      findings.push({ ruleId: rule.id, category: rule.category });
    }
  }
  return findings;
}

export function containsSensitiveData(text: string, options?: ScanOptions): boolean {
  return scanForSensitiveData(text, options).length > 0;
}

export const SENSITIVE_DATA_BLOCK_MESSAGE =
  "Your message contains sensitive personal information. Please remove it before continuing.";

/**
 * Logs a blocked event locally for debugging - categories/rule ids only,
 * never the raw text - so support engineers can see that blocking happened
 * without the sensitive value ever touching application logs.
 */
export function logSensitiveDataBlocked(
  findings: SensitiveDataFinding[],
  context?: Record<string, unknown>,
): void {
  // eslint-disable-next-line no-console
  console.warn("[sensitive-data-guard] Blocked outgoing message", {
    categories: Array.from(new Set(findings.map((finding) => finding.category))),
    ruleIds: findings.map((finding) => finding.ruleId),
    ...context,
  });
}
