export default {
  async fetch() {
    return new Response(JSON.stringify({ ok: true, now: Date.now() }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
