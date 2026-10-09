# Security design

- The collector accepts only HTTPS URLs on `toronto.publicbikesystem.net`, using
  the default HTTPS port or port 443, without URL credentials.
- HTTP redirects are disabled. Decoded feed responses are capped at 10 MiB.
- Database queries use parameterized values; dynamic database names use quoted
  SQL identifiers.
- Docker Compose binds PostgreSQL, Streamlit, and Airflow ports to `127.0.0.1`.

The stack is intended for local development. Its shared database account and
Airflow development access settings are not suitable for public hosting.
