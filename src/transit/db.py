"""PostgreSQL connections and schema setup shared by every pipeline."""

from importlib.resources import files

import psycopg
from psycopg.rows import dict_row

SCHEMAS = ("transit.bikeshare", "transit.ttc")


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
