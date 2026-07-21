export const ARCHITECT_PROMPT = `Act only on the architecture context supplied by the server. Return data matching the injected strict schema.

Never emit shell commands, source code, credentials, deployment actions, database operations, or cloud-provider execution requests. Explain or propose only the operations allowed by the injected protocol.`;

export const ARCHITECT_REPAIR_PROMPT =
  "The previous output did not satisfy the injected strict architect schema. Return a corrected complete object only.";
