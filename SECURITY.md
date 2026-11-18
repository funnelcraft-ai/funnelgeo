# Security

FunnelGeo holds data for many agencies and their clients, so we take reports
seriously.

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** and describe the problem, how to reproduce
   it, and what an attacker could do with it.

We'll acknowledge your report and keep you updated until the fix ships.

## What we're most interested in

- One agency, or a client viewer, reading or changing another tenant's data
- Bypassing row-level security or the API's trust of forwarded hostnames
- Getting the platform to issue certificates for, or serve, domains it should not
- Reading stored provider keys or other secrets
- Making the platform name appear on an agency's white-labelled pages, emails or reports

## Please don't

- Test against agencies' live workspaces or their clients' websites
- Run automated scanners that send large volumes of requests
- Access, keep or share data that isn't yours

Run FunnelGeo locally instead (see the README); every feature works with
stand-in engines.
