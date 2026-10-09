# Security review ? 2026-10-09

This is a focused engineering review, not a penetration test or a guarantee of security.
Public source code and a publicly accessible running service have different risks.
This project is intended for local development; do not expose its service ports publicly.

## Findings and fixes

The first pip-audit scan found 21 known advisories across Pillow, Streamlit and pytest
in the application/test environment, and five in sqlparse in the dbt environment.
An advisory count is not a count of demonstrated exploitable paths in this application.
Streamlit's Windows-specific advisory was especially relevant to the native setup:
https://github.com/streamlit/streamlit/security/advisories/GHSA-7p48-42j8-8846

Updated and locked Streamlit 1.54.0, Pillow 12.3.0, pytest 9.0.3,
dbt Core 1.11.15 and sqlparse 0.6.0. Both installed-environment scans then reported
**no known vulnerabilities** using pip-audit 2.9.0. The local project is not on PyPI
and cannot be advisory-scanned as a published package. Advisory databases change.

The HTTP collector now permits only HTTPS on the official Toronto host, with no
URL credentials or nonstandard port. Automatic redirects are refused, including
when an injected HTTP client enables them. Decoded responses are limited to 10 MiB.
Existing explicit timeouts, bounded transient retries and persisted Retry-After
backoff remain. A legitimate upstream host change will require a reviewed code update.
This is destination restriction, not a network firewall or DNS-rebinding defense.

Added tests for destination rejection, redirects, oversized streamed bodies and
nonfinite Retry-After input. Environment-specific .env files are now ignored while
.env.example remains tracked. CI includes dependency audits and a weekly run;
the new remote workflow has not yet been executed.

## Verification actually performed

- 154 pytest tests passed, including real PostgreSQL integration and dbt build
  with 45 data tests; ordinary tests use fixtures, not the live API.
- Ruff lint and formatting checks passed.
- Playwright rendered the updated dashboard against real stored observations,
  exercised station search and ranking tabs, and found no displayed errors.
- pip-audit scanned both installed application/test and dbt environments.
- Earlier review checked tracked files for accidental credentials; this is not a
  guarantee that every possible secret pattern has been detected.
- SQL values use bound parameters; dynamic database creation uses SQL identifiers.
  dbt is invoked with an argument list, without a shell. No user-upload or arbitrary
  code execution feature is provided by the application.

## Remaining boundaries

Docker images, OS packages, bundled browser binaries and the separate Airflow
runtime have not been vulnerability-scanned here. Docker/WSL is unavailable, so
container startup and scheduled Airflow execution still require verification.
The successful dbt test does not substitute for those checks.

Compose publishes service ports on loopback. Its database account is shared and
privileged, and Airflow uses development access settings. The native PostgreSQL
fallback uses loopback trust authentication. These are local conveniences, not a
production security design. Public hosting would require separate least-privilege
roles (including a read-only dashboard role), authentication, secret management,
network controls, TLS and a separate deployment review. Do not port-forward this setup.

Large-body protection does not bound every possible parsing CPU/memory cost or
station count. This review did not perform fuzzing, load testing or exploitation.
API responses remain external input; source/schema changes should fail visibly.
No private API key is needed for the public GBFS feed. Source attribution and usage
limitations are documented in source.md; public availability is not a license assumption.

## Repeat the dependency checks

After installing the locked dependencies, on Windows:

```powershell
uv tool run --from pip-audit==2.9.0 pip-audit --path .venv/Lib/site-packages
uv tool run --from pip-audit==2.9.0 pip-audit --path dbt/.venv/Lib/site-packages
```

On Linux replace each `Lib/site-packages` with `lib/python3.12/site-packages`.
These checks use an online advisory database; they are separate from offline fixture tests.
