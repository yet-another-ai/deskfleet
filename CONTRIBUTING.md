# Contributing to DeskFleet

DeskFleet accepts code, documentation, and design contributions. Read the
[development guide](agents/docs/environment.md) for setup and focused checks,
and the [agent guide](AGENTS.md) for repository conventions.

## Contributor License Agreement

Each contributor must have a recorded acceptance of the
[Contributor License Agreement](CLA.md) with **Yet Another AI Global Ltd.** before
their contributions are merged. The CLA lets contributors retain ownership while
granting copyright and patent permissions, including the ability to sublicense
contributions under different license terms. The Work's current public license
is [Apache-2.0](LICENSE). If an employer owns the relevant rights, obtain its
authorization or have an authorized representative accept on its behalf.
Identify third-party material and its license separately.

### Signing the CLA

1. Read [CLA.md](CLA.md). Use GitHub's file permalink to record the exact commit
   containing the agreement You are accepting.
2. Email [contact@yetanother.ai](mailto:contact@yetanother.ai) with the subject
   `DeskFleet CLA acceptance`. Attach a copy of that agreement and include the
   completed acceptance below in the email body. Send it from the contact email
   listed in Your acceptance.
3. Link Your pull request in the email. A maintainer will confirm receipt and
   record the GitHub account's CLA status on the pull request. Keep a copy of the
   email and agreement for Your records.

```text
I have read and agree to the DeskFleet Contributor License Agreement identified
below with the named Recipient. I intend this email and my typed signature to
constitute my electronic signature to that Agreement. If signing for a legal
entity, I am authorized to bind it.

Recipient legal name: Yet Another AI Global Ltd.
Agreement version and immutable commit URL:
Contributor legal name (individual or legal entity):
Contact email:
GitHub username(s) covered:
Pull request URL:
Other earlier contributions expressly included, if any (otherwise "none"):
Signer's full legal name:
Signer's title, if signing for a legal entity:
Signature (type full legal name):
Date (YYYY-MM-DD):
```

Send the acceptance privately; do not commit it or post personal details in a
public issue or pull request. A maintainer should confirm account ownership
through the corresponding GitHub account before recording acceptance. For
company contributions, record the authorized accounts and the company's scope
of ownership. Contributions outside that scope need the relevant rights owner's
acceptance. Reuse a recorded acceptance for later contributions covered by the
same agreement and authority; changes to the agreement require a new acceptance.

Maintainers retain the acceptance email, the exact agreement text and commit,
the signature date, and the account verification together in private records.
Only the GitHub account and signing status need to appear on the pull request.
Checking signatures is manual; this repository has no automated CLA check.

## Preparing a pull request

Keep changes focused, explain the resulting behavior, and include the relevant
validation results. Run checks appropriate to the change using the repository's
locked mise toolchain. Engineering documentation belongs in `agents/docs/`;
`docs/` contains the product website and user manual.
