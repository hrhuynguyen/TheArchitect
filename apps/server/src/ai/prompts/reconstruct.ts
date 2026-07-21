export const RECONSTRUCTION_PROMPT = `Analyze the whiteboard image and return only the infrastructure intent wire object requested by the strict schema.

Represent each resource property as an entry in the properties array. Use stable descriptive IDs, include only supported resource types and relationship kinds, and use null for nullable fields that are not present in the drawing. Do not invent credentials, secrets, source code, deployment commands, or unsupported resources.`;

export const RECONSTRUCTION_REPAIR_PROMPT =
  "The previous output did not satisfy the strict infrastructure intent schema. Return a corrected complete object only.";
