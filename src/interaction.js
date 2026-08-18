const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_APPROVAL = "item/fileChange/requestApproval";
const USER_INPUT = "item/tool/requestUserInput";
const PERMISSIONS_APPROVAL = "item/permissions/requestApproval";
const MCP_ELICITATION = "mcpServer/elicitation/request";
const LEGACY_COMMAND_APPROVAL = "execCommandApproval";
const LEGACY_FILE_APPROVAL = "applyPatchApproval";

const SUPPORTED = new Set([
  COMMAND_APPROVAL,
  FILE_APPROVAL,
  USER_INPUT,
  PERMISSIONS_APPROVAL,
  MCP_ELICITATION,
  LEGACY_COMMAND_APPROVAL,
  LEGACY_FILE_APPROVAL,
]);

export function supportsServerRequest(request) {
  const method = typeof request === "string" ? request : request?.method;
  const params = typeof request === "string" ? {} : request?.params || {};
  if (!SUPPORTED.has(method)) return false;
  if (method === USER_INPUT && (params.questions || []).some((question) => question.isSecret)) return false;
  if (method === MCP_ELICITATION && params.mode === "openai/form") return false;
  if (method === MCP_ELICITATION && params.mode === "form" && !schemaSupported(params.requestedSchema)) return false;
  if (method === FILE_APPROVAL && !params.grantRoot && !Array.isArray(params.changes)) return false;
  return true;
}

export function formatServerRequest(request) {
  const { method, params = {} } = request;
  if (method === COMMAND_APPROVAL || method === LEGACY_COMMAND_APPROVAL) {
    const scope = method === LEGACY_COMMAND_APPROVAL
      ? { argv: params.command, cwd: params.cwd, parsedCommand: params.parsedCmd }
      : {
          command: params.command,
          cwd: params.cwd,
          environmentId: params.environmentId,
          network: params.networkApprovalContext,
          commandActions: params.commandActions,
          proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
          proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
        };
    return approvalPrompt("Codex command approval", exactScope(scope), params.reason);
  }
  if (method === FILE_APPROVAL || method === LEGACY_FILE_APPROVAL) {
    const scope = method === LEGACY_FILE_APPROVAL
      ? { grantRoot: params.grantRoot, fileChanges: params.fileChanges }
      : { grantRoot: params.grantRoot, changes: params.changes };
    return approvalPrompt("Codex file approval", exactScope(scope), params.reason);
  }
  if (method === PERMISSIONS_APPROVAL) {
    return approvalPrompt(
      "Codex permission approval",
      exactScope({ cwd: params.cwd, environmentId: params.environmentId, permissions: params.permissions }),
      params.reason,
    );
  }
  if (method === USER_INPUT) {
    const questions = params.questions || [];
    const body = questions.map((question, index) => {
      const options = question.options?.map((option, optionIndex) =>
        `${optionIndex + 1}. ${option.label}${option.description ? `: ${option.description}` : ""}`,
      ).join("\n");
      return `${index + 1}) ${question.question}${options ? `\n${options}` : ""}`;
    }).join("\n\n");
    const suffix = questions.length > 1 ? "\n\nReply with one answer per line." : "";
    return `Codex needs your input\n\n${body}${suffix}`;
  }
  if (method === MCP_ELICITATION) {
    if (params.mode === "url") {
      return `Codex app action\n\n${params.message}\n${params.url}\n\nReply: allow | deny | cancel`;
    }
    const properties = Object.entries(params.requestedSchema?.properties || {}).map(([key, schema]) =>
      `${key}${describeField(schema)}`,
    );
    const fields = properties.length ? `\n\nReply as key=value, one per line:\n${properties.join("\n")}` : "";
    return `Codex app input\n\n${params.message}${fields}\n\nOr reply: deny | cancel`;
  }
  throw new Error(`unsupported Codex request: ${method}`);
}

export function resolveServerRequest(request, text) {
  const value = String(text || "").trim();
  if (!value) throw new Error("A text answer is required.");
  const { method, params = {} } = request;

  if (method === COMMAND_APPROVAL) return { decision: modernDecision(value) };
  if (method === FILE_APPROVAL) return { decision: modernDecision(value) };
  if (method === LEGACY_COMMAND_APPROVAL || method === LEGACY_FILE_APPROVAL) {
    return { decision: legacyDecision(value) };
  }
  if (method === PERMISSIONS_APPROVAL) {
    const decision = decisionWord(value);
    if (!decision) throw decisionError();
    return {
      permissions: decision === "allow" || decision === "always" ? params.permissions || {} : {},
      scope: decision === "always" ? "session" : "turn",
    };
  }
  if (method === USER_INPUT) return resolveUserInput(params.questions || [], value);
  if (method === MCP_ELICITATION) return resolveMcpElicitation(params, value);
  throw new Error(`unsupported Codex request: ${method}`);
}

function approvalPrompt(title, subject, reason) {
  const detail = [subject, reason ? `Reason: ${reason}` : null].filter(Boolean).join("\n");
  return `${title}\n\n${detail}\n\nReply: allow | always | deny | cancel`;
}

function modernDecision(value) {
  const decision = decisionWord(value);
  if (decision === "allow") return "accept";
  if (decision === "always") return "acceptForSession";
  if (decision === "deny") return "decline";
  if (decision === "cancel") return "cancel";
  throw decisionError();
}

function legacyDecision(value) {
  const decision = decisionWord(value);
  if (decision === "allow") return "approved";
  if (decision === "always") return "approved_for_session";
  if (decision === "deny") return { denied: { rejection: "Denied by the user over iMessage." } };
  if (decision === "cancel") return "abort";
  throw decisionError();
}

function decisionWord(value) {
  const normalized = value.trim().toLowerCase();
  if (["allow", "approve", "approved", "yes", "y"].includes(normalized)) return "allow";
  if (["always", "session", "allow always", "approve always"].includes(normalized)) return "always";
  if (["deny", "decline", "denied", "no", "n"].includes(normalized)) return "deny";
  if (["cancel", "abort", "stop"].includes(normalized)) return "cancel";
  return null;
}

function decisionError() {
  return new Error("Reply with allow, always, deny, or cancel.");
}

function resolveUserInput(questions, value) {
  if (!questions.length) return { answers: {} };
  const lines = questions.length === 1
    ? [value]
    : value.split(/\r?\n/).map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
  if (lines.length < questions.length) throw new Error(`Reply with ${questions.length} answers, one per line.`);
  const answers = {};
  questions.forEach((question, index) => {
    answers[question.id] = { answers: [resolveOption(question, lines[index])] };
  });
  return { answers };
}

function resolveOption(question, value) {
  const options = question.options || [];
  if (!options.length) return value;
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1].label;
  }
  const option = options.find((item) => item.label.toLowerCase() === value.toLowerCase());
  if (option) return option.label;
  if (question.isOther) return value;
  throw new Error(`Choose one of: ${options.map((item, index) => `${index + 1}. ${item.label}`).join("; ")}`);
}

function resolveMcpElicitation(params, value) {
  const decision = decisionWord(value);
  if (decision === "deny") return { action: "decline", content: null, _meta: null };
  if (decision === "cancel") return { action: "cancel", content: null, _meta: null };
  if (params.mode === "url") {
    if (decision !== "allow" && decision !== "always") throw decisionError();
    return { action: "accept", content: null, _meta: null };
  }
  const schema = params.requestedSchema || {};
  const properties = schema.properties || {};
  let content;
  if (value.startsWith("{")) {
    content = JSON.parse(value);
  } else if (Object.keys(properties).length === 1 && !/[=:]/.test(value)) {
    const [key, fieldSchema] = Object.entries(properties)[0];
    content = { [key]: coerce(value, fieldSchema) };
  } else {
    content = {};
    for (const line of value.split(/\r?\n/)) {
      const match = line.match(/^\s*([^=:]+?)\s*[=:]\s*(.*?)\s*$/);
      if (!match) continue;
      const key = match[1].trim();
      content[key] = coerce(match[2], properties[key]);
    }
  }
  const missing = (schema.required || []).filter((key) => content[key] === undefined);
  if (missing.length) throw new Error(`Missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  validateSchema(content, schema, "response");
  return { action: "accept", content, _meta: null };
}

function coerce(value, schema = {}) {
  if (schema.type === "boolean") {
    if (/^(?:true|yes)$/i.test(value)) return true;
    if (/^(?:false|no)$/i.test(value)) return false;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if (schema.type === "array") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return value;
}

function exactScope(value) {
  return `Exact scope:\n${JSON.stringify(value, null, 2)}`;
}

function schemaSupported(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const allowed = new Set([
    "$schema", "title", "description", "type", "properties", "required", "additionalProperties",
    "enum", "enumNames", "const", "oneOf", "anyOf", "items", "minimum", "maximum",
    "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format",
    "minItems", "maxItems", "default",
  ]);
  if (Object.keys(schema).some((key) => !allowed.has(key))) return false;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some((type) => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))) return false;
  if (schema.format && !["email", "uri", "date", "date-time"].includes(schema.format)) return false;
  if (schema.properties && Object.values(schema.properties).some((value) => !schemaSupported(value))) return false;
  if (schema.items && !schemaSupported(schema.items)) return false;
  if (schema.oneOf && (!Array.isArray(schema.oneOf) || schema.oneOf.some((value) => !schemaSupported(value)))) return false;
  if (schema.anyOf && (!Array.isArray(schema.anyOf) || schema.anyOf.some((value) => !schemaSupported(value)))) return false;
  return true;
}

function validateSchema(value, schema, location) {
  if (!schemaSupported(schema)) throw new Error("This app form uses an unsupported schema and was rejected safely.");
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    throw new Error(`${location} must be ${types.join(" or ")}.`);
  }
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`${location} must be one of the allowed values.`);
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    throw new Error(`${location} does not match the required value.`);
  }
  const titledOptions = schema.oneOf || schema.anyOf;
  if (titledOptions && !titledOptions.some((option) => JSON.stringify(option.const) === JSON.stringify(value))) {
    throw new Error(`${location} must be one of the allowed values.`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${location} is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${location} is too long.`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) throw new Error(`${location} has an invalid format.`);
    if (schema.format && !matchesFormat(value, schema.format)) throw new Error(`${location} must be a valid ${schema.format}.`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${location} is below the minimum.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${location} is above the maximum.`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) throw new Error(`${location} is below the exclusive minimum.`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) throw new Error(`${location} is above the exclusive maximum.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${location} has too few items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${location} has too many items.`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${location}[${index}]`));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    const missing = (schema.required || []).filter((key) => value[key] === undefined);
    if (missing.length) throw new Error(`Missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter((key) => !Object.hasOwn(properties, key));
      if (extra.length) throw new Error(`Unknown field${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}`);
    }
    for (const [key, fieldSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) validateSchema(value[key], fieldSchema, key);
    }
  }
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function matchesFormat(value, format) {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (format === "date-time") return !Number.isNaN(Date.parse(value));
  return false;
}

function describeField(schema = {}) {
  const options = schema.oneOf?.map((option) => `${option.const} (${option.title})`)
    || schema.enum?.map((value, index) => schema.enumNames?.[index] ? `${value} (${schema.enumNames[index]})` : value)
    || schema.items?.anyOf?.map((option) => `${option.const} (${option.title})`)
    || schema.items?.enum;
  const details = [schema.description, schema.format, options?.length ? `values: ${options.join(", ")}` : null].filter(Boolean);
  return details.length ? `: ${details.join("; ")}` : "";
}
