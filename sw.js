// @ts-check
// Service worker — offline app shell for Issue 01.
// Precache-first for the shell; network-first fallback for navigations.
// The detection model artifact (Issue 03 / Issue 08) will join APP_SHELL
// once its URL is locked, so repeat visits already work offline here.

export const CACHE_NAME = 'echopath-v1';

export const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/main.js',
  './src/camera.js',
  './src/pause.js',
  './src/earcons.js',
  './src/speech.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/// <reference lib="webworker" />
const sw = /** @type {any} */ (globalThis);

sw.addEventListener('install', (/** @type {any} */ event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (/** @type {any} */ event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('fetch', (/** @type {any} */ event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(sw.location.origin)) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return res;
        }),
    ),
  );
});
