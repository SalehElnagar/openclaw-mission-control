"""Weather API for Toronto current conditions with live-source fallback."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel

from app.api.deps import require_user_auth
from app.core.logging import get_logger

router = APIRouter(prefix="/weather", tags=["weather"])
logger = get_logger(__name__)
AUTH_DEP = Depends(require_user_auth)

TORONTO_LAT = 43.6532
TORONTO_LON = -79.3832
TORONTO_NAME = "Toronto"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
_CACHE_TTL_SECONDS = 300.0
_weather_cache: tuple[float, dict[str, Any]] | None = None


class WeatherSourceResponse(BaseModel):
    source: str
    fallback_used: bool
    updated_at: str
    location: str
    temperature_c: float
    windspeed_kph: float | None = None
    weather_code: int | None = None
    description: str | None = None


class WeatherEnvelope(BaseModel):
    ok: bool = True
    data: WeatherSourceResponse
    warning: str | None = None


class WeatherError(BaseModel):
    detail: str


_WEATHER_CODE_LABELS: dict[int, str] = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    80: "Rain showers",
    81: "Heavy rain showers",
    82: "Violent rain showers",
}


async def _fetch_live_weather(client: httpx.AsyncClient) -> WeatherSourceResponse:
    response = await client.get(
        OPEN_METEO_URL,
        params={
            "latitude": TORONTO_LAT,
            "longitude": TORONTO_LON,
            "current": "temperature_2m,windspeed_10m,weather_code",
            "temperature_unit": "celsius",
            "wind_speed_unit": "kmh",
            "timezone": "America/Toronto",
        },
    )
    response.raise_for_status()
    payload = response.json()
    current = payload.get("current")
    if not isinstance(current, dict):
        raise ValueError("missing current weather data")
    temperature = current.get("temperature_2m")
    if temperature is None:
        raise ValueError("missing temperature data")
    code = current.get("weather_code")
    updated_at = str(current.get("time") or datetime.now(timezone.utc).isoformat())
    return WeatherSourceResponse(
        source="open-meteo",
        fallback_used=False,
        updated_at=updated_at,
        location=TORONTO_NAME,
        temperature_c=float(temperature),
        windspeed_kph=(
            float(current["windspeed_10m"]) if current.get("windspeed_10m") is not None else None
        ),
        weather_code=int(code) if code is not None else None,
        description=_WEATHER_CODE_LABELS.get(int(code)) if code is not None else None,
    )


def _fallback_weather() -> WeatherSourceResponse:
    return WeatherSourceResponse(
        source="mock-fallback",
        fallback_used=True,
        updated_at=datetime.now(timezone.utc).isoformat(),
        location=TORONTO_NAME,
        temperature_c=0.0,
        windspeed_kph=None,
        weather_code=None,
        description="Live weather source unavailable; returning a documented fallback value.",
    )


def _cached_weather(now: float) -> WeatherSourceResponse | None:
    global _weather_cache
    if _weather_cache is None:
        return None
    cached_at, cached_payload = _weather_cache
    if now - cached_at > _CACHE_TTL_SECONDS:
        return None
    return WeatherSourceResponse.model_validate(cached_payload)


@router.get("/toronto", response_model=WeatherEnvelope, responses={502: {"model": WeatherError}})
async def get_toronto_weather(
    _auth: object = AUTH_DEP,
    use_fallback: bool = Query(
        default=False, description="Return the documented fallback without calling upstream."
    ),
) -> WeatherEnvelope:
    """Return current weather conditions for Toronto."""
    now = datetime.now(timezone.utc).timestamp()
    if use_fallback:
        return WeatherEnvelope(
            data=_fallback_weather(),
            warning="Fallback requested explicitly via use_fallback=true.",
        )

    cached = _cached_weather(now)
    if cached is not None:
        return WeatherEnvelope(data=cached)

    timeout = httpx.Timeout(10.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        try:
            data = await _fetch_live_weather(client)
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("weather.toronto.upstream_failed error=%s", exc)
            fallback = _fallback_weather()
            return WeatherEnvelope(
                data=fallback,
                warning="Live weather source unavailable; using fallback data.",
            )

    global _weather_cache
    _weather_cache = (now, data.model_dump())
    return WeatherEnvelope(data=data)
