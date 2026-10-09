"""PostgreSQL advisory lock IDs. Keep every ID here: two features sharing an ID block
each other (a long-lived collector lock once stopped every dbt build)."""

BIKESHARE_COLLECTION = 814_700_015
DBT_TRANSFORM = 814_700_016
TTC_EVENT_MATCHING = 814_700_017
TTC_COLLECTOR = 814_700_018

ALL = {
    "BIKESHARE_COLLECTION": BIKESHARE_COLLECTION,
    "DBT_TRANSFORM": DBT_TRANSFORM,
    "TTC_EVENT_MATCHING": TTC_EVENT_MATCHING,
    "TTC_COLLECTOR": TTC_COLLECTOR,
}
