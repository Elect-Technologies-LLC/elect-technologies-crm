import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

/**
 * The closed set of operations the marketing site is allowed to perform.
 *
 * This is the whole point of the function: the caller names an operation, not a
 * table and not a query. Anything absent from this map is impossible, so a
 * leaked intake secret cannot read CRM data, mutate or delete existing rows, or
 * reach the auth schema — all of which a leaked service-role key could do.
 *
 * `fields` doubles as a column allowlist. Unknown keys in the request are
 * rejected rather than ignored, so a caller cannot smuggle in a column that a
 * future migration happens to add.
 */
export type FieldType = "string" | "int" | "json" | "intArray";

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
}

export interface OpSpec {
  table: string;
  /** "insert" writes a row; "findId" looks one up by a single column. */
  mode: "insert" | "findId";
  fields: Record<string, FieldSpec>;
}

export const OPERATIONS: Record<string, OpSpec> = {
  // --- lookups (id only; never returns row contents) ---
  "sales.find_by_email": {
    table: "sales",
    mode: "findId",
    fields: { email: { type: "string", required: true } },
  },
  "company.find_by_name": {
    table: "companies",
    mode: "findId",
    fields: { name: { type: "string", required: true } },
  },
  "deal.find_by_name": {
    table: "deals",
    mode: "findId",
    fields: { name: { type: "string", required: true } },
  },

  // --- inserts ---
  "company.create": {
    table: "companies",
    mode: "insert",
    fields: {
      name: { type: "string", required: true },
      phone_number: { type: "string" },
      state_abbr: { type: "string" },
      sales_id: { type: "int" },
    },
  },
  "contact.create": {
    table: "contacts",
    mode: "insert",
    fields: {
      first_name: { type: "string", required: true },
      last_name: { type: "string" },
      email_jsonb: { type: "json" },
      phone_jsonb: { type: "json" },
      company_id: { type: "int", required: true },
      sales_id: { type: "int" },
      // Atomic CRM creates contacts with `tags: []` (contactModel.ts), and the
      // column is a nullable bigint[] with no default. A null here is not
      // equivalent: TagsListEdit spreads `record.tags` unguarded, so a
      // null-tags contact throws in the CRM UI.
      tags: { type: "intArray" },
      first_seen: { type: "string" },
      last_seen: { type: "string" },
    },
  },
  "deal.create": {
    table: "deals",
    mode: "insert",
    fields: {
      name: { type: "string", required: true },
      company_id: { type: "int" },
      contact_ids: { type: "intArray" },
      stage: { type: "string", required: true },
      category: { type: "string" },
      description: { type: "string" },
      sales_id: { type: "int" },
    },
  },
  "deal_note.create": {
    table: "deal_notes",
    mode: "insert",
    fields: {
      deal_id: { type: "int", required: true },
      type: { type: "string" },
      text: { type: "string", required: true },
      date: { type: "string" },
      sales_id: { type: "int" },
    },
  },
  "concept_feedback.create": {
    table: "concept_feedback",
    mode: "insert",
    fields: {
      concept_slug: { type: "string", required: true },
      concept_name: { type: "string", required: true },
      reviewer_name: { type: "string", required: true },
      reviewer_email: { type: "string", required: true },
      reviewer_role: { type: "string" },
      reviewer_company: { type: "string" },
      reviewer_type: { type: "string", required: true },
      rating: { type: "int", required: true },
      feels_like_elect: { type: "string", required: true },
      buyers_respect: { type: "string", required: true },
      what_works: { type: "string" },
      whats_missing: { type: "string" },
      user_agent: { type: "string" },
      request_id: { type: "string" },
    },
  },
};

export class BadRequest extends Error {}

function coerce(value: unknown, field: string, spec: FieldSpec): unknown {
  if (value === undefined || value === null) {
    if (spec.required) throw new BadRequest(`${field} is required`);
    return null;
  }
  switch (spec.type) {
    case "string":
      if (typeof value !== "string")
        throw new BadRequest(`${field} must be a string`);
      return value;
    case "int":
      if (!Number.isInteger(value))
        throw new BadRequest(`${field} must be an integer`);
      return value;
    case "intArray":
      if (!Array.isArray(value) || !value.every((v) => Number.isInteger(v))) {
        throw new BadRequest(`${field} must be an array of integers`);
      }
      return value;
    case "json":
      if (typeof value !== "object")
        throw new BadRequest(`${field} must be an object or array`);
      return value;
  }
}

/** Validates `data` against the op's allowlist and returns only allowed columns. */
export function buildPayload(
  spec: OpSpec,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const unknown = Object.keys(data).filter((k) => !(k in spec.fields));
  if (unknown.length > 0) {
    throw new BadRequest(`unknown field(s): ${unknown.join(", ")}`);
  }

  const payload: Record<string, unknown> = {};
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    const value = coerce(data[field], field, fieldSpec);
    // Omit absent optional fields entirely so column defaults still apply.
    if (value !== null || field in data) payload[field] = value;
  }
  return payload;
}

export async function runOperation(
  spec: OpSpec,
  payload: Record<string, unknown>,
): Promise<{ id: number | string | null }> {
  if (spec.mode === "findId") {
    const [column, value] = Object.entries(payload)[0];
    const { data, error } = await supabaseAdmin
      .from(spec.table)
      .select("id")
      .eq(column, value as string)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return { id: data?.id ?? null };
  }

  const { data, error } = await supabaseAdmin
    .from(spec.table)
    .insert(payload)
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id };
}
