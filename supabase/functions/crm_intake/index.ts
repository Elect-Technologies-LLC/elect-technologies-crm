// Intake endpoint for the marketing site (elect-technologies-web).
//
// Why this exists: the site previously held SUPABASE_SERVICE_ROLE_KEY in its
// Vercel environment to write leads over PostgREST. That key bypasses RLS on
// every table AND reaches the auth admin API, so a compromise of the marketing
// site's environment meant full control of the CRM including its user accounts
// — vastly more authority than "record an inbound lead" needs.
//
// The service-role key now stays inside Supabase, where it is auto-injected and
// never leaves. The site holds only CRM_INTAKE_SECRET, whose entire authority is
// the closed operation set in operations.ts: create leads and feedback, and look
// up three ids. It cannot read CRM data, modify or delete rows, or touch auth.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import {
  BadRequest,
  buildPayload,
  OPERATIONS,
  runOperation,
} from "./operations.ts";

const INTAKE_SECRET = Deno.env.get("CRM_INTAKE_SECRET");
if (!INTAKE_SECRET) {
  throw new Error("Missing CRM_INTAKE_SECRET env variable");
}

const encoder = new TextEncoder();

/**
 * Constant-time secret comparison. Digesting first keeps the comparison length
 * fixed, so neither the secret's length nor its content leaks through timing.
 */
async function secretMatches(presented: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(INTAKE_SECRET as string)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

Deno.serve((req: Request) =>
  OptionsMiddleware(req, async (req) => {
    if (req.method !== "POST") {
      return createErrorResponse(405, "Method Not Allowed");
    }

    const token = bearerToken(req);
    if (!token || !(await secretMatches(token))) {
      return createErrorResponse(401, "Unauthorized");
    }

    let body: { op?: unknown; data?: unknown };
    try {
      body = await req.json();
    } catch {
      return createErrorResponse(400, "Body must be valid JSON");
    }

    const op = typeof body.op === "string" ? body.op : "";
    const spec = Object.prototype.hasOwnProperty.call(OPERATIONS, op)
      ? OPERATIONS[op]
      : undefined;
    if (!spec) {
      return createErrorResponse(
        400,
        `Unknown operation: ${op || "(missing)"}`,
      );
    }

    const data =
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? (body.data as Record<string, unknown>)
        : {};

    try {
      const result = await runOperation(spec, buildPayload(spec, data));
      return new Response(JSON.stringify({ data: result }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (err) {
      if (err instanceof BadRequest) {
        return createErrorResponse(400, err.message);
      }
      // Postgres errors can echo row contents; log server-side, stay opaque.
      console.error(`crm_intake ${op} failed:`, err);
      return createErrorResponse(500, "Internal Server Error");
    }
  }),
);
