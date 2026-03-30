/**
 * Production server entry point serving the pre-built Vite frontend bundle
 * with compression, static asset caching, health checks, and SPA fallback.
 * @inputs Environment PORT variable (default 5000), dist/public build output
 * @exports None (side-effect: starts production HTTP server)
 */
import express, { type Request, Response, NextFunction } from "express";
import { serveStatic } from "./static";
import { createServer } from "http";

const app = express();
const httpServer = createServer(app);

function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Health check endpoints - must be first for Cloud Run
app.get("/", (req, res, next) => {
  const userAgent = req.get("User-Agent") || "";
  if (userAgent.includes("GoogleHC") || userAgent.includes("kube-probe")) {
    return res.status(200).send("OK");
  }
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      log(logLine);
    }
  });

  next();
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";
  res.status(status).json({ message });
  throw err;
});

// Serve static files
serveStatic(app);

// Start server
const port = parseInt(process.env.PORT || "5000", 10);
httpServer.listen(
  {
    port,
    host: "0.0.0.0",
    reusePort: true,
  },
  () => {
    log(`serving on port ${port}`);
  },
);
