"""Backend-side sensitive-data detection.

This mirrors packages/sensitive-data (the frontend detector) so the same
categories are blocked regardless of entry point. It exists as defense in
depth: the frontend gate stops a request before it ever leaves the browser,
but this backend gate also protects direct API callers and the one path the
browser cannot intercept before the fact - the live voice transcript, which
Gemini has already produced server-side transcription for by the time this
service sees it. In that case the backend gate cannot stop the audio bytes
already sent to the model, but it does stop the app from doing anything
further with the sensitive transcript (no RAG lookup, no re-injection into
the conversation, no persistence).

Rules are modular (one entry per pattern) so new categories can be added
without touching the scanning logic. Findings never carry the matched
substring, only a rule id/category label, so callers cannot accidentally log
or persist the sensitive value itself.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class SensitiveDataFinding:
    rule_id: str
    category: str


class SensitiveDataDetectedError(ValueError):
    """Raised when user input matches a sensitive-data rule and must be blocked."""

    def __init__(self, findings: list[SensitiveDataFinding]) -> None:
        self.findings = findings
        self.categories = sorted({finding.category for finding in findings})
        super().__init__(f"Blocked message containing sensitive data: {self.categories}")


BLOCK_MESSAGE = "Your message contains sensitive personal information. Please remove it before continuing."


def _passes_luhn_check(digits: str) -> bool:
    total = 0
    should_double = False
    for char in reversed(digits):
        digit = int(char)
        if should_double:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        should_double = not should_double
    return total % 10 == 0


_CARD_CANDIDATE_PATTERN = re.compile(r"\b(?:\d[ -]?){13,19}\b")


def _card_number_rule(text: str) -> bool:
    for candidate in _CARD_CANDIDATE_PATTERN.findall(text):
        digits = candidate.replace(" ", "").replace("-", "")
        if 13 <= len(digits) <= 19 and _passes_luhn_check(digits):
            return True
    return False


@dataclass(frozen=True)
class _Rule:
    id: str
    category: str
    enabled_by_default: bool
    test: "callable[[str], bool]"


def _regex_rule(rule_id: str, category: str, pattern: str, enabled_by_default: bool = True) -> _Rule:
    compiled = re.compile(pattern, re.IGNORECASE)
    return _Rule(
        id=rule_id,
        category=category,
        enabled_by_default=enabled_by_default,
        test=lambda text: compiled.search(text) is not None,
    )


DEFAULT_RULES: list[_Rule] = [
    _regex_rule("nic_old", "National ID / NIC number", r"\b\d{9}[VXvx]\b"),
    _regex_rule("nic_new", "National ID / NIC number", r"\b\d{12}\b"),
    _regex_rule("passport_lk", "Passport number", r"\b[NDnd]\d{7}\b"),
    _regex_rule("passport_generic", "Passport number", r"\bpassport\b\D{0,15}[A-Za-z0-9]{6,9}\b"),
    _regex_rule(
        "driving_licence",
        "Driving licence number",
        r"\bdriving licen[cs]e\b\D{0,15}[A-Za-z0-9-]{5,15}\b",
    ),
    _Rule(
        id="card_number",
        category="Credit or debit card number",
        enabled_by_default=True,
        test=_card_number_rule,
    ),
    _regex_rule("iban", "Bank account number", r"\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b"),
    _regex_rule(
        "bank_account",
        "Bank account number",
        r"\b(?:account (?:no\.?|number)|a/c (?:no\.?|number)|acc(?:ount)? no\.?)\D{0,10}\d{6,18}\b",
    ),
    _regex_rule(
        "cvv_pin",
        "CVV or PIN code",
        r"\b(?:cvv2?|cvc2?|security code|pin(?: code| number)?)\D{0,15}\d{3,6}\b",
    ),
    _regex_rule("ssn_us", "Social Security / Tax ID number", r"\b\d{3}-\d{2}-\d{4}\b"),
    _regex_rule(
        "tin_generic",
        "Social Security / Tax ID number",
        r"\b(?:tax id(?:entification)?(?: number)?|tin|social security(?: number)?|ssn)\D{0,15}\d{6,11}\b",
    ),
    _regex_rule(
        "date_of_birth",
        "Date of birth",
        r"\b(?:date of birth|dob|born on|birth date)\D{0,10}\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}\b",
    ),
    _regex_rule(
        "phone_number",
        "Phone number",
        r"\b\+?\d{1,3}?[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b",
    ),
    _regex_rule(
        "email_address",
        "Email address",
        r"\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b",
        enabled_by_default=False,
    ),
    _regex_rule(
        "otp_code",
        "One-time password / verification code",
        r"\b(?:otp|one[- ]time (?:password|code|pin)|verification code|auth(?:entication)? code|2fa code)\D{0,15}\d{4,8}\b",
    ),
    _regex_rule(
        "password",
        "Password or passphrase",
        r"\b(?:password|passcode|passphrase|pwd)\s*(?:is|:|=)\s*\S{3,}",
    ),
]


def scan_for_sensitive_data(
    text: str,
    *,
    enable_rule_ids: set[str] | None = None,
    disable_rule_ids: set[str] | None = None,
    rules: list[_Rule] | None = None,
) -> list[SensitiveDataFinding]:
    if not text or not text.strip():
        return []

    active_rules = rules if rules is not None else DEFAULT_RULES
    enable_set = enable_rule_ids or set()
    disable_set = disable_rule_ids or set()

    findings: list[SensitiveDataFinding] = []
    for rule in active_rules:
        if rule.id in disable_set:
            continue
        if not (rule.enabled_by_default or rule.id in enable_set):
            continue
        if rule.test(text):
            findings.append(SensitiveDataFinding(rule_id=rule.id, category=rule.category))
    return findings


def contains_sensitive_data(text: str, **kwargs: object) -> bool:
    return len(scan_for_sensitive_data(text, **kwargs)) > 0  # type: ignore[arg-type]


def assert_not_sensitive(text: str, **kwargs: object) -> None:
    """Raise SensitiveDataDetectedError if `text` matches any active rule."""
    findings = scan_for_sensitive_data(text, **kwargs)  # type: ignore[arg-type]
    if findings:
        raise SensitiveDataDetectedError(findings)
