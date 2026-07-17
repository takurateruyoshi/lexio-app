// netconfig.js — ICEサーバー（STUN/TURN）設定の読み込み
// model/net.json で差し替え可能。staticAuthSecret 形式は TURN REST 方式の
// 短期クレデンシャル（username=期限unix秒, credential=HMAC-SHA1）をクライアントで生成する。
"use strict";

let ICE = [{ urls: "stun:stun.l.google.com:19302" }];

export function getIceServers() { return ICE; }

async function resolveStaticAuth(s) {
  const ttl = s.ttl ?? 6 * 3600;
  const username = String(Math.floor(Date.now() / 1000) + ttl);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(s.staticAuthSecret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return { urls: s.urls, username, credential };
}

export async function loadNetConfig(url = "model/net.json") {
  try {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) return ICE;
    const cfg = await r.json();
    const out = [];
    for (const s of cfg.iceServers || []) {
      try {
        out.push(s.staticAuthSecret ? await resolveStaticAuth(s) : s);
      } catch {}
    }
    if (out.length) ICE = out;
  } catch {}
  return ICE;
}
