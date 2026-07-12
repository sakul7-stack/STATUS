// GET /api/status — proxies UptimeRobot, adds 30-day history, edge-cached.
// Stale-while-revalidate: always answer from cache instantly; refresh in the
// background. Only the very first cold hit waits on UptimeRobot (~20s).

const DAYS = 30;
const FRESH_MS = 90_000;   // younger than this -> serve as-is, no refresh
const RETAIN_S = 3600;     // keep the cached copy at the edge up to 1h

export async function onRequest(context) {
  const { env } = context;
  const apiKey = (env.UPTIMEROBOT_API_KEY || "").trim();

  if (!apiKey) {
    return json({ stat: "fail", error: "UPTIMEROBOT_API_KEY is not set" }, 500);
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://status.kushal-kc.com.np/__cache/monitors-${DAYS}d`);
  const cached = await cache.match(cacheKey);

  if (cached) {
    // We have *something* cached. Serve it instantly no matter how old it is,
    // and kick off a background refresh only when it's gone stale. The visitor
    // never waits on UptimeRobot.
    const age = Date.now() - Number(cached.headers.get("x-generated-ms") || 0);
    if (age > FRESH_MS) {
      context.waitUntil(refresh(apiKey, cache, cacheKey).catch(() => {}));
    }
    return cached;
  }

  // cold: nothing cached yet in this datacenter -> must wait for UptimeRobot
  // (slow, but only the very first hit per colo ever pays this).
  try {
    return await refresh(apiKey, cache, cacheKey);
  } catch (e) {
    return json({ stat: "fail", error: "Upstream fetch failed: " + e.message }, 502);
  }
}

async function refresh(apiKey, cache, cacheKey) {
  // one range per day, oldest -> newest
  const now = Math.floor(Date.now() / 1000);
  const ranges = [];
  const dayStart = [];
  for (let i = DAYS; i >= 1; i--) {
    const start = now - i * 86400;
    ranges.push(`${start}_${now - (i - 1) * 86400}`);
    dayStart.push(start);
  }

  const body = new URLSearchParams({
    api_key: apiKey,
    format: "json",
    custom_uptime_ratios: "1-7-30",
    custom_uptime_ranges: ranges.join("-"),
    response_times: "1",
    response_times_limit: "1",
  });

  const upstream = await fetch("https://api.uptimerobot.com/v2/getMonitors", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cache-control": "no-cache",
    },
    body,
  });
  const data = await upstream.json();

  // don't cache failures
  if (!data || data.stat !== "ok" || !Array.isArray(data.monitors)) {
    return json(data || { stat: "fail", error: "No data from UptimeRobot" }, 200);
  }

  const monitors = data.monitors.map((m) => {
    const [d1, d7, d30] = (m.custom_uptime_ratio || "").split("-");
    const dayRatios = (m.custom_uptime_ranges || "").split("-");

    // null = no data (before monitor existed)
    const history = dayStart.map((start, idx) => {
      if (start + 86400 <= (m.create_datetime || 0)) return null;
      const v = parseFloat(dayRatios[idx]);
      return isNaN(v) ? null : v;
    });

    const rt = Array.isArray(m.response_times) ? m.response_times[0] : null;
    const avg = m.average_response_time != null && m.average_response_time !== ""
      ? Math.round(parseFloat(m.average_response_time))
      : (rt ? Math.round(rt.value) : null);

    return {
      id: m.id,
      friendly_name: m.friendly_name,
      url: m.url,
      status: m.status,
      interval: m.interval,        // seconds
      uptime: { d1: num(d1), d7: num(d7), d30: num(d30) },
      avg_response: avg,           // ms
      last_checked: rt ? rt.datetime : null,
      history,
    };
  });

  const res = json(
    { stat: "ok", days: DAYS, generated_at: now, monitors },
    200,
    {
      // Edge/browser may serve this for up to RETAIN_S fresh, and keep serving
      // it stale for a day while a background refresh runs — so nobody blocks.
      "cache-control": `public, max-age=${RETAIN_S}, stale-while-revalidate=86400`,
      "x-generated-ms": String(Date.now()),
    }
  );
  await cache.put(cacheKey, res.clone());
  return res;
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}
