"""PostgreSQL connections and schema setup shared by every pipeline."""

from importlib.resources import files

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

SCHEMAS = ("transit.bikeshare", "transit.ttc")
# Everything the public site reads. raw holds source payloads it never needs.
READONLY_SCHEMAS = ("normalized", "staging", "analytics", "ops")


def connect(database_url):
    return psycopg.connect(
        database_url,
        autocommit=True,
        row_factory=dict_row,
        connect_timeout=10,
        options="-c timezone=UTC -c statement_timeout=60000",
    )


def init_db(database_url):
    with connect(database_url) as conn, conn.transaction():
        for package in SCHEMAS:
            conn.execute(files(package).joinpath("schema.sql").read_text(encoding="utf-8"))


def ensure_readonly_role(database_url, role: str, password: str):
    """Create or update a login role that can read the site's schemas and write nothing,
    including tables dbt creates later (default privileges for objects this user makes)."""
    with connect(database_url) as conn, conn.transaction():
        name = sql.Identifier(role)
        exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)).fetchone()
        verb = sql.SQL("ALTER" if exists else "CREATE")
        conn.execute(
            sql.SQL("{} ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD {}").format(
                verb, name, sql.Literal(password)
            )
        )
        conn.execute(sql.SQL("ALTER ROLE {} SET default_transaction_read_only = on").format(name))
        database = conn.execute("SELECT current_database() AS name").fetchone()["name"]
        conn.execute(
            sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database), name)
        )
        for schema in READONLY_SCHEMAS:
            s = sql.Identifier(schema)
            conn.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(s))
            conn.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(s, name))
            conn.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(s, name))
            conn.execute(
                sql.SQL(
                    "ALTER DEFAULT PRIVILEGES IN SCHEMA {} GRANT SELECT ON TABLES TO {}"
                ).format(s, name)
            )
