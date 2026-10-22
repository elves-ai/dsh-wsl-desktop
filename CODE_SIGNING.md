# Code signing policy

Last updated: 2026-10-22

## Current status: unsigned

DSH WSL Desktop is preparing an application to [SignPath Foundation](https://signpath.org/). No approval, certificate, signing subscription, or active sponsorship is claimed. Current published Windows builds are **unsigned** and can trigger Windows SmartScreen warnings. The MIT source-code license does not establish trust in an executable or imply approval by a signing service.

The current GitHub Actions workflow tests and builds Windows binaries, creates an NSIS installer, and uploads artifacts and SHA256 checksums. It does not contain a signing key or perform signing. A checksum detects changes relative to the published checksum; it is not a substitute for a trusted signature.

## Maintainer and roles

This is an individually maintained project. Evan Yang is the project maintainer and proposed author/reviewer/signing approver. These roles are held by the same person; this policy does not claim independent multi-person review or an existing SignPath approval role.

The source and build scripts are maintained in the [public repository](https://github.com/elves-ai/dsh-wsl-desktop). External contributions must be reviewed by the maintainer before inclusion in a signed release. Any future signing-service access requires the provider's approval and setup, including applicable multi-factor authentication requirements.

## Requirements before signing is enabled

- Only artifacts verifiably built from this project's reviewed source and build configuration may be submitted under this project's signing configuration. Upstream projects must not be rebranded or separately signed as this project's own work.
- A signing request must identify its source commit, version, successful CI run, and artifacts. Product name/version metadata must be consistent with the project and release.
- Every release/signing request requires explicit human approval by the maintainer. Passing CI alone is not approval. Pull requests and unreviewed branches must not receive signing credentials or automatic signing access.
- If SignPath approves the project, configure its artifact-origin checks, signing policy, and manual approval requirements before distributing any build as SignPath-signed. Private keys must not be placed in the repository or public CI logs.
- Publish checksums only after signing the application and installer, and verify the resulting signatures and timestamps before distribution. Do not treat a signed outer installer as proof that its embedded executable is signed.
- Suspected build compromise or policy violations must suspend signing while the maintainer investigates and cooperates with the signing provider.

These are the project's intended gates for future signed releases. They are not a claim that a signing integration, GitHub branch protection, multi-factor authentication, or provider approval has already been configured or audited.

## Attribution if approved

The intended attribution for future builds actually signed through the program is:

> Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

This is **conditional future attribution**, not a statement that current downloads are signed or the application has been accepted. If approval is not granted, the project remains unsigned or must use another appropriately authorized signing solution.

See the [download page](<DOWNLOADS.md>) and [privacy policy](<PRIVACY.md>) for current distribution and data-handling details. The maintainer's acceptance of any provider agreement must occur separately; this document does not accept those terms on the maintainer's behalf.
