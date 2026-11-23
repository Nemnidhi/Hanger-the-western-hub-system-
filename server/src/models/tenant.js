// Every record carries tenantId. This deployment serves one brand (The Hanger), but the same code is meant to
// serve other boutiques later, so the field and the indexes are there from day one.
export const tenantField = { tenantId: { type: String, required: true, index: true } };
