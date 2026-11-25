/**
 * CORS Middleware
 *
 * Handles Cross-Origin Resource Sharing for browser clients.
 */

export interface CorsConfig {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAge: number;
  credentials: boolean;
}

const defaultConfig: CorsConfig = {
  allowedOrigins: ["*"],
  allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-API-Key",
    "X-Request-ID",
    "Accept",
    "Cache-Control",
  ],
  exposeHeaders: ["X-Request-ID", "X-Session-ID"],
  maxAge: 86400, // 24 hours
  credentials: true,
};

let config = { ...defaultConfig };

/**
 * Configure CORS
 */
export function configureCors(newConfig: Partial<CorsConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Get CORS headers for a request
 */
export function getCorsHeaders(req: Request): Headers {
  const headers = new Headers();
  const origin = req.headers.get("Origin");

  // Check if origin is allowed
  const allowedOrigin = isOriginAllowed(origin);

  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
  }

  headers.set(
    "Access-Control-Allow-Methods",
    config.allowedMethods.join(", ")
  );

  headers.set(
    "Access-Control-Allow-Headers",
    config.allowedHeaders.join(", ")
  );

  headers.set(
    "Access-Control-Expose-Headers",
    config.exposeHeaders.join(", ")
  );

  headers.set("Access-Control-Max-Age", config.maxAge.toString());

  if (config.credentials) {
    headers.set("Access-Control-Allow-Credentials", "true");
  }

  return headers;
}

/**
 * Check if origin is allowed
 */
function isOriginAllowed(origin: string | null): string | null {
  if (!origin) {
    return null;
  }

  for (const allowed of config.allowedOrigins) {
    // Wildcard match all
    if (allowed === "*") {
      return origin;
    }

    // Exact match
    if (allowed === origin) {
      return origin;
    }

    // Wildcard pattern (e.g., "http://localhost:*")
    if (allowed.includes("*")) {
      const pattern = allowed
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      const regex = new RegExp(`^${pattern}$`);
      if (regex.test(origin)) {
        return origin;
      }
    }
  }

  return null;
}

/**
 * CORS middleware
 */
export function corsMiddleware(
  handler: (req: Request) => Promise<Response> | Response
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const corsHeaders = getCorsHeaders(req);

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Handle actual request
    const response = await handler(req);

    // Add CORS headers to response
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of corsHeaders) {
      newHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  };
}
