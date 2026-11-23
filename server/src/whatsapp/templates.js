import { Template } from "../models/index.js";

/** The body text of a Meta template and how many {{n}} blanks it has. */
export function readTemplateBody(components = []) {
  const body = (Array.isArray(components) ? components : []).find((component) => String(component?.type).toUpperCase() === "BODY");
  const text = String(body?.text || "");
  const params = new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((match) => match[1]));
  return { bodyText: text, paramCount: params.size };
}

/** Copies every template from Meta; ones no longer at Meta are marked DELETED, not removed. */
export async function syncTemplates({ tenantId, client, businessAccountId, now = new Date() }) {
  const remote = await client.listTemplates(businessAccountId);
  const seen = [];
  for (const template of remote) {
    const { bodyText, paramCount } = readTemplateBody(template.components);
    await Template.updateOne(
      { tenantId, name: template.name, language: template.language },
      {
        $set: {
          category: template.category || "",
          status: template.status || "",
          components: template.components || [],
          bodyText,
          paramCount,
          rejectedReason: template.rejected_reason && template.rejected_reason !== "NONE" ? template.rejected_reason : "",
          syncedAt: now,
        },
      },
      { upsert: true },
    );
    seen.push(`${template.name}|${template.language}`);
  }
  const existing = await Template.find({ tenantId }).select("name language status");
  for (const template of existing) {
    if (!seen.includes(`${template.name}|${template.language}`) && template.status !== "DELETED") {
      await Template.updateOne({ _id: template._id }, { $set: { status: "DELETED", syncedAt: now } });
    }
  }
  return remote.length;
}

/** Meta's webhook when a template is approved, rejected, paused or disabled. */
export async function applyTemplateStatus({ tenantId, value }) {
  const name = String(value?.message_template_name || "");
  const language = String(value?.message_template_language || "");
  const status = String(value?.event || "").toUpperCase();
  if (!name || !language || !status) return;
  await Template.updateOne(
    { tenantId, name, language },
    { $set: { status, rejectedReason: value?.reason && value.reason !== "NONE" ? String(value.reason) : "" } },
  );
}

/** Meta's send format for a template with body blanks filled in order. */
export function templatePayload(template, params = []) {
  const components = params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text: String(text) })) }] : [];
  return { name: template.name, language: template.language, components };
}
