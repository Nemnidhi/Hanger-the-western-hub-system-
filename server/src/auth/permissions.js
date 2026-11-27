// Who may do what.
// Owner: everything, including settings, prices and the team.
// Manager: runs the day - chats, orders, catalogue, stock, reports, WhatsApp broadcasts.
// Staff (store): chats, orders and store billing; can see the catalogue and stock but not change them.
// The photo studio (studio:use): staff photograph new pieces and put the result on a new draft style;
// changing a style that already exists stays with catalog:write.
// Packer: sees confirmed orders and marks them packed and shipped.
export const ROLES = ["owner", "manager", "staff", "packer"];

const PERMISSIONS = {
  owner: ["*"],
  manager: [
    "inbox:read", "inbox:write", "templates:read",
    "orders:read", "orders:write", "orders:fulfil",
    "catalog:read", "catalog:write", "stock:read", "stock:write", "studio:use",
    "reports:read", "settings:read", "broadcasts:send",
  ],
  staff: ["inbox:read", "inbox:write", "templates:read", "orders:read", "orders:write", "catalog:read", "stock:read", "studio:use", "settings:read"],
  packer: ["orders:read", "orders:fulfil", "catalog:read", "stock:read"],
};

// These roles can change prices, stock and refunds, so two-step login is required, not optional.
export const TWO_FACTOR_REQUIRED_ROLES = new Set(["owner", "manager"]);

export function can(role, permission) {
  const granted = PERMISSIONS[role] || [];
  return granted.includes("*") || granted.includes(permission);
}

export function permissionsFor(role) {
  return PERMISSIONS[role] || [];
}
