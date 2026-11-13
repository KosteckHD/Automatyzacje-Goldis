export { PrivilegedActionsModule } from "./privileged-actions.module";
export type { PrivilegedActionPersistence } from "./privileged-actions.persistence";
export { PRIVILEGED_ACTION_PERSISTENCE } from "./privileged-actions.persistence";
export {
  completePrivilegedAction,
  consumePrivilegedAction,
  hashPrivilegedActionToken,
  PrivilegedActionService,
  privilegedActionAllowed,
  privilegedActionFingerprint,
  privilegedActionLifetimeMs,
  runConfirmedPrivilegedAction,
} from "./privileged-actions.service";
