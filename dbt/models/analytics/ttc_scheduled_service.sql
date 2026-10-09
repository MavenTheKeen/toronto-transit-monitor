{{
    config(
        materialized='incremental',
        unique_key=['service_date', 'stop_id', 'service_hour'],
        incremental_strategy='delete+insert',
        on_schema_change='fail',
    )
}}
-- Scheduled trains per platform and service hour on each day with observations. Each
-- date uses the newest static GTFS version whose calendar covers it, so a later schedule
-- never rewrites the comparison for earlier days.
with dates as (
    select distinct service_date from {{ ref('ttc_headways') }}
    {% if is_incremental() %}
        where service_date >= (select coalesce(max(service_date), date '1900-01-01') - 1
                               from {{ this }})
    {% endif %}
), dated as (
    select d.service_date, v.feed_version
    from dates d
    cross join lateral (
        select feed_version
        from {{ source('normalized', 'ttc_gtfs_versions') }} gv
        order by (d.service_date between gv.service_start and gv.service_end) desc,
                 gv.loaded_at desc
        limit 1
    ) v
), services as (
    (
        select d.service_date, d.feed_version, c.service_id
        from dated d
        inner join {{ source('normalized', 'ttc_calendar') }} c
            on c.feed_version = d.feed_version
            and d.service_date between c.start_date and c.end_date
            and case extract(isodow from d.service_date)
                when 1 then c.monday when 2 then c.tuesday when 3 then c.wednesday
                when 4 then c.thursday when 5 then c.friday when 6 then c.saturday
                else c.sunday end
        union
        select d.service_date, d.feed_version, cd.service_id
        from dated d
        inner join {{ source('normalized', 'ttc_calendar_dates') }} cd
            on cd.feed_version = d.feed_version and cd.date = d.service_date
            and cd.exception_type = 1
    )
    except
    select d.service_date, d.feed_version, cd.service_id
    from dated d
    inner join {{ source('normalized', 'ttc_calendar_dates') }} cd
        on cd.feed_version = d.feed_version and cd.date = d.service_date
        and cd.exception_type = 2
)
select
    s.service_date,
    st.stop_id,
    st.arrival_seconds / 3600 as service_hour,
    min(s.feed_version) as feed_version,
    count(*) as scheduled_trains,
    round(3600.0 / count(*), 1) as scheduled_headway_seconds
from services s
inner join {{ source('normalized', 'ttc_trips') }} t
    on t.feed_version = s.feed_version and t.service_id = s.service_id
inner join {{ source('normalized', 'ttc_stop_times') }} st
    on st.feed_version = t.feed_version and st.trip_id = t.trip_id
where st.arrival_seconds is not null
group by 1, 2, 3
