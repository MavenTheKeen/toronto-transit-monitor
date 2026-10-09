"""Public read-only API and page. Run: uvicorn transit.web.app:app

Responses are cached in memory for 15 s, so load on PostgreSQL does not grow with
visitors. A small per-IP limit protects the process. Browsers only talk to this
service; it never calls the TTC.
"""

import os
import threading
import time
from collections import deque
from datetime import UTC, datetime
from importlib.resources import files

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from transit.db import connect
from transit.web import queries

CACHE_SECONDS = 15
RATE_LIMIT = int(os.environ.get("WEB_RATE_LIMIT_PER_MINUTE", "120"))
STATIC = files("transit.web").joinpath("static")
ATTRIBUTION = "Data: Toronto Transit Commission. Predictions may be inaccurate."


class TTLCache:
    def __init__(self, seconds: float, clock=time.monotonic):
        self.seconds, self.clock = seconds, clock
        self.items: dict = {}
        self.lock = threading.Lock()

    def get(self, key, compute):
        now = self.clock()
        with self.lock:
            hit = self.items.get(key)
            if hit and hit[0] > now:
                return hit[1]
        value = compute()
        with self.lock:
            self.items[key] = (now + self.seconds, value)
            if len(self.items) > 500:  # Unknown station keys cannot grow memory unbounded.
                self.items = {k: v for k, v in self.items.items() if v[0] > now}
        return value


class RateLimiter:
    """Sliding one-minute window per client address."""

    def __init__(self, limit: int, clock=time.monotonic):
        self.limit, self.clock = limit, clock
        self.hits: dict[str, deque] = {}
        self.lock = threading.Lock()

    def allow(self, client: str) -> bool:
        now = self.clock()
        with self.lock:
            window = self.hits.setdefault(client, deque())
            while window and window[0] <= now - 60:
                window.popleft()
            if len(window) >= self.limit:
                return False
            window.append(now)
            if len(self.hits) > 10_000:
                self.hits = {k: v for k, v in self.hits.items() if v and v[-1] > now - 60}
            return True


def create_app(database_url: str | None = None, clock=lambda: datetime.now(UTC)) -> FastAPI:
    app = FastAPI(title="Toronto subway status", docs_url=None, redoc_url=None, openapi_url=None)
    cache = TTLCache(CACHE_SECONDS)
    limiter = RateLimiter(RATE_LIMIT)
    static_cache = {}
    static_lock = threading.Lock()

    def db_url():
        url = database_url or os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("Set DATABASE_URL")
        return url

    def schedule(conn):
        """Per-feed-version data that only changes when a new schedule is loaded."""
        version = queries.feed_version(conn)
        with static_lock:
            if static_cache.get("version") != version:
                static_cache.clear()
                static_cache.update(
                    version=version,
                    lines=queries.lines(conn, version),
                    stations=queries.all_stations(conn, version),
                    segments=queries.segment_seconds(conn, version),
                    network=queries.map_network(conn, version),
                )
            return dict(static_cache)

    def overview(conn, now):
        static = schedule(conn)
        state = queries.feed_state(conn)
        alerts = queries.current_alerts(conn, now)
        alerts_fresh = queries.freshness(state, "alerts_subway", now, queries.ALERTS_STALE)
        detected = {}
        if not queries.freshness(state, "trips_subway", now, queries.PREDICTIONS_STALE)["stale"]:
            headways = {
                line["id"]: queries.scheduled_headways(conn, static["version"], line["id"], now)
                for line in static["lines"]
            }
            detected = queries.detected_delays(
                queries.platform_waits(conn, static["version"], now),
                headways,
                queries.collection_gaps(conn, now),
                now,
            )
        statuses = queries.line_statuses(static["lines"], alerts, alerts_fresh, detected)
        return static, state, alerts, statuses

    def cached(key, build):
        def compute():
            now = clock()
            with connect(db_url()) as conn:
                body = build(conn, now)
            return {"generated_at": now, "attribution": ATTRIBUTION, **body}

        try:
            return cache.get(key, compute)
        except queries.NotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    # The map response lists every Bike Share dock (~200 KB); compressed it is a fraction.
    app.add_middleware(GZipMiddleware, minimum_size=1000)

    @app.middleware("http")
    async def protect(request: Request, call_next):
        client = request.client.host if request.client else "unknown"
        if request.url.path.startswith("/api/") and not limiter.allow(client):
            return JSONResponse(
                {"detail": "Too many requests"}, status_code=429, headers={"Retry-After": "60"}
            )
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/") and response.status_code == 200:
            response.headers["Cache-Control"] = f"public, max-age={CACHE_SECONDS}"
        return response

    @app.get("/health")
    def health():
        try:
            with connect(db_url()) as conn:
                state = queries.feed_state(conn)
                version = queries.feed_version(conn)
        except queries.NotFound:
            return {"status": "no_data", "schedule_version": None, "predictions_as_of": None}
        except Exception:
            return JSONResponse({"status": "unavailable"}, status_code=503)
        now = clock()
        trips = queries.freshness(state, "trips_subway", now, queries.PREDICTIONS_STALE)
        return {
            "status": "degraded" if trips["stale"] else "ok",
            "schedule_version": version[:12],
            "predictions_as_of": trips["as_of"],
        }

    @app.get("/api/status")
    def status():
        def build(conn, now):
            static, state, alerts, statuses = overview(conn, now)
            return {
                "alerts_as_of": queries.freshness(
                    state, "alerts_subway", now, queries.ALERTS_STALE
                ),
                "lines": statuses,
            }

        return cached("status", build)

    @app.get("/api/alerts")
    def alerts():
        def build(conn, now):
            _, state, current, _ = overview(conn, now)
            return {
                "alerts_as_of": queries.freshness(
                    state, "alerts_subway", now, queries.ALERTS_STALE
                ),
                "active": [
                    a for a in current if a["kind"] == "service" and a["timing"] == "active"
                ],
                "upcoming": [a for a in current if a["timing"] == "upcoming"],
                "accessibility": [
                    a for a in current if a["kind"] == "accessibility" and a["timing"] == "active"
                ],
            }

        return cached("alerts", build)

    @app.get("/api/lines")
    def lines():
        def build(conn, now):
            static, _, _, statuses = overview(conn, now)
            by_line = {s["line"]: s for s in statuses}
            return {
                "lines": [{**line, "status": by_line[line["id"]]} for line in static["lines"]],
                "stations": static["stations"],
            }

        return cached("lines", build)

    @app.get("/api/lines/{route_id}")
    def line(route_id: str):
        if not route_id.isdigit() or len(route_id) > 3:
            raise HTTPException(status_code=404, detail="Unknown line")

        def build(conn, now):
            static, state, alerts, statuses = overview(conn, now)
            meta = next((x for x in static["lines"] if x["id"] == route_id), None)
            if meta is None:
                raise queries.NotFound(f"Unknown line {route_id}")
            stations = queries.line_stations(conn, static["version"], route_id)
            trains = queries.train_positions(conn, route_id, stations, static["segments"], now)
            headways = queries.scheduled_headways(conn, static["version"], route_id, now)
            gaps = queries.gaps(trains, headways)
            return {
                "line": meta,
                "status": next(s for s in statuses if s["line"] == route_id),
                "predictions_as_of": queries.freshness(
                    state, "trips_subway", now, queries.PREDICTIONS_STALE
                ),
                "stations": [{"key": s["key"], "name": s["name"]} for s in stations],
                "trains": [{k: v for k, v in t.items() if not k.startswith("_")} for t in trains],
                "gaps": gaps,
                "scheduled_headway_seconds": {d: round(h) for d, h in headways.items()},
            }

        return cached(f"line:{route_id}", build)

    @app.get("/api/stations/{key}")
    def station(key: str):
        if len(key) > 60 or not key.replace("-", "").isalnum():
            raise HTTPException(status_code=404, detail="Unknown station")

        def build(conn, now):
            static, state, alerts, statuses = overview(conn, now)
            data = queries.station(conn, static["version"], key, now)
            stops = set(data.pop("stop_ids"))
            return {
                "station": data,
                "predictions_as_of": queries.freshness(
                    state, "trips_subway", now, queries.PREDICTIONS_STALE
                ),
                "line_status": [s for s in statuses if s["line"] in data["lines"]],
                "alerts": [a for a in alerts if stops & set(a["stop_ids"])],
                "bike_share": queries.nearest_bikes(conn, data["lat"], data["lon"], now),
            }

        return cached(f"station:{key}", build)

    @app.get("/api/map")
    def network_map():
        def build(conn, now):
            static, _, _, statuses = overview(conn, now)
            by_line = {s["line"]: s for s in statuses}
            network = static["network"]
            return {
                "lines": [
                    {**line, "status": by_line[line["id"]], "path": network["paths"][line["id"]]}
                    for line in static["lines"]
                ],
                "stations": network["stations"],
                "bike_share": queries.bike_docks(conn, now),
            }

        return cached("map", build)

    @app.get("/api/reliability")
    def reliability():
        def build(conn, now):
            try:
                return {"available": True, **queries.reliability(conn, now)}
            except psycopg.errors.UndefinedTable:
                # Reliability tables appear after the first dbt build.
                return {"available": False}

        return cached("reliability", build)

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC.joinpath("index.html"), headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
    return app


app = create_app()
