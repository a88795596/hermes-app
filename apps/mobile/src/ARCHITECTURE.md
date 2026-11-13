# Mobile module boundaries

Expo Router mounts the personal client in `src/app`. Auth stores the device session in SecureStore. The connection layer opens an authenticated WebSocket for change notices and fetches complete projections over HTTP on changes, reconnect and foreground refresh.

Native SQLite persists the directory, topic projections and queued text per server and device credential. The client keeps a queued message until its accepted copy is durably cached. Retries reuse the same submission ID. The web preview keeps the session and cache in memory for the page lifetime.
