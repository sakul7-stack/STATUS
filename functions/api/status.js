// GET /api/status — proxies UptimeRobot, adds 90-day history, edge-cached.

const DAYS = 90;

export async function onRequest(context) {
  const { env } = context;
  const apiKey = (env.UPTIMEROBOT_API_KEY || "").trim();

  if (!apiKey) {
    return json({ stat: "fail", error: "UPTIMEROBOT_API_KEY is not set" }, 500);
  }

  // edge cache
  const cache = caches.default;
  const cacheKey = new Request("https://status.kushal-kc.com.np/__cache/monitors-v2");
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // one range per day, oldest -> newest
  const now = Math.floor(Date.now() / 1000);
  const ranges = [];
  const dayStart = [];
  for (let i = DAYS; i >= 1; i--) {
    const start = now - i * 86400;
    const end = now - (i - 1) * 86400;
    ranges.push(`${start}_${end}`);
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

  let data;
  try {
    const upstream = await fetch("https://api.uptimerobot.com/v2/getMonitors", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cache-control": "no-cache",
      },
      body,
    });
    data = await upstream.json();
  } catch (e) {
    return json({ stat: "fail", error: "Upstream fetch failed: " + e.message }, 502);
  }

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
    { "cache-control": "public, max-age=120" }
  );
  context.waitUntil(cache.put(cacheKey, res.clone()));
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
