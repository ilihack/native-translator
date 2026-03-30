/**
 * Static file serving middleware that detects build output location (dist/public)
 * and configures Express to serve frontend assets with proper MIME types.
 * @inputs Express app instance
 * @exports serveStatic(app) setup function
 */
import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  // In production bundle (dist/index.cjs), static files are in dist/ folder
  // Try multiple locations to find the build output
  const possiblePaths = [
    path.resolve(process.cwd(), "dist"),  // Running from project root
    __dirname,  // Running from within dist folder
    path.resolve(__dirname, ".."),  // One level up from dist
  ];

  let distPath: string | null = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(path.resolve(p, "index.html"))) {
      distPath = p;
      break;
    }
  }

  if (!distPath) {
    throw new Error(
      `Could not find build directory with index.html. Checked: ${possiblePaths.join(", ")}`,
    );
  }

  // Service Worker must never be long-cached by the browser — browsers already
  // limit SW cache to 24 h by default, but `no-cache` ensures they always
  // revalidate, allowing immediate update delivery when sw.js changes.
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.sendFile(path.resolve(distPath!, 'sw.js'));
  });

  app.use(express.static(distPath, {
    // Hashed Vite assets are content-addressed and never change — cache them for 1 year
    setHeaders(res, filePath) {
      if (/\/assets\/[^/]+\.(js|css|woff2?)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // /app and sub-paths serve the React app; everything else falls back to the landing page
  app.use("/app", (_req, res) => {
    res.sendFile(path.resolve(distPath!, "app.html"));
  });

  // fall through to index.html (landing page) for all other routes
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath!, "index.html"));
  });
}
