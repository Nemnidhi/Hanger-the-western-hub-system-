import { User } from "../models/index.js";
import { can, TWO_FACTOR_REQUIRED_ROLES } from "./permissions.js";
import { SESSION_COOKIE, findSession, readCookie } from "./sessions.js";

// Every state-changing request must carry this header. Browsers cannot add a custom header to a
// cross-site request without a CORS preflight, which this server never grants - so together with
// SameSite=Strict cookies, another site cannot act on a signed-in staff member's behalf.
export const CSRF_HEADER = "x-hanger-app";

export function requireAppHeader(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get(CSRF_HEADER) !== "1") return res.status(403).json({ error: "FORBIDDEN", message: "Missing app header." });
  return next();
}

const httpError = (status, error, message) => Object.assign(new Error(message), { status, code: error });

/**
 * Loads the signed-in user. Until two-step login is passed, and until a temporary password is changed,
 * only the routes that finish those steps are allowed (`allowIncomplete`).
 */
export function requireAuth({ allowIncomplete = false } = {}) {
  return async (req, res, next) => {
    try {
      const session = await findSession(readCookie(req, SESSION_COOKIE));
      if (!session) throw httpError(401, "UNAUTHENTICATED", "Please sign in.");
      const user = await User.findOne({ _id: session.userId, tenantId: session.tenantId });
      if (!user || user.status !== "active") throw httpError(401, "UNAUTHENTICATED", "Please sign in.");

      const needsTwoFactorSetup = TWO_FACTOR_REQUIRED_ROLES.has(user.role) && !user.twoFactor?.enabled;
      const incomplete = session.twoFactorPending || user.mustChangePassword || needsTwoFactorSetup;
      if (incomplete && !allowIncomplete) {
        const step = session.twoFactorPending ? "TWO_FACTOR_REQUIRED" : user.mustChangePassword ? "PASSWORD_CHANGE_REQUIRED" : "TWO_FACTOR_SETUP_REQUIRED";
        throw httpError(403, step, "Finish signing in first.");
      }
      req.user = user;
      req.authSession = session;
      req.tenantId = user.tenantId;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** Allows the request when the role has any one of the permissions given. */
export function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user || !permissions.some((permission) => can(req.user.role, permission))) return next(httpError(403, "FORBIDDEN", "Your role cannot do this."));
    return next();
  };
}
