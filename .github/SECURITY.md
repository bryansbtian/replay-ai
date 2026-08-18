# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in replay-ai, please report it
privately. Do not open a public issue, pull request, or discussion, since that could
expose users of the project before a fix is available.

Use GitHub private vulnerability reporting: open the **Security** tab of this
repository and choose **Report a vulnerability**. That channel is private to the
maintainers.

Please include:

- A description of the issue and the potential impact.
- Steps to reproduce, or a proof of concept.
- The affected area (module, CLI command, capability artifact, dependency) if known.
- Any relevant logs or output, with secrets and personal data redacted.

## What to Expect

- We aim to acknowledge your report within 3 business days.
- We will investigate, keep you updated on progress, and let you know when a fix ships.
- Please give us a reasonable amount of time to address the issue before any public
  disclosure.

## Supported Versions

This project is pre-release and under active development. Only the `main` branch
receives security fixes. There are no supported published releases yet.

## Scope

In scope:

- Credential handling: anything that causes an API key or other secret to reach logs,
  evidence files, capability artifacts, error messages, or stdout.
- Capability artifacts and run evidence: content that leaks data, or an artifact that
  can be crafted to make replay take an unintended action.
- The safety guardrails that decide which actions may run without a human.
- Dependency issues with a demonstrated, exploitable impact on this project.

Out of scope:

- Reports from automated scanners without a demonstrated, exploitable impact.
- Vulnerabilities in the third-party websites or applications that this tool is pointed
  at during discovery or replay. Report those to the relevant vendor.
- Issues in third-party services or SDKs we integrate with, unless our use of them is
  what creates the vulnerability.
- Denial of service, volumetric, or rate-limit testing.
- Automating a target you are not authorized to automate. That is a misuse question,
  not a vulnerability in this project.

## Handling Secrets

Never include real secrets, API keys, tokens, or production credentials in a report. If
you discover an exposed secret, tell us what was exposed and where, but do not paste the
value.

The same rule governs this repository: `.env` is git-ignored, `.env.example` holds
placeholders only, and anything committed under `capabilities/` or `evidence/` must be
reviewed for credentials and personal data before it lands.
