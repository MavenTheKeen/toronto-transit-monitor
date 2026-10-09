-- A missing status row is still a metadata snapshot and contributes to coverage.
with snapshots as (
    select
        s.collection_id,
        s.station_id,
        s.name,
        s.lat,
        s.lon,
        s.capacity,
        r.collected_at,
        s.information_raw_id,
        coalesce(o.status_raw_id, p.raw_id) as status_raw_id,
        coalesce(o.status_fetched_at, p.fetched_at) as status_fetched_at,
        coalesce(o.source_published_at, p.source_published_at) as source_published_at,
        o.station_reported_at,
        o.num_bikes_available,
        o.num_docks_available,
        o.num_bikes_disabled,
        o.num_docks_disabled,
        o.is_installed,
        o.is_renting,
        o.is_returning,
        o.station_id is not null as observed
    from {{ source('normalized', 'station_snapshots') }} s
    inner join {{ source('ops', 'ingestion_runs') }} r
        on s.collection_id = r.collection_id and r.status = 'succeeded'
    left join {{ source('normalized', 'observations') }} o
        on s.collection_id = o.collection_id and s.station_id = o.station_id
    left join {{ source('raw', 'feed_payloads') }} p
        on s.collection_id = p.collection_id and p.feed_name = 'station_status'
), freshness as (
    select
        *,
        coalesce(
            observed
            and extract(epoch from status_fetched_at - source_published_at)
                between -{{ var('future_tolerance_seconds') }}
                    and {{ var('max_report_age_seconds') }},
            false
        ) as source_fresh,
        coalesce(
            observed
            and extract(epoch from status_fetched_at - station_reported_at)
                between -{{ var('future_tolerance_seconds') }}
                    and {{ var('max_report_age_seconds') }},
            false
        ) as station_fresh
    from snapshots
), eligibility as (
    select
        *,
        source_fresh and station_fresh as is_fresh,
        coalesce(observed and source_fresh and station_fresh and is_installed
            and is_renting, false) as rental_eligible,
        coalesce(observed and source_fresh and station_fresh and is_installed
            and is_returning, false) as return_eligible
    from freshness
)
select
    *,
    rental_eligible and num_bikes_available = 0 as is_empty,
    return_eligible and num_docks_available = 0 as is_full
from eligibility
