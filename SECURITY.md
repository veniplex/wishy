# Security policy

Found a vulnerability in Wishy? Thank you for reporting it. Please do it **privately** and do not open a public issue, pull
request or discussion about it.

## Reporting a vulnerability

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/veniplex/wishy/security/advisories/new)**
(tab *Security › Advisories › Report a vulnerability*). Only you and the maintainer can see the report.

Please include, as far as you know it:

- the affected version (*Admin › Updates*) and how Wishy runs (Docker image, reverse proxy, HTTPS),
- what an attacker needs (no account, a shared link, a member account, admin rights …) and what they gain,
- steps to reproduce or a proof of concept,
- relevant log lines or requests, **without** real personal data, passwords, tokens or your `secret.key`.

## What happens next

Wishy is maintained in spare time, so there are no guaranteed response times. The aim is to

1. acknowledge the report within a few days,
2. confirm or reject it, and tell you the planned fix,
3. release a fixed version and publish a security advisory, with a CVE where it makes sense,
4. credit you in the advisory if you want that.

Please give us time to ship a fix before you publish details. There is no bug bounty.

## Scope

Examples of what is in scope:

- bypassing sign-in, two-factor authentication, permissions or the separation between spaces,
- revealing hidden information to the wrong person, such as who reserved a wish or which gift is planned for them,
- cross-site scripting, request forgery, SQL injection, server-side request forgery through the link import,
- leaking secrets (`secret.key`, API keys, backup passphrases, session tokens),
- problems with signed updates, backups and restore, or the offline data stored in the browser,
- the Docker image and the release process of this repository.

Usually out of scope:

- attacks that need admin rights or access to the host, the data folder or volume, or the Docker API that the operator granted,
- running without HTTPS or with a wrongly configured reverse proxy, against the documentation,
- missing hardening without a practical attack, results of automated scanners without an explanation,
- denial of service through large amounts of traffic, social engineering,
- vulnerabilities in dependencies that Wishy does not use in a vulnerable way (a normal issue is fine for those).

Test only against your own installation and your own data. Do not access other people's data or disturb running services.

## Supported versions

Security fixes are provided for the latest stable version (`ghcr.io/veniplex/wishy:latest`). Please update before reporting.

## Operating Wishy securely

See "Security" in the [README](README.md#security) and the [operations guide](docs/operations.md).
