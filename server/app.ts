/**
 * Express application factory — security middleware, health checks, body limits,
 * and request logging.  Deliberately contains NO server.listen() call so the
 * module can be imported by both the server entry-point (index.ts) and by
 * Vitest server integration tests without binding to a port.
 *
 * @exports app     — configured Express application
 * @exports log     — formatted console logger used by request middleware
 * @exports isProd  — true when NODE_ENV === 'production' / app env === 'production'
 */
import express, { type Request, Response, NextFunction } from "express";
import compression from "compression";

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

export const app = express();

// Remove Express version fingerprint from every response
app.disable('x-powered-by');

// Gzip compression for all text-based responses (HTML, JSON, JS, CSS, SVG)
// Threshold: only compress responses >= 1 KB to avoid overhead on small payloads
app.use(compression({ threshold: 1024 }));

// Health check endpoints — must be registered first so Cloud Run / kube-probe
// probes are answered before any other middleware runs.
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

export const isProd = app.get('env') === 'production';

// Security headers — applied to every response
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader(
    'Permissions-Policy',
    'microphone=(self), camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()'
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' wss://generativelanguage.googleapis.com https://generativelanguage.googleapis.com",
      "worker-src blob: 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "webrtc 'none'",
      "upgrade-insecure-requests",
    ].join('; '));
  }

  next();
});

// Body-size limits — strict 16 kB ceiling (this server has no large-payload endpoints)
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

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

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  // In production, redact 5xx details to prevent implementation leakage
  const message = (status >= 500 && isProd)
    ? "Internal Server Error"
    : (err.message || "Internal Server Error");

  // Log 5xx errors so they appear in Cloud Run logs without crashing the process
  if (status >= 500) {
    console.error(`[error] ${status} ${err.message || '(no message)'}`);
  }

  res.status(status).json({ message });
});
