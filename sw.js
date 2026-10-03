/* 生体スキャナー BioScanner — Service Worker
 *
 * 屋外の電波のない場所でも起動できるように、アプリ本体(シェル)を
 * 先読みキャッシュする。更新は「まずキャッシュを返し、裏で取得して
 * 次回に反映」する stale-while-revalidate 方式。
 *
 * CACHE 名の版を上げると、古いキャッシュは activate 時に破棄される。
 */
"use strict";

/* 版を上げると古いキャッシュが activate 時に破棄される。アプリやアイコンを
   更新したら必ず上げること。上げないと、ホーム画面に追加済みの端末が古い
   内容を持ち続ける。 */
const CACHE = "bioscanner-v2";

/* アプリの動作に必要な自前のファイル */
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon-180.png"
];

/* 書体は読めなくても CSS 側に実在するフォールバックを宣言してあるので、
   取得できたときだけ機会的にキャッシュする(失敗を致命にしない)。 */
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      /* 1つでも失敗すると addAll 全体が落ちるので個別に入れる */
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = FONT_HOSTS.includes(url.hostname);
  if (!sameOrigin && !isFont) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: sameOrigin });

      const fresh = fetch(req)
        .then((res) => {
          /* opaque(フォント等の no-cors)も含めて保存する。
             status 0 の opaque 応答は ok が false になるため個別に許す。 */
          if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => null);

      if (hit) return hit;

      const res = await fresh;
      if (res) return res;

      /* 完全オフラインで未キャッシュのページ遷移 → アプリ本体を返す */
      if (req.mode === "navigate") {
        const shell = await cache.match("./index.html");
        if (shell) return shell;
      }
      return new Response("オフラインです。", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    })
  );
});
