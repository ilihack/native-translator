/**
 * Development server entry point — imports the configured Express app from app.ts
 * and starts the HTTP server (with Vite HMR in dev or static serving in production).
 * @inputs Environment PORT variable (default 5000)
 * @exports None (side-effect: starts HTTP server)
 */
import { createServer } from "http";
import { app, log, isProd } from "./app";
import { serveStatic } from "./static";

const httpServer = createServer(app);
const port = parseInt(process.env.PORT || "5000", 10);

if (isProd) {
  // Production: serve static files synchronously, then start server
  serveStatic(app);
  httpServer.listen(
    { port, host: "0.0.0.0", reusePort: true },
    () => { log(`serving on port ${port}`); },
  );
} else {
  // Development: async Vite HMR setup, then start server
  (async () => {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
    httpServer.listen(
      { port, host: "0.0.0.0", reusePort: true },
      () => { log(`serving on port ${port}`); },
    );
  })();
}
