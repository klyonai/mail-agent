# Agent threat-model scope

Decision · 2026-10-03. The operator explicitly excluded the sender-forgery, delegation, mailbox-insertion, connector and compromised-account scenarios from this product's threat model, while retaining malicious content in legitimate email.

## Desired state

Assume correctly administered Microsoft 365 identity, mailbox and transport configuration. Retain configured sender admission, recipient restrictions, scoped mailbox credentials, resource authorization, exact write approval and uncertain-effect fences. Focus agent qualification on instructions embedded in legitimate mail, quotes, attachments, documents and tool results. Content cannot grant authority or change policy. See [security](../../../design/security.md).

Microsoft support and bespoke protected-header assurance are removed as release dependencies. The prepared support draft remains unsent. This is an explicit boundary decision, not evidence that earlier inconclusive probes proved header protection. Existing runtime authentication profiles and checks are unchanged. The existing `transport_headers_verified` setting records deliberate administrator acceptance of the profile's deployment assumptions; it is not enabled automatically.

## Roadmap amendment

Only the MA-004 acceptance sentence changes:

- Previous: “Record allowed/denied sender and mailbox access plus administrator verification of protected authentication headers.”
- Replacement: “Record allowed/denied sender and mailbox access plus administrator acceptance of the configured Microsoft 365 deployment assumptions.”

Recipient arrival, follow-ups, ambiguity, unavailable services, quoted injection, bounded effects, redacted reporting and restricted test grants remain required. All other twelve item criteria, dependencies and statuses remain unchanged. MA-004 stays in progress pending an evidence audit against the revised criterion; this decision alone completes no item.

## Next work

Audit existing text and tenant acceptance against MA-004, then close any actual evidence gaps. Verify that injection coverage checks application-enforced authority, rather than relying on the model to obey a warning. Continue release review, GitHub reporting readiness and retained image-advisory disposition under MA-007. Earlier evidence, frozen candidates and archives remain unchanged; no tenant changes, mail, support contact, publication or new test run occurs in this decision.
