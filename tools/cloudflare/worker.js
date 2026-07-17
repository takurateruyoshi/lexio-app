// Cloudflare Worker — レキシオ対局データ収集エンドポイント（大規模用）
// POST /games : gzip または生JSONの {v:1, records:[...]} を受け取り R2 に保存する。
// デプロイ手順は同ディレクトリの README.md を参照。
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Content-Encoding",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/games") {
      return new Response("not found", { status: 404, headers: cors });
    }
    // サイズ上限 512KB（圧縮後）
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 512 * 1024) {
      return new Response("too large", { status: 413, headers: cors });
    }
    // gzip 展開
    let text;
    try {
      if (request.headers.get("Content-Encoding") === "gzip") {
        const ds = new DecompressionStream("gzip");
        const stream = new Blob([buf]).stream().pipeThrough(ds);
        text = await new Response(stream).text();
      } else {
        text = new TextDecoder().decode(buf);
      }
    } catch {
      return new Response("bad encoding", { status: 400, headers: cors });
    }
    // 形式検証（最低限）
    let data;
    try {
      data = JSON.parse(text);
      if (data.v !== 1 || !Array.isArray(data.records) || data.records.length > 50) throw 0;
    } catch {
      return new Response("bad payload", { status: 400, headers: cors });
    }
    // R2 へ保存: games/YYYY-MM-DD/<uuid>.json
    const day = new Date().toISOString().slice(0, 10);
    const key = `games/${day}/${crypto.randomUUID()}.json`;
    await env.GAMES_BUCKET.put(key, JSON.stringify(data.records), {
      httpMetadata: { contentType: "application/json" },
    });
    return new Response(JSON.stringify({ ok: true, n: data.records.length }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
