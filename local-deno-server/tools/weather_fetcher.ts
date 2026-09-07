import { initToolConfig } from "/core/utils/initToolConfig.ts";
import { dispatchToGateway } from "/core/network/network_gateway.ts";
import type { ToolExecutionContext, ToolConfig } from "/core/contracts/ToolContract.ts";

// 1. Declarative Configuration
const baseConfig: Partial<ToolConfig> = {
  name: "weather_fetcher",
  version: "1.0.0",
  description: "Returns the current temperature for a city using the Open-Meteo public API.",

  // Rule 4 — secrets over env. Open-Meteo needs no key, so this one is optional
  // and is only forwarded when the operator supplied it.
  secrets: {
    WEATHER_API_KEY: {
      description: "Optional Open-Meteo commercial API key. Public endpoints work without it.",
      isOptional: true,
    },
  },

  // Rule 3 + Rule 7 — the gateway is a dependency, and every host it may reach
  // is spelled out as an absolute prefix below.
  tool_dependencies: ["network_gateway"],
  network_requests: ["https://api.open-meteo.com/"],

  rateLimit: { requestsPerMinute: 60 },
  outputModality: ["text"],
  timeoutMs: 15000,
  isIdempotent: true,

  signature: {
    inputs: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude in decimal degrees." },
        longitude: { type: "number", description: "Longitude in decimal degrees." },
        city: {
          type: "string",
          description: "Optional label echoed back; resolved from the built-in gazetteer when lat/lon are omitted.",
        },
      },
      required: [],
    },
    outputs: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        city: { type: "string" },
        latitude: { type: "number" },
        longitude: { type: "number" },
        temperature_c: { type: "number" },
        windspeed_kmh: { type: "number" },
      },
    },
    errors: {
      CITY_NOT_FOUND: {
        description: "The named city is not in the built-in gazetteer and no coordinates were supplied.",
        actionable_advice:
          "Call again with explicit numeric `latitude` and `longitude`, or use one of: london, paris, new york, tokyo, sydney, tel aviv.",
      },
      INVALID_INPUT: {
        description: "Neither a known city nor a valid latitude/longitude pair was provided.",
        actionable_advice: "Supply `city` as a string, or both `latitude` and `longitude` as numbers.",
      },
      UPSTREAM_ERROR: {
        description: "The Open-Meteo API returned a non-200 response.",
        actionable_advice: "Retry once; if it persists the upstream service is down — do not loop.",
      },
      NETWORK_NOT_ALLOWLISTED: {
        description: "The gateway refused the target URL because it is not in config.network_requests.",
        actionable_advice: "Add the absolute URL prefix to network_requests in weather_fetcher.ts.",
      },
    },
  },

  tests: [
    {
      name: "Known city resolves and returns a temperature",
      payload: { city: "london" },
      expect: { status: 200, hasKey: "temperature_c" },
    },
    {
      name: "Unknown city returns actionable CITY_NOT_FOUND",
      payload: { city: "atlantis" },
      expect: { status: 404, hasKey: "error" },
    },
  ],
};

export const config = await initToolConfig(import.meta.url, baseConfig) as ToolConfig;

/** Tiny built-in gazetteer — keeps the tool dependency-free and deterministic. */
const GAZETTEER: Record<string, { latitude: number; longitude: number }> = {
  "london": { latitude: 51.5072, longitude: -0.1276 },
  "paris": { latitude: 48.8566, longitude: 2.3522 },
  "new york": { latitude: 40.7128, longitude: -74.006 },
  "tokyo": { latitude: 35.6762, longitude: 139.6503 },
  "sydney": { latitude: -33.8688, longitude: 151.2093 },
  "tel aviv": { latitude: 32.0853, longitude: 34.7818 },
};

// 2. Execution Logic
export default async function execute(
  request: Request,
  context: ToolExecutionContext,
): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({}));
    const { city, latitude, longitude } = body ?? {};

    let lat = typeof latitude === "number" ? latitude : undefined;
    let lon = typeof longitude === "number" ? longitude : undefined;
    let label = typeof city === "string" ? city : undefined;

    if (lat === undefined || lon === undefined) {
      if (typeof city !== "string" || city.trim() === "") {
        return Response.json({
          error: "INVALID_INPUT",
          message: "Provide `city`, or both `latitude` and `longitude`.",
          actionable_advice: config.signature.errors?.INVALID_INPUT?.actionable_advice,
        }, { status: 400 });
      }
      const hit = GAZETTEER[city.trim().toLowerCase()];
      if (!hit) {
        return Response.json({
          error: "CITY_NOT_FOUND",
          message: `"${city}" is not in the built-in gazetteer.`,
          actionable_advice: config.signature.errors?.CITY_NOT_FOUND?.actionable_advice,
          known_cities: Object.keys(GAZETTEER),
        }, { status: 404 });
      }
      lat = hit.latitude;
      lon = hit.longitude;
      label = city;
    }

    // Rule 7 — never a bare fetch(). The gateway validates the target against
    // config.network_requests, so `config` rides along as callerConfig.
    const base = context.env?.WEATHER_API_BASE ?? "https://api.open-meteo.com/v1/forecast";
    const url = `${base}?latitude=${lat}&longitude=${lon}&current_weather=true`;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = context.env?.WEATHER_API_KEY;
    if (apiKey) headers["X-API-Key"] = apiKey; // optional secret — only sent when present

    const gatewayResult = await dispatchToGateway(
      { url, method: "GET", headers },
      { ...context, callerConfig: config },
    );

    if (gatewayResult.status !== 200) {
      return Response.json({
        error: "UPSTREAM_ERROR",
        message: `Open-Meteo responded ${gatewayResult.status}.`,
        actionable_advice: config.signature.errors?.UPSTREAM_ERROR?.actionable_advice,
      }, { status: 502 });
    }

    const payload = gatewayResult.body as { current_weather?: { temperature?: number; windspeed?: number } };
    const current = payload?.current_weather ?? {};

    // 3. Strict JSON Output
    return Response.json({
      success: true,
      city: label ?? null,
      latitude: lat,
      longitude: lon,
      temperature_c: current.temperature ?? null,
      windspeed_kmh: current.windspeed ?? null,
    });
  } catch (error) {
    // Rule 5 — never throw out of execute.
    const code = (error as { code?: string })?.code;
    if (code === "NETWORK_NOT_ALLOWLISTED") {
      return Response.json({
        error: "NETWORK_NOT_ALLOWLISTED",
        message: error instanceof Error ? error.message : String(error),
        actionable_advice: (error as { actionable_advice?: string }).actionable_advice,
      }, { status: 403 });
    }
    return Response.json({
      error: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
