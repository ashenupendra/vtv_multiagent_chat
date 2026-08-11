# Sensitive Data Guard

Client-side detection of common PII/secret formats (national IDs, card numbers,
OTPs, passwords, ...) used to block user input before it is ever sent to the
AI model. Findings never carry the matched value, only a rule id/category, so
callers can log a blocked event without risk of logging the sensitive data
itself.

See `services/orchestrator/app/services/sensitive_data.py` for the equivalent
backend-side rule set (defense in depth for direct API callers and the voice
transcript path, where the browser cannot intercept before Gemini's own
speech-to-text runs).
