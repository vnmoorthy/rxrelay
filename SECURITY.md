# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | ✅ |

## Reporting a vulnerability

If you believe you have found a security issue in RxRelay — especially anything that could:

- bypass the consent gate,
- fabricate proof-gate evidence,
- leak patient/recipient identifiers, or
- enable unconsented outbound telephony —

**do not open a public issue.**

Email the maintainer via the GitHub profile contact on [`vnmoorthy`](https://github.com/vnmoorthy), or open a [private security advisory](https://github.com/vnmoorthy/rxrelay/security/advisories/new) on this repository.

Please include:

1. a description of the issue,
2. steps to reproduce,
3. impact assessment, and
4. any suggested fix.

We aim to acknowledge reports within 72 hours.

## Non-goals / expected behavior

These are **not** vulnerabilities:

- Sandbox mode recording fake SMS/calls (by design when `TELEPHONY_PROVIDER=demo`).
- Live mode refusing outbound actions without OTP-verified allowlisted recipients.
- Safe-stop / human-review handoffs for clinical or emergency language.
