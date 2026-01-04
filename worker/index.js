export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve real assets first
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;

    // Only fallback for browser navigations
    const accept = request.headers.get("Accept") || "";
    if (!accept.includes("text/html")) return res;

    // SPA fallback to index.html
    return env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
  },
};
