
const CACHE_SECONDS = 24 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

async function searchYouTube(request, env, ctx) {
  const url = new URL(request.url);

  const rawQuery = url.searchParams.get("q") || "";
  const query = rawQuery.trim().replace(/\s+/g, " ");

  if (query.length < 3 || query.length > 80) {
    return json(
      { error: "Enter a search between 3 and 80 characters." },
      400
    );
  }

  if (!env.YOUTUBE_API_KEY) {
    return json(
      { error: "YouTube API key is not configured." },
      500
    );
  }

  // Normalize searches to improve cache reuse.
  const normalized = query.toLowerCase();

  // Search only for karaoke videos.
  const searchTerm = `${normalized} karaoke`;

  // Remove all other query parameters from the cache key.
  const cacheUrl = new URL("/api/youtube/search", url.origin);
  cacheUrl.searchParams.set("q", normalized);

  const cacheKey = new Request(cacheUrl.toString(), {
    method: "GET",
  });

  const cache = caches.default;

  // 1. Check Cloudflare's cache first.
  const cached = await cache.match(cacheKey);

  if (cached) {
    const response = new Response(cached.body, cached);

    response.headers.set("X-SingSpace-Cache", "HIT");

    return response;
  }

  // 2. Ask YouTube only when the cache misses.
  const youtubeUrl = new URL(
    "https://www.googleapis.com/youtube/v3/search"
  );

  youtubeUrl.searchParams.set("part", "snippet");
  youtubeUrl.searchParams.set("type", "video");
  youtubeUrl.searchParams.set("videoEmbeddable", "true");
  youtubeUrl.searchParams.set("videoSyndicated", "true");
  youtubeUrl.searchParams.set("maxResults", "12");
  youtubeUrl.searchParams.set("safeSearch", "moderate");
  youtubeUrl.searchParams.set("q", searchTerm);
  youtubeUrl.searchParams.set("key", env.YOUTUBE_API_KEY);

  let apiResponse;

  try {
    apiResponse = await fetch(youtubeUrl.toString());
  } catch {
    return json(
      { error: "Unable to contact YouTube right now." },
      502
    );
  }

  if (!apiResponse.ok) {
    const details = await apiResponse.json().catch(() => ({}));

    const reason =
      details.error?.errors?.[0]?.reason || "";

    if (
      apiResponse.status === 403 &&
      ["quotaExceeded", "dailyLimitExceeded"].includes(reason)
    ) {
      return json(
        {
          error:
            "YouTube's daily search quota has been reached. " +
            "Please try again after the quota resets.",
        },
        429
      );
    }

    console.error("YouTube API request failed", {
      status: apiResponse.status,
      reason,
    });

    return json(
      {
        error:
          "YouTube search is unavailable. " +
          "Check your API key, quota and API restrictions.",
      },
      502
    );
  }

  const data = await apiResponse.json();

  // 3. Return only the fields needed by React.
  const songs = (data.items || [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({
      id: item.id.videoId,
      youtubeId: item.id.videoId,
      title: item.snippet.title,
      artist: item.snippet.channelTitle,
      thumbnail:
        item.snippet.thumbnails?.medium?.url ||
        item.snippet.thumbnails?.default?.url ||
        "",
    }));

  // 4. Save successful results for 24 hours.
  const response = json(
    { songs },
    200,
    {
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      "X-SingSpace-Cache": "MISS",
    }
  );

  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API route.
    if (url.pathname === "/api/youtube/search") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed." }, 405);
      }

      return searchYouTube(request, env, ctx);
    }

    // Serve the React website for all other routes.
    return env.ASSETS.fetch(request);
  },
};
