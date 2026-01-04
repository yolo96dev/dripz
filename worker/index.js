export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Try the requested asset first
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;

    // Only for browser navigations
    const accept = request.headers.get("Accept") || "";
    const isHtmlNav = request.method === "GET" && accept.includes("text/html");
    if (!isHtmlNav) return res;

    // Rewrite to /index.html (NO redirect), keep the original URL (/coinflip)
    const indexUrl = new URL("/index.html", url);

    // Create a clean GET request for index.html
    const indexReq = new Request(indexUrl.toString(), {
      method: "GET",
      headers: request.headers,
    });

    return env.ASSETS.fetch(indexReq);
  },
};
